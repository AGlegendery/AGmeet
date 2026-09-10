/**
 * The dashboard: everything you decide *before* entering a room.
 *
 * Home and Rooms live here rather than in the meeting sidebar, because none
 * of it is a decision you make while a class is running. A room is entered by
 * link or by code; once you are inside, the only thing left to configure is
 * the room itself, and that belongs in its header.
 */

import { el, generateRoomId } from "../dom";
import { icons } from "../icons";
import type { CreateOptions, RoomLock } from "../types";
import { buildThemeMenu } from "./settings";

const NAME_KEY = "agmeet.name";
const RECENT_KEY = "agmeet.recent";

export interface EnterRequest {
  room: string;
  name: string;
  /** Present only when opening a new room. */
  create?: CreateOptions;
}

interface Recent {
  room: string;
  label: string;
  at: number;
}

export function rememberRoom(room: string, label: string): void {
  try {
    const list: Recent[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    const next = [{ room, label, at: Date.now() }, ...list.filter((r) => r.room !== room)];
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, 8)));
  } catch {
    // A corrupt or unavailable store is not worth failing a join over.
  }
}

function recentRooms(): Recent[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? (list as Recent[]).filter((r) => typeof r?.room === "string") : [];
  } catch {
    return [];
  }
}

export function buildDashboard(onEnter: (request: EnterRequest) => void): HTMLElement {
  let section: "home" | "rooms" = "home";

  // --- Identity ----------------------------------------------------------
  const nameInput = el("input", {
    class: "input",
    type: "text",
    id: "dash-name",
    maxlength: "64",
    autocomplete: "name",
    placeholder: "Your name",
    value: localStorage.getItem(NAME_KEY) ?? "",
  }) as HTMLInputElement;

  const nameError = el("p", { class: "field__error", hidden: true });

  function displayName(): string | null {
    const value = nameInput.value.trim();
    if (!value) {
      nameError.hidden = false;
      nameError.textContent = "Enter a name so people know who joined.";
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
      return null;
    }
    nameError.hidden = true;
    nameInput.removeAttribute("aria-invalid");
    localStorage.setItem(NAME_KEY, value);
    return value;
  }

  // --- Join by code ------------------------------------------------------
  const codeInput = el("input", {
    class: "input",
    type: "text",
    id: "dash-code",
    maxlength: "64",
    placeholder: "Room code, or paste a link",
    "aria-label": "Room code",
  }) as HTMLInputElement;

  const codeError = el("p", { class: "field__error", hidden: true });

  /** Accepts a bare code or a full room URL, so a pasted link just works. */
  function normaliseCode(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const fromUrl = trimmed.match(/\/r\/([A-Za-z0-9_-]{1,64})/);
    const candidate = fromUrl ? fromUrl[1] : trimmed;
    return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : null;
  }

  const joinForm = el("form", { class: "stack", style: "gap:var(--s-3)" }, [
    el("label", { class: "field__label", for: "dash-code", text: "Room code" }),
    codeInput,
    codeError,
    el("button", { class: "btn btn--accent btn--lg btn--block", type: "submit" }, [
      el("span", { html: icons.rooms }),
      el("span", { text: "Join room" }),
    ]),
  ]) as HTMLFormElement;

  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const room = normaliseCode(codeInput.value);
    if (!room) {
      codeError.hidden = false;
      codeError.textContent = "That is not a room code. Codes use letters, numbers and dashes.";
      codeInput.focus();
      return;
    }
    codeError.hidden = true;
    const name = displayName();
    if (name) onEnter({ room, name });
  });

  // --- Create a room -----------------------------------------------------
  const roomName = el("input", {
    class: "input",
    type: "text",
    id: "dash-roomname",
    maxlength: "80",
    placeholder: "Physics — period 3",
    "aria-label": "Room name",
  }) as HTMLInputElement;

  const roomCode = el("input", {
    class: "input",
    type: "text",
    id: "dash-roomcode",
    maxlength: "64",
    value: generateRoomId(),
    "aria-label": "Room code",
  }) as HTMLInputElement;

  const regenerate = el("button", {
    class: "icon-btn tip tip--end",
    type: "button",
    "data-tip": "New code",
    "aria-label": "Generate a new room code",
    html: icons.refresh,
  });
  regenerate.addEventListener("click", () => {
    roomCode.value = generateRoomId();
  });

  const toggle = (
    id: string,
    label: string,
    hint: string,
    checked: boolean
  ): { row: HTMLElement; input: HTMLInputElement } => {
    const input = el("input", {
      class: "switch",
      type: "checkbox",
      id,
      ...(checked ? { checked: true } : {}),
    }) as HTMLInputElement;
    const row = el("label", { class: "toggle", for: id }, [
      input,
      el("span", { class: "toggle__text" }, [
        el("span", { class: "field__label", style: "display:block", text: label }),
        el("span", { class: "field__hint", style: "display:block;margin-top:2px", text: hint }),
      ]),
    ]);
    return { row, input };
  };

  const classroom = toggle(
    "opt-classroom",
    "Classroom mode",
    "Teacher priority on the stage, and the whiteboard starts locked to them.",
    false
  );
  const whiteboard = toggle(
    "opt-whiteboard",
    "Whiteboard",
    "A shared board the host can put on the stage at any point.",
    true
  );
  const guestMedia = toggle(
    "opt-guestmedia",
    "Guests may use camera and microphone",
    "Turn this off for a lecture where only the host speaks. It is enforced by the server, not just hidden.",
    true
  );
  const allowRecording = toggle(
    "opt-recording",
    "Allow others to record",
    "Recording always happens on the recorder's own machine. Nothing is stored on the server.",
    false
  );

  // --- Access ------------------------------------------------------------
  const passcode = el("input", {
    class: "input",
    type: "text",
    id: "opt-passcode",
    maxlength: "128",
    autocomplete: "off",
    placeholder: "Passcode",
    "aria-label": "Room passcode",
  }) as HTMLInputElement;

  const passcodeField = el("div", { class: "field", hidden: true }, [
    el("label", { class: "field__label", for: "opt-passcode", text: "Passcode" }),
    passcode,
    el("p", {
      class: "field__hint",
      text: "Everyone joining is asked for this. It is hashed on the server and never stored in the clear.",
    }),
  ]);

  const LOCKS: { value: RoomLock; label: string; hint: string }[] = [
    { value: "open", label: "Open", hint: "Anyone with the link walks in." },
    { value: "passcode", label: "Passcode", hint: "A shared code is required." },
    { value: "approval", label: "Ask to join", hint: "You admit each person by hand." },
  ];

  let lock: RoomLock = "open";
  const lockHint = el("p", { class: "field__hint", text: LOCKS[0].hint });
  const lockButtons = LOCKS.map((option) => {
    const button = el(
      "button",
      {
        class: "segment",
        type: "button",
        role: "radio",
        "aria-checked": String(option.value === lock),
      },
      [el("span", { text: option.label })]
    );
    button.addEventListener("click", () => {
      lock = option.value;
      lockButtons.forEach((b, i) => b.setAttribute("aria-checked", String(LOCKS[i].value === lock)));
      lockHint.textContent = option.hint;
      passcodeField.hidden = lock !== "passcode";
      if (lock === "passcode") passcode.focus();
    });
    return button;
  });

  const createForm = el("form", { class: "stack", style: "gap:var(--s-5)" }, [
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "dash-roomname", text: "Room name" }),
      roomName,
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "dash-roomcode", text: "Room code" }),
      el("div", { class: "row", style: "gap:var(--s-2)" }, [roomCode, regenerate]),
      el("p", { class: "field__hint", text: "This becomes the link you share." }),
    ]),
    el("div", { class: "field" }, [
      el("span", { class: "field__label", text: "Who can enter" }),
      el("div", { class: "segments", role: "radiogroup", "aria-label": "Who can enter" }, lockButtons),
      lockHint,
    ]),
    passcodeField,
    el("div", { class: "stack", style: "gap:var(--s-4)" }, [
      classroom.row,
      whiteboard.row,
      guestMedia.row,
      allowRecording.row,
    ]),
    el("button", { class: "btn btn--accent btn--lg btn--block", type: "submit" }, [
      el("span", { html: icons.plus }),
      el("span", { text: "Create room" }),
    ]),
  ]) as HTMLFormElement;

  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const room = normaliseCode(roomCode.value);
    if (!room) {
      roomCode.focus();
      return;
    }
    if (lock === "passcode" && !passcode.value.trim()) {
      passcode.focus();
      return;
    }
    const name = displayName();
    if (!name) return;
    onEnter({
      room,
      name,
      create: {
        roomName: roomName.value.trim() || room,
        classroom: classroom.input.checked,
        whiteboard: whiteboard.input.checked,
        guestMedia: guestMedia.input.checked,
        allowRecording: allowRecording.input.checked,
        lock,
        ...(lock === "passcode" ? { passcode: passcode.value.trim() } : {}),
      },
    });
  });

  // --- Recent ------------------------------------------------------------
  function recentList(): HTMLElement {
    const rooms = recentRooms();
    if (rooms.length === 0) {
      return el("p", { class: "field__hint", text: "Rooms you join will show up here." });
    }
    return el(
      "div",
      { class: "recents", role: "list" },
      rooms.map((entry) => {
        const button = el("button", { class: "recent", type: "button", role: "listitem" }, [
          el("span", { class: "recent__mark", html: icons.rooms }),
          el("span", { class: "recent__id" }, [
            el("span", { class: "recent__name", text: entry.label || entry.room }),
            el("span", { class: "recent__code num", text: entry.room }),
          ]),
          el("span", { class: "recent__go", html: icons.chevronRight }),
        ]);
        button.addEventListener("click", () => {
          const name = displayName();
          if (name) onEnter({ room: entry.room, name });
        });
        return button;
      })
    );
  }

  // --- Shell -------------------------------------------------------------
  const body = el("div", { class: "dash__body" });

  function render(): void {
    body.replaceChildren(
      section === "home"
        ? el("div", { class: "dash__grid" }, [
            el("section", { class: "dash__card glass-2" }, [
              el("h2", { class: "dash__card-title", text: "Start a room" }),
              el("p", {
                class: "dash__card-sub",
                text: "Open a room, choose who can enter, then send the link.",
              }),
              createForm,
            ]),
            el("div", { class: "stack", style: "gap:var(--s-5);min-width:0" }, [
              el("section", { class: "dash__card glass-2" }, [
                el("h2", { class: "dash__card-title", text: "Join a room" }),
                el("p", {
                  class: "dash__card-sub",
                  text: "Paste a link or type the code you were given.",
                }),
                joinForm,
              ]),
              el("section", { class: "dash__card glass-2" }, [
                el("h2", { class: "dash__card-title", text: "Recent" }),
                recentList(),
              ]),
            ]),
          ])
        : el("div", { class: "dash__single" }, [
            el("section", { class: "dash__card glass-2" }, [
              el("h2", { class: "dash__card-title", text: "Join a room" }),
              el("p", {
                class: "dash__card-sub",
                text: "Paste a link or type the code you were given.",
              }),
              joinForm,
            ]),
            el("section", { class: "dash__card glass-2" }, [
              el("h2", { class: "dash__card-title", text: "Recent" }),
              recentList(),
            ]),
          ])
    );
  }

  const tabs = (["home", "rooms"] as const).map((id) => {
    const button = el(
      "button",
      { class: "dash__tab", type: "button", "aria-current": id === section ? "page" : null },
      [
        el("span", { html: id === "home" ? icons.home : icons.rooms }),
        el("span", { text: id === "home" ? "Home" : "Rooms" }),
      ]
    );
    button.addEventListener("click", () => {
      section = id;
      tabs.forEach((b, i) =>
        b.setAttribute("aria-current", (["home", "rooms"] as const)[i] === section ? "page" : "false")
      );
      render();
    });
    return button;
  });

  render();

  return el("main", { class: "dash" }, [
    el("header", { class: "dash__head" }, [
      el("div", { class: "brand" }, [
        el("span", { class: "brand__mark", html: icons.logo }),
        el("span", { class: "brand__name", text: "AGmeet" }),
      ]),
      el("nav", { class: "dash__tabs", "aria-label": "Sections" }, tabs),
      el("div", { class: "dash__head-end" }, [
        el("div", { class: "field", style: "min-width:200px" }, [nameInput, nameError]),
        buildThemeMenu(),
      ]),
    ]),
    body,
  ]);
}
