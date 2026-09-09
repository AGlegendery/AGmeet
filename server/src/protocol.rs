//! Wire protocol shared with the browser client.
//!
//! Every message is a JSON object with a `t` discriminator so the TypeScript
//! side can switch on it directly. Media never travels through here: the
//! `Signal` variants carry opaque SDP/ICE payloads between two peers and the
//! server forwards them without inspection.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type ParticipantId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Created the room. Exactly one per room; inherited when the host leaves.
    Host,
    /// Granted moderation rights by the host.
    Moderator,
    /// Everyone else.
    Guest,
}

impl Role {
    pub fn can_moderate(self) -> bool {
        matches!(self, Role::Host | Role::Moderator)
    }
}

/// Per-participant media state, mirrored to everyone in the room.
///
/// The default is everything off: a client that omits it joins muted with no
/// camera, which is the safe assumption.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct MediaState {
    pub mic: bool,
    pub cam: bool,
    pub screen: bool,
    pub hand: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantView {
    pub id: ParticipantId,
    pub name: String,
    pub role: Role,
    #[serde(flatten)]
    pub media: MediaState,
    /// Unix millis. Used to order tiles stably and to show join order.
    pub joined_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: Uuid,
    pub from: ParticipantId,
    pub author: String,
    pub role: Role,
    pub body: String,
    pub at: u64,
}

/// One pen stroke on the whiteboard.
///
/// Points are normalised to 0..1 against the board's own box, so a stroke
/// drawn on a phone lands in the same place on a projector. Colour and width
/// are indices into fixed palettes rather than free values, which keeps the
/// wire small and stops a client inventing an unreadable colour.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub id: Uuid,
    pub color: u8,
    pub width: u8,
    #[serde(default)]
    pub erase: bool,
    pub points: Vec<[f32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    /// Whether the board currently owns the stage.
    pub open: bool,
    /// When locked, only the host and moderators may draw.
    pub locked: bool,
    pub strokes: Vec<Stroke>,
}

/// Votes are counted, never attributed: the room sees totals and nobody sees
/// who chose what. A classroom poll people are afraid to answer is worthless.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollView {
    pub id: Uuid,
    pub question: String,
    pub options: Vec<String>,
    pub counts: Vec<u32>,
    pub total: u32,
    pub open: bool,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    pub id: String,
    pub name: String,
    /// Unix millis of the first join, so every client shows the same duration.
    pub started_at: u64,
    pub classroom: bool,
    pub participants: Vec<ParticipantView>,
    pub chat: Vec<ChatMessage>,
    pub board: BoardView,
    pub polls: Vec<PollView>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModAction {
    /// Ask a participant to mute. The client mutes itself on receipt; the
    /// server never fabricates media state it cannot verify.
    RequestMute,
    Remove,
    PromoteModerator,
    DemoteModerator,
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientMessage {
    /// First message on a socket. Anything else before this is rejected.
    Join {
        room: String,
        #[serde(default)]
        room_name: Option<String>,
        name: String,
        #[serde(default)]
        classroom: bool,
        #[serde(default)]
        media: MediaState,
    },
    /// Opaque WebRTC payload forwarded verbatim to a single peer.
    Signal { to: ParticipantId, payload: serde_json::Value },
    Chat { body: String },
    Media { #[serde(flatten)] state: MediaState },
    Reaction { kind: String },
    Moderate { target: ParticipantId, action: ModAction },

    /// Appends points to a stroke, creating it on first sight. Sent while the
    /// pointer moves so other people watch the line being drawn rather than
    /// waiting for it to appear finished.
    Draw {
        id: Uuid,
        color: u8,
        width: u8,
        #[serde(default)]
        erase: bool,
        points: Vec<[f32; 2]>,
    },
    /// Removes the sender's own stroke. Anyone may undo their own work; only
    /// a moderator can clear the board.
    Undo { id: Uuid },
    BoardClear,
    /// Moderators put the board on the stage and control who may draw.
    BoardOpen { open: bool },
    BoardLock { locked: bool },

    PollCreate { question: String, options: Vec<String> },
    PollVote { poll: Uuid, option: usize },
    PollClose { poll: Uuid },

    /// Keeps intermediaries from closing an idle socket.
    Ping,
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMessage {
    /// Sent once, in reply to `Join`.
    Welcome {
        you: ParticipantId,
        room: RoomView,
        /// ICE servers configured on this deployment. Empty is valid and works
        /// on a LAN; see the README for adding a TURN server.
        ice_servers: Vec<serde_json::Value>,
    },
    /// A peer joined. The receiving client initiates the WebRTC offer, which
    /// makes the offerer deterministic and avoids negotiation glare.
    Joined { participant: ParticipantView },
    Left { id: ParticipantId },
    Signal { from: ParticipantId, payload: serde_json::Value },
    Chat { message: ChatMessage },
    Media {
        id: ParticipantId,
        #[serde(flatten)]
        state: MediaState,
    },
    Reaction { id: ParticipantId, kind: String },
    RoleChanged { id: ParticipantId, role: Role },
    /// Directed at one participant by a moderator.
    Moderated { by: ParticipantId, action: ModAction },

    Draw {
        from: ParticipantId,
        id: Uuid,
        color: u8,
        width: u8,
        erase: bool,
        points: Vec<[f32; 2]>,
    },
    Undone { id: Uuid },
    BoardCleared { by: ParticipantId },
    BoardOpen { open: bool },
    BoardLock { locked: bool },

    /// Sent whenever a poll is created, voted on, or closed. Carries the whole
    /// poll so a client never has to reconcile a partial update.
    Poll { poll: PollView },
    /// Recoverable problem; the socket stays open.
    Error { message: String },
    Pong,
}
