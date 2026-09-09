/**
 * Polls.
 *
 * Moderators ask, everyone answers, and the room sees totals only — the
 * server never attributes a vote to a person. A classroom poll people are
 * afraid to answer tells you nothing.
 */

import { el } from "../dom";
import { icons } from "../icons";
import type { PollView } from "../types";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

export interface PollHandlers {
  onCreate: (question: string, options: string[]) => void;
  onVote: (poll: string, option: number) => void;
  onClose: (poll: string) => void;
}

export interface PollHandles {
  root: HTMLElement;
  setPolls: (polls: PollView[]) => void;
  upsert: (poll: PollView) => void;
  setCanModerate: (can: boolean) => void;
  count: () => number;
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
    // Typing in the last field offers another, up to the maximum.
    input.addEventListener("input", () => {
      if (input.value.trim() && input === optionInputs[optionInputs.length - 1]) addOption();
      paintComposer();
    });
    optionInputs.push(input);
    optionList.append(input);
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
  }
  question.addEventListener("input", paintComposer);

  function resetComposer(): void {
    question.value = "";
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
    handlers.onCreate(question.value.trim(), options);
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
    // Participants see the tally only after answering, or once the poll has
    // closed: showing it first would steer the vote. Moderators see it
    // straight away — they are running the poll, and making a teacher vote in
    // their own question to read the room is absurd.
    const showResults = canModerate || myVote !== undefined || !poll.open;

    const body = el("div", { class: "poll__options" });

    poll.options.forEach((option, index) => {
      if (showResults) {
        const share = poll.total === 0 ? 0 : Math.round((poll.counts[index] / poll.total) * 100);
        const row = el(
          "div",
          {
            class: `poll__result${myVote === index ? " is-mine" : ""}`,
            role: "listitem",
            "aria-label": `${option}: ${poll.counts[index]} of ${poll.total} votes, ${share} percent`,
          },
          [
            el("span", { class: "poll__bar", style: `--share:${share}%`, "aria-hidden": "true" }),
            el("span", { class: "poll__result-label", text: option }),
            el("span", { class: "poll__share num", text: `${share}%` }),
          ]
        );
        body.append(row);
      } else {
        const button = el("button", { class: "poll__option", type: "button" }, [
          el("span", { text: option }),
        ]);
        button.addEventListener("click", () => {
          myVotes.set(poll.id, index);
          handlers.onVote(poll.id, index);
          // Repaint at once so the answer feels immediate; the server's echo
          // arrives a moment later with the updated totals.
          render();
        });
        body.append(button);
      }
    });

    const meta = el("div", { class: "poll__meta" }, [
      el("span", {
        class: "pill",
        text: poll.open ? "Open" : "Closed",
        ...(poll.open ? {} : { style: "opacity:.7" }),
      }),
      el("span", {
        class: "num",
        text: poll.total === 1 ? "1 vote" : `${poll.total} votes`,
      }),
    ]);

    if (canModerate && poll.open) {
      const close = el("button", { class: "btn", type: "button", style: "height:26px;padding:0 10px" }, [
        el("span", { text: "Close" }),
      ]);
      close.addEventListener("click", () => handlers.onClose(poll.id));
      meta.append(close);
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
  };
}
