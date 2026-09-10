/**
 * The lobby: the moment between choosing a room and being in it.
 *
 * Everything that can go wrong with a camera goes wrong here, where it is
 * cheap to fix, rather than in front of a room full of people. It also owns
 * the door: a passcode challenge, or waiting for a moderator, happens on this
 * screen rather than dropping someone into an error page.
 */

import { el } from "../dom";
import { icons } from "../icons";
import {
  acquireLocalStream,
  isSecureContextForMedia,
  listDevices,
  MediaError,
  stopStream,
} from "../media";
import type { CreateOptions, RoomLock } from "../types";
import { buildThemeMenu } from "./settings";

export interface LobbyRequest {
  room: string;
  name: string;
  create?: CreateOptions;
}

export interface LobbyResult {
  room: string;
  name: string;
  create?: CreateOptions;
  username?: string;
  password?: string;
  mic: boolean;
  cam: boolean;
  cameraId?: string;
  microphoneId?: string;
  stream: MediaStream | null;
}

/** What the room told us about itself before anyone tried to enter. */
interface RoomInfo {
  exists: boolean;
  name: string | null;
  lock: RoomLock | null;
  participants: number;
  waiting: number;
}

export type LobbyState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "passcode"; retry: boolean }
  | { kind: "signIn"; retry: boolean }
  | { kind: "knocking" }
  | { kind: "denied"; reason: string }
  | { kind: "missing" };

export interface LobbyHandlers {
  onJoin: (result: LobbyResult) => void;
  onPasscode: (passcode: string) => void;
  onSignIn: (username: string, password: string) => void;
  onBack: () => void;
}

export interface LobbyHandles {
  root: HTMLElement;
  setState: (state: LobbyState) => void;
}

export function buildLobby(
  request: LobbyRequest,
  handlers: LobbyHandlers,
  onSurfaces?: (previewRoot: HTMLElement, controls: HTMLElement) => void
): LobbyHandles {
  let stream: MediaStream | null = null;
  let wantMic = true;
  let wantCam = true;
  let cameraId: string | undefined;
  let microphoneId: string | undefined;
  let info: RoomInfo | null = null;
  let state: LobbyState = { kind: "idle" };

  // --- Preview -----------------------------------------------------------
  const video = el("video", { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
  video.muted = true;

  const previewState = el("div", { class: "state", style: "padding:var(--s-6)" }, [
    el("span", { class: "state__mark", html: icons.camera }),
    el("p", { class: "state__title", text: "Starting your camera" }),
  ]);

  const micToggle = el("button", {
    class: "dock__btn tip",
    type: "button",
    "data-tip": "Microphone",
    "aria-label": "Microphone",
    html: icons.mic,
  }) as HTMLButtonElement;

  const camToggle = el("button", {
    class: "dock__btn tip",
    type: "button",
    "data-tip": "Camera",
    "aria-label": "Camera",
    html: icons.camera,
  }) as HTMLButtonElement;

  const previewControls = el("div", { class: "lobby__preview-controls glass-4" }, [
    micToggle,
    camToggle,
  ]);
  const preview = el("div", { class: "lobby__preview" }, [video, previewState, previewControls]);
  video.hidden = true;

  // --- Devices -----------------------------------------------------------
  const cameraSelect = el("select", {
    class: "select",
    id: "lobby-camera",
    "aria-label": "Camera",
  }) as HTMLSelectElement;
  const micSelect = el("select", {
    class: "select",
    id: "lobby-mic",
    "aria-label": "Microphone",
  }) as HTMLSelectElement;

  const notice = el("p", { class: "field__hint", hidden: true });

  function paintToggles(): void {
    micToggle.innerHTML = wantMic ? icons.mic : icons.micOff;
    micToggle.classList.toggle("dock__btn--off", !wantMic);
    micToggle.setAttribute("aria-pressed", String(wantMic));
    micToggle.setAttribute("data-tip", wantMic ? "Microphone on" : "Microphone off");

    camToggle.innerHTML = wantCam ? icons.camera : icons.cameraOff;
    camToggle.classList.toggle("dock__btn--off", !wantCam);
    camToggle.setAttribute("aria-pressed", String(wantCam));
    camToggle.setAttribute("data-tip", wantCam ? "Camera on" : "Camera off");
  }

  function showPreviewState(title: string, body?: string, error = false): void {
    previewState.className = `state${error ? " state--error" : ""}`;
    previewState.style.padding = "var(--s-6)";
    previewState.replaceChildren(
      el("span", { class: "state__mark", html: error ? icons.alert : icons.cameraOff }),
      el("p", { class: "state__title", text: title }),
      ...(body ? [el("p", { class: "state__body", text: body })] : [])
    );
    previewState.hidden = false;
    video.hidden = true;
  }

  async function refreshDevices(): Promise<void> {
    const { cameras, microphones } = await listDevices();
    const fill = (select: HTMLSelectElement, devices: MediaDeviceInfo[], fallback: string): void => {
      const previous = select.value;
      select.replaceChildren(
        ...devices.map((device, index) =>
          el("option", { value: device.deviceId }, [
            document.createTextNode(device.label || `${fallback} ${index + 1}`),
          ])
        )
      );
      if (devices.length === 0) {
        select.append(
          el("option", { value: "" }, [document.createTextNode(`No ${fallback.toLowerCase()} found`)])
        );
        select.disabled = true;
      } else {
        select.disabled = false;
        if (previous && devices.some((d) => d.deviceId === previous)) select.value = previous;
      }
    };
    fill(cameraSelect, cameras, "Camera");
    fill(micSelect, microphones, "Microphone");
  }

  async function start(): Promise<void> {
    stopStream(stream);
    stream = null;
    video.srcObject = null;

    if (!wantMic && !wantCam) {
      showPreviewState(
        "Joining without camera or microphone",
        "You can turn them on at any point once you are in the room."
      );
      return;
    }
    if (!isSecureContextForMedia()) {
      showPreviewState(
        "This page is not a secure context",
        "Browsers only release the camera and microphone over HTTPS, or on localhost. See the README for a TLS setup.",
        true
      );
      return;
    }

    try {
      const result = await acquireLocalStream({
        cameraId,
        microphoneId,
        wantVideo: wantCam,
        wantAudio: wantMic,
      });
      stream = result.stream;

      const hasVideo = stream.getVideoTracks().length > 0;
      video.srcObject = hasVideo ? stream : null;
      video.hidden = !hasVideo;
      previewState.hidden = hasVideo;

      if (!hasVideo && wantCam) {
        showPreviewState("Camera unavailable", result.errors.find((e) => e.kind === "camera")?.message, true);
      } else if (!hasVideo) {
        showPreviewState("Camera is off", "Your microphone is still live.");
      }

      notice.hidden = result.errors.length === 0;
      notice.textContent = result.errors.map((e) => e.message).join(" ");
      await refreshDevices();
    } catch (error) {
      showPreviewState(
        "Devices unavailable",
        error instanceof MediaError ? error.message : "Your devices could not be started.",
        true
      );
    }
  }

  micToggle.addEventListener("click", () => {
    wantMic = !wantMic;
    paintToggles();
    void start();
  });
  camToggle.addEventListener("click", () => {
    wantCam = !wantCam;
    paintToggles();
    void start();
  });
  cameraSelect.addEventListener("change", () => {
    cameraId = cameraSelect.value || undefined;
    void start();
  });
  micSelect.addEventListener("change", () => {
    microphoneId = micSelect.value || undefined;
    void start();
  });

  // --- The door ----------------------------------------------------------
  const passcodeInput = el("input", {
    class: "input",
    type: "password",
    id: "lobby-passcode",
    autocomplete: "off",
    placeholder: "Passcode",
    "aria-label": "Room passcode",
  }) as HTMLInputElement;

  const passcodeError = el("p", { class: "field__error", hidden: true });
  const passcodeField = el("div", { class: "field", hidden: true }, [
    el("label", { class: "field__label", for: "lobby-passcode", text: "Passcode" }),
    passcodeInput,
    passcodeError,
  ]);

  // Signing in with an account: the account decides what you may do once
  // inside, so this is not the same thing as a shared passcode.
  const usernameInput = el("input", {
    class: "input",
    type: "text",
    id: "lobby-username",
    autocomplete: "username",
    placeholder: "Username",
    "aria-label": "Username",
  }) as HTMLInputElement;

  const passwordInput = el("input", {
    class: "input",
    type: "password",
    id: "lobby-password",
    autocomplete: "current-password",
    placeholder: "Password",
    "aria-label": "Password",
  }) as HTMLInputElement;

  const signInError = el("p", { class: "field__error", hidden: true });
  const signInField = el("div", { class: "stack", style: "gap:var(--s-3)", hidden: true }, [
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "lobby-username", text: "Username" }),
      usernameInput,
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "lobby-password", text: "Password" }),
      passwordInput,
      signInError,
    ]),
  ]);

  const title = el("h1", { class: "lobby__title", text: "Join the room" });
  const subtitle = el("p", { class: "lobby__sub", text: "Check your camera and microphone before you go in." });
  const doorState = el("div", { class: "lobby__door", hidden: true });

  const action = el("button", { class: "btn btn--accent btn--lg btn--block", type: "submit" }, [
    el("span", { text: "Join the room" }),
  ]) as HTMLButtonElement;

  const back = el("button", { class: "btn btn--block", type: "button" }, [
    el("span", { html: icons.chevronRight, style: "transform:rotate(180deg)" }),
    el("span", { text: "Back" }),
  ]);
  back.addEventListener("click", () => {
    stopStream(stream);
    handlers.onBack();
  });

  /** The label is the promise: approval rooms do not say "Join". */
  function actionLabel(): string {
    if (request.create) return "Create and enter";
    if (info?.lock === "approval") return "Ask to join the room";
    if (info?.lock === "accounts" || state.kind === "signIn") return "Sign in and join";
    return "Join the room";
  }

  function paintDoor(): void {
    passcodeField.hidden = !(state.kind === "passcode" || (info?.lock === "passcode" && !request.create));
    signInField.hidden = !(state.kind === "signIn" || (info?.lock === "accounts" && !request.create));
    action.disabled = state.kind === "connecting" || state.kind === "knocking";

    switch (state.kind) {
      case "connecting":
        action.replaceChildren(el("span", { text: "Connecting" }));
        doorState.hidden = true;
        break;
      case "knocking":
        action.replaceChildren(el("span", { text: "Waiting to be let in" }));
        doorState.hidden = false;
        doorState.replaceChildren(
          el("div", { class: "lobby__waiting" }, [
            el("span", { class: "spinner", "aria-hidden": "true" }),
            el("div", {}, [
              el("p", { class: "field__label", text: "A moderator has been asked" }),
              el("p", {
                class: "field__hint",
                text: "You will go straight in when they let you. Keep this tab open.",
              }),
            ]),
          ])
        );
        break;
      case "passcode":
        action.replaceChildren(el("span", { text: actionLabel() }));
        doorState.hidden = true;
        passcodeError.hidden = !state.retry;
        passcodeError.textContent = state.retry ? "That passcode was not right." : "";
        passcodeInput.focus();
        break;
      case "signIn":
        action.replaceChildren(el("span", { text: actionLabel() }));
        doorState.hidden = true;
        signInError.hidden = !state.retry;
        // Deliberately does not say which half was wrong.
        signInError.textContent = state.retry ? "That username and password did not match." : "";
        (usernameInput.value ? passwordInput : usernameInput).focus();
        break;
      case "denied":
        action.replaceChildren(el("span", { text: actionLabel() }));
        doorState.hidden = false;
        doorState.replaceChildren(
          el("div", { class: "state state--error", style: "padding:var(--s-4);height:auto" }, [
            el("span", { class: "state__mark", html: icons.alert }),
            el("p", { class: "state__title", text: "Not admitted" }),
            el("p", { class: "state__body", text: state.reason }),
          ])
        );
        break;
      case "missing":
        action.disabled = true;
        action.replaceChildren(el("span", { text: "Room not open" }));
        doorState.hidden = false;
        doorState.replaceChildren(
          el("div", { class: "state", style: "padding:var(--s-4);height:auto" }, [
            el("span", { class: "state__mark", html: icons.rooms }),
            el("p", { class: "state__title", text: "This room has not started" }),
            el("p", {
              class: "state__body",
              text: "Nobody has opened it yet. Wait for the host, or go back and start it yourself.",
            }),
          ])
        );
        break;
      default:
        action.replaceChildren(el("span", { text: actionLabel() }));
        doorState.hidden = true;
        break;
    }
  }

  /** Asks the server what this room is before offering to enter it. */
  async function loadInfo(): Promise<void> {
    if (request.create) {
      paintDoor();
      return;
    }
    try {
      const response = await fetch(`/api/room/${encodeURIComponent(request.room)}`);
      info = (await response.json()) as RoomInfo;
    } catch {
      info = null;
    }
    if (info && !info.exists) {
      state = { kind: "missing" };
    } else if (info?.name) {
      title.textContent = info.name;
      subtitle.textContent =
        info.participants === 1
          ? "One person is already in the room."
          : `${info.participants} people are already in the room.`;
    }
    paintDoor();
  }

  const form = el("form", { class: "lobby__form" }, [
    el("div", {}, [title, subtitle]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "lobby-camera", text: "Camera" }),
      cameraSelect,
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "lobby-mic", text: "Microphone" }),
      micSelect,
    ]),
    passcodeField,
    signInField,
    notice,
    doorState,
    action,
    back,
  ]) as HTMLFormElement;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.kind === "missing" || state.kind === "knocking") return;

    // A challenge the server raised is answered on the socket that raised it.
    // The very first attempt has no socket yet, so it goes through the normal
    // join with the credentials attached.
    if (state.kind === "signIn") {
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (!username || !password) {
        (username ? passwordInput : usernameInput).focus();
        return;
      }
      handlers.onSignIn(username, password);
      return;
    }

    // A passcode challenge is answered on the socket that asked for it.
    if (state.kind === "passcode") {
      const value = passcodeInput.value.trim();
      if (!value) {
        passcodeInput.focus();
        return;
      }
      handlers.onPasscode(value);
      return;
    }

    const signingIn = signInField.hidden === false;
    const username = usernameInput.value.trim();
    if (signingIn && (!username || !passwordInput.value)) {
      (username ? passwordInput : usernameInput).focus();
      return;
    }

    handlers.onJoin({
      room: request.room,
      // An account names the person: signing in as `mamad` should not also
      // require typing a display name somewhere else.
      name: signingIn ? username : request.name,
      create: request.create,
      ...(signingIn ? { username, password: passwordInput.value } : {}),
      mic: wantMic && (stream?.getAudioTracks().length ?? 0) > 0,
      cam: wantCam && (stream?.getVideoTracks().length ?? 0) > 0,
      cameraId,
      microphoneId,
      stream,
      ...(passcodeInput.value.trim() ? { passcode: passcodeInput.value.trim() } : {}),
    } as LobbyResult);
  });

  paintToggles();
  void start();
  void loadInfo();
  onSurfaces?.(preview, previewControls);

  const root = el("main", { class: "lobby" }, [
    el("div", { class: "lobby__top" }, [buildThemeMenu()]),
    el("div", { class: "lobby__card glass-2" }, [preview, form]),
  ]);

  return {
    root,
    setState(next) {
      state = next;
      paintDoor();
    },
  };
}
