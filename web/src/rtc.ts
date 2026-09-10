/**
 * Peer-to-peer mesh.
 *
 * Every participant connects directly to every other one. The server carries
 * signalling only, so it never touches media and its cost stays flat no matter
 * how much video is flowing. That is what lets a small VPS host this.
 *
 * The tradeoff is the sender's uplink: each participant encodes and sends one
 * stream per peer, which is comfortable to roughly eight cameras and is the
 * reason `AGMEET_MAX_ROOM_SIZE` exists. See docs/ARCHITECTURE.md for the SFU
 * path when a deployment outgrows the mesh.
 *
 * Three transceivers are created up front, in a fixed order, so both sides
 * agree on what each `mid` carries:
 *
 *   mid 0  audio   microphone
 *   mid 1  video   camera
 *   mid 2  video   screen share
 *
 * Media is then attached and removed with `replaceTrack`, which needs no
 * renegotiation at all: muting, unmuting and starting a screen share never
 * re-run the offer/answer exchange, so tiles do not flicker.
 */

import type { ParticipantId, SignalPayload } from "./types";

export type PeerQuality = "good" | "poor" | "lost";

export interface MeshEvents {
  onTrack: (id: ParticipantId, slot: "camera" | "screen", stream: MediaStream | null) => void;
  onAudio: (id: ParticipantId, stream: MediaStream) => void;
  onQuality: (id: ParticipantId, quality: PeerQuality) => void;
  onSignal: (to: ParticipantId, payload: SignalPayload) => void;
}

const MID_AUDIO = "0";
const MID_CAMERA = "1";
const MID_SCREEN = "2";

const STATS_INTERVAL_MS = 4000;

interface Peer {
  pc: RTCPeerConnection;
  /** Candidates that arrived before the remote description was applied. */
  pending: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  lastPacketsLost: number;
  lastPacketsReceived: number;
  quality: PeerQuality;
  /** Most recent round-trip time in milliseconds, or null before the first
   *  sample lands. */
  rttMs: number | null;
  /** Fraction of packets lost in the last sampling window. */
  loss: number;
}

/** What the header shows: bars, plus the numbers behind them. */
export interface LinkStrength {
  bars: 0 | 1 | 2 | 3;
  rttMs: number | null;
  lossPercent: number;
}

export class PeerMesh {
  private peers = new Map<ParticipantId, Peer>();
  private localStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private statsTimer: number | undefined;

  constructor(
    private iceServers: RTCIceServer[],
    private readonly events: MeshEvents
  ) {
    this.statsTimer = window.setInterval(() => void this.pollStats(), STATS_INTERVAL_MS);
  }

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
  }

  /** Attaches the local camera/mic stream to every existing and future peer. */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    for (const [, peer] of this.peers) this.syncSenders(peer);
  }

  setScreenTrack(track: MediaStreamTrack | null): void {
    this.screenTrack = track;
    for (const [, peer] of this.peers) this.syncSenders(peer);
  }

  /**
   * Opens a connection to a peer. `initiate` is true only for the side that
   * was already in the room, which makes the offerer deterministic and removes
   * negotiation glare entirely.
   */
  async connect(id: ParticipantId, initiate: boolean): Promise<void> {
    if (this.peers.has(id)) return;
    const peer = this.createPeer(id);

    if (initiate) {
      // Creating the transceivers here fixes the m-line order for both sides.
      peer.pc.addTransceiver("audio", { direction: "sendrecv" });
      peer.pc.addTransceiver("video", { direction: "sendrecv" });
      peer.pc.addTransceiver("video", { direction: "sendrecv" });

      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      // Only now do the transceivers have mids. Attaching tracks before this
      // point silently matches nothing and the offer carries no media.
      this.syncSenders(peer);
      this.events.onSignal(id, { kind: "offer", sdp: offer });
    }
  }

  private createPeer(id: ParticipantId): Peer {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: "max-bundle",
      // A mesh opens one connection per peer; pooling candidates up front
      // makes each of those noticeably faster to establish.
      iceCandidatePoolSize: 2,
    });

    const peer: Peer = {
      pc,
      pending: [],
      remoteDescriptionSet: false,
      lastPacketsLost: 0,
      lastPacketsReceived: 0,
      quality: "good",
      rttMs: null,
      loss: 0,
    };
    this.peers.set(id, peer);

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.events.onSignal(id, { kind: "ice", candidate: event.candidate.toJSON() });
      }
    });

    pc.addEventListener("track", (event) => {
      const mid = event.transceiver.mid;
      const [stream] = event.streams;
      if (mid === MID_AUDIO) {
        if (stream) this.events.onAudio(id, stream);
        return;
      }
      const slot = mid === MID_SCREEN ? "screen" : "camera";
      const wrapper = new MediaStream([event.track]);
      this.events.onTrack(id, slot, wrapper);

      // A remote camera switching off ends its track; clear the tile rather
      // than leaving the last frozen frame on screen.
      event.track.addEventListener("ended", () => this.events.onTrack(id, slot, null));
      event.track.addEventListener("mute", () => this.events.onTrack(id, slot, null));
      event.track.addEventListener("unmute", () => this.events.onTrack(id, slot, wrapper));
    });

    pc.addEventListener("connectionstatechange", () => {
      switch (pc.connectionState) {
        case "connected":
          this.setQuality(id, peer, "good");
          break;
        case "disconnected":
          this.setQuality(id, peer, "poor");
          break;
        case "failed":
          this.setQuality(id, peer, "lost");
          // An ICE restart recovers a network change without dropping the tile.
          void this.restartIce(id, peer);
          break;
        default:
          break;
      }
    });

    return peer;
  }

  /**
   * Points each transceiver at the current local track for its slot.
   *
   * The direction is asserted as well as the track. Applying a remote offer
   * creates the answerer's transceivers as `recvonly`, because nothing is
   * attached to them yet, and `replaceTrack` does not change a direction that
   * has already been set. Without this the answer would advertise `recvonly`
   * and that peer would never send anything, however many tracks it holds.
   */
  private syncSenders(peer: Peer): void {
    const audio = this.localStream?.getAudioTracks()[0] ?? null;
    const camera = this.localStream?.getVideoTracks()[0] ?? null;

    for (const transceiver of peer.pc.getTransceivers()) {
      let track: MediaStreamTrack | null;
      switch (transceiver.mid) {
        case MID_AUDIO:
          track = audio;
          break;
        case MID_CAMERA:
          track = camera;
          break;
        case MID_SCREEN:
          track = this.screenTrack;
          break;
        default:
          continue;
      }

      // Every slot stays bidirectional for the life of the connection, so a
      // camera or screen share that starts later needs no renegotiation.
      if (transceiver.direction !== "sendrecv") {
        transceiver.direction = "sendrecv";
      }
      void transceiver.sender.replaceTrack(track);
    }
  }

  async handleSignal(from: ParticipantId, payload: SignalPayload): Promise<void> {
    let peer = this.peers.get(from);
    if (!peer) {
      // The offer can arrive before the `joined` notice; accept it.
      await this.connect(from, false);
      peer = this.peers.get(from);
      if (!peer) return;
    }

    try {
      if (payload.kind === "offer") {
        await peer.pc.setRemoteDescription(payload.sdp);
        peer.remoteDescriptionSet = true;
        // The transceivers now exist, mirrored from the offer; fill them.
        this.syncSenders(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.events.onSignal(from, { kind: "answer", sdp: answer });
        await this.drainCandidates(peer);
      } else if (payload.kind === "answer") {
        await peer.pc.setRemoteDescription(payload.sdp);
        peer.remoteDescriptionSet = true;
        await this.drainCandidates(peer);
      } else if (payload.kind === "ice") {
        if (peer.remoteDescriptionSet) {
          await peer.pc.addIceCandidate(payload.candidate);
        } else {
          peer.pending.push(payload.candidate);
        }
      }
    } catch {
      // A malformed or out-of-order frame must not take the whole mesh down;
      // the connection state handler recovers the peer if it actually broke.
    }
  }

  private async drainCandidates(peer: Peer): Promise<void> {
    const queued = peer.pending.splice(0);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        // A candidate for a bundled transport that was rejected is expected.
      }
    }
  }

  private async restartIce(id: ParticipantId, peer: Peer): Promise<void> {
    // Only the offering side may restart; the other waits for the new offer.
    if (peer.pc.signalingState !== "stable") return;
    try {
      const offer = await peer.pc.createOffer({ iceRestart: true });
      await peer.pc.setLocalDescription(offer);
      this.events.onSignal(id, { kind: "offer", sdp: offer });
    } catch {
      // Nothing more to try; the peer stays marked lost.
    }
  }

  /**
   * Samples inbound packet loss per peer. Loss is reported as a quality state
   * rather than a number: the user needs to know their call is degrading, not
   * to read a percentage.
   */
  private async pollStats(): Promise<void> {
    for (const [id, peer] of this.peers) {
      if (peer.pc.connectionState !== "connected") continue;
      try {
        const report = await peer.pc.getStats();
        let lost = 0;
        let received = 0;
        report.forEach((entry) => {
          if (entry.type === "inbound-rtp" && !entry.isRemote) {
            lost += (entry as RTCInboundRtpStreamStats).packetsLost ?? 0;
            received += (entry as RTCInboundRtpStreamStats).packetsReceived ?? 0;
          }
          // The selected candidate pair carries the only round-trip time that
          // reflects the path actually in use.
          if (entry.type === "candidate-pair" && (entry as RTCIceCandidatePairStats).state === "succeeded") {
            const rtt = (entry as RTCIceCandidatePairStats).currentRoundTripTime;
            if (typeof rtt === "number") peer.rttMs = Math.round(rtt * 1000);
          }
        });

        const deltaLost = lost - peer.lastPacketsLost;
        const deltaReceived = received - peer.lastPacketsReceived;
        peer.lastPacketsLost = lost;
        peer.lastPacketsReceived = received;

        if (deltaReceived + deltaLost < 50) continue;
        const ratio = deltaLost / (deltaReceived + deltaLost);
        peer.loss = ratio;
        this.setQuality(id, peer, ratio > 0.06 ? "poor" : "good");
      } catch {
        // getStats can reject while a connection is tearing down.
      }
    }
  }

  private setQuality(id: ParticipantId, peer: Peer, quality: PeerQuality): void {
    if (peer.quality === quality) return;
    peer.quality = quality;
    this.events.onQuality(id, quality);
  }

  disconnect(id: ParticipantId): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
  }

  /**
   * Per-peer speech level, 0..1.
   *
   * Read from the RTP receiver's synchronization sources, which carry the
   * sender's own audio-level header extension. That costs nothing: the
   * alternative — one AudioContext and analyser per peer — would mean N Web
   * Audio graphs running continuously just to draw a ring.
   */
  audioLevels(): Map<ParticipantId, number> {
    const levels = new Map<ParticipantId, number>();
    for (const [id, peer] of this.peers) {
      let level = 0;
      for (const receiver of peer.pc.getReceivers()) {
        if (receiver.track.kind !== "audio") continue;
        const sources = receiver.getSynchronizationSources?.() ?? [];
        for (const source of sources) {
          if (typeof source.audioLevel === "number") {
            level = Math.max(level, source.audioLevel);
          }
        }
      }
      levels.set(id, level);
    }
    return levels;
  }

  /**
   * The link as a person would read it: bars, plus the latency and loss the
   * bars are made of. "Connected" alone does not tell anyone whether the call
   * is about to fall over.
   */
  linkStrength(): LinkStrength {
    let worstRtt: number | null = null;
    let worstLoss = 0;
    let connected = 0;
    for (const [, peer] of this.peers) {
      if (peer.pc.connectionState !== "connected") continue;
      connected += 1;
      if (peer.rttMs !== null) worstRtt = Math.max(worstRtt ?? 0, peer.rttMs);
      worstLoss = Math.max(worstLoss, peer.loss);
    }
    if (this.peers.size === 0) {
      // Alone in the room: nothing to measure, and nothing wrong.
      return { bars: 3, rttMs: null, lossPercent: 0 };
    }
    if (connected === 0) return { bars: 0, rttMs: null, lossPercent: 0 };

    let bars: 0 | 1 | 2 | 3 = 3;
    if (worstLoss > 0.1 || (worstRtt !== null && worstRtt > 400)) bars = 1;
    else if (worstLoss > 0.03 || (worstRtt !== null && worstRtt > 180)) bars = 2;
    if (this.worstQuality() === "lost") bars = 0;

    return { bars, rttMs: worstRtt, lossPercent: Math.round(worstLoss * 100) };
  }

  /** Worst quality across all peers, for the single status shown in the header. */
  worstQuality(): PeerQuality {
    let worst: PeerQuality = "good";
    for (const [, peer] of this.peers) {
      if (peer.quality === "lost") return "lost";
      if (peer.quality === "poor") worst = "poor";
    }
    return worst;
  }

  destroy(): void {
    window.clearInterval(this.statsTimer);
    for (const [, peer] of this.peers) peer.pc.close();
    this.peers.clear();
  }
}
