/**
 * Sidebar and room header.
 *
 * The sidebar is room context, not a site menu: it stays narrow, quiet, and
 * the same at every width until it collapses to icons.
 */

import { el, formatDuration, hueFromName, initials } from "../dom";
import { icons } from "../icons";
import type { ConnectionState, RoomView } from "../types";

const NAV = [
  { id: "home", label: "Home", icon: icons.home },
  { id: "rooms", label: "Rooms", icon: icons.rooms },
  { id: "calendar", label: "Calendar", icon: icons.calendar },
  { id: "files", label: "Files", icon: icons.files },
] as const;

export function buildSidebar(userName: string, onNavigate: (id: string) => void): HTMLElement {
  const nav = el("nav", { class: "nav", "aria-label": "Sections" });

  NAV.forEach((item, index) => {
    const button = el(
      "button",
      {
        class: "nav__item",
        type: "button",
        "data-nav": item.id,
        ...(index === 0 ? { "aria-current": "page" } : {}),
      },
      [el("span", { html: item.icon }), el("span", { text: item.label })]
    );
    button.addEventListener("click", () => {
      nav.querySelectorAll(".nav__item").forEach((n) => n.removeAttribute("aria-current"));
      button.setAttribute("aria-current", "page");
      onNavigate(item.id);
    });
    nav.append(button);
  });

  return el("aside", { class: "sidebar glass-1" }, [
    el("div", { class: "brand" }, [
      el("span", { class: "brand__mark", html: icons.logo }),
      el("span", { class: "brand__name", text: "AGmeet" }),
    ]),
    el("div", { class: "stack", style: "gap:var(--s-2);min-height:0" }, [
      el("p", { class: "nav__label", text: "Workspace" }),
      nav,
    ]),
    el("div", { class: "stack", style: "gap:var(--s-2)" }, [
      el(
        "button",
        { class: "nav__item", type: "button", "data-nav": "settings" },
        [el("span", { html: icons.settings }), el("span", { text: "Settings" })]
      ),
      el("div", { class: "account" }, [
        el("span", {
          class: "avatar",
          style: `--hue:${hueFromName(userName)}`,
          text: initials(userName),
          "aria-hidden": "true",
        }),
        el("span", { class: "account__id" }, [
          el("span", { class: "account__name", text: userName }),
          el("span", { class: "account__status" }, [
            el("span", { class: "dot dot--online", "aria-hidden": "true" }),
            el("span", { text: "Online" }),
          ]),
        ]),
      ]),
    ]),
  ]);
}

export interface HeaderHandles {
  root: HTMLElement;
  setRoom: (room: RoomView) => void;
  setCount: (count: number) => void;
  setConnection: (state: ConnectionState) => void;
  tick: () => void;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  poor: "Weak connection",
  lost: "Connection lost",
};

export function buildHeader(onCopyLink: () => void, onTogglePanel: () => void): HeaderHandles {
  const name = el("h1", { class: "room-header__name", text: "Room" });
  const clock = el("span", { class: "num", text: "0:00" });
  const count = el("span", { text: "1 participant" });
  const live = el("span", { class: "pill pill--live" }, [
    el("span", { class: "dot dot--live", "aria-hidden": "true" }),
    el("span", { text: "Live" }),
  ]);
  const connection = el("span", { class: "link-state", "data-state": "connecting" }, [
    el("span", { html: icons.signal, style: "width:14px;height:14px" }),
    el("span", { text: CONNECTION_LABEL.connecting }),
  ]);

  let startedAt = Date.now();

  const copy = el(
    "button",
    { class: "btn btn--glass tip", type: "button", "data-tip": "Copy invite link" },
    [el("span", { html: icons.link }), el("span", { text: "Invite" })]
  );
  copy.addEventListener("click", onCopyLink);

  const panelToggle = el("button", {
    class: "icon-btn tip",
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

  const root = el("header", { class: "room-header glass-1" }, [
    el("div", { class: "room-header__id" }, [
      name,
      el("div", { class: "room-header__meta" }, [live, clock, count]),
    ]),
    el("div", { class: "room-header__actions" }, [connection, copy, panelToggle]),
  ]);

  return {
    root,
    setRoom(room) {
      name.textContent = room.name;
      startedAt = room.startedAt;
    },
    setCount(value) {
      count.textContent = value === 1 ? "1 participant" : `${value} participants`;
    },
    setConnection(state) {
      connection.setAttribute("data-state", state);
      (connection.lastElementChild as HTMLElement).textContent = CONNECTION_LABEL[state];
    },
    tick() {
      clock.textContent = formatDuration(Date.now() - startedAt);
    },
  };
}
