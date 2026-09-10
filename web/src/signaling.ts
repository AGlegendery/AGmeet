/**
 * WebSocket client.
 *
 * Reconnects with capped exponential backoff and re-announces the participant
 * on the way back in, so a dropped connection is a visible state rather than a
 * dead page.
 */

import type { ClientMessage, ConnectionState, CreateOptions, ServerMessage } from "./types";

type Handler = (message: ServerMessage) => void;
type StateHandler = (state: ConnectionState) => void;

const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 12_000;
const KEEPALIVE_MS = 25_000;

export interface JoinRequest {
  room: string;
  name: string;
  /** Present only when opening a new room. */
  create?: CreateOptions;
  /** Filled in after the server asks for it. */
  passcode?: string;
  mic: boolean;
  cam: boolean;
}

export class Signaling {
  private socket: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private stateHandlers = new Set<StateHandler>();
  private keepalive: number | undefined;
  private attempt = 0;
  private closedByUs = false;
  private state: ConnectionState = "connecting";

  constructor(private readonly join: JoinRequest) {}

  onMessage(handler: Handler): void {
    this.handlers.add(handler);
  }

  onState(handler: StateHandler): void {
    this.stateHandlers.add(handler);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    this.closedByUs = false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.setState("connected");
      this.sendJoin();
      // Some proxies close a socket that has been quiet for a minute.
      this.keepalive = window.setInterval(() => this.send({ t: "ping" }), KEEPALIVE_MS);
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === "pong") return;
      for (const handler of this.handlers) handler(message);
    });

    socket.addEventListener("close", () => {
      window.clearInterval(this.keepalive);
      if (this.closedByUs) return;
      this.setState("reconnecting");
      this.scheduleReconnect();
    });

    // An error is always followed by close, which owns the retry.
    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    // Give up telling the user it is coming back after a couple of minutes of
    // failures; the state drives an actionable error rather than a spinner.
    if (this.attempt > 9) {
      this.setState("lost");
      return;
    }
    window.setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, delay);
  }

  /** The opening handshake, also re-sent after a passcode challenge. */
  sendJoin(): void {
    this.send({
      t: "join",
      room: this.join.room,
      name: this.join.name,
      ...(this.join.create ? { create: this.join.create } : {}),
      ...(this.join.passcode ? { passcode: this.join.passcode } : {}),
      media: {
        mic: this.join.mic,
        cam: this.join.cam,
        screen: false,
        hand: false,
        recording: false,
      },
    });
  }

  /** Supplies a passcode and retries the handshake on the same socket. */
  retryWithPasscode(passcode: string): void {
    this.join.passcode = passcode;
    this.sendJoin();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /** Reflects the current media state so late joiners see the truth. */
  updateJoinState(mic: boolean, cam: boolean): void {
    this.join.mic = mic;
    this.join.cam = cam;
  }

  close(): void {
    this.closedByUs = true;
    window.clearInterval(this.keepalive);
    this.socket?.close();
    this.socket = null;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}
