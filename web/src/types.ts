/** Mirrors server/src/protocol.rs. Keep the two in step. */

export type ParticipantId = string;
export type Role = "host" | "moderator" | "guest";

export interface MediaState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  hand: boolean;
}

export interface Participant extends MediaState {
  id: ParticipantId;
  name: string;
  role: Role;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  from: ParticipantId;
  author: string;
  role: Role;
  body: string;
  at: number;
}

export interface Stroke {
  id: string;
  color: number;
  width: number;
  erase: boolean;
  points: [number, number][];
}

export interface BoardView {
  open: boolean;
  locked: boolean;
  strokes: Stroke[];
}

export interface PollView {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  total: number;
  open: boolean;
  createdAt: number;
}

export interface RoomView {
  id: string;
  name: string;
  startedAt: number;
  classroom: boolean;
  participants: Participant[];
  chat: ChatMessage[];
  board: BoardView;
  polls: PollView[];
}

export type ModAction = "requestMute" | "remove" | "promoteModerator" | "demoteModerator";

export type ClientMessage =
  | ({ t: "join"; room: string; roomName?: string; name: string; classroom: boolean } & MediaState)
  | { t: "signal"; to: ParticipantId; payload: unknown }
  | { t: "chat"; body: string }
  | ({ t: "media" } & MediaState)
  | { t: "reaction"; kind: string }
  | { t: "moderate"; target: ParticipantId; action: ModAction }
  | { t: "draw"; id: string; color: number; width: number; erase: boolean; points: [number, number][] }
  | { t: "undo"; id: string }
  | { t: "boardClear" }
  | { t: "boardOpen"; open: boolean }
  | { t: "boardLock"; locked: boolean }
  | { t: "pollCreate"; question: string; options: string[] }
  | { t: "pollVote"; poll: string; option: number }
  | { t: "pollClose"; poll: string }
  | { t: "ping" };

export type ServerMessage =
  | { t: "welcome"; you: ParticipantId; room: RoomView; iceServers: RTCIceServer[] }
  | { t: "joined"; participant: Participant }
  | { t: "left"; id: ParticipantId }
  | { t: "signal"; from: ParticipantId; payload: SignalPayload }
  | { t: "chat"; message: ChatMessage }
  | ({ t: "media"; id: ParticipantId } & MediaState)
  | { t: "reaction"; id: ParticipantId; kind: string }
  | { t: "roleChanged"; id: ParticipantId; role: Role }
  | { t: "moderated"; by: ParticipantId; action: ModAction }
  | { t: "draw"; from: ParticipantId; id: string; color: number; width: number; erase: boolean; points: [number, number][] }
  | { t: "undone"; id: string }
  | { t: "boardCleared"; by: ParticipantId }
  | { t: "boardOpen"; open: boolean }
  | { t: "boardLock"; locked: boolean }
  | { t: "poll"; poll: PollView }
  | { t: "error"; message: string }
  | { t: "pong" };

/** WebRTC payloads the server forwards without inspecting. */
export type SignalPayload =
  | { kind: "offer" | "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "poor" | "lost";

/**
 * How much glass this client can afford. Decided from its own capabilities
 * and its measured frame rate; never sent to or from the server.
 */
export type GlassTier = "full" | "enhanced" | "minimal";
