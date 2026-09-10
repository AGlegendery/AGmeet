/**
 * Polls.
 *
 * Moderators ask, everyone answers, and the room sees totals only — the
 * server never attributes a vote to a person. A classroom poll people are
 * afraid to answer tells you nothing.
 */

import { el } from "../dom";
import { icons } from "../icons";
import type { PollView, RevealMode } from "../types";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

export interface PollHandlers {
  onCreate: (question: string, options: string[], correct: number | null) => void;
  onVote: (poll: string, option: number) => void;
  onClose: (poll: string) => void;
  onReveal: (poll: string, mode: RevealMode) => void;
  /** Reopens the popup for a poll the viewer wants another look at. */
  onOpen: (poll: string) => void;
}

export interface PollHandles {
  root: HTMLElement;
  setPolls: (polls: PollView[]) => void;
  upsert: (poll: PollView) => void;
  setCanModerate: (can: boolean) => void;
  count: () => number;
  get: (id: string) => PollView | undefined;
  myVote: (id: string) => number | undefined;
  recordVote: (id: string, option: number) => void;
}

export function buildPolls(handlers: PollHandlers): PollHandles {
  const polls = new Map<string, PollView>();
  /** This browser's own choices. Votes are anonymous, so only the voter
   *  knows what they picked, and only for as long as they stay in the room. */
  const myVotes = new Map<string, number>();
  let canModerate = false;

  const list = el("div", { class: "polls scroll", role: "list", "aria-label": "Polls" });

  const empty = el("div", { class: "state" }, [
    el("span", { class: "state__mark", html: icons.poll }),
    el("p", { class: "state__title", text: "No polls yet" }),
    el("p", {
      class: "state__body",
      text: "A quick poll is the fastest way to find out whether a room is following you.",
    }),
  ]);

  // --- Composer ----------------------------------------------------------
  const question = el("input", {
    class: "input",
    type: "text",
    maxlength: "200",
    placeholder: "Ask a question",
    "aria-label": "Poll question",
  }) as HTMLInputElement;

  const optionList = el("div", { class: "stack", style: "gap:var(--s-2)" });
  const optionInputs: HTMLInputElement[] = [];
  /** Index of the option marked right, or null for an opinion poll. */
  let correctIndex: number | null = null;

  function addOption(focus = false): void {
    if (optionInputs.length >= MAX_OPTIONS) return;
    const index = optionInputs.length;
    const input = el("input", {
      class: "input",
      type: "text",
      maxlength: "80",
      placeholder: `Option ${index + 1}`,
      "aria-label": `Option ${index + 1}`,
    }) as HTMLInputElement;

    // Marking an answer is optional: a poll asking the room's opinion has no
    // right answer, and forcing one would be a lie.
    const mark = el("button", {
      class: "poll__mark tip tip--end",
      type: "button",
      "data-tip": "Mark as the correct answer",
      "aria-label": `Mark option ${index + 1} as correct`,
      "aria-pressed": "false",
      html: icons.check,
    }) as HTMLButtonElement;
    mark.addEventListener("click", () => {
      correctIndex = correctIndex === index ? null : index;
      paintComposer();
    });

    input.addEventListener("input", () => {
      if (input.value.trim() && input === optionInputs[optionInputs.length - 1]) addOption();
      paintComposer();
    });
    optionInputs.push(input);
    optionList.append(el("div", { class: "poll__option-row" }, [input, mark]));
    if (focus) input.focus();
  }

  const submit = el("button", { class: "btn btn--accent btn--block", type: "submit" }, [
    el("span", { text: "Start poll" }),
  ]) as HTMLButtonElement;

  const cancel = el("button", { class: "btn btn--glass btn--block", type: "button" }, [
    el("span", { text: "Cancel" }),
  ]);

  const composerError = el("p", { class: "field__error", hidden: true });

  const composer = el("form", { class: "poll-composer glass-2", hidden: true }, [
    el("p", { class: "field__label", text: "New poll" }),
    question,
    optionList,
    composerError,
    el("div", { class: "row", style: "gap:var(--s-2)" }, [cancel, submit]),
  ]) as HTMLFormElement;

  function filledOptions(): string[] {
    return optionInputs.map((i) => i.value.trim()).filter(Boolean);
  }

  function paintComposer(): void {
    submit.disabled = question.value.trim().length === 0 || filledOptions().length < MIN_OPTIONS;
    optionList.querySelectorAll(".poll__mark").forEach((node, index) => {
      const on = correctIndex === index;
      node.setAttribute("aria-pressed", String(on));
      node.classList.toggle("is-correct", on);
    });
  }
  question.addEventListener("input", paintComposer);

  function resetComposer(): void {
    question.value = "";
    correctIndex = null;
    optionInputs.length = 0;
    optionList.replaceChildren();
    addOption();
    addOption();
    composerError.hidden = true;
    paintComposer();
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const options = filledOptions();
    if (options.length < MIN_OPTIONS) {
      composerError.hidden = false;
      composerError.textContent = "A poll needs at least two options.";
      return;
    }
    handlers.onCreate(
      question.value.trim(),
      options,
      correctIndex !== null && correctIndex < options.length ? correctIndex : null
    );
    composer.hidden = true;
    newPoll.hidden = false;
    resetComposer();
  });

  cancel.addEventListener("click", () => {
    composer.hidden = true;
    newPoll.hidden = false;
    resetComposer();
  });

  const newPoll = el("button", { class: "btn btn--glass btn--block", type: "button", hidden: true }, [
    el("span", { html: icons.plus }),
    el("span", { text: "New poll" }),
  ]);
  newPoll.addEventListener("click", () => {
    composer.hidden = false;
    newPoll.hidden = true;
    question.focus();
  });

  // --- Rendering ---------------------------------------------------------

  function renderPoll(poll: PollView): HTMLElement {
    const myVote = myVotes.get(poll.id);
    // The panel is the operator's view and the archive. Live answering
    // happens in the popup, so this always shows the tally to a moderator and
    // to anyone who has already answered or whose poll has ended.
    const showResults = canModerate || myVote !== undefined || !poll.open;

    const body = el("div", { class: "poll__options" });

    poll.options.forEach((option, index) => {
      const isCorrect = poll.correct === index;
      if (showResults) {
        const share = poll.total === 0 ? 0 : Math.round((poll.counts[index] / poll.total) * 100);
        body.append(
          el(
            "div",
            {
              class: `poll__result${myVote === index ? " is-mine" : ""}${isCorrect ? " is-correct" : ""}`,
              role: "listitem",
              "aria-label": `${option}: ${poll.counts[index]} of ${poll.total} votes, ${share} percent${isCorrect ? ", correct answer" : ""}`,
            },
            [
              el("span", { class: "poll__bar", style: `--share:${share}%`, "aria-hidden": "true" }),
              el("span", { class: "poll__result-label", text: option }),
              ...(isCorrect
                ? [el("span", { class: "poll__correct", html: icons.check, "aria-hidden": "true" })]
                : []),
              el("span", { class: "poll__share num", text: `${share}%` }),
            ]
          )
        );
      } else {
        const button = el("button", { class: "poll__option", type: "button" }, [
          el("span", { text: option }),
        ]);
        button.addEventListener("click", () => {
          myVotes.set(poll.id, index);
          handlers.onVote(poll.id, index);
          render();
        });
        body.append(button);
      }
    });

    const meta = el("div", { class: "poll__meta" }, [
      el("span", {
        class: poll.open ? "pill" : "pill",
        text: poll.open ? "Open" : poll.revealed ? "Revealed" : "Ended",
        ...(poll.open ? {} : { style: "opacity:.75" }),
      }),
      el("span", { class: "num", text: poll.total === 1 ? "1 vote" : `${poll.total} votes` }),
    ]);

    if (poll.open) {
      const reopen = el("button", { class: "btn poll__act", type: "button" }, [
        el("span", { text: "Open" }),
      ]);
      reopen.addEventListener("click", () => handlers.onOpen(poll.id));
      meta.append(reopen);
    }

    if (canModerate) {
      if (poll.open) {
        const end = el("button", { class: "btn poll__act", type: "button" }, [
          el("span", { text: "End" }),
        ]);
        end.addEventListener("click", () => handlers.onClose(poll.id));
        meta.append(end);
      }
      if (!poll.revealed) {
        // Publishing is a separate decision from ending: some questions want
        // the tally shown, some only the answer, some neither.
        const reveal = el("div", { class: "poll__reveal" }, []);
        const modes: { mode: RevealMode; label: string }[] = [
          { mode: "counts", label: "Show results" },
          ...(poll.correct !== null || !poll.open
            ? [{ mode: "correct" as RevealMode, label: "Show answer" }]
            : []),
          { mode: "both", label: "Show both" },
        ];
        for (const entry of modes) {
          const button = el("button", { class: "btn poll__act", type: "button" }, [
            el("span", { text: entry.label }),
          ]);
          button.addEventListener("click", () => handlers.onReveal(poll.id, entry.mode));
          reveal.append(button);
        }
        meta.append(reveal);
      }
    }

    return el("article", { class: "poll", role: "listitem" }, [
      el("h3", { class: "poll__question", text: poll.question }),
      body,
      meta,
    ]);
  }

  function render(): void {
    const ordered = [...polls.values()].sort((a, b) => b.createdAt - a.createdAt);
    list.replaceChildren();
    if (ordered.length === 0) {
      list.append(empty);
    } else {
      for (const poll of ordered) list.append(renderPoll(poll));
    }
  }

  const root = el("div", { class: "panel__view", role: "tabpanel", "aria-label": "Polls" }, [
    list,
    el("div", { class: "polls__foot" }, [newPoll, composer]),
  ]);
  root.setAttribute("aria-hidden", "true");

  resetComposer();
  render();

  return {
    root,
    setPolls(list) {
      polls.clear();
      for (const poll of list) polls.set(poll.id, poll);
      render();
    },
    upsert(poll) {
      polls.set(poll.id, poll);
      render();
    },
    setCanModerate(can) {
      canModerate = can;
      if (!can) {
        composer.hidden = true;
        newPoll.hidden = true;
      } else if (composer.hidden) {
        newPoll.hidden = false;
      }
      render();
    },
    count: () => polls.size,
    get: (id) => polls.get(id),
    myVote: (id) => myVotes.get(id),
    recordVote(id, option) {
      // The popup answers optimistically; the panel has to agree with it so
      // reopening from the chat shows the choice already made.
      myVotes.set(id, option);
      render();
    },
  };
}
