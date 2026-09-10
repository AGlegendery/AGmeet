//! In-memory room registry.
//!
//! Rooms exist only while someone is in them: the last participant to leave
//! takes the room with them. That keeps a small deployment at zero idle cost
//! and removes the need for a database entirely.

use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use sha2::{Digest, Sha256};

use crate::protocol::{
    BoardView, ChatMessage, CreateOptions, MediaState, ParticipantId, ParticipantView, PollView,
    Role, RoomLock, RoomSettings, RoomView, ServerMessage, Stroke,
};

/// Chat kept per room so a late joiner sees recent context. Bounded so a
/// long-running room cannot grow without limit.
const CHAT_HISTORY: usize = 200;

/// Whiteboard limits. A board is a shared buffer that anyone in the room can
/// append to, so every dimension of it is bounded.
const MAX_STROKES: usize = 2000;
const MAX_POINTS_PER_STROKE: usize = 4000;

/// Poll limits, sized for a classroom rather than a survey tool.
const MAX_POLLS: usize = 20;
pub const MAX_QUESTION_LEN: usize = 200;
pub const MAX_OPTION_LEN: usize = 80;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 6;

pub type Outbox = mpsc::UnboundedSender<ServerMessage>;

/// Hashes a passcode. The room holds only this, so a memory dump or a stray
/// log line cannot hand out the credential.
fn hash_passcode(passcode: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"agmeet-room-passcode-v1");
    hasher.update(passcode.trim().as_bytes());
    hasher.finalize().into()
}

/// Compares in constant time. The comparison is short and local, but a
/// credential check that leaks its progress through timing is a bad habit to
/// leave in a codebase other people will copy from.
fn passcode_matches(expected: &[u8; 32], candidate: &str) -> bool {
    let actual = hash_passcode(candidate);
    let mut difference = 0u8;
    for index in 0..32 {
        difference |= expected[index] ^ actual[index];
    }
    difference == 0
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A room id is used in URLs and log lines, so it is restricted rather than
/// sanitised: reject anything unexpected instead of silently rewriting it.
pub fn valid_room_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub struct Participant {
    pub id: ParticipantId,
    pub name: String,
    pub role: Role,
    pub media: MediaState,
    pub joined_at: u64,
    pub outbox: Outbox,
}

impl Participant {
    pub fn view(&self) -> ParticipantView {
        ParticipantView {
            id: self.id,
            name: self.name.clone(),
            role: self.role,
            media: self.media,
            joined_at: self.joined_at,
        }
    }
}

/// The shared whiteboard.
#[derive(Default)]
pub struct Board {
    pub open: bool,
    pub locked: bool,
    strokes: Vec<Stroke>,
    /// Who drew each stroke, so a participant can undo their own work without
    /// being able to remove anyone else's.
    authors: HashMap<Uuid, ParticipantId>,
}

impl Board {
    pub fn view(&self) -> BoardView {
        BoardView { open: self.open, locked: self.locked, strokes: self.strokes.clone() }
    }

    /// Appends to an existing stroke, or starts one. Returns false when the
    /// stroke belongs to somebody else, which stops a client extending another
    /// participant's line by reusing its id.
    pub fn append(
        &mut self,
        author: ParticipantId,
        id: Uuid,
        color: u8,
        width: u8,
        erase: bool,
        points: Vec<[f32; 2]>,
    ) -> bool {
        match self.authors.get(&id) {
            Some(owner) if *owner != author => return false,
            Some(_) => {
                if let Some(stroke) = self.strokes.iter_mut().find(|s| s.id == id) {
                    let room = MAX_POINTS_PER_STROKE.saturating_sub(stroke.points.len());
                    stroke.points.extend(points.into_iter().take(room));
                }
            }
            None => {
                if self.strokes.len() >= MAX_STROKES {
                    // Drop the oldest stroke rather than refusing to draw; a
                    // board that silently stops working is worse than one that
                    // forgets its earliest marks.
                    let oldest = self.strokes.remove(0);
                    self.authors.remove(&oldest.id);
                }
                self.authors.insert(id, author);
                self.strokes.push(Stroke {
                    id,
                    color,
                    width,
                    erase,
                    points: points.into_iter().take(MAX_POINTS_PER_STROKE).collect(),
                });
            }
        }
        true
    }

    /// Removes a stroke if `author` drew it.
    pub fn undo(&mut self, author: ParticipantId, id: Uuid) -> bool {
        if self.authors.get(&id) != Some(&author) {
            return false;
        }
        self.authors.remove(&id);
        self.strokes.retain(|s| s.id != id);
        true
    }

    pub fn clear(&mut self) {
        self.strokes.clear();
        self.authors.clear();
    }
}

/// A poll. Votes are stored per participant so a second vote replaces the
/// first, but only totals ever leave the server.
pub struct Poll {
    pub id: Uuid,
    pub question: String,
    pub options: Vec<String>,
    pub votes: HashMap<ParticipantId, usize>,
    pub open: bool,
    pub created_at: u64,
    /// Set at creation, withheld from the room until the operator reveals it.
    pub correct: Option<usize>,
    pub revealed: bool,
    pub reveal_correct: bool,
}

impl Poll {
    pub fn view(&self) -> PollView {
        let mut counts = vec![0u32; self.options.len()];
        for choice in self.votes.values() {
            if let Some(slot) = counts.get_mut(*choice) {
                *slot += 1;
            }
        }
        PollView {
            id: self.id,
            question: self.question.clone(),
            options: self.options.clone(),
            total: self.votes.len() as u32,
            counts,
            open: self.open,
            created_at: self.created_at,
            // The answer only goes on the wire once it has been revealed;
            // before that a curious participant could read it out of the
            // socket instead of answering the question.
            correct: if self.revealed && self.reveal_correct { self.correct } else { None },
            revealed: self.revealed,
        }
    }
}

/// Somebody waiting for a moderator to let them in.
pub struct Knocker {
    pub id: ParticipantId,
    pub name: String,
    pub media: MediaState,
    pub outbox: Outbox,
    pub since: u64,
}

pub struct Room {
    pub id: String,
    pub name: String,
    pub settings: RoomSettings,
    pub passcode: Option<[u8; 32]>,
    /// People at the door, in arrival order.
    pub waiting: Vec<Knocker>,
    pub started_at: u64,
    pub participants: HashMap<ParticipantId, Participant>,
    chat: VecDeque<ChatMessage>,
    pub board: Board,
    pub polls: Vec<Poll>,
}

impl Room {
    fn new(id: String, name: String, options: &CreateOptions) -> Self {
        let settings = RoomSettings {
            classroom: options.classroom,
            whiteboard: options.whiteboard,
            guest_media: options.guest_media,
            allow_recording: options.allow_recording,
            lock: options.lock,
        };
        let passcode = match options.lock {
            RoomLock::Passcode => options
                .passcode
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(hash_passcode),
            _ => None,
        };
        Self {
            id,
            name,
            settings,
            passcode,
            waiting: Vec::new(),
            started_at: now_millis(),
            participants: HashMap::new(),
            chat: VecDeque::new(),
            // A classroom board starts locked: thirty people drawing at once
            // is not a lesson. Any other room starts open.
            board: Board { locked: options.classroom, ..Board::default() },
            polls: Vec::new(),
        }
    }

    /// True when the room demands a passcode and one was actually set. A room
    /// marked `Passcode` whose operator supplied none is treated as open
    /// rather than as impossible to enter.
    pub fn requires_passcode(&self) -> bool {
        self.settings.lock == RoomLock::Passcode && self.passcode.is_some()
    }

    pub fn passcode_ok(&self, candidate: Option<&str>) -> bool {
        match (&self.passcode, candidate) {
            (Some(expected), Some(given)) => passcode_matches(expected, given),
            (Some(_), None) => false,
            (None, _) => true,
        }
    }

    pub fn moderators(&self) -> impl Iterator<Item = &Participant> {
        self.participants.values().filter(|p| p.role.can_moderate())
    }

    /// Tells every moderator something. Used for the door: an arrival is a
    /// moderator's problem, not the room's.
    pub fn notify_moderators(&self, message: &ServerMessage) {
        for moderator in self.moderators() {
            let _ = moderator.outbox.send(message.clone());
        }
    }

    pub fn view(&self) -> RoomView {
        let mut participants: Vec<ParticipantView> =
            self.participants.values().map(Participant::view).collect();
        // Stable order everywhere: join order, then id to break ties.
        participants.sort_by(|a, b| a.joined_at.cmp(&b.joined_at).then(a.id.cmp(&b.id)));
        RoomView {
            id: self.id.clone(),
            name: self.name.clone(),
            started_at: self.started_at,
            settings: self.settings,
            participants,
            chat: self.chat.iter().cloned().collect(),
            board: self.board.view(),
            polls: self.polls.iter().map(Poll::view).collect(),
        }
    }

    /// Validates and stores a poll. Returns the stored view, or the reason it
    /// was refused.
    pub fn add_poll(
        &mut self,
        question: String,
        options: Vec<String>,
        correct: Option<usize>,
    ) -> Result<PollView, &'static str> {
        let question = question.trim().to_string();
        if question.is_empty() || question.chars().count() > MAX_QUESTION_LEN {
            return Err("A poll needs a question of 200 characters or fewer.");
        }
        let options: Vec<String> = options
            .into_iter()
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .map(|o| o.chars().take(MAX_OPTION_LEN).collect())
            .collect();
        if options.len() < MIN_OPTIONS || options.len() > MAX_OPTIONS {
            return Err("A poll needs between two and six options.");
        }
        if self.polls.len() >= MAX_POLLS {
            return Err("This room already has the maximum number of polls.");
        }

        let poll = Poll {
            id: Uuid::new_v4(),
            question,
            // An out-of-range answer index is dropped rather than refused:
            // the poll is still perfectly usable without a marked answer.
            correct: correct.filter(|index| *index < options.len()),
            options,
            votes: HashMap::new(),
            open: true,
            created_at: now_millis(),
            revealed: false,
            reveal_correct: false,
        };
        let view = poll.view();
        self.polls.push(poll);
        Ok(view)
    }

    pub fn push_chat(&mut self, message: ChatMessage) {
        if self.chat.len() == CHAT_HISTORY {
            self.chat.pop_front();
        }
        self.chat.push_back(message);
    }

    /// Send to everyone. A closed outbox means the peer's writer task is gone;
    /// the socket's own cleanup path removes it, so it is ignored here.
    pub fn broadcast(&self, message: &ServerMessage) {
        for participant in self.participants.values() {
            let _ = participant.outbox.send(message.clone());
        }
    }

    /// Send to everyone except `except`.
    pub fn broadcast_except(&self, except: ParticipantId, message: &ServerMessage) {
        for participant in self.participants.values() {
            if participant.id != except {
                let _ = participant.outbox.send(message.clone());
            }
        }
    }

    pub fn send_to(&self, target: ParticipantId, message: ServerMessage) -> bool {
        match self.participants.get(&target) {
            Some(participant) => participant.outbox.send(message).is_ok(),
            None => false,
        }
    }

    /// Longest-present participant, preferring existing moderators. Used to
    /// hand the room over when the host disconnects so a class is not left
    /// without anyone able to moderate.
    fn successor_host(&self) -> Option<ParticipantId> {
        self.participants
            .values()
            .min_by_key(|p| (p.role != Role::Moderator, p.joined_at, p.id))
            .map(|p| p.id)
    }
}

pub struct Config {
    pub bind: String,
    pub static_dir: String,
    pub ice_servers: Vec<serde_json::Value>,
    pub max_room_size: usize,
}

pub struct AppState {
    pub rooms: RwLock<HashMap<String, Room>>,
    pub config: Config,
}

/// Why a join was refused. Kept separate from the wire type so the socket
/// layer decides how to phrase it.
pub enum JoinError {
    InvalidRoomId,
    NameRequired,
    RoomFull(usize),
}

/// What the caller asked for at the door.
pub struct JoinRequest {
    pub name: String,
    pub create: Option<CreateOptions>,
    pub passcode: Option<String>,
    pub media: MediaState,
}

/// What the door decided.
pub enum JoinOutcome {
    Admitted(ParticipantId, Role),
    NeedPasscode { retry: bool },
    Knocking(ParticipantId),
    /// No such room, and the caller did not ask to open one.
    Missing,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self { rooms: RwLock::new(HashMap::new()), config }
    }

    /// Puts a socket through the room's door policy.
    ///
    /// The same call creates, admits, challenges or queues, because those are
    /// four answers to one question and splitting them across endpoints only
    /// moves the branching somewhere less obvious.
    pub async fn join(
        &self,
        room_id: &str,
        request: JoinRequest,
        outbox: Outbox,
    ) -> Result<JoinOutcome, JoinError> {
        if !valid_room_id(room_id) {
            return Err(JoinError::InvalidRoomId);
        }
        let name = request.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(JoinError::NameRequired);
        }

        let mut rooms = self.rooms.write().await;

        // Opening a room.
        if let Some(options) = request.create.as_ref() {
            if !rooms.contains_key(room_id) {
                let label = options
                    .room_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.chars().count() <= 80)
                    .unwrap_or(room_id)
                    .to_string();
                rooms.insert(room_id.to_string(), Room::new(room_id.to_string(), label, options));
            }
            // If it already existed, the creator joins it like anyone else and
            // the existing policy applies. Re-opening does not reset a room.
        }

        let Some(room) = rooms.get_mut(room_id) else {
            return Ok(JoinOutcome::Missing);
        };

        if room.participants.len() + room.waiting.len() >= self.config.max_room_size {
            return Err(JoinError::RoomFull(self.config.max_room_size));
        }

        // The first person through the door hosts, whatever the policy says,
        // or an approval-gated room could never be opened.
        let opening = room.participants.is_empty();

        if !opening {
            match room.settings.lock {
                RoomLock::Open => {}
                RoomLock::Passcode => {
                    if room.requires_passcode() && !room.passcode_ok(request.passcode.as_deref()) {
                        return Ok(JoinOutcome::NeedPasscode {
                            retry: request.passcode.is_some(),
                        });
                    }
                }
                RoomLock::Approval => {
                    let id = Uuid::new_v4();
                    room.waiting.push(Knocker {
                        id,
                        name: name.clone(),
                        media: request.media,
                        outbox,
                        since: now_millis(),
                    });
                    let since = room.waiting.last().map(|k| k.since).unwrap_or_else(now_millis);
                    room.notify_moderators(&ServerMessage::Knock { id, name, since });
                    return Ok(JoinOutcome::Knocking(id));
                }
            }
        }

        let role = if opening { Role::Host } else { Role::Guest };
        let id = Uuid::new_v4();
        let media = self.sanitise_media(room, role, request.media);
        room.participants.insert(
            id,
            Participant { id, name, role, media, joined_at: now_millis(), outbox },
        );
        Ok(JoinOutcome::Admitted(id, role))
    }

    /// Room policy can forbid a guest from arriving with a live microphone,
    /// so the declared state is filtered rather than trusted.
    fn sanitise_media(&self, room: &Room, role: Role, mut media: MediaState) -> MediaState {
        if !room.settings.guest_media && !role.can_moderate() {
            media.mic = false;
            media.cam = false;
            media.screen = false;
        }
        if !room.settings.allow_recording && !role.can_moderate() {
            media.recording = false;
        }
        media
    }

    /// A moderator lets somebody in. Returns their new id and role so the
    /// caller can announce them exactly as it would a normal arrival.
    pub async fn admit(
        &self,
        room_id: &str,
        actor: ParticipantId,
        target: ParticipantId,
    ) -> Option<(ParticipantId, Role)> {
        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(room_id)?;
        if !room.participants.get(&actor).is_some_and(|p| p.role.can_moderate()) {
            return None;
        }
        let index = room.waiting.iter().position(|k| k.id == target)?;
        let knocker = room.waiting.remove(index);

        let role = Role::Guest;
        let media = self.sanitise_media(room, role, knocker.media);
        room.participants.insert(
            knocker.id,
            Participant {
                id: knocker.id,
                name: knocker.name,
                role,
                media,
                joined_at: now_millis(),
                outbox: knocker.outbox,
            },
        );
        Some((knocker.id, role))
    }

    /// A moderator turns somebody away, or a knocker's socket closed.
    pub async fn withdraw_knock(
        &self,
        room_id: &str,
        target: ParticipantId,
        by_moderator: Option<ParticipantId>,
    ) -> Option<Outbox> {
        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(room_id)?;
        if let Some(actor) = by_moderator {
            if !room.participants.get(&actor).is_some_and(|p| p.role.can_moderate()) {
                return None;
            }
        }
        let index = room.waiting.iter().position(|k| k.id == target)?;
        let knocker = room.waiting.remove(index);
        room.notify_moderators(&ServerMessage::KnockWithdrawn { id: target });

        // A room whose last participant left while somebody was knocking must
        // still be cleaned up.
        if room.participants.is_empty() && room.waiting.is_empty() {
            rooms.remove(room_id);
        }
        Some(knocker.outbox)
    }

    /// Removes a participant and tells the room. Drops the room when empty,
    /// and hands the host role over when the host was the one leaving.
    pub async fn leave(&self, room_id: &str, id: ParticipantId) {
        let mut rooms = self.rooms.write().await;
        let Some(room) = rooms.get_mut(room_id) else { return };

        let Some(departed) = room.participants.remove(&id) else { return };

        if room.participants.is_empty() {
            // Anyone still at the door is told the room is gone rather than
            // left waiting on a host who has left.
            for knocker in room.waiting.drain(..) {
                let _ = knocker.outbox.send(ServerMessage::Denied {
                    reason: "The room closed before you were let in.".into(),
                });
            }
            rooms.remove(room_id);
            return;
        }

        room.broadcast(&ServerMessage::Left { id });

        if departed.role == Role::Host {
            if let Some(heir) = room.successor_host() {
                if let Some(participant) = room.participants.get_mut(&heir) {
                    participant.role = Role::Host;
                }
                room.broadcast(&ServerMessage::RoleChanged { id: heir, role: Role::Host });
            }
        }
    }
}
