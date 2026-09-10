/**
 * The poll popup.
 *
 * A poll interrupts on purpose — that is the point of asking — but it never
 * traps anyone: it can be dismissed, and the chat keeps a way back in so an
 * answer can still be changed until the operator ends it.
 */

import { el } from "../dom";
import { icons } from "../icons";
import type { PollView, RevealMode } from "../types";

export interface PollDialogHandlers {
  onVote: (poll: string, option: number) => void;
  onClose: (poll: string) => void;
  onReveal: (poll: string, mode: RevealMode) => void;
}

export interface PollDialogHandles {
  root: HTMLElement;
  /** Opens, or refreshes if this poll is already showing. */
  open: (poll: PollView, myVote: number | undefined) => void;
  setCanModerate: (can: boolean) => void;
  /** Refreshes only if the given poll is the one on screen. */
  update: (poll: PollView, myVote: number | undefined) => void;
  close: () => void;
  isOpen: (pollId?: string) => boolean;
}

export function buildPollDialog(handlers: PollDialogHandlers): PollDialogHandles {
  let current: PollView | null = null;
  let myVote: number | undefined;
  let canModerate = false;
  let lastFocused: HTMLElement | null = null;

  const body = el("div", { class: "polldlg__body" });

  const dismiss = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Dismiss this poll",
    html: icons.close,
  });
  dismiss.addEventListener("click", () => close());

  const card = el("div", { class: "polldlg glass-3", role: "dialog", "aria-modal": "false" }, [
    el("div", { class: "polldlg__head" }, [
      el("span", { class: "polldlg__badge" }, [
        el("span", { html: icons.poll }),
        el("span", { text: "Poll" }),
      ]),
      dismiss,
    ]),
    body,
  ]);

  const root = el("div", { class: "polldlg__layer", hidden: true }, [card]);

  function close(): void {
    root.hidden = true;
    current = null;
    lastFocused?.focus();
    lastFocused = null;
  }

  function paint(): void {
    if (!current) return;
    const poll = current;
    const answered = myVote !== undefined;
    // Once the poll is closed nobody can move, so it becomes a read-out.
    const readOnly = !poll.open;

    const options = poll.options.map((option, index) => {
      const chosen = myVote === index;
      const isCorrect = poll.correct === index;

      if (readOnly) {
        const share = poll.total === 0 ? 0 : Math.round((poll.counts[index] / poll.total) * 100);
        return el(
          "div",
          {
            class: `poll__result${chosen ? " is-mine" : ""}${isCorrect ? " is-correct" : ""}`,
            "aria-label": `${option}: ${share} percent${isCorrect ? ", correct answer" : ""}`,
          },
          [
            el("span", { class: "poll__bar", style: `--share:${share}%`, "aria-hidden": "true" }),
            el("span", { class: "poll__result-label", text: option }),
            ...(isCorrect
              ? [el("span", { class: "poll__correct", html: icons.check, "aria-hidden": "true" })]
              : []),
            el("span", { class: "poll__share num", text: `${share}%` }),
          ]
        );
      }

      const button = el(
        "button",
        {
          class: `poll__option${chosen ? " is-mine" : ""}`,
          type: "button",
          "aria-pressed": String(chosen),
        },
        [
          el("span", { text: option }),
          ...(chosen ? [el("span", { class: "poll__tick", html: icons.check })] : []),
        ]
      );
      button.addEventListener("click", () => {
        handlers.onVote(poll.id, index);
        myVote = index;
        // Answering dismisses it. The chat keeps a way back in if they change
        // their mind before the operator ends the poll.
        close();
      });
      return button;
    });

    // A moderator runs the poll from the same place everyone answers it —
    // there is no separate panel to go and find.
    const controls: Node[] = [];

    // Whoever is running the poll needs to see it land — that is the whole
    // reason for asking. Everyone else sees only their own choice until the
    // results are published: a visible tally would tell the undecided which
    // way to go.
    const tally: Node[] = [];
    if (canModerate && poll.open) {
      tally.push(
        el("div", { class: "poll__tally" }, [
          el("span", {
            class: "poll__tally-head num",
            text: `${poll.total} ${poll.total === 1 ? "vote" : "votes"}`,
          }),
          ...poll.options.map((option, index) => {
            const share = poll.total === 0 ? 0 : Math.round((poll.counts[index] / poll.total) * 100);
            return el(
              "div",
              {
                class: "poll__result poll__result--live",
                "aria-label": `${option}: ${share} percent so far`,
              },
              [
                el("span", { class: "poll__bar", style: `--share:${share}%`, "aria-hidden": "true" }),
                el("span", { class: "poll__result-label", text: option }),
                el("span", { class: "poll__share num", text: `${share}%` }),
              ]
            );
          }),
        ])
      );
    }

    if (canModerate) {
      if (poll.open) {
        const end = el("button", { class: "btn btn--glass", type: "button" }, [
          el("span", { text: "End poll" }),
        ]);
        end.addEventListener("click", () => handlers.onClose(poll.id));
        controls.push(end);
      }
      if (!poll.revealed) {
        const modes: { mode: RevealMode; label: string }[] = [
          { mode: "counts", label: "Show results" },
          ...(poll.correct !== null || !poll.open
            ? [{ mode: "correct" as RevealMode, label: "Show answer" }]
            : []),
          { mode: "both", label: "Show both" },
        ];
        for (const entry of modes) {
          const button = el("button", { class: "btn btn--glass", type: "button" }, [
            el("span", { text: entry.label }),
          ]);
          button.addEventListener("click", () => handlers.onReveal(poll.id, entry.mode));
          controls.push(button);
        }
      }
    }

    body.replaceChildren(
      el("h2", { class: "polldlg__question", text: poll.question }),
      el("div", { class: "poll__options" }, options),
      el("p", {
        class: "polldlg__foot",
        text: readOnly
          ? poll.revealed
            ? "Results are in the chat."
            : "This poll has ended."
          : answered
            ? "Your answer is saved. You can change it until the poll ends."
            : "Pick one. You can change it until the poll ends.",
      }),
      ...tally,
      ...(controls.length > 0
        ? [el("div", { class: "polldlg__controls" }, controls)]
        : [])
    );
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) close();
  });

  return {
    root,
    open(poll, vote) {
      if (root.hidden) lastFocused = document.activeElement as HTMLElement | null;
      current = poll;
      myVote = vote;
      root.hidden = false;
      paint();
      (body.querySelector("button") as HTMLElement | null)?.focus();
    },
    update(poll, vote) {
      if (!current || current.id !== poll.id) return;
      current = poll;
      myVote = vote;
      paint();
    },
    setCanModerate(can) {
      canModerate = can;
      paint();
    },
    close,
    isOpen(pollId) {
      if (root.hidden) return false;
      return pollId === undefined || current?.id === pollId;
    },
  };
}
