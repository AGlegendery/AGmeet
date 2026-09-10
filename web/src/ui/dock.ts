/**
 * Floating control dock.
 *
 * Level 4 glass: the closest surface to the user. It floats clear of the
 * stage rather than being welded to the window edge, and it carries only the
 * controls someone reaches for without thinking. Everything else lives behind
 * "More".
 */

import { el } from "../dom";
import { icons, REACTIONS } from "../icons";

export interface DockState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  hand: boolean;
  board: boolean;
}

export interface DockHandlers {
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleScreen: () => void;
  onToggleBoard: () => void;
  onToggleHand: () => void;
  onReaction: (kind: string) => void;
  onLeave: () => void;
}

export interface DockHandles {
  root: HTMLElement;
  setState: (state: DockState) => void;
  setScreenAvailable: (available: boolean) => void;
  setBoardAvailable: (available: boolean) => void;
  /** Room policy can forbid a guest a microphone or camera entirely. */
  setMediaAllowed: (allowed: boolean) => void;
}

function control(
  label: string,
  iconOn: string,
  onClick: () => void,
  options: { pressed?: boolean } = {}
): HTMLButtonElement {
  const button = el("button", {
    class: "dock__btn tip",
    type: "button",
    "data-tip": label,
    "aria-label": label,
    ...(options.pressed !== undefined ? { "aria-pressed": String(options.pressed) } : {}),
    html: iconOn,
  }) as HTMLButtonElement;
  button.addEventListener("click", onClick);
  return button;
}

export function buildDock(handlers: DockHandlers): DockHandles {
  const mic = control("Microphone", icons.mic, handlers.onToggleMic);
  const cam = control("Camera", icons.camera, handlers.onToggleCam);
  const screen = control("Share screen", icons.screen, handlers.onToggleScreen, { pressed: false });
  const board = control("Whiteboard", icons.board, handlers.onToggleBoard, { pressed: false });
  const hand = control("Raise hand", icons.hand, handlers.onToggleHand, { pressed: false });

  // --- Reactions ---------------------------------------------------------
  const reactionMenu = el("div", {
    class: "menu glass-3",
    role: "menu",
    hidden: true,
    style: "bottom:calc(100% + 12px);top:auto;left:50%;transform:translateX(-50%);min-width:auto;display:flex;gap:4px",
  });
  for (const reaction of REACTIONS) {
    const button = el("button", {
      class: "icon-btn",
      type: "button",
      role: "menuitem",
      "aria-label": reaction.label,
      html: icons[reaction.kind as keyof typeof icons],
    });
    button.addEventListener("click", () => {
      handlers.onReaction(reaction.kind);
      closeAll();
    });
    reactionMenu.append(button);
  }

  const reactions = el("button", {
    class: "dock__btn tip",
    type: "button",
    "data-tip": "Reactions",
    "aria-label": "Reactions",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: icons.reactions,
  }) as HTMLButtonElement;

  // --- Leave -------------------------------------------------------------
  // Two steps on purpose: leaving is the one action nobody should trigger by
  // brushing a key or a thumb.
  const leaveMenu = el("div", {
    class: "menu glass-3",
    role: "menu",
    hidden: true,
    style: "bottom:calc(100% + 12px);top:auto;right:0",
  });
  const confirmLeave = el(
    "button",
    { class: "menu__item menu__item--danger", type: "button", role: "menuitem" },
    [el("span", { html: icons.leave }), el("span", { text: "Leave the meeting" })]
  );
  confirmLeave.addEventListener("click", handlers.onLeave);
  leaveMenu.append(
    el("p", {
      style: "padding:var(--s-3) var(--s-3) var(--s-2);font:var(--t-caption);color:var(--text-3)",
      text: "Leave this room?",
    }),
    confirmLeave
  );

  const leave = el(
    "button",
    {
      class: "dock__btn dock__leave",
      type: "button",
      "aria-label": "Leave the meeting",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
    [el("span", { html: icons.leave }), el("span", { text: "Leave" })]
  ) as HTMLButtonElement;

  function closeAll(): void {
    reactionMenu.hidden = true;
    leaveMenu.hidden = true;
    reactions.setAttribute("aria-expanded", "false");
    leave.setAttribute("aria-expanded", "false");
  }

  function toggle(trigger: HTMLElement, menu: HTMLElement): void {
    const willOpen = menu.hidden;
    closeAll();
    if (willOpen) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      (menu.querySelector("button") as HTMLElement | null)?.focus();
    }
  }

  reactions.addEventListener("click", () => toggle(reactions, reactionMenu));
  leave.addEventListener("click", () => toggle(leave, leaveMenu));

  const root = el("div", { class: "dock glass-4", role: "toolbar", "aria-label": "Meeting controls" }, [
    mic,
    cam,
    screen,
    board,
    el("span", { class: "dock__divider", "aria-hidden": "true" }),
    hand,
    el("span", { style: "position:relative;display:inline-flex" }, [reactions, reactionMenu]),
    el("span", { style: "position:relative;display:inline-flex" }, [leave, leaveMenu]),
  ]);

  document.addEventListener("click", (event) => {
    if (!root.contains(event.target as Node)) closeAll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });

  return {
    root,
    setState(state) {
      // Off states read in the signal colour: whether your microphone is live
      // is worth seeing without reading a label.
      mic.innerHTML = state.mic ? icons.mic : icons.micOff;
      mic.classList.toggle("dock__btn--off", !state.mic);
      mic.setAttribute("aria-label", state.mic ? "Mute microphone" : "Unmute microphone");
      mic.setAttribute("data-tip", state.mic ? "Mute" : "Unmute");

      cam.innerHTML = state.cam ? icons.camera : icons.cameraOff;
      cam.classList.toggle("dock__btn--off", !state.cam);
      cam.setAttribute("aria-label", state.cam ? "Turn camera off" : "Turn camera on");
      cam.setAttribute("data-tip", state.cam ? "Stop video" : "Start video");

      screen.innerHTML = state.screen ? icons.screenOff : icons.screen;
      screen.setAttribute("aria-pressed", String(state.screen));
      screen.setAttribute("data-tip", state.screen ? "Stop sharing" : "Share screen");
      screen.setAttribute("aria-label", state.screen ? "Stop sharing screen" : "Share screen");

      board.setAttribute("aria-pressed", String(state.board));
      board.setAttribute("data-tip", state.board ? "Close the whiteboard" : "Whiteboard");
      board.setAttribute("aria-label", state.board ? "Close the whiteboard" : "Open the whiteboard");

      hand.setAttribute("aria-pressed", String(state.hand));
      hand.setAttribute("data-tip", state.hand ? "Lower hand" : "Raise hand");
      hand.setAttribute("aria-label", state.hand ? "Lower hand" : "Raise hand");
    },
    setScreenAvailable(available) {
      screen.disabled = !available;
      if (!available) {
        screen.setAttribute("data-tip", "Screen sharing needs a desktop browser");
      }
    },
    setMediaAllowed(allowed) {
      // Disabled rather than hidden: a control that vanishes leaves people
      // hunting for it, while a disabled one with a tooltip explains itself.
      mic.disabled = !allowed;
      cam.disabled = !allowed;
      if (!allowed) {
        const reason = "The host has turned this off for guests";
        mic.setAttribute("data-tip", reason);
        cam.setAttribute("data-tip", reason);
      }
      // setState repaints the real labels; this only clears a stale excuse.
    },
    setBoardAvailable(available) {
      // Opening the board for everyone is a moderator action; the control is
      // disabled rather than hidden so its absence is never a mystery.
      board.disabled = !available;
      if (!available) {
        board.setAttribute("data-tip", "Only the host can open the whiteboard");
      }
    },
  };
}
