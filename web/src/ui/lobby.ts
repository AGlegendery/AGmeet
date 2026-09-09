/**
 * Pre-join screen.
 *
 * Everything that can go wrong with a camera goes wrong here, where it is
 * cheap to fix, rather than in front of a room full of people. The preview is
 * live, the device pickers are real, and the join button says what will
 * happen.
 */

import { el, generateRoomId } from "../dom";
import { icons } from "../icons";
import {
  acquireLocalStream,
  isSecureContextForMedia,
  listDevices,
  MediaError,
  stopStream,
} from "../media";

export interface LobbyResult {
  room: string;
  roomName: string;
  name: string;
  classroom: boolean;
  mic: boolean;
  cam: boolean;
  cameraId?: string;
  microphoneId?: string;
  stream: MediaStream | null;
}

const NAME_KEY = "agmeet.name";

export function buildLobby(
  roomFromUrl: string | null,
  onJoin: (result: LobbyResult) => void
): HTMLElement {
  let stream: MediaStream | null = null;
  let wantMic = true;
  let wantCam = true;
  let cameraId: string | undefined;
  let microphoneId: string | undefined;

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

  const preview = el("div", { class: "lobby__preview" }, [
    video,
    previewState,
    el("div", { class: "lobby__preview-controls glass-4" }, [micToggle, camToggle]),
  ]);
  video.hidden = true;

  // --- Form --------------------------------------------------------------
  const nameInput = el("input", {
    class: "input",
    type: "text",
    id: "agmeet-name",
    maxlength: "64",
    autocomplete: "name",
    placeholder: "Your name",
    value: localStorage.getItem(NAME_KEY) ?? "",
  }) as HTMLInputElement;

  const nameError = el("p", { class: "field__error", hidden: true, id: "agmeet-name-error" });

  const roomInput = el("input", {
    class: "input",
    type: "text",
    id: "agmeet-room",
    maxlength: "64",
    placeholder: "Room code",
    value: roomFromUrl ?? generateRoomId(),
    readonly: roomFromUrl !== null,
  }) as HTMLInputElement;

  const cameraSelect = el("select", {
    class: "select",
    id: "agmeet-camera",
    "aria-label": "Camera",
  }) as HTMLSelectElement;
  const micSelect = el("select", {
    class: "select",
    id: "agmeet-mic",
    "aria-label": "Microphone",
  }) as HTMLSelectElement;

  const classroom = el("input", {
    class: "switch",
    type: "checkbox",
    id: "agmeet-classroom",
  }) as HTMLInputElement;

  const joinButton = el("button", { class: "btn btn--accent btn--lg btn--block", type: "submit" }, [
    el("span", { text: roomFromUrl ? "Join room" : "Create room" }),
  ]) as HTMLButtonElement;

  const notice = el("p", { class: "field__hint", hidden: true });

  // --- Device handling ---------------------------------------------------
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
        select.append(el("option", { value: "" }, [document.createTextNode(`No ${fallback.toLowerCase()} found`)]));
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
        const failure = result.errors.find((e) => e.kind === "camera");
        showPreviewState("Camera unavailable", failure?.message, true);
      } else if (!hasVideo) {
        showPreviewState("Camera is off", "Your microphone is still live.");
      }

      if (result.errors.length > 0) {
        notice.hidden = false;
        notice.textContent = result.errors.map((e) => e.message).join(" ");
      } else {
        notice.hidden = true;
      }

      await refreshDevices();
    } catch (error) {
      const message =
        error instanceof MediaError ? error.message : "Your devices could not be started.";
      showPreviewState("Devices unavailable", message, true);
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

  // --- Submit ------------------------------------------------------------
  const form = el("form", { class: "lobby__form" }, [
    el("div", {}, [
      el("h1", { class: "lobby__title", text: roomFromUrl ? "Join the room" : "Start a room" }),
      el("p", {
        class: "lobby__sub",
        text: roomFromUrl
          ? "Check your camera and microphone before you go in."
          : "Create a room, then send the link to whoever should be there.",
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "agmeet-name", text: "Display name" }),
      nameInput,
      nameError,
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "agmeet-room", text: "Room code" }),
      roomInput,
      el("p", {
        class: "field__hint",
        text: roomFromUrl
          ? "You were invited to this room."
          : "Anyone with this code and the address of this server can join.",
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "agmeet-camera", text: "Camera" }),
      cameraSelect,
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "agmeet-mic", text: "Microphone" }),
      micSelect,
    ]),
    ...(roomFromUrl
      ? []
      : [
          el("label", { class: "toggle", for: "agmeet-classroom" }, [
            classroom,
            el("span", { class: "toggle__text" }, [
              el("span", { class: "field__label", style: "display:block", text: "Classroom mode" }),
              el("span", {
                class: "field__hint",
                style: "display:block;margin-top:2px",
                text: "Gives the teacher priority on the stage and moderation over the room.",
              }),
            ]),
          ]),
        ]),
    notice,
    joinButton,
  ]) as HTMLFormElement;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameError.hidden = false;
      nameError.textContent = "Enter a name so people know who joined.";
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.setAttribute("aria-describedby", "agmeet-name-error");
      nameInput.focus();
      return;
    }
    const room = roomInput.value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
      notice.hidden = false;
      notice.textContent = "Room codes use letters, numbers, dashes and underscores only.";
      roomInput.focus();
      return;
    }

    localStorage.setItem(NAME_KEY, name);
    joinButton.disabled = true;
    joinButton.replaceChildren(el("span", { text: "Connecting" }));

    onJoin({
      room,
      roomName: room,
      name,
      classroom: classroom.checked,
      mic: wantMic && (stream?.getAudioTracks().length ?? 0) > 0,
      cam: wantCam && (stream?.getVideoTracks().length ?? 0) > 0,
      cameraId,
      microphoneId,
      stream,
    });
  });

  paintToggles();
  void start();

  return el("main", { class: "lobby" }, [
    el("div", { class: "lobby__card glass-2" }, [preview, form]),
  ]);
}
