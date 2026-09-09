//! In-memory room registry.
//!
//! Rooms exist only while someone is in them: the last participant to leave
//! takes the room with them. That keeps a small deployment at zero idle cost
//! and removes the need for a database entirely.

use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::protocol::{
    ChatMessage, MediaState, ParticipantId, ParticipantView, Role, RoomView, ServerMessage,
};

/// Chat kept per room so a late joiner sees recent context. Bounded so a
/// long-running room cannot grow without limit.
const CHAT_HISTORY: usize = 200;

pub type Outbox = mpsc::UnboundedSender<ServerMessage>;

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

pub struct Room {
    pub id: String,
    pub name: String,
    pub classroom: bool,
    pub started_at: u64,
    pub participants: HashMap<ParticipantId, Participant>,
    chat: VecDeque<ChatMessage>,
}

impl Room {
    fn new(id: String, name: String, classroom: bool) -> Self {
        Self {
            id,
            name,
            classroom,
            started_at: now_millis(),
            participants: HashMap::new(),
            chat: VecDeque::new(),
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
            classroom: self.classroom,
            participants,
            chat: self.chat.iter().cloned().collect(),
        }
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

impl AppState {
    pub fn new(config: Config) -> Self {
        Self { rooms: RwLock::new(HashMap::new()), config }
    }

    /// Adds a participant, creating the room if this is the first arrival.
    /// Returns the participant's assigned role and a snapshot of the room as
    /// it looked *before* they were added, so the caller can announce them.
    pub async fn join(
        &self,
        room_id: &str,
        room_name: Option<String>,
        classroom: bool,
        name: String,
        media: MediaState,
        outbox: Outbox,
    ) -> Result<(ParticipantId, Role), JoinError> {
        if !valid_room_id(room_id) {
            return Err(JoinError::InvalidRoomId);
        }
        let name = name.trim().to_string();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(JoinError::NameRequired);
        }

        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(room_id.to_string()).or_insert_with(|| {
            let label = room_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.chars().count() <= 80)
                .unwrap_or(room_id)
                .to_string();
            Room::new(room_id.to_string(), label, classroom)
        });

        if room.participants.len() >= self.config.max_room_size {
            return Err(JoinError::RoomFull(self.config.max_room_size));
        }

        // First arrival hosts. Everyone after is a guest until promoted.
        let role = if room.participants.is_empty() { Role::Host } else { Role::Guest };
        let id = Uuid::new_v4();
        room.participants.insert(
            id,
            Participant { id, name, role, media, joined_at: now_millis(), outbox },
        );
        Ok((id, role))
    }

    /// Removes a participant and tells the room. Drops the room when empty,
    /// and hands the host role over when the host was the one leaving.
    pub async fn leave(&self, room_id: &str, id: ParticipantId) {
        let mut rooms = self.rooms.write().await;
        let Some(room) = rooms.get_mut(room_id) else { return };

        let Some(departed) = room.participants.remove(&id) else { return };

        if room.participants.is_empty() {
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
