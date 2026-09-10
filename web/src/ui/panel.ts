/**
 * Context panel: chat and participants.
 *
 * A secondary workspace. It uses the same design system as the stage but one
 * glass level shallower, so it never competes for attention, and it collapses
 * away completely when it is not wanted.
 */

import { el, formatClock, hueFromName, initials } from "../dom";
import { icons } from "../icons";
import { formatDuration } from "../dom";
import type { ChatMessage, ModAction, Participant, ParticipantId, Role } from "../types";

export interface Knock {
  id: ParticipantId;
  name: string;
  since: number;
}

export interface PanelHandlers {
  onSend: (body: string) => void;
  onModerate: (target: ParticipantId, action: ModAction) => void;
  /** Reopens a poll from its notice in the chat. */
  onOpenPoll: (poll: string) => void;
  onAdmit: (id: ParticipantId) => void;
  onDeny: (id: ParticipantId) => void;
}

export interface PanelHandles {
  root: HTMLElement;
  setPollCount: (count: number) => void;
  setKnocks: (knocks: Knock[]) => void;
  addMessage: (message: ChatMessage, selfId: ParticipantId) => void;
  setHistory: (messages: ChatMessage[], selfId: ParticipantId) => void;
  setParticipants: (
    participants: Participant[],
    selfId: ParticipantId,
    selfRole: Role,
    speaking: (id: ParticipantId) => boolean
  ) => void;
  showTab: (tab: "chat" | "people" | "polls") => void;
  unreadBump: () => void;
}

const ROLE_LABEL: Record<Role, string> = { host: "Host", moderator: "Moderator", guest: "" };

export function buildPanel(handlers: PanelHandlers, pollsView: HTMLElement): PanelHandles {
  // --- Chat --------------------------------------------------------------
  const messages = el("div", { class: "chat scroll", role: "log", "aria-label": "Chat messages" });
  const chatEmpty = el("div", { class: "state" }, [
    el("span", { class: "state__mark", html: icons.chat }),
    el("p", { class: "state__title", text: "No messages yet" }),
    el("p", { class: "state__body", text: "Ask a question or drop a link. Everyone in the room sees it." }),
  ]);
  messages.append(chatEmpty);

  const input = el("textarea", {
    rows: 1,
    placeholder: "Write a message",
    "aria-label": "Message",
  }) as HTMLTextAreaElement;

  const send = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Send message",
    html: icons.send,
  }) as HTMLButtonElement;
  send.disabled = true;

  function submit(): void {
    const body = input.value.trim();
    if (!body) return;
    handlers.onSend(body);
    input.value = "";
    input.style.height = "auto";
    send.disabled = true;
  }

  input.addEventListener("input", () => {
    send.disabled = input.value.trim().length === 0;
    // Grow with the content up to the CSS max-height, then scroll.
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  send.addEventListener("click", submit);

  const composer = el("div", { class: "composer glass-2" }, [
    input,
    el("button", {
      class: "icon-btn",
      type: "button",
      "aria-label": "Attach a file",
      title: "Attachments are not enabled on this deployment",
      html: icons.attach,
      disabled: true,
    }),
    send,
  ]);

  const chatView = el("div", { class: "panel__view", role: "tabpanel", "aria-label": "Chat" }, [
    messages,
    composer,
  ]);

  // --- Participants ------------------------------------------------------
  const waiting = el("div", { class: "waiting", hidden: true });
  const people = el("div", { class: "people scroll", role: "list", "aria-label": "Participants" });
  const peopleView = el("div", { class: "panel__view", role: "tabpanel", "aria-label": "Participants" }, [
    el("div", { class: "people__scroll scroll" }, [waiting, people]),
  ]);
  peopleView.setAttribute("aria-hidden", "true");

  // --- Tabs --------------------------------------------------------------
  const chatCount = el("span", { class: "tab__count", text: "" });
  const peopleCount = el("span", { class: "tab__count", text: "1" });

  const pollCount = el("span", { class: "tab__count", text: "" });

  const chatTab = el("button", { class: "tab", type: "button", role: "tab", "aria-selected": "true" }, [
    el("span", { text: "Chat" }),
    chatCount,
  ]);
  const peopleTab = el("button", { class: "tab", type: "button", role: "tab", "aria-selected": "false" }, [
    el("span", { text: "People" }),
    peopleCount,
  ]);
  const pollsTab = el("button", { class: "tab", type: "button", role: "tab", "aria-selected": "false" }, [
    el("span", { text: "Polls" }),
    pollCount,
  ]);

  let unread = 0;
  let active: "chat" | "people" | "polls" = "chat";

  function showTab(tab: "chat" | "people" | "polls"): void {
    active = tab;
    for (const [button, view, name] of [
      [chatTab, chatView, "chat"],
      [peopleTab, peopleView, "people"],
      [pollsTab, pollsView, "polls"],
    ] as const) {
      button.setAttribute("aria-selected", String(tab === name));
      view.setAttribute("aria-hidden", String(tab !== name));
    }
    if (tab === "chat") {
      unread = 0;
      chatCount.textContent = "";
      messages.scrollTop = messages.scrollHeight;
    }
  }

  chatTab.addEventListener("click", () => showTab("chat"));
  peopleTab.addEventListener("click", () => showTab("people"));
  pollsTab.addEventListener("click", () => showTab("polls"));

  const root = el("aside", { class: "panel glass-2", "aria-label": "Meeting context" }, [
    el("div", { class: "panel__tabs", role: "tablist" }, [chatTab, peopleTab, pollsTab]),
    el("div", { class: "panel__body" }, [chatView, peopleView, pollsView]),
  ]);

  // --- Message rendering -------------------------------------------------
  let lastAuthor: ParticipantId | null = null;
  let lastAt = 0;

  function renderMessage(message: ChatMessage, selfId: ParticipantId): HTMLElement {
    // Group consecutive messages from one author within two minutes.
    const grouped = message.from === lastAuthor && message.at - lastAt < 120_000;
    lastAuthor = message.from;
    lastAt = message.at;

    // A poll announces itself in the chat so the notice outlives the popup,
    // reaches late joiners, and gives somebody a way back in to change their
    // answer while the poll is still open.
    if (message.kind === "pollStarted" && message.poll) {
      const pollId = message.poll;
      const card = el("button", { class: "msg-poll", type: "button" }, [
        el("span", { class: "msg-poll__mark", html: icons.poll }),
        el("span", { class: "msg-poll__id" }, [
          el("span", { class: "msg-poll__title", text: "A poll is started" }),
          el("span", { class: "msg-poll__q", text: message.body }),
        ]),
        el("span", { class: "msg-poll__go", text: "Answer" }),
      ]);
      card.addEventListener("click", () => handlers.onOpenPoll(pollId));
      lastAuthor = null;
      return el("div", { class: "msg msg--notice" }, [card]);
    }

    if (message.kind === "pollResults") {
      lastAuthor = null;
      return el("div", { class: "msg msg--notice" }, [
        el("div", { class: "msg-results" }, [
          el("span", { class: "msg-poll__mark", html: icons.poll }),
          el("p", { class: "msg-results__body", text: message.body }),
        ]),
      ]);
    }

    const classes = ["msg"];
    if (grouped) classes.push("msg--continued");
    if (message.role === "host") classes.push("msg--host");
    if (message.from === selfId) classes.push("msg--self");

    return el("div", { class: classes.join(" ") }, [
      el("span", {
        class: "avatar",
        style: `--hue:${hueFromName(message.author)}`,
        text: initials(message.author),
        "aria-hidden": "true",
      }),
      el("div", {}, [
        el("div", { class: "msg__head" }, [
          el("span", { class: "msg__author", text: message.author }),
          el("span", { class: "msg__time num", text: formatClock(message.at) }),
        ]),
        // textContent: chat is user input and must never be parsed as markup.
        el("p", { class: "msg__body", text: message.body }),
      ]),
    ]);
  }

  function appendMessage(message: ChatMessage, selfId: ParticipantId): void {
    chatEmpty.remove();
    // Only auto-scroll when the reader is already at the bottom; yanking the
    // view away while someone reads history is the classic chat annoyance.
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    messages.append(renderMessage(message, selfId));
    if (atBottom) messages.scrollTop = messages.scrollHeight;

    if (active !== "chat" && message.from !== selfId) {
      unread += 1;
      chatCount.textContent = String(unread);
    }
  }

  // --- Participant rendering ---------------------------------------------
  let openMenu: HTMLElement | null = null;

  function closeMenu(): void {
    openMenu?.remove();
    openMenu = null;
    document.querySelectorAll('.person__menu[aria-expanded="true"]').forEach((node) =>
      node.setAttribute("aria-expanded", "false")
    );
  }

  document.addEventListener("click", (event) => {
    if (openMenu && !openMenu.contains(event.target as Node)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  function moderationMenu(participant: Participant, selfRole: Role, trigger: HTMLElement): HTMLElement {
    const menu = el("div", { class: "menu glass-3", role: "menu" });

    const item = (label: string, icon: string, action: ModAction, danger = false): void => {
      const button = el(
        "button",
        {
          class: `menu__item${danger ? " menu__item--danger" : ""}`,
          type: "button",
          role: "menuitem",
        },
        [el("span", { html: icon }), el("span", { text: label })]
      );
      button.addEventListener("click", () => {
        handlers.onModerate(participant.id, action);
        closeMenu();
      });
      menu.append(button);
    };

    if (participant.mic) item("Ask to mute", icons.micOff, "requestMute");
    if (selfRole === "host") {
      if (participant.role === "moderator") {
        item("Remove moderator", icons.shield, "demoteModerator");
      } else {
        item("Make moderator", icons.shield, "promoteModerator");
      }
    }
    item("Remove from room", icons.leave, "remove", true);

    trigger.setAttribute("aria-expanded", "true");
    return menu;
  }

  function renderPerson(
    participant: Participant,
    selfId: ParticipantId,
    selfRole: Role,
    isSpeaking: boolean
  ): HTMLElement {
    const isSelf = participant.id === selfId;
    const label = ROLE_LABEL[participant.role];

    const media = el("div", { class: "person__media" }, [
      el("span", {
        class: participant.mic ? "" : "is-off",
        html: participant.mic ? icons.mic : icons.micOff,
        "aria-label": participant.mic ? "Microphone on" : "Microphone off",
        role: "img",
      }),
      el("span", {
        class: participant.cam ? "" : "is-off",
        html: participant.cam ? icons.camera : icons.cameraOff,
        "aria-label": participant.cam ? "Camera on" : "Camera off",
        role: "img",
      }),
    ]);

    const row = el(
      "div",
      {
        class: `person${isSpeaking ? " person--speaking" : ""}`,
        role: "listitem",
      },
      [
        el("span", {
          class: "avatar",
          style: `--hue:${hueFromName(participant.name)}`,
          text: initials(participant.name),
          "aria-hidden": "true",
        }),
        el("span", { class: "person__id" }, [
          el("span", { class: "person__name" }, [
            el("span", { text: isSelf ? `${participant.name} (you)` : participant.name }),
            ...(participant.hand
              ? [el("span", { html: icons.hand, style: "width:14px;height:14px;color:#ffd88a" })]
              : []),
          ]),
          ...(label ? [el("span", { class: "person__role", text: label })] : []),
        ]),
        media,
      ]
    );

    // Moderation is contextual: the trigger only exists for someone who can
    // act, and the actions themselves stay hidden until the row is engaged.
    const canModerate =
      (selfRole === "host" || selfRole === "moderator") && !isSelf && participant.role !== "host";

    if (canModerate) {
      const trigger = el("button", {
        class: "icon-btn person__menu",
        type: "button",
        "aria-label": `Actions for ${participant.name}`,
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        html: icons.more,
      });
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const wasOpen = trigger.getAttribute("aria-expanded") === "true";
        closeMenu();
        if (wasOpen) return;
        const menu = moderationMenu(participant, selfRole, trigger);
        row.append(menu);
        openMenu = menu;
      });
      media.append(trigger);
    }

    return row;
  }

  return {
    root,
    addMessage: appendMessage,
    setHistory(history, selfId) {
      lastAuthor = null;
      lastAt = 0;
      messages.replaceChildren();
      if (history.length === 0) {
        messages.append(chatEmpty);
        return;
      }
      for (const message of history) messages.append(renderMessage(message, selfId));
      messages.scrollTop = messages.scrollHeight;
    },
    setParticipants(participants, selfId, selfRole, speaking) {
      closeMenu();
      peopleCount.textContent = String(participants.length);
      people.replaceChildren(
        ...participants.map((participant) =>
          renderPerson(participant, selfId, selfRole, speaking(participant.id))
        )
      );
    },
    showTab,
    setPollCount(count) {
      pollCount.textContent = count > 0 ? String(count) : "";
    },
    setKnocks(list) {
      waiting.hidden = list.length === 0;
      if (list.length === 0) {
        waiting.replaceChildren();
        return;
      }
      waiting.replaceChildren(
        el("p", { class: "waiting__label", text: list.length === 1 ? "Waiting to join" : `${list.length} waiting to join` }),
        ...list.map((knock) => {
          const admit = el("button", { class: "btn btn--accent", type: "button" }, [
            el("span", { text: "Admit" }),
          ]);
          admit.addEventListener("click", () => handlers.onAdmit(knock.id));
          const deny = el("button", { class: "btn", type: "button" }, [el("span", { text: "Deny" })]);
          deny.addEventListener("click", () => handlers.onDeny(knock.id));

          return el("div", { class: "waiting__row" }, [
            el("span", {
              class: "avatar",
              style: `--hue:${hueFromName(knock.name)}`,
              text: initials(knock.name),
              "aria-hidden": "true",
            }),
            el("span", { class: "person__id" }, [
              el("span", { class: "person__name", text: knock.name }),
              el("span", {
                class: "person__role num",
                // Shows a real wait, so a moderator joining late does not see
                // a queue that all looks like it arrived a second ago.
                text: `waiting ${formatDuration(Date.now() - knock.since)}`,
              }),
            ]),
            el("span", { class: "waiting__acts" }, [deny, admit]),
          ]);
        })
      );
    },
    unreadBump() {
      if (active !== "chat") {
        unread += 1;
        chatCount.textContent = String(unread);
      }
    },
  };
}
