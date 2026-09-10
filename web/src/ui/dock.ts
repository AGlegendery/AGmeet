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
  onNewPoll: () => void;
  onToggleRecording: () => void;
  onInvite: () => void;
  onLeave: () => void;
}

/** What the current participant is actually allowed to reach. */
export interface DockCapabilities {
  moderate: boolean;
  whiteboard: boolean;
  record: boolean;
  recording: boolean;
}

export interface DockHandles {
  root: HTMLElement;
  /** Where the room's settings and appearance menus mount. They belong under
   *  the stage with the other controls, not up in the header. */
  settingsSlot: HTMLElement;
  setState: (state: DockState) => void;
  setScreenAvailable: (available: boolean) => void;
  setBoardAvailable: (available: boolean) => void;
  /** A role or the room's policy can withhold each of these separately. */
  setMediaAllowed: (mic: boolean, cam: boolean) => void;
  setCapabilities: (capabilities: DockCapabilities) => void;
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

  // --- More ---------------------------------------------------------------
  // Everything a room can do that is not a per-second control lives here,
  // with words rather than icons. "Where do I start a poll" and "where is the
  // whiteboard" were fair questions when the only answer was an unlabelled
  // glyph that happened to be disabled.
  const moreMenu = el("div", {
    class: "menu glass-3 dock__menu",
    role: "menu",
    hidden: true,
  });

  const more = el("button", {
    class: "dock__btn tip",
    type: "button",
    "data-tip": "More",
    "aria-label": "More room actions",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: icons.more,
  }) as HTMLButtonElement;

  let capabilities: DockCapabilities = {
    moderate: false,
    whiteboard: false,
    record: false,
    recording: false,
  };

  function menuItem(
    label: string,
    icon: string,
    onClick: () => void,
    options: { danger?: boolean; hint?: string } = {}
  ): HTMLElement {
    const button = el(
      "button",
      {
        class: `menu__item${options.danger ? " menu__item--danger" : ""}`,
        type: "button",
        role: "menuitem",
      },
      [
        el("span", { html: icon }),
        el("span", { style: "flex:1" }, [
          el("span", { style: "display:block", text: label }),
          ...(options.hint
            ? [el("span", { class: "field__hint", style: "display:block", text: options.hint })]
            : []),
        ]),
      ]
    );
    button.addEventListener("click", () => {
      onClick();
      closeAll();
    });
    return button;
  }

  function paintMore(): void {
    const items: Node[] = [];

    if (capabilities.moderate && capabilities.whiteboard) {
      items.push(
        menuItem(boardOpen ? "Close the whiteboard" : "Open the whiteboard", icons.board, () =>
          handlers.onToggleBoard()
        )
      );
    }
    if (capabilities.moderate) {
      items.push(menuItem("Start a poll", icons.poll, () => handlers.onNewPoll()));
    }
    if (capabilities.record) {
      items.push(
        menuItem(
          capabilities.recording ? "Stop recording" : "Record the room",
          capabilities.recording ? icons.stop : icons.record,
          () => handlers.onToggleRecording(),
          { hint: capabilities.recording ? undefined : "Saved on this device only" }
        )
      );
    }
    items.push(menuItem("Copy invite link", icons.link, () => handlers.onInvite()));

    moreMenu.replaceChildren(...items);
  }

  let boardOpen = false;

  function closeAll(): void {
    reactionMenu.hidden = true;
    leaveMenu.hidden = true;
    moreMenu.hidden = true;
    reactions.setAttribute("aria-expanded", "false");
    leave.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-expanded", "false");
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
  more.addEventListener("click", () => {
    paintMore();
    toggle(more, moreMenu);
  });
  leave.addEventListener("click", () => toggle(leave, leaveMenu));

  const settingsSlot = el("span", { class: "dock__slot" });

  const root = el("div", { class: "dock glass-4", role: "toolbar", "aria-label": "Meeting controls" }, [
    mic,
    cam,
    screen,
    board,
    el("span", { class: "dock__divider", "aria-hidden": "true" }),
    hand,
    el("span", { style: "position:relative;display:inline-flex" }, [reactions, reactionMenu]),
    el("span", { style: "position:relative;display:inline-flex" }, [more, moreMenu]),
    settingsSlot,
    el("span", { style: "position:relative;display:inline-flex" }, [leave, leaveMenu]),
  ]);

  // The dock wraps to a second row when the screen is too narrow for one, so
  // the clearance the stage keeps under its tiles cannot be a fixed number.
  // The dock is the only thing that knows its own height, so it publishes it.
  new ResizeObserver(() => {
    const height = Math.round(root.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty("--dock-h", `${height}px`);
  }).observe(root);

  document.addEventListener("click", (event) => {
    if (!root.contains(event.target as Node)) closeAll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });

  return {
    root,
    settingsSlot,
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

      boardOpen = state.board;
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
    setCapabilities(next) {
      capabilities = next;
      paintMore();
    },
    setMediaAllowed(micAllowed, camAllowed) {
      // Disabled rather than hidden: a control that vanishes leaves people
      // hunting for it, while a disabled one with a tooltip explains itself.
      mic.disabled = !micAllowed;
      cam.disabled = !camAllowed;
      const reason = "Not available with your role in this room";
      if (!micAllowed) mic.setAttribute("data-tip", reason);
      if (!camAllowed) cam.setAttribute("data-tip", reason);
      // setState repaints the real labels; this only sets a stale excuse.
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
