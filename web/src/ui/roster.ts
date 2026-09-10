/**
 * Roles and accounts.
 *
 * A role template is a named set of capabilities; an account is a username
 * and password granted one of those templates. The same editor runs in the
 * dashboard, where it edits a list that has not been created yet, and inside
 * a room, where every change goes to the server — the only difference is
 * where `onChange` sends things.
 */

import { el } from "../dom";
import { icons } from "../icons";
import type { AccountSpec, AccountView, Capability, RoleTemplate } from "../types";

const CAP_LABELS: { key: keyof Capability; label: string; hint: string }[] = [
  { key: "mic", label: "Microphone", hint: "Can speak" },
  { key: "cam", label: "Camera", hint: "Can be seen" },
  { key: "screen", label: "Present", hint: "Share a screen or slides" },
  { key: "board", label: "Whiteboard", hint: "Draw even when the board is locked" },
  { key: "chat", label: "Chat", hint: "Can post messages" },
  { key: "upload", label: "Attachments", hint: "Can attach files" },
  { key: "moderate", label: "Run the room", hint: "Admit people, mute, poll, record" },
];

export interface RosterHandlers {
  onSaveTemplate: (template: RoleTemplate) => void;
  onDeleteTemplate: (id: string) => void;
  onSaveAccount: (account: AccountSpec) => void;
  onDeleteAccount: (username: string) => void;
}

export interface RosterHandles {
  root: HTMLElement;
  set: (templates: RoleTemplate[], accounts: AccountView[]) => void;
}

const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || `role-${Date.now().toString(36)}`;

export function buildRoster(handlers: RosterHandlers): RosterHandles {
  let templates: RoleTemplate[] = [];
  let accounts: AccountView[] = [];

  const templateList = el("div", { class: "roster__list" });
  const accountList = el("div", { class: "roster__list" });

  // --- New role ----------------------------------------------------------
  const roleName = el("input", {
    class: "input",
    type: "text",
    maxlength: "40",
    placeholder: "Role name",
    "aria-label": "Role name",
  }) as HTMLInputElement;

  const caps: Partial<Record<keyof Capability, HTMLInputElement>> = {};
  const capGrid = el(
    "div",
    { class: "roster__caps" },
    CAP_LABELS.map(({ key, label, hint }) => {
      const input = el("input", { class: "switch", type: "checkbox" }) as HTMLInputElement;
      caps[key] = input;
      return el("label", { class: "toggle toggle--menu" }, [
        input,
        el("span", { class: "toggle__text" }, [
          el("span", { class: "field__label", style: "display:block", text: label }),
          el("span", { class: "field__hint", style: "display:block", text: hint }),
        ]),
      ]);
    })
  );

  const addRole = el("button", { class: "btn btn--glass btn--block", type: "button" }, [
    el("span", { html: icons.plus }),
    el("span", { text: "Add role" }),
  ]);

  function readCaps(): Capability {
    return {
      mic: caps.mic?.checked ?? false,
      cam: caps.cam?.checked ?? false,
      screen: caps.screen?.checked ?? false,
      board: caps.board?.checked ?? false,
      chat: caps.chat?.checked ?? true,
      upload: caps.upload?.checked ?? false,
      moderate: caps.moderate?.checked ?? false,
    };
  }

  addRole.addEventListener("click", () => {
    const name = roleName.value.trim();
    if (!name) {
      roleName.focus();
      return;
    }
    handlers.onSaveTemplate({ id: slug(name), name, builtin: false, ...readCaps() });
    roleName.value = "";
    for (const input of Object.values(caps)) input.checked = false;
    if (caps.chat) caps.chat.checked = true;
  });

  // --- New account -------------------------------------------------------
  const username = el("input", {
    class: "input",
    type: "text",
    maxlength: "64",
    autocomplete: "off",
    placeholder: "Username",
    "aria-label": "Username",
  }) as HTMLInputElement;

  const password = el("input", {
    class: "input",
    type: "text",
    maxlength: "128",
    autocomplete: "off",
    placeholder: "Password",
    "aria-label": "Password",
  }) as HTMLInputElement;

  const roleSelect = el("select", { class: "select", "aria-label": "Role" }) as HTMLSelectElement;

  const addAccount = el("button", { class: "btn btn--accent btn--block", type: "button" }, [
    el("span", { html: icons.plus }),
    el("span", { text: "Add account" }),
  ]);

  addAccount.addEventListener("click", () => {
    const user = username.value.trim();
    if (!user || !password.value.trim() || !roleSelect.value) {
      (user ? password : username).focus();
      return;
    }
    handlers.onSaveAccount({ username: user, password: password.value, role: roleSelect.value });
    username.value = "";
    password.value = "";
    username.focus();
  });

  // --- Rendering ---------------------------------------------------------
  function capSummary(template: RoleTemplate): string {
    const on = CAP_LABELS.filter(({ key }) => template[key]).map(({ label }) => label);
    return on.length === 0 ? "Nothing" : on.join(" · ");
  }

  function render(): void {
    templateList.replaceChildren(
      ...templates.map((template) => {
        const row = el("div", { class: "roster__row" }, [
          el("span", { class: "roster__id" }, [
            el("span", { class: "roster__name" }, [
              el("span", { text: template.name }),
              ...(template.builtin
                ? [el("span", { class: "pill", text: "built-in" })]
                : []),
            ]),
            el("span", { class: "roster__meta", text: capSummary(template) }),
          ]),
        ]);
        if (!template.builtin) {
          const remove = el("button", {
            class: "icon-btn",
            type: "button",
            "aria-label": `Delete the ${template.name} role`,
            html: icons.trash,
          });
          remove.addEventListener("click", () => handlers.onDeleteTemplate(template.id));
          row.append(remove);
        }
        return row;
      })
    );

    roleSelect.replaceChildren(
      ...templates.map((template) =>
        el("option", { value: template.id }, [document.createTextNode(template.name)])
      )
    );
    // Presenter is the useful default: an operator is rarely what you are
    // handing out in bulk.
    roleSelect.value = templates.some((t) => t.id === "presenter") ? "presenter" : roleSelect.value;

    accountList.replaceChildren(
      ...(accounts.length === 0
        ? [el("p", { class: "field__hint", text: "No accounts yet. Anyone with the link is turned away." })]
        : accounts.map((account) => {
            const remove = el("button", {
              class: "icon-btn",
              type: "button",
              "aria-label": `Delete the account ${account.username}`,
              html: icons.trash,
            });
            remove.addEventListener("click", () => handlers.onDeleteAccount(account.username));
            return el("div", { class: "roster__row" }, [
              el("span", { class: "roster__id" }, [
                el("span", { class: "roster__name", text: account.username }),
                el("span", { class: "roster__meta", text: account.roleName }),
              ]),
              remove,
            ]);
          }))
    );
  }

  const root = el("div", { class: "roster" }, [
    el("section", { class: "roster__section" }, [
      el("h3", { class: "roster__title", text: "Roles" }),
      templateList,
      el("details", { class: "roster__new" }, [
        el("summary", { text: "New role" }),
        el("div", { class: "stack", style: "gap:var(--s-3);padding-top:var(--s-3)" }, [
          roleName,
          capGrid,
          addRole,
        ]),
      ]),
    ]),
    el("section", { class: "roster__section" }, [
      el("h3", { class: "roster__title", text: "Accounts" }),
      el("p", {
        class: "field__hint",
        text: "Each account signs in with its own username and password, and gets whatever its role allows.",
      }),
      accountList,
      el("div", { class: "stack", style: "gap:var(--s-2);padding-top:var(--s-3)" }, [
        username,
        password,
        roleSelect,
        addAccount,
      ]),
    ]),
  ]);

  render();

  return {
    root,
    set(nextTemplates, nextAccounts) {
      templates = nextTemplates;
      accounts = nextAccounts;
      render();
    },
  };
}

/** The built-ins, mirrored so the dashboard can show them before a room exists. */
export const BUILTIN_TEMPLATES: RoleTemplate[] = [
  { id: "operator", name: "Operator", builtin: true, mic: true, cam: true, screen: true, board: true, chat: true, upload: true, moderate: true },
  { id: "presenter", name: "Presenter", builtin: true, mic: true, cam: true, screen: true, board: false, chat: true, upload: false, moderate: false },
  { id: "attendee", name: "Attendee", builtin: true, mic: true, cam: true, screen: false, board: false, chat: true, upload: false, moderate: false },
  { id: "viewer", name: "Viewer", builtin: true, mic: false, cam: false, screen: false, board: false, chat: true, upload: false, moderate: false },
];
