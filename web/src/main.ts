/**
 * Application entry point.
 *
 * Three views: the dashboard (what you decide before entering a room), the
 * lobby (devices, and the room's door), and the meeting. Everything below
 * wires the signalling socket, the peer mesh and the interface together; none
 * of those modules knows about the others directly.
 */

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/views.css";

import { el, prefersReducedMotion, qs } from "./dom";
import { detectTier, GlassSurfaces } from "./glass";
import { icons } from "./icons";
import {
  acquireLocalStream,
  acquireScreenStream,
  MediaError,
  SpeechDetector,
  stopStream,
} from "./media";
import { canRecord, download, RoomRecorder, type Recording } from "./recorder";
import { PeerMesh } from "./rtc";
import { Signaling } from "./signaling";
import { initTheme } from "./theme";
import type {
  ConnectionState,
  ModAction,
  Participant,
  ParticipantId,
  PollView,
  RevealMode,
  Role,
  RoomSettings,
  RoomView,
} from "./types";
import { buildBoard } from "./ui/board";
import { buildDashboard, rememberRoom, type EnterRequest } from "./ui/dashboard";
import { buildDock } from "./ui/dock";
import { buildLobby, type LobbyResult } from "./ui/lobby";
import { buildPanel } from "./ui/panel";
import { buildPollDialog } from "./ui/pollDialog";
import { buildPolls } from "./ui/polls";
import { buildRoomMenu, buildThemeMenu } from "./ui/settings";
import { buildHeader } from "./ui/shell";
import { Stage } from "./ui/stage";
import { toast } from "./ui/toast";

initTheme();

const app = qs("#app");

// Decided once, before anything is rendered or downloaded: the stylesheet
// reads it off <html>, and only the top tier ever fetches the WebGL library.
const { tier: initialTier, reason: tierReason } = detectTier();
document.documentElement.dataset.glass = initialTier;
if (initialTier !== "full") {
  console.info(`AGmeet: glass tier "${initialTier}" — ${tierReason}`);
}

/**
 * One manager for the whole app. Sharing it means every view agrees on a
 * tier, and a downgrade decided while checking your camera is still in force
 * once you are in the room.
 */
const glass = new GlassSurfaces(initialTier, (tier, reason) => {
  document.documentElement.dataset.glass = tier;
  console.info(`AGmeet: glass tier lowered to "${tier}" — ${reason}`);
  toast("Switched to lighter visuals to keep the call smooth");
});

/** A room in the address bar goes straight to its lobby. */
function roomFromLocation(): string | null {
  const path = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (path) return path[1];
  const query = new URLSearchParams(location.search).get("room");
  return query && /^[A-Za-z0-9_-]{1,64}$/.test(query) ? query : null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function showDashboard(): void {
  glass.detach("lobby");
  history.replaceState(null, "", "/");
  document.title = "AGmeet";
  app.replaceChildren(buildDashboard((request) => showLobby(request)));
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function showLobby(request: EnterRequest): void {
  glass.detach("lobby");
  history.replaceState(null, "", `/r/${request.room}`);

  let signaling: Signaling | null = null;
  let pending: LobbyResult | null = null;

  const lobby = buildLobby(
    request,
    {
      onJoin: (result) => {
        pending = result;
        lobby.setState({ kind: "connecting" });
        signaling?.close();
        signaling = connect(result, lobby.setState);
      },
      onPasscode: (passcode) => {
        lobby.setState({ kind: "connecting" });
        signaling?.retryWithPasscode(passcode);
      },
      onBack: () => {
        signaling?.close();
        showDashboard();
      },
    },
    (previewRoot, controls) => {
      if (glass.currentTier !== "full") return;
      void glass.attach("lobby", previewRoot, [controls], {
        cornerRadius: 30,
        zRadius: 14,
        shadowSpread: 22,
      });
    }
  );

  app.replaceChildren(lobby.root);

  /**
   * Opens the socket and waits for the door's verdict. The socket survives a
   * passcode challenge, so a wrong code costs a round trip rather than a
   * reconnection.
   */
  function connect(
    result: LobbyResult,
    setState: (state: Parameters<typeof lobby.setState>[0]) => void
  ): Signaling {
    const socket = new Signaling({
      room: result.room,
      name: result.name,
      create: result.create,
      mic: result.mic,
      cam: result.cam,
    });

    socket.onMessage((message) => {
      switch (message.t) {
        case "welcome":
          glass.detach("lobby");
          rememberRoom(message.room.id, message.room.name);
          startMeeting(result, socket, message.you, message.room, message.iceServers);
          break;
        case "needPasscode":
          setState({ kind: "passcode", retry: message.retry });
          break;
        case "knocking":
          setState({ kind: "knocking" });
          break;
        case "denied":
          setState({ kind: "denied", reason: message.reason });
          socket.close();
          break;
        case "roomMissing":
          setState({ kind: "missing" });
          break;
        case "error":
          setState({ kind: "denied", reason: message.message });
          break;
        default:
          break;
      }
    });

    socket.onState((state) => {
      if (state === "lost") setState({ kind: "denied", reason: "The server could not be reached." });
    });

    socket.connect();
    return socket;
  }

  void pending;
}

// ---------------------------------------------------------------------------
// Meeting
// ---------------------------------------------------------------------------

function startMeeting(
  config: LobbyResult,
  signaling: Signaling,
  you: ParticipantId,
  initialRoom: RoomView,
  iceServers: RTCIceServer[]
): void {
  const selfId = you;
  let selfRole: Role = "guest";
  let participants: Participant[] = [];
  let settings: RoomSettings = initialRoom;
  let localStream: MediaStream | null = config.stream;
  let screenStream: MediaStream | null = null;
  let micOn = config.mic;
  let camOn = config.cam;
  let handUp = false;
  let boardOpen = false;
  let knocks: { id: ParticipantId; name: string; since: number }[] = [];

  const remoteAudio = new Map<ParticipantId, HTMLAudioElement>();
  const remoteStreams = new Map<ParticipantId, MediaStream>();
  const audioHost = el("div", { "aria-hidden": "true", style: "display:none" });

  const inviteUrl = `${location.origin}/r/${config.room}`;

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast("Invite link copied");
    } catch {
      toast(inviteUrl);
    }
  }

  const canModerate = (): boolean => selfRole === "host" || selfRole === "moderator";
  /** Room policy can forbid a guest a camera; moderators are never blocked. */
  const mayUseMedia = (): boolean => settings.guestMedia || canModerate();
  const mayRecord = (): boolean => canRecord() && (settings.allowRecording || canModerate());

  // ---------------------------------------------------------------- pieces
  const stage = new Stage({ onInvite: () => void copyInvite() });

  const pollDialog = buildPollDialog({
    onVote: (poll, option) => {
      signaling.send({ t: "pollVote", poll, option });
      polls.recordVote(poll, option);
    },
  });

  const polls = buildPolls({
    onCreate: (question, options, correct) =>
      signaling.send({ t: "pollCreate", question, options, correct }),
    onVote: (poll, option) => {
      signaling.send({ t: "pollVote", poll, option });
      polls.recordVote(poll, option);
    },
    onClose: (poll) => signaling.send({ t: "pollClose", poll }),
    onReveal: (poll, mode: RevealMode) => signaling.send({ t: "pollReveal", poll, mode }),
    onOpen: (poll) => openPoll(poll),
  });

  const panel = buildPanel(
    {
      onSend: (body) => signaling.send({ t: "chat", body }),
      onModerate: (target, action) => moderate(target, action),
      onOpenPoll: (poll) => openPoll(poll),
      onAdmit: (id) => signaling.send({ t: "admit", id }),
      onDeny: (id) => signaling.send({ t: "deny", id }),
    },
    polls.root
  );

  const board = buildBoard({
    onDraw: (id, colour, width, erase, points) =>
      signaling.send({ t: "draw", id, color: colour, width, erase, points }),
    onUndo: (id) => signaling.send({ t: "undo", id }),
    onClear: () => signaling.send({ t: "boardClear" }),
    onLock: (locked) => signaling.send({ t: "boardLock", locked }),
    onClose: () => signaling.send({ t: "boardOpen", open: false }),
  });

  const dock = buildDock({
    onToggleMic: () => toggleMic(),
    onToggleCam: () => toggleCam(),
    onToggleScreen: () => void toggleScreen(),
    onToggleBoard: () => toggleBoard(),
    onToggleHand: () => toggleHand(),
    onReaction: (kind) => signaling.send({ t: "reaction", kind }),
    onLeave: () => leave(),
  });

  const header = buildHeader(
    () => void copyInvite(),
    () => togglePanel(),
    () => {
      shell.dataset.panel = "open";
      panel.showTab("people");
    }
  );

  // --- Recording ---------------------------------------------------------
  const recorder = new RoomRecorder();

  const roomMenu = buildRoomMenu({
    onSettings: (patch) => signaling.send({ t: "settings", ...patch }),
    onStartRecording: () => startRecording(),
    onStopRecording: () => void stopRecording(),
  });
  // Room policy and appearance both live in the header: the sidebar that used
  // to hold settings is gone, and these are the only two things still worth
  // configuring once you are inside a room.
  header.actions.append(roomMenu.root, buildThemeMenu());

  const reactionLayer = el("div", { class: "reactions", "aria-hidden": "true" });
  stage.root.append(dock.root, reactionLayer, pollDialog.root);

  const shell = el("div", { class: "app", "data-panel": "open" }, [
    el("div", { class: "meeting" }, [header.root, stage.root]),
    panel.root,
    audioHost,
  ]);

  app.replaceChildren(shell);

  if (glass.currentTier === "full") {
    void glass.attach("dock", stage.root, [dock.root], { cornerRadius: 32, zRadius: 15 });
  }

  function togglePanel(): void {
    shell.dataset.panel = shell.dataset.panel === "open" ? "closed" : "open";
  }

  // ------------------------------------------------------------------ mesh
  const mesh = new PeerMesh(iceServers, {
    onTrack: (id, slot, stream) => stage.setStream(id, slot, stream),
    onAudio: (id, stream) => attachRemoteAudio(id, stream),
    onQuality: () => refreshConnectionState(),
    onSignal: (to, payload) => signaling.send({ t: "signal", to, payload }),
  });
  mesh.setLocalStream(localStream);

  function attachRemoteAudio(id: ParticipantId, stream: MediaStream): void {
    let audio = remoteAudio.get(id);
    if (!audio) {
      audio = el("audio", { autoplay: true }) as HTMLAudioElement;
      remoteAudio.set(id, audio);
      audioHost.append(audio);
    }
    audio.srcObject = stream;
    remoteStreams.set(id, stream);
    void audio.play().catch(() => undefined);
  }

  // ------------------------------------------------------------- signalling
  // The lobby opened this socket, so its "connected" transition has already
  // happened; asking the socket beats waiting for an event that will not come.
  let socketState: ConnectionState = signaling.connectionState;

  function refreshConnectionState(): void {
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
      case "joined":
        participants = [...participants, message.participant];
        applyParticipants();
        void mesh.connect(message.participant.id, true);
        toast(`${message.participant.name} joined`);
        break;

      case "left": {
        const gone = participants.find((p) => p.id === message.id);
        participants = participants.filter((p) => p.id !== message.id);
        mesh.disconnect(message.id);
        remoteAudio.get(message.id)?.remove();
        remoteAudio.delete(message.id);
        remoteStreams.delete(message.id);
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

      case "media":
        participants = participants.map((p) =>
          p.id === message.id
            ? {
                ...p,
                mic: message.mic,
                cam: message.cam,
                screen: message.screen,
                hand: message.hand,
                recording: message.recording,
              }
            : p
        );
        applyParticipants();
        break;

      case "reaction":
        showReaction(message.kind);
        break;

      case "roleChanged":
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

      case "moderated":
        handleModerated(message.action, message.by);
        break;

      case "draw":
        board.applyDraw(message.id, message.color, message.width, message.erase, message.points);
        break;

      case "undone":
        board.applyUndo(message.id);
        break;

      case "boardCleared": {
        board.clear();
        const actor = participants.find((p) => p.id === message.by)?.name;
        if (message.by !== selfId && actor) toast(`${actor} cleared the board`);
        break;
      }

      case "boardOpen":
        applyBoardOpen(message.open);
        break;

      case "boardLock":
        board.setLocked(message.locked);
        toast(message.locked ? "The board is locked" : "Anyone can draw on the board");
        break;

      case "poll":
        applyPoll(message.poll);
        break;

      case "settingsChanged":
        settings = { ...settings, ...message.settings };
        applySettings();
        break;

      case "knock":
        knocks = [
          ...knocks.filter((k) => k.id !== message.id),
          { id: message.id, name: message.name, since: message.since },
        ];
        applyKnocks();
        toast(`${message.name} is asking to join`);
        break;

      case "knockWithdrawn":
        knocks = knocks.filter((k) => k.id !== message.id);
        applyKnocks();
        break;

      case "error":
        toast(message.message, "error");
        break;

      default:
        break;
    }
  });

  // ------------------------------------------------------------------ room
  function applyRoom(room: RoomView): void {
    header.setRoom(room);
    document.title = `${room.name} — AGmeet`;
    settings = room;
    participants = room.participants;
    selfRole = participants.find((p) => p.id === selfId)?.role ?? "guest";
    applyParticipants();
    applySettings();
  }

  function applyParticipants(): void {
    stage.setParticipants(participants);
    header.setCount(participants.length);
    panel.setParticipants(participants, selfId, selfRole, (id) => stage.isSpeaking(id));
    header.setRecording(participants.some((p) => p.recording));

    const moderate = canModerate();
    board.setCanModerate(moderate);
    polls.setCanModerate(moderate);
    applySettings();
  }

  function applySettings(): void {
    const moderate = canModerate();
    dock.setBoardAvailable(settings.whiteboard && moderate);
    dock.setMediaAllowed(mayUseMedia());
    dock.setScreenAvailable(
      typeof navigator.mediaDevices?.getDisplayMedia === "function" && mayUseMedia()
    );
    roomMenu.setSettings(settings, moderate);
    roomMenu.setRecording(recorder.active, mayRecord());
    header.setRoom({ ...initialRoom, ...settings, name: initialRoom.name });

    // Losing permission mid-room has to actually stop the hardware, not just
    // grey out a button.
    if (!mayUseMedia() && (micOn || camOn || screenStream)) {
      if (micOn || camOn) {
        stopStream(localStream);
        localStream = null;
        micOn = false;
        camOn = false;
        mesh.setLocalStream(null);
        stage.setStream(selfId, "camera", null);
        localDetector.detach();
      }
      if (screenStream) {
        stopStream(screenStream);
        screenStream = null;
        mesh.setScreenTrack(null);
        stage.setStream(selfId, "screen", null);
      }
      toast("The host turned off camera and microphone for guests");
      publishMedia();
    }
  }

  function applyKnocks(): void {
    header.setKnocking(knocks.length);
    panel.setKnocks(canModerate() ? knocks : []);
  }

  function publishMedia(): void {
    signaling.updateJoinState(micOn, camOn);
    signaling.send({
      t: "media",
      mic: micOn,
      cam: camOn,
      screen: screenStream !== null,
      hand: handUp,
      recording: recorder.active,
    });
    participants = participants.map((p) =>
      p.id === selfId
        ? {
            ...p,
            mic: micOn,
            cam: camOn,
            screen: screenStream !== null,
            hand: handUp,
            recording: recorder.active,
          }
        : p
    );
    applyParticipants();
    dock.setState({
      mic: micOn,
      cam: camOn,
      screen: screenStream !== null,
      hand: handUp,
      board: boardOpen,
    });
  }

  // ----------------------------------------------------------------- media
  function toggleMic(): void {
    if (!mayUseMedia()) {
      toast("The host has turned off microphones for guests", "error");
      return;
    }
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
    if (!mayUseMedia()) {
      toast("The host has turned off cameras for guests", "error");
      return;
    }
    const track = localStream?.getVideoTracks()[0];
    if (!track) {
      void reacquire({ wantAudio: micOn, wantVideo: true });
      return;
    }
    camOn = !camOn;
    track.enabled = camOn;
    stage.setStream(selfId, "camera", camOn ? localStream : null);
    publishMedia();
  }

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
    if (!mayUseMedia()) {
      toast("The host has turned off screen sharing for guests", "error");
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

  // ------------------------------------------------------------- recording
  function startRecording(): void {
    try {
      recorder.start({
        videos: () => [...stage.root.querySelectorAll("video")] as HTMLVideoElement[],
        audio: () => {
          const streams = [...remoteStreams.values()];
          if (localStream && micOn) streams.push(localStream);
          return streams;
        },
      });
      publishMedia();
      roomMenu.setRecording(true, mayRecord());
      header.setRecording(true);
      toast("Recording on this device");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Recording could not start", "error");
    }
  }

  async function stopRecording(): Promise<void> {
    const recording = await recorder.stop();
    publishMedia();
    roomMenu.setRecording(false, mayRecord());
    if (!recording) {
      toast("Nothing was captured", "error");
      return;
    }
    showRecordingResult(recording);
  }

  /**
   * The take is in memory and nowhere else, so the only two things that can
   * happen to it are offered together and neither is hidden.
   */
  function showRecordingResult(recording: Recording): void {
    const minutes = Math.floor(recording.durationMs / 60000);
    const seconds = Math.floor((recording.durationMs % 60000) / 1000);
    const size = (recording.blob.size / (1024 * 1024)).toFixed(1);

    const keep = el("button", { class: "btn btn--accent", type: "button" }, [
      el("span", { html: icons.download }),
      el("span", { text: "Download" }),
    ]);
    const drop = el("button", { class: "btn btn--danger", type: "button" }, [
      el("span", { html: icons.trash }),
      el("span", { text: "Discard" }),
    ]);

    const layer = el("div", { class: "polldlg__layer" }, [
      el("div", { class: "polldlg glass-3", role: "dialog", "aria-modal": "true" }, [
        el("div", { class: "polldlg__body" }, [
          el("h2", { class: "polldlg__question", text: "Recording finished" }),
          el("p", {
            class: "field__hint",
            text: `${minutes}:${String(seconds).padStart(2, "0")} · ${size} MB · stayed on this device.`,
          }),
          el("div", { class: "row", style: "gap:var(--s-3);margin-top:var(--s-4)" }, [keep, drop]),
        ]),
      ]),
    ]);

    const close = (): void => layer.remove();
    keep.addEventListener("click", () => {
      download(recording);
      toast("Saved to your downloads");
      close();
    });
    drop.addEventListener("click", () => {
      toast("Recording discarded");
      close();
    });

    stage.root.append(layer);
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

  // ----------------------------------------------------------------- board
  function applyBoardOpen(open: boolean): void {
    boardOpen = open;
    stage.setPresentation(open ? board.root : null);
    if (open) board.resize();

    if (glass.currentTier === "full") {
      if (open) {
        void glass.attach("boardToolbar", board.root, [board.toolbar], {
          cornerRadius: 22,
          zRadius: 11,
          shadowSpread: 20,
        });
      } else {
        glass.detach("boardToolbar");
      }
    }
    dock.setState({
      mic: micOn,
      cam: camOn,
      screen: screenStream !== null,
      hand: handUp,
      board: boardOpen,
    });
  }

  function toggleBoard(): void {
    if (!canModerate() || !settings.whiteboard) return;
    signaling.send({ t: "boardOpen", open: !boardOpen });
  }

  // ----------------------------------------------------------------- polls
  const seenPolls = new Set<string>();

  function openPoll(id: string): void {
    const poll = polls.get(id);
    if (poll) pollDialog.open(poll, polls.myVote(id));
  }

  function applyPoll(poll: PollView): void {
    const isNew = !seenPolls.has(poll.id);
    seenPolls.add(poll.id);
    polls.upsert(poll);
    panel.setPollCount(polls.count());

    if (isNew && poll.open) {
      // A new poll interrupts on purpose. The chat keeps the notice, so
      // dismissing this costs nothing.
      pollDialog.open(poll, polls.myVote(poll.id));
    } else {
      pollDialog.update(poll, polls.myVote(poll.id));
    }
  }

  // ------------------------------------------------------------- reactions
  function showReaction(kind: string): void {
    const icon = icons[kind as keyof typeof icons];
    if (!icon) return;
    const node = el("span", { class: "reaction", html: icon });
    node.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 90)}px`);
    node.style.left = `${Math.round((Math.random() - 0.5) * 160)}px`;
    reactionLayer.append(node);
    window.setTimeout(() => node.remove(), prefersReducedMotion() ? 1500 : 2700);
  }

  // -------------------------------------------------------------- speaking
  const localDetector = new SpeechDetector((speaking) => {
    stage.setSpeaking(selfId, speaking && micOn);
  });
  if (localStream) localDetector.attach(localStream);

  const speakingTimer = window.setInterval(() => {
    for (const [id, level] of mesh.audioLevels()) {
      stage.setSpeaking(id, level > 0.02);
    }
  }, 220);

  const clockTimer = window.setInterval(() => header.tick(), 1000);

  // -------------------------------------------------------------- keyboard
  function onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
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
      case "o":
        event.preventDefault();
        shell.dataset.panel = "open";
        panel.showTab("polls");
        break;
      case "b":
        event.preventDefault();
        toggleBoard();
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
    glass.detach("dock");
    glass.detach("boardToolbar");
    board.destroy();
    mesh.destroy();
    signaling.close();
    // A recording in flight is kept, not thrown away: leaving a room is not
    // a decision to lose the take.
    if (recorder.active) {
      void recorder.stop().then((recording) => {
        if (recording) showRecordingResult(recording);
      });
    }
    stopStream(localStream);
    stopStream(screenStream);
    stage.destroy();
    document.title = "AGmeet";
    showFarewell(config.room);
  }

  window.addEventListener("beforeunload", () => signaling.close());

  // Seed everything from the snapshot the server sent with the welcome.
  stage.setSelf(selfId);
  applyRoom(initialRoom);
  stage.setStream(selfId, "camera", camOn ? localStream : null);
  panel.setHistory(initialRoom.chat, selfId);
  board.setStrokes(initialRoom.board.strokes);
  board.setLocked(initialRoom.board.locked);
  applyBoardOpen(initialRoom.board.open);
  polls.setPolls(initialRoom.polls);
  panel.setPollCount(initialRoom.polls.length);
  for (const poll of initialRoom.polls) seenPolls.add(poll.id);
  for (const participant of initialRoom.participants) {
    if (participant.id !== selfId) void mesh.connect(participant.id, false);
  }
  publishMedia();
  refreshConnectionState();
  header.tick();
}

/** Leaving is a destination, not a blank page. */
function showFarewell(room: string): void {
  const rejoin = el("button", { class: "btn btn--accent btn--lg", type: "button" }, [
    el("span", { text: "Rejoin the room" }),
  ]);
  rejoin.addEventListener("click", () => showLobby({ room, name: localStorage.getItem("agmeet.name") ?? "" }));

  const home = el("button", { class: "btn btn--glass btn--lg", type: "button" }, [
    el("span", { text: "Back to rooms" }),
  ]);
  home.addEventListener("click", () => showDashboard());

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

// A link straight to a room skips the dashboard.
const linked = roomFromLocation();
if (linked) {
  const remembered = localStorage.getItem("agmeet.name") ?? "";
  if (remembered) {
    showLobby({ room: linked, name: remembered });
  } else {
    // No name yet: the dashboard asks for one, and its code field is prefilled.
    showDashboard();
    const code = document.getElementById("dash-code") as HTMLInputElement | null;
    if (code) code.value = linked;
  }
} else {
  showDashboard();
}
