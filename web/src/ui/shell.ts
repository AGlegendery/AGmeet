/**
 * The room header.
 *
 * There is no sidebar. Home, Rooms and your account are decisions you make
 * before entering a room, so they live in the dashboard; once you are inside,
 * the only thing left to configure is the room, and that belongs here next to
 * its name. The stage gets the space the sidebar used to take.
 */

import { el, formatDuration } from "../dom";
import { icons } from "../icons";
import type { ConnectionState, RoomView } from "../types";

export interface HeaderHandles {
  root: HTMLElement;
  /** Slot for the room-settings and appearance menus. */
  actions: HTMLElement;
  setRoom: (room: RoomView) => void;
  setCount: (count: number) => void;
  setConnection: (state: ConnectionState) => void;
  setRecording: (active: boolean) => void;
  setKnocking: (count: number) => void;
  tick: () => void;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  poor: "Weak connection",
  lost: "Connection lost",
};

export function buildHeader(
  onCopyLink: () => void,
  onTogglePanel: () => void,
  onShowKnocks: () => void
): HeaderHandles {
  const name = el("h1", { class: "room-header__name", text: "Room" });
  const clock = el("span", { class: "num", text: "0:00" });
  const count = el("span", { text: "1 participant" });

  const live = el("span", { class: "pill pill--live" }, [
    el("span", { class: "dot dot--live", "aria-hidden": "true" }),
    el("span", { text: "Live" }),
  ]);

  // Recording is a room-wide fact, so it is stated next to the room's name
  // rather than hidden in the menu that started it.
  const recording = el("span", { class: "pill pill--rec", hidden: true }, [
    el("span", { class: "dot dot--rec", "aria-hidden": "true" }),
    el("span", { text: "Recording" }),
  ]);

  const lock = el("span", { class: "pill", hidden: true });

  const connection = el("span", { class: "link-state", "data-state": "connecting" }, [
    el("span", { html: icons.signal, style: "width:14px;height:14px" }),
    el("span", { text: CONNECTION_LABEL.connecting }),
  ]);

  // Only appears when somebody is actually at the door.
  // Named at creation, not only once somebody knocks: a control that exists
  // in the document without an accessible name is one an assistive technology
  // can reach and cannot describe.
  const knocks = el("button", {
    class: "btn btn--glass knocks tip tip--end",
    type: "button",
    hidden: true,
    "aria-label": "People waiting to join",
    "data-tip": "Someone is waiting to join",
  }) as HTMLButtonElement;
  knocks.addEventListener("click", onShowKnocks);

  const copy = el(
    "button",
    { class: "btn btn--glass tip tip--end", type: "button", "data-tip": "Copy invite link" },
    [el("span", { html: icons.link }), el("span", { text: "Invite" })]
  );
  copy.addEventListener("click", onCopyLink);

  const panelToggle = el("button", {
    class: "icon-btn tip tip--end",
    type: "button",
    "data-tip": "Toggle panel",
    "aria-label": "Toggle side panel",
    "aria-expanded": "true",
    html: icons.chevronRight,
  });
  panelToggle.addEventListener("click", () => {
    const open = panelToggle.getAttribute("aria-expanded") === "true";
    panelToggle.setAttribute("aria-expanded", String(!open));
    onTogglePanel();
  });

  const actions = el("div", { class: "room-header__menus" });

  const root = el("header", { class: "room-header glass-1" }, [
    el("span", { class: "brand__mark brand__mark--sm", html: icons.logo, "aria-hidden": "true" }),
    el("div", { class: "room-header__id" }, [
      name,
      el("div", { class: "room-header__meta" }, [live, recording, lock, clock, count]),
    ]),
    el("div", { class: "room-header__actions" }, [
      connection,
      knocks,
      copy,
      actions,
      panelToggle,
    ]),
  ]);

  let startedAt = Date.now();

  return {
    root,
    actions,
    setRoom(room) {
      name.textContent = room.name;
      startedAt = room.startedAt;
      // The door policy is worth stating: it explains why people are or are
      // not arriving without anyone opening a menu.
      if (room.lock === "open") {
        lock.hidden = true;
      } else {
        lock.hidden = false;
        lock.replaceChildren(
          el("span", { html: room.lock === "passcode" ? icons.lock : icons.doorbell,
                       style: "width:12px;height:12px" }),
          el("span", { text: room.lock === "passcode" ? "Passcode" : "Approval" })
        );
      }
    },
    setCount(value) {
      count.textContent = value === 1 ? "1 participant" : `${value} participants`;
    },
    setConnection(state) {
      connection.setAttribute("data-state", state);
      (connection.lastElementChild as HTMLElement).textContent = CONNECTION_LABEL[state];
    },
    setRecording(active) {
      recording.hidden = !active;
    },
    setKnocking(waiting) {
      knocks.hidden = waiting === 0;
      knocks.replaceChildren(
        el("span", { html: icons.doorbell }),
        el("span", { text: waiting === 1 ? "1 waiting" : `${waiting} waiting` })
      );
    },
    tick() {
      clock.textContent = formatDuration(Date.now() - startedAt);
    },
  };
}
