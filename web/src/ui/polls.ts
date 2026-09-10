/**
 * Polls: the store, and the dialog for writing one.
 *
 * There is no polls panel. A poll is a moment, not a page: it is written in a
 * dialog, it arrives as a popup, and its notice and its results live in the
 * chat where the room is already looking. Keeping a third tab in sync with
 * all of that bought nothing.
 */

import { el } from "../dom";
import { icons } from "../icons";
import type { PollView } from "../types";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

export interface PollHandlers {
  onCreate: (question: string, options: string[], correct: number | null) => void;
}

export interface PollHandles {
  /** The composer dialog's layer, mounted once over the stage. */
  root: HTMLElement;
  openComposer: () => void;
  setPolls: (polls: PollView[]) => void;
  upsert: (poll: PollView) => void;
  get: (id: string) => PollView | undefined;
  myVote: (id: string) => number | undefined;
  recordVote: (id: string, option: number) => void;
  count: () => number;
}

export function buildPolls(handlers: PollHandlers): PollHandles {
  const polls = new Map<string, PollView>();
  /** This browser's own choices. Votes are anonymous, so only the voter
   *  knows what they picked, and only while they stay in the room. */
  const myVotes = new Map<string, number>();

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

  const submit = el("button", { class: "btn btn--accent btn--block", type: "submit" }, [
    el("span", { text: "Start poll" }),
  ]) as HTMLButtonElement;

  function filledOptions(): string[] {
    return optionInputs.map((i) => i.value.trim()).filter(Boolean);
  }

  function paint(): void {
    submit.disabled = question.value.trim().length === 0 || filledOptions().length < MIN_OPTIONS;
    optionList.querySelectorAll(".poll__mark").forEach((node, index) => {
      const on = correctIndex === index;
      node.setAttribute("aria-pressed", String(on));
      node.classList.toggle("is-correct", on);
    });
  }

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
    });
    mark.addEventListener("click", () => {
      correctIndex = correctIndex === index ? null : index;
      paint();
    });

    input.addEventListener("input", () => {
      if (input.value.trim() && input === optionInputs[optionInputs.length - 1]) addOption();
      paint();
    });
    optionInputs.push(input);
    optionList.append(el("div", { class: "poll__option-row" }, [input, mark]));
    if (focus) input.focus();
  }

  function reset(): void {
    question.value = "";
    correctIndex = null;
    optionInputs.length = 0;
    optionList.replaceChildren();
    addOption();
    addOption();
    paint();
  }

  const cancel = el("button", { class: "btn btn--block", type: "button" }, [
    el("span", { text: "Cancel" }),
  ]);

  const form = el("form", { class: "polldlg__body stack", style: "gap:var(--s-4)" }, [
    el("h2", { class: "polldlg__question", text: "New poll" }),
    question,
    optionList,
    el("p", {
      class: "field__hint",
      text: "Mark one option with the tick if it is the right answer. You choose later whether the room sees the tally, the answer, or both.",
    }),
    el("div", { class: "row", style: "gap:var(--s-2)" }, [cancel, submit]),
  ]) as HTMLFormElement;

  question.addEventListener("input", paint);

  // Named apart from the poll popup: both are dialogs on the same layer, and
  // the one you write a poll in is not the one you answer it in.
  const layer = el("div", { class: "polldlg__layer", hidden: true }, [
    el("div", { class: "polldlg polldlg--composer glass-3", role: "dialog", "aria-modal": "true" }, [
      form,
    ]),
  ]);

  function close(): void {
    layer.hidden = true;
    reset();
  }

  cancel.addEventListener("click", close);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const options = filledOptions();
    if (options.length < MIN_OPTIONS) return;
    handlers.onCreate(
      question.value.trim(),
      options,
      correctIndex !== null && correctIndex < options.length ? correctIndex : null
    );
    close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !layer.hidden) close();
  });

  reset();

  return {
    root: layer,
    openComposer() {
      layer.hidden = false;
      question.focus();
    },
    setPolls(list) {
      polls.clear();
      for (const poll of list) polls.set(poll.id, poll);
    },
    upsert(poll) {
      polls.set(poll.id, poll);
    },
    get: (id) => polls.get(id),
    myVote: (id) => myVotes.get(id),
    recordVote(id, option) {
      myVotes.set(id, option);
    },
    count: () => polls.size,
  };
}
