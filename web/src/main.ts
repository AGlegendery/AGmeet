/**
 * Application entry point.
 *
 * Two views: the lobby, then the meeting. Everything below wires the
 * signalling socket, the peer mesh and the interface together; none of these
 * modules know about each other directly.
 */

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/views.css";

import { el, prefersReducedMotion, qs } from "./dom";
import { icons } from "./icons";
import {
  acquireLocalStream,
  acquireScreenStream,
  MediaError,
  SpeechDetector,
  stopStream,
} from "./media";
import { PeerMesh } from "./rtc";
import { Signaling } from "./signaling";
import type {
  ConnectionState,
  ModAction,
  Participant,
  ParticipantId,
  Role,
  RoomView,
} from "./types";
import { buildDock } from "./ui/dock";
import { buildLobby, type LobbyResult } from "./ui/lobby";
import { buildPanel } from "./ui/panel";
import { buildHeader, buildSidebar } from "./ui/shell";
import { Stage } from "./ui/stage";
import { toast } from "./ui/toast";

const app = qs("#app");

/** Room comes from /r/<code> or ?room=<code>; both make a shareable link. */
function roomFromLocation(): string | null {
  const path = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (path) return path[1];
  const query = new URLSearchParams(location.search).get("room");
  return query && /^[A-Za-z0-9_-]{1,64}$/.test(query) ? query : null;
}

function showLobby(): void {
  app.replaceChildren(buildLobby(roomFromLocation(), (result) => startMeeting(result)));
}

function startMeeting(config: LobbyResult): void {
  // ---------------------------------------------------------------- state
  let selfId: ParticipantId = "";
  let selfRole: Role = "guest";
  let participants: Participant[] = [];
  let localStream: MediaStream | null = config.stream;
  let screenStream: MediaStream | null = null;
  let micOn = config.mic;
  let camOn = config.cam;
  let handUp = false;

  const remoteAudio = new Map<ParticipantId, HTMLAudioElement>();
  const audioHost = el("div", { "aria-hidden": "true", style: "display:none" });

  // ------------------------------------------------------------------ url
  // Make the address shareable the moment the meeting starts.
  history.replaceState(null, "", `/r/${config.room}`);

  const inviteUrl = `${location.origin}/r/${config.room}`;

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast("Invite link copied");
    } catch {
      // Clipboard access is refused in some contexts; show the link instead
      // of failing silently.
      toast(inviteUrl);
    }
  }

  // ---------------------------------------------------------------- pieces
  const stage = new Stage({ onInvite: () => void copyInvite() });
  const header = buildHeader(
    () => void copyInvite(),
    () => togglePanel()
  );
  const panel = buildPanel({
    onSend: (body) => signaling.send({ t: "chat", body }),
    onModerate: (target, action) => moderate(target, action),
  });
  const dock = buildDock({
    onToggleMic: () => toggleMic(),
    onToggleCam: () => toggleCam(),
    onToggleScreen: () => void toggleScreen(),
    onToggleHand: () => toggleHand(),
    onReaction: (kind) => signaling.send({ t: "reaction", kind }),
    onLeave: () => leave(),
  });

  const reactionLayer = el("div", { class: "reactions", "aria-hidden": "true" });
  stage.root.append(dock.root, reactionLayer);

  const shell = el("div", { class: "app", "data-panel": "open" }, [
    buildSidebar(config.name, (section) => {
      if (section !== "home" && section !== "rooms") {
        toast("That section is not part of this build yet");
      }
    }),
    el("div", { class: "meeting" }, [header.root, stage.root]),
    panel.root,
    audioHost,
  ]);

  app.replaceChildren(shell);

  dock.setScreenAvailable(typeof navigator.mediaDevices?.getDisplayMedia === "function");
  dock.setState({ mic: micOn, cam: camOn, screen: false, hand: false });

  function togglePanel(): void {
    const open = shell.dataset.panel === "open";
    shell.dataset.panel = open ? "closed" : "open";
  }

  // ------------------------------------------------------------------ mesh
  const mesh = new PeerMesh([], {
    onTrack: (id, slot, stream) => stage.setStream(id, slot, stream),
    onAudio: (id, stream) => attachRemoteAudio(id, stream),
    onQuality: () => refreshConnectionState(),
    onSignal: (to, payload) => signaling.send({ t: "signal", to, payload }),
  });
  mesh.setLocalStream(localStream);

  /**
   * Remote audio plays through a dedicated element per peer, kept outside the
   * tile. Tiles are reordered as the grid adapts, and moving a <video> in the
   * DOM interrupts its audio.
   */
  function attachRemoteAudio(id: ParticipantId, stream: MediaStream): void {
    let audio = remoteAudio.get(id);
    if (!audio) {
      audio = el("audio", { autoplay: true }) as HTMLAudioElement;
      remoteAudio.set(id, audio);
      audioHost.append(audio);
    }
    audio.srcObject = stream;
    void audio.play().catch(() => {
      // Autoplay can be blocked until the page has been interacted with; the
      // join click normally satisfies that, and the next click will retry.
    });
  }

  // ------------------------------------------------------------- signalling
  const signaling = new Signaling({
    room: config.room,
    roomName: config.roomName,
    name: config.name,
    classroom: config.classroom,
    mic: micOn,
    cam: camOn,
  });

  let socketState: ConnectionState = "connecting";

  function refreshConnectionState(): void {
    // The header shows one status. A degraded peer matters more than a
    // healthy socket, so peer quality wins when the socket is fine.
    if (socketState !== "connected") {
      header.setConnection(socketState);
      return;
    }
    const quality = mesh.worstQuality();
    header.setConnection(quality === "good" ? "connected" : quality === "poor" ? "poor" : "lost");
  }

  signaling.onState((state) => {
    socketState = state;
    refreshConnectionState();
    if (state === "reconnecting") toast("Connection dropped. Reconnecting.", "error");
    if (state === "lost") toast("Could not reconnect. Reload to rejoin.", "error");
  });

  signaling.onMessage((message) => {
    switch (message.t) {
      case "welcome": {
        selfId = message.you;
        mesh.setIceServers(message.iceServers);
        stage.setSelf(selfId);
        applyRoom(message.room);
        stage.setStream(selfId, "camera", camOn ? localStream : null);
        panel.setHistory(message.room.chat, selfId);
        // Existing peers send the offers; open the connections and wait.
        for (const participant of message.room.participants) {
          if (participant.id !== selfId) void mesh.connect(participant.id, false);
        }
        break;
      }

      case "joined": {
        participants = [...participants, message.participant];
        applyParticipants();
        // We were here first, so we make the offer.
        void mesh.connect(message.participant.id, true);
        toast(`${message.participant.name} joined`);
        break;
      }

      case "left": {
        const gone = participants.find((p) => p.id === message.id);
        participants = participants.filter((p) => p.id !== message.id);
        mesh.disconnect(message.id);
        remoteAudio.get(message.id)?.remove();
        remoteAudio.delete(message.id);
        applyParticipants();
        if (gone) toast(`${gone.name} left`);
        break;
      }

      case "signal":
        void mesh.handleSignal(message.from, message.payload);
        break;

      case "chat":
        panel.addMessage(message.message, selfId);
        break;

      case "media": {
        participants = participants.map((p) =>
          p.id === message.id
            ? { ...p, mic: message.mic, cam: message.cam, screen: message.screen, hand: message.hand }
            : p
        );
        applyParticipants();
        break;
      }

      case "reaction":
        showReaction(message.id, message.kind);
        break;

      case "roleChanged": {
        participants = participants.map((p) =>
          p.id === message.id ? { ...p, role: message.role } : p
        );
        if (message.id === selfId) {
          selfRole = message.role;
          toast(
            message.role === "host"
              ? "You are now hosting this room"
              : message.role === "moderator"
                ? "You can now moderate this room"
                : "Your moderator rights were removed"
          );
        }
        applyParticipants();
        break;
      }

      case "moderated":
        handleModerated(message.action, message.by);
        break;

      case "error":
        toast(message.message, "error");
        break;

      default:
        break;
    }
  });

  signaling.connect();

  // ------------------------------------------------------------------ room
  function applyRoom(room: RoomView): void {
    header.setRoom(room);
    document.title = `${room.name} — AGmeet`;
    participants = room.participants;
    selfRole = participants.find((p) => p.id === selfId)?.role ?? "guest";
    applyParticipants();
  }

  function applyParticipants(): void {
    stage.setParticipants(participants);
    header.setCount(participants.length);
    panel.setParticipants(participants, selfId, selfRole, (id) => stage.isSpeaking(id));
  }

  function publishMedia(): void {
    signaling.updateJoinState(micOn, camOn);
    signaling.send({
      t: "media",
      mic: micOn,
      cam: camOn,
      screen: screenStream !== null,
      hand: handUp,
    });
    // Reflect locally at once rather than waiting for the echo, so the tile
    // never lags behind the button.
    participants = participants.map((p) =>
      p.id === selfId
        ? { ...p, mic: micOn, cam: camOn, screen: screenStream !== null, hand: handUp }
        : p
    );
    applyParticipants();
    dock.setState({ mic: micOn, cam: camOn, screen: screenStream !== null, hand: handUp });
  }

  // ----------------------------------------------------------------- media
  function toggleMic(): void {
    const track = localStream?.getAudioTracks()[0];
    if (!track) {
      void reacquire({ wantAudio: true, wantVideo: camOn });
      return;
    }
    micOn = !micOn;
    track.enabled = micOn;
    localDetector.resume();
    publishMedia();
  }

  function toggleCam(): void {
    const track = localStream?.getVideoTracks()[0];
    if (!track) {
      void reacquire({ wantAudio: micOn, wantVideo: true });
      return;
    }
    camOn = !camOn;
    track.enabled = camOn;
    // A disabled video track still sends black frames, so the tile is told
    // explicitly rather than waiting for the track to end.
    stage.setStream(selfId, "camera", camOn ? localStream : null);
    publishMedia();
  }

  /** Used when a device was refused at join time and the user tries again. */
  async function reacquire(want: { wantAudio: boolean; wantVideo: boolean }): Promise<void> {
    try {
      const result = await acquireLocalStream({
        cameraId: config.cameraId,
        microphoneId: config.microphoneId,
        wantVideo: want.wantVideo,
        wantAudio: want.wantAudio,
      });
      if (result.errors.length > 0) {
        toast(result.errors[0].message, "error");
        if (result.stream.getTracks().length === 0) return;
      }
      stopStream(localStream);
      localStream = result.stream;
      micOn = result.stream.getAudioTracks().length > 0;
      camOn = result.stream.getVideoTracks().length > 0;
      mesh.setLocalStream(localStream);
      stage.setStream(selfId, "camera", camOn ? localStream : null);
      localDetector.attach(localStream);
      publishMedia();
    } catch (error) {
      toast(error instanceof MediaError ? error.message : "Devices unavailable", "error");
    }
  }

  async function toggleScreen(): Promise<void> {
    if (screenStream) {
      stopStream(screenStream);
      screenStream = null;
      mesh.setScreenTrack(null);
      stage.setStream(selfId, "screen", null);
      publishMedia();
      return;
    }

    try {
      const stream = await acquireScreenStream();
      screenStream = stream;
      const track = stream.getVideoTracks()[0];
      mesh.setScreenTrack(track);
      stage.setStream(selfId, "screen", stream);
      // The browser's own "Stop sharing" bar ends the track behind our back.
      track.addEventListener("ended", () => {
        screenStream = null;
        mesh.setScreenTrack(null);
        stage.setStream(selfId, "screen", null);
        publishMedia();
      });
      publishMedia();
    } catch (error) {
      if (error instanceof MediaError && error.reason !== "denied") {
        toast(error.message, "error");
      }
    }
  }

  function toggleHand(): void {
    handUp = !handUp;
    publishMedia();
    if (handUp) toast("Your hand is raised");
  }

  // ------------------------------------------------------------ moderation
  function moderate(target: ParticipantId, action: ModAction): void {
    signaling.send({ t: "moderate", target, action });
    const name = participants.find((p) => p.id === target)?.name ?? "Participant";
    const said: Record<ModAction, string> = {
      requestMute: `Asked ${name} to mute`,
      remove: `Removed ${name}`,
      promoteModerator: `${name} can now moderate`,
      demoteModerator: `${name} is no longer a moderator`,
    };
    toast(said[action]);
  }

  function handleModerated(action: ModAction, by: ParticipantId): void {
    const actor = participants.find((p) => p.id === by)?.name ?? "A moderator";
    if (action === "requestMute") {
      // Advisory from the server; the mute happens here, on the device that
      // actually owns the microphone.
      const track = localStream?.getAudioTracks()[0];
      if (track && micOn) {
        micOn = false;
        track.enabled = false;
        publishMedia();
      }
      toast(`${actor} muted you`);
    } else if (action === "remove") {
      toast(`${actor} removed you from the room`, "error");
      window.setTimeout(() => leave(), 1200);
    }
  }

  // ------------------------------------------------------------- reactions
  function showReaction(id: ParticipantId, kind: string): void {
    const icon = icons[kind as keyof typeof icons];
    if (!icon) return;
    const node = el("span", { class: "reaction", html: icon });
    // A little horizontal drift so several at once do not stack in a column.
    node.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 90)}px`);
    node.style.left = `${Math.round((Math.random() - 0.5) * 160)}px`;
    reactionLayer.append(node);
    window.setTimeout(() => node.remove(), prefersReducedMotion() ? 1500 : 2700);

    if (id !== selfId) {
      const name = participants.find((p) => p.id === id)?.name;
      if (name) panel.unreadBump();
    }
  }

  // -------------------------------------------------------------- speaking
  const localDetector = new SpeechDetector((speaking) => {
    if (selfId) {
      stage.setSpeaking(selfId, speaking && micOn);
    }
  });
  if (localStream) localDetector.attach(localStream);

  // Remote levels come from the RTP receivers, so this is a cheap poll rather
  // than an audio graph per peer.
  const speakingTimer = window.setInterval(() => {
    for (const [id, level] of mesh.audioLevels()) {
      stage.setSpeaking(id, level > 0.02);
    }
  }, 220);

  const clockTimer = window.setInterval(() => header.tick(), 1000);
  header.tick();

  // -------------------------------------------------------------- keyboard
  function onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    // Never steal a keystroke from a field.
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key.toLowerCase()) {
      case "m":
        event.preventDefault();
        toggleMic();
        break;
      case "v":
        event.preventDefault();
        toggleCam();
        break;
      case "h":
        event.preventDefault();
        toggleHand();
        break;
      case "c":
        event.preventDefault();
        shell.dataset.panel = "open";
        panel.showTab("chat");
        break;
      case "p":
        event.preventDefault();
        shell.dataset.panel = "open";
        panel.showTab("people");
        break;
      default:
        break;
    }
  }
  document.addEventListener("keydown", onKeydown);

  // ------------------------------------------------------------------ exit
  function leave(): void {
    window.clearInterval(speakingTimer);
    window.clearInterval(clockTimer);
    document.removeEventListener("keydown", onKeydown);
    localDetector.detach();
    mesh.destroy();
    signaling.close();
    stopStream(localStream);
    stopStream(screenStream);
    stage.destroy();
    document.title = "AGmeet";
    history.replaceState(null, "", "/");
    showFarewell(config.room);
  }

  window.addEventListener("beforeunload", () => signaling.close());
}

/** Leaving is a destination, not a blank page. */
function showFarewell(room: string): void {
  const rejoin = el("button", { class: "btn btn--accent btn--lg", type: "button" }, [
    el("span", { text: "Rejoin the room" }),
  ]);
  rejoin.addEventListener("click", () => {
    history.replaceState(null, "", `/r/${room}`);
    showLobby();
  });

  const home = el("button", { class: "btn btn--glass btn--lg", type: "button" }, [
    el("span", { text: "Start a new room" }),
  ]);
  home.addEventListener("click", () => {
    history.replaceState(null, "", "/");
    showLobby();
  });

  app.replaceChildren(
    el("main", { class: "lobby" }, [
      el("div", { class: "lobby__card glass-2", style: "grid-template-columns:minmax(0,1fr);max-width:560px" }, [
        el("div", { class: "state" }, [
          el("span", { class: "state__mark", html: icons.check }),
          el("p", { class: "state__title", text: "You left the meeting" }),
          el("p", { class: "state__body", text: "Your camera and microphone have been released." }),
          el("div", { class: "row", style: "gap:var(--s-3);margin-top:var(--s-2)" }, [rejoin, home]),
        ]),
      ]),
    ])
  );
}

showLobby();
