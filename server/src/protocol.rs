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

/// How a room admits people.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoomLock {
    /// Anyone with the link walks in.
    #[default]
    Open,
    /// A shared passcode set by the operator.
    Passcode,
    /// A moderator admits each arrival by hand.
    Approval,
}

/// Everything the operator decides when the room is created.
///
/// These are room policy, not preferences: they gate what the server accepts,
/// so a client that hides a control is a convenience rather than the
/// enforcement.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    /// Teacher priority on the stage and moderation over the room.
    pub classroom: bool,
    /// Whether the whiteboard exists in this room at all.
    pub whiteboard: bool,
    /// Whether guests may turn a microphone or camera on.
    pub guest_media: bool,
    /// Whether anyone but a moderator may record.
    pub allow_recording: bool,
    pub lock: RoomLock,
}

impl Default for RoomSettings {
    fn default() -> Self {
        Self {
            classroom: false,
            whiteboard: true,
            guest_media: true,
            allow_recording: false,
            lock: RoomLock::Open,
        }
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
    /// This participant is recording locally. Recordings never touch the
    /// server; this exists so the room can see it is being recorded.
    #[serde(default)]
    pub recording: bool,
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

/// What a chat line is. Polls announce themselves in the chat so the notice
/// survives the popup being dismissed, reaches late joiners, and gives
/// somebody a way back in to change their answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatKind {
    #[default]
    Text,
    PollStarted,
    PollResults,
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
    pub kind: ChatKind,
    /// The poll this line refers to, for the two poll kinds.
    pub poll: Option<Uuid>,
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
    /// Withheld until the operator reveals it, so the answer cannot be read
    /// out of the wire before the room has finished voting.
    pub correct: Option<usize>,
    pub revealed: bool,
}

/// What an operator chooses to publish when a poll ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevealMode {
    /// How the room answered, as percentages.
    Counts,
    /// Which option was right.
    Correct,
    Both,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    pub id: String,
    pub name: String,
    /// Unix millis of the first join, so every client shows the same duration.
    pub started_at: u64,
    #[serde(flatten)]
    pub settings: RoomSettings,
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
// `rename_all` renames the variants; `rename_all_fields` renames the fields
// inside them. Without the second, a multi-word field such as `guest_media`
// silently never matches the `guestMedia` the client sends.
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    /// First message on a socket. Anything else before this is rejected.
    ///
    /// The same message creates a room and joins one: `create` is present
    /// only when the sender means to open it, which keeps a typo in a room
    /// code from silently opening an empty room instead of reporting that
    /// the class has not started.
    Join {
        room: String,
        name: String,
        #[serde(default)]
        create: Option<CreateOptions>,
        #[serde(default)]
        passcode: Option<String>,
        #[serde(default)]
        media: MediaState,
    },

    /// A moderator's verdict on someone waiting to be let in.
    Admit { id: ParticipantId },
    Deny { id: ParticipantId },
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

    PollCreate {
        question: String,
        options: Vec<String>,
        /// Marks one option as right. Withheld from the room until revealed.
        #[serde(default)]
        correct: Option<usize>,
    },
    PollVote { poll: Uuid, option: usize },
    /// Ends the poll. No further answers or changes are accepted.
    PollClose { poll: Uuid },
    /// Publishes the outcome to the room.
    PollReveal { poll: Uuid, mode: RevealMode },

    /// Changes room policy mid-session. Moderators only.
    Settings {
        #[serde(default)]
        whiteboard: Option<bool>,
        #[serde(default)]
        guest_media: Option<bool>,
        #[serde(default)]
        allow_recording: Option<bool>,
    },

    /// Keeps intermediaries from closing an idle socket.
    Ping,
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
    /// The room needs a passcode, or the one supplied was wrong. `retry` is
    /// false on the first ask so the client can tell "enter it" apart from
    /// "that was not it".
    NeedPasscode { retry: bool },
    /// Waiting for a moderator to admit this socket.
    Knocking,
    /// Somebody is waiting to be let in. Sent to moderators only.
    Knock { id: ParticipantId, name: String, since: u64 },
    /// A knocker gave up or was refused; moderators drop them from the list.
    KnockWithdrawn { id: ParticipantId },
    /// This socket was refused. The connection closes after it.
    Denied { reason: String },
    /// The room does not exist and the sender did not ask to create it.
    RoomMissing,

    SettingsChanged { settings: RoomSettings },

    /// Recoverable problem; the socket stays open.
    Error { message: String },
    Pong,
}

/// Everything the operator decides when opening a room.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOptions {
    #[serde(default)]
    pub room_name: Option<String>,
    #[serde(default)]
    pub classroom: bool,
    #[serde(default = "yes")]
    pub whiteboard: bool,
    #[serde(default = "yes")]
    pub guest_media: bool,
    #[serde(default)]
    pub allow_recording: bool,
    #[serde(default)]
    pub lock: RoomLock,
    /// Only meaningful with `RoomLock::Passcode`. Hashed on arrival and never
    /// stored or echoed in the clear.
    #[serde(default)]
    pub passcode: Option<String>,
}

fn yes() -> bool {
    true
}
