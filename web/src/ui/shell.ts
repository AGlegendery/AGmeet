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
import type { LinkStrength } from "../rtc";
import type { ConnectionState, RoomView } from "../types";

export interface HeaderHandles {
  root: HTMLElement;
  setRoom: (room: RoomView) => void;
  setCount: (count: number) => void;
  setConnection: (state: ConnectionState, strength?: LinkStrength) => void;
  setRecording: (active: boolean) => void;
  setKnocking: (count: number) => void;
  setPanelOpen: (open: boolean) => void;
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

  // Three bars and the numbers behind them. "Connected" on its own does not
  // tell anybody whether their call is about to fall over.
  const bars = el("span", { class: "bars", "aria-hidden": "true" }, [
    el("i", {}),
    el("i", {}),
    el("i", {}),
  ]);
  const connectionLabel = el("span", { text: CONNECTION_LABEL.connecting });
  const connection = el("span", { class: "link-state", "data-state": "connecting", "data-bars": "3" }, [
    bars,
    connectionLabel,
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
  // The header does not own the panel's state; it reports the click and is
  // told the outcome, so a shortcut that opens the panel keeps it in step.
  panelToggle.addEventListener("click", () => onTogglePanel());

  /**
   * On a phone the header cannot hold the connection state, an invite button
   * and two menus — measured, that row is 417px wide inside a 390px viewport,
   * and because a flex row will not shrink below its content it dragged the
   * whole grid column off-screen. So the layout transforms: those controls
   * move into a sheet behind one button, and move back on a wide screen.
   * The nodes are relocated, not duplicated, so their listeners survive.
   */
  const sheet = el("div", { class: "popover__menu popover__menu--wide glass-3", role: "menu", hidden: true });
  const overflowTrigger = el("button", {
    class: "icon-btn header-more",
    type: "button",
    "aria-label": "Room actions",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: icons.more,
  });
  const overflow = el("div", { class: "popover header-more-wrap" }, [overflowTrigger, sheet]);

  overflowTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = sheet.hidden;
    sheet.hidden = !opening;
    overflowTrigger.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", (event) => {
    if (!overflow.contains(event.target as Node)) {
      sheet.hidden = true;
      overflowTrigger.setAttribute("aria-expanded", "false");
    }
  });

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
      overflow,
      panelToggle,
    ]),
  ]);

  // --- Responsive relocation ---------------------------------------------
  const narrow = window.matchMedia("(max-width: 720px)");
  const row = root.querySelector(".room-header__actions") as HTMLElement;
  /** Moved into the sheet on a phone, in this order. */
  const relocatable = [connection, copy];

  function applyViewport(): void {
    if (narrow.matches) {
      for (const node of relocatable) {
        if (node.parentElement !== sheet) sheet.append(node);
      }
    } else {
      sheet.hidden = true;
      overflowTrigger.setAttribute("aria-expanded", "false");
      // Put them back in their original order, before the overflow button.
      for (const node of relocatable) {
        if (node.parentElement !== row) row.insertBefore(node, overflow);
      }
    }
  }
  narrow.addEventListener("change", applyViewport);
  applyViewport();

  // On a phone the context panel is a sheet over the stage, and it has to
  // start below this header — covering it takes away the only control that
  // closes the sheet, and there is no keyboard to escape with. The header is
  // the only thing that knows how tall it ended up, so it says so.
  new ResizeObserver(() => {
    const height = Math.round(root.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty("--header-live-h", `${height}px`);
  }).observe(root);

  let startedAt = Date.now();

  return {
    root,
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
    setConnection(state, strength) {
      connection.setAttribute("data-state", state);
      const level = state === "connected" ? (strength?.bars ?? 3) : state === "poor" ? 1 : 0;
      connection.setAttribute("data-bars", String(level));

      let label = CONNECTION_LABEL[state];
      if (state === "connected" && strength) {
        const parts: string[] = [];
        if (strength.rttMs !== null) parts.push(`${strength.rttMs} ms`);
        if (strength.lossPercent > 0) parts.push(`${strength.lossPercent}% loss`);
        if (parts.length > 0) label = parts.join(" · ");
        else if (level === 3) label = "Strong";
      }
      connectionLabel.textContent = label;
      connection.setAttribute("aria-label", `Connection: ${CONNECTION_LABEL[state]}, ${label}`);
    },
    setRecording(active) {
      recording.hidden = !active;
    },
    setPanelOpen(open) {
      panelToggle.setAttribute("aria-expanded", String(open));
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
