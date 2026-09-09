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

export interface RoomView {
  id: string;
  name: string;
  startedAt: number;
  classroom: boolean;
  participants: Participant[];
  chat: ChatMessage[];
}

export type ModAction = "requestMute" | "remove" | "promoteModerator" | "demoteModerator";

export type ClientMessage =
  | ({ t: "join"; room: string; roomName?: string; name: string; classroom: boolean } & MediaState)
  | { t: "signal"; to: ParticipantId; payload: unknown }
  | { t: "chat"; body: string }
  | ({ t: "media" } & MediaState)
  | { t: "reaction"; kind: string }
  | { t: "moderate"; target: ParticipantId; action: ModAction }
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
  | { t: "error"; message: string }
  | { t: "pong" };

/** WebRTC payloads the server forwards without inspecting. */
export type SignalPayload =
  | { kind: "offer" | "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "poor" | "lost";
