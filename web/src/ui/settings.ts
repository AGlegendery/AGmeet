/**
 * Settings.
 *
 * Two menus, deliberately separate. Theme is a preference belonging to the
 * person and follows them across rooms; room policy belongs to the room and
 * only moderators see it.
 */

import { el } from "../dom";
import { icons } from "../icons";
import { currentChoice, setTheme, type ThemeChoice } from "../theme";
import type { RoomSettings } from "../types";

/** Wires a trigger to a menu, with outside-click and Escape handling. */
function popover(trigger: HTMLElement, menu: HTMLElement): HTMLElement {
  const wrap = el("div", { class: "popover" }, [trigger, menu]);
  menu.hidden = true;

  const close = (): void => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    // Close any other popover first: two open menus is never intentional.
    document.querySelectorAll(".popover__menu:not([hidden])").forEach((other) => {
      (other as HTMLElement).hidden = true;
      other.previousElementSibling?.setAttribute("aria-expanded", "false");
    });
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening) (menu.querySelector("button") as HTMLElement | null)?.focus();
  });

  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target as Node)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return wrap;
}

const THEMES: { value: ThemeChoice; label: string; icon: string }[] = [
  { value: "system", label: "Match system", icon: icons.monitor },
  { value: "light", label: "Light", icon: icons.sun },
  { value: "dark", label: "Dark", icon: icons.moon },
];

/** Where the menu is mounted, which decides which way it opens. */
export interface MenuPlacement {
  /** Mounted in the dock: a dock-sized button whose menu opens upward. */
  dock?: boolean;
}

export function buildThemeMenu(placement: MenuPlacement = {}): HTMLElement {
  const trigger = el("button", {
    class: placement.dock ? "dock__btn tip" : "icon-btn tip tip--end",
    type: "button",
    "data-tip": "Appearance",
    "aria-label": "Appearance",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: icons.settings,
  });

  const menu = el("div", {
    class: `popover__menu glass-3${placement.dock ? " dock__menu" : ""}`,
    role: "menu",
  });

  function paint(): void {
    const choice = currentChoice();
    menu.replaceChildren(
      el("p", { class: "popover__label", text: "Appearance" }),
      ...THEMES.map((option) => {
        const item = el(
          "button",
          {
            class: "menu__item",
            type: "button",
            role: "menuitemradio",
            "aria-checked": String(option.value === choice),
          },
          [
            el("span", { html: option.icon }),
            el("span", { text: option.label, style: "flex:1" }),
            ...(option.value === choice
              ? [el("span", { html: icons.check, style: "width:15px;height:15px" })]
              : []),
          ]
        );
        item.addEventListener("click", () => {
          setTheme(option.value);
          paint();
        });
        return item;
      })
    );
  }

  paint();
  return popover(trigger, menu);
}

export interface RoomMenuHandlers {
  onSettings: (patch: Partial<Pick<RoomSettings, "whiteboard" | "guestMedia" | "allowRecording">>) => void;
  onManageRoster: () => void;
}

export interface RoomMenuHandles {
  root: HTMLElement;
  setSettings: (settings: RoomSettings, canModerate: boolean) => void;
}

/**
 * The in-room menu: what the room allows, for whoever may change it.
 *
 * Policy only. Starting a recording is an action, and actions live together
 * in the dock's More menu — the same thing offered in two adjacent menus is
 * how a person ends up unsure which one is the real control.
 *
 * Mounted in the dock, under the stage, because the header states what the
 * room is; it does not operate it.
 */
export function buildRoomMenu(
  handlers: RoomMenuHandlers,
  placement: MenuPlacement = {}
): RoomMenuHandles {
  const trigger = el("button", {
    class: placement.dock ? "dock__btn tip" : "icon-btn tip tip--end",
    type: "button",
    "data-tip": "Room settings",
    "aria-label": "Room settings",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: icons.sliders,
  });

  const menu = el("div", {
    class: `popover__menu popover__menu--wide glass-3${placement.dock ? " dock__menu" : ""}`,
    role: "menu",
  });

  let settings: RoomSettings | null = null;
  let canModerate = false;

  function switchRow(
    label: string,
    hint: string,
    checked: boolean,
    onChange: (value: boolean) => void
  ): HTMLElement {
    const input = el("input", {
      class: "switch",
      type: "checkbox",
      ...(checked ? { checked: true } : {}),
    }) as HTMLInputElement;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { class: "toggle toggle--menu" }, [
      input,
      el("span", { class: "toggle__text" }, [
        el("span", { class: "field__label", style: "display:block", text: label }),
        el("span", { class: "field__hint", style: "display:block", text: hint }),
      ]),
    ]);
  }

  function paint(): void {
    const children: Node[] = [];

    if (canModerate) {
      children.push(el("p", { class: "popover__label", text: "People" }));
      const manage = el("button", { class: "menu__item", type: "button", role: "menuitem" }, [
        el("span", { html: icons.people }),
        el("span", { text: "Roles and accounts" }),
      ]);
      manage.addEventListener("click", () => {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        handlers.onManageRoster();
      });
      children.push(manage);
    }

    if (canModerate && settings) {
      const current = settings;
      children.push(el("p", { class: "popover__label", text: "Room" }));
      children.push(
        switchRow("Whiteboard", "Available on the stage.", current.whiteboard, (value) =>
          handlers.onSettings({ whiteboard: value })
        ),
        switchRow(
          "Guest camera and microphone",
          "Off makes it a lecture.",
          current.guestMedia,
          (value) => handlers.onSettings({ guestMedia: value })
        ),
        switchRow(
          "Allow others to record",
          "Each recording stays on its own machine.",
          current.allowRecording,
          (value) => handlers.onSettings({ allowRecording: value })
        )
      );
    }

    if (children.length === 0) {
      children.push(
        el("p", { class: "popover__note", text: "Nothing to configure in this room." })
      );
    }

    menu.replaceChildren(...children);
  }

  paint();
  const root = popover(trigger, menu);

  return {
    root,
    setSettings(next, moderate) {
      settings = next;
      canModerate = moderate;
      paint();
    },
  };
}
