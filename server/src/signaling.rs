//! WebSocket endpoint.
//!
//! One socket per participant. The socket owns no media: it carries room
//! state, chat, and opaque WebRTC payloads that the server forwards without
//! parsing. That is what keeps the server's cost per participant flat.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::protocol::{
    ChatKind, ChatMessage, ClientMessage, ModAction, ParticipantId, RevealMode, Role, ServerMessage,
};
use crate::room::{now_millis, AppState, JoinError, JoinOutcome, JoinRequest};

/// Longest chat message accepted, in characters.
const MAX_CHAT_LEN: usize = 2000;

/// Reactions are a fixed vocabulary rather than free text: the client renders
/// each one as a specific icon, and an unknown value would render as nothing.
const REACTIONS: [&str; 6] = ["thumbsup", "clap", "heart", "smile", "surprised", "question"];

/// Points accepted in a single draw frame. The client sends a few points per
/// pointer move; anything far above that is not a person drawing.
const MAX_POINTS_PER_FRAME: usize = 256;

/// Palette and pen sizes are fixed on both sides, so an index outside them is
/// a malformed client rather than a preference.
const PALETTE_LEN: u8 = 8;
const PEN_SIZES: u8 = 4;

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(move |socket| connection(socket, state))
}

async fn connection(socket: WebSocket, state: Arc<AppState>) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();
    let (outbox, mut inbox) = mpsc::unbounded_channel::<ServerMessage>();

    // Writer task: the single place that touches the socket's send half, so
    // any part of the server can enqueue a message without coordination.
    let writer = tokio::spawn(async move {
        while let Some(message) = inbox.recv().await {
            let Ok(text) = serde_json::to_string(&message) else { continue };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // A socket has no identity until it sends Join.
    let mut session: Option<(String, ParticipantId)> = None;

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            // Ping/Pong are handled by axum; binary frames are not part of the
            // protocol and are ignored rather than treated as an error.
            _ => continue,
        };

        let Ok(parsed) = serde_json::from_str::<ClientMessage>(&text) else {
            let _ = outbox.send(ServerMessage::Error {
                message: "Message could not be understood.".into(),
            });
            continue;
        };

        match (&session, parsed) {
            (None, ClientMessage::Join { room, name, create, passcode, media }) => {
                let request = JoinRequest { name, create, passcode, media };
                match state.join(&room, request, outbox.clone()).await {
                    Ok(JoinOutcome::Admitted(id, role)) => {
                        session = Some((room.clone(), id));
                        announce_join(&state, &room, id, role).await;
                    }
                    Ok(JoinOutcome::Knocking(id)) => {
                        // The socket stays open and idle until a moderator
                        // decides. Its id is the one it will keep if admitted,
                        // so the cleanup path works either way.
                        session = Some((room.clone(), id));
                        let _ = outbox.send(ServerMessage::Knocking);
                    }
                    Ok(JoinOutcome::NeedPasscode { retry }) => {
                        let _ = outbox.send(ServerMessage::NeedPasscode { retry });
                        // Deliberately not closed: the client re-sends Join
                        // with the passcode on the same socket.
                    }
                    Ok(JoinOutcome::Missing) => {
                        let _ = outbox.send(ServerMessage::RoomMissing);
                        break;
                    }
                    Err(error) => {
                        let _ = outbox.send(ServerMessage::Error { message: join_error(error) });
                        break;
                    }
                }
            }
            (None, _) => {
                let _ = outbox.send(ServerMessage::Error {
                    message: "Join the room before sending anything else.".into(),
                });
                break;
            }
            (Some((room, id)), incoming) => {
                let (room, id) = (room.clone(), *id);
                if !handle(&state, &room, id, incoming).await {
                    break;
                }
            }
        }
    }

    if let Some((room, id)) = session {
        // The socket may have been a participant or still at the door. Both
        // calls ignore an id they do not know, so there is no state to track
        // just to pick between them.
        state.withdraw_knock(&room, id, None).await;
        state.leave(&room, id).await;
    }
    drop(outbox);
    let _ = writer.await;
}

fn join_error(error: JoinError) -> String {
    match error {
        JoinError::InvalidRoomId => {
            "That room link is not valid. Room codes use letters, numbers, dashes and underscores."
                .into()
        }
        JoinError::NameRequired => "Enter a display name to join.".into(),
        JoinError::RoomFull(limit) => {
            format!("This room is full. It holds up to {limit} participants.")
        }
    }
}

/// Sends the newcomer their snapshot, then tells everyone else about them.
async fn announce_join(state: &AppState, room_id: &str, id: ParticipantId, role: Role) {
    let rooms = state.rooms.read().await;
    let Some(room) = rooms.get(room_id) else { return };
    let Some(participant) = room.participants.get(&id) else { return };

    let view = participant.view();
    let _ = participant.outbox.send(ServerMessage::Welcome {
        you: id,
        room: room.view(),
        ice_servers: state.config.ice_servers.clone(),
    });

    // Existing peers hear about the newcomer and are the ones who send the
    // WebRTC offer. Making the established peer the offerer means the two
    // sides never negotiate simultaneously.
    room.broadcast_except(id, &ServerMessage::Joined { participant: view });

    // A moderator arriving mid-session inherits the queue at the door.
    if role.can_moderate() {
        for knocker in &room.waiting {
            let _ = participant.outbox.send(ServerMessage::Knock {
                id: knocker.id,
                name: knocker.name.clone(),
                since: knocker.since,
            });
        }
    }

    if role == Role::Host {
        tracing::info!(room = room_id, %id, "room opened");
    }
}

/// Returns false when the socket should close.
async fn handle(
    state: &AppState,
    room_id: &str,
    id: ParticipantId,
    incoming: ClientMessage,
) -> bool {
    match incoming {
        ClientMessage::Join { .. } => {
            let rooms = state.rooms.read().await;
            if let Some(room) = rooms.get(room_id) {
                room.send_to(
                    id,
                    ServerMessage::Error { message: "Already in a room.".into() },
                );
            }
            true
        }

        ClientMessage::Ping => {
            let rooms = state.rooms.read().await;
            if let Some(room) = rooms.get(room_id) {
                room.send_to(id, ServerMessage::Pong);
            }
            true
        }

        // Forwarded verbatim. The server does not parse SDP or ICE.
        ClientMessage::Signal { to, payload } => {
            let rooms = state.rooms.read().await;
            if let Some(room) = rooms.get(room_id) {
                room.send_to(to, ServerMessage::Signal { from: id, payload });
            }
            true
        }

        ClientMessage::Chat { body } => {
            let body = body.trim().to_string();
            if body.is_empty() {
                return true;
            }
            let body: String = body.chars().take(MAX_CHAT_LEN).collect();

            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            let Some(sender) = room.participants.get(&id) else { return true };

            let message = ChatMessage {
                id: Uuid::new_v4(),
                from: id,
                author: sender.name.clone(),
                role: sender.role,
                body,
                at: now_millis(),
                kind: ChatKind::Text,
                poll: None,
            };
            room.push_chat(message.clone());
            room.broadcast(&ServerMessage::Chat { message });
            true
        }

        ClientMessage::Media { state: mut media } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            let settings = room.settings;
            let Some(participant) = room.participants.get_mut(&id) else { return true };
            let privileged = participant.role.can_moderate();

            // A client that hides these controls is a convenience. This is
            // the enforcement.
            if !settings.guest_media && !privileged {
                media.mic = false;
                media.cam = false;
                media.screen = false;
            }
            if !settings.allow_recording && !privileged {
                media.recording = false;
            }
            participant.media = media;
            room.broadcast(&ServerMessage::Media { id, state: media });
            true
        }

        ClientMessage::Reaction { kind } => {
            if !REACTIONS.contains(&kind.as_str()) {
                return true;
            }
            let rooms = state.rooms.read().await;
            if let Some(room) = rooms.get(room_id) {
                room.broadcast(&ServerMessage::Reaction { id, kind });
            }
            true
        }

        ClientMessage::Moderate { target, action } => {
            moderate(state, room_id, id, target, action).await;
            true
        }

        // ------------------------------------------------------------ board
        ClientMessage::Draw { id: stroke, color, width, erase, points } => {
            if color >= PALETTE_LEN || width >= PEN_SIZES || points.is_empty() {
                return true;
            }
            let points: Vec<[f32; 2]> = points
                .into_iter()
                .take(MAX_POINTS_PER_FRAME)
                // Coordinates are normalised; anything outside the board is a
                // bug or an attempt to grow the buffer with junk.
                .filter(|[x, y]| x.is_finite() && y.is_finite() && (-0.05..=1.05).contains(x) && (-0.05..=1.05).contains(y))
                .collect();
            if points.is_empty() {
                return true;
            }

            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            let Some(role) = room.participants.get(&id).map(|p| p.role) else { return true };
            if room.board.locked && !role.can_moderate() {
                return true;
            }
            if !room.board.append(id, stroke, color, width, erase, points.clone()) {
                return true;
            }
            // Only to other people: the drawer already has the ink on screen,
            // and echoing it back would make their own line lag their pointer.
            room.broadcast_except(
                id,
                &ServerMessage::Draw { from: id, id: stroke, color, width, erase, points },
            );
            true
        }

        ClientMessage::Undo { id: stroke } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if room.board.undo(id, stroke) {
                room.broadcast(&ServerMessage::Undone { id: stroke });
            }
            true
        }

        ClientMessage::BoardClear => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if !room.participants.get(&id).is_some_and(|p| p.role.can_moderate()) {
                return true;
            }
            room.board.clear();
            room.broadcast(&ServerMessage::BoardCleared { by: id });
            true
        }

        ClientMessage::BoardOpen { open } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if !room.participants.get(&id).is_some_and(|p| p.role.can_moderate()) {
                return true;
            }
            // A room created without a whiteboard does not grow one.
            if open && !room.settings.whiteboard {
                return true;
            }
            room.board.open = open;
            room.broadcast(&ServerMessage::BoardOpen { open });
            true
        }

        ClientMessage::BoardLock { locked } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if !room.participants.get(&id).is_some_and(|p| p.role.can_moderate()) {
                return true;
            }
            room.board.locked = locked;
            room.broadcast(&ServerMessage::BoardLock { locked });
            true
        }

        // ------------------------------------------------------------ polls
        ClientMessage::PollCreate { question, options, correct } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if !room.participants.get(&id).is_some_and(|p| p.role.can_moderate()) {
                return true;
            }
            let author = room.participants.get(&id).map(|p| (p.name.clone(), p.role));
            match room.add_poll(question, options, correct) {
                Ok(poll) => {
                    let poll_id = poll.id;
                    let question = poll.question.clone();
                    room.broadcast(&ServerMessage::Poll { poll });
                    if let Some((name, role)) = author {
                        let message = ChatMessage {
                            id: Uuid::new_v4(),
                            from: id,
                            author: name,
                            role,
                            body: question,
                            at: now_millis(),
                            kind: ChatKind::PollStarted,
                            poll: Some(poll_id),
                        };
                        room.push_chat(message.clone());
                        room.broadcast(&ServerMessage::Chat { message });
                    }
                }
                Err(message) => {
                    room.send_to(id, ServerMessage::Error { message: message.into() });
                }
            }
            true
        }

        ClientMessage::PollVote { poll: poll_id, option } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            let Some(poll) = room.polls.iter_mut().find(|p| p.id == poll_id) else { return true };
            if !poll.open || option >= poll.options.len() {
                return true;
            }
            // Re-voting replaces the previous choice rather than adding one.
            poll.votes.insert(id, option);
            let view = poll.view();
            room.broadcast(&ServerMessage::Poll { poll: view });
            true
        }

        ClientMessage::PollClose { poll: poll_id } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if !room.participants.get(&id).is_some_and(|p| p.role.can_moderate()) {
                return true;
            }
            let Some(poll) = room.polls.iter_mut().find(|p| p.id == poll_id) else { return true };
            poll.open = false;
            let view = poll.view();
            room.broadcast(&ServerMessage::Poll { poll: view });
            true
        }

        ClientMessage::PollReveal { poll: poll_id, mode } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            let Some(actor) = room.participants.get(&id) else { return true };
            if !actor.role.can_moderate() {
                return true;
            }
            let author = actor.name.clone();
            let author_role = actor.role;

            let Some(poll) = room.polls.iter_mut().find(|p| p.id == poll_id) else { return true };
            // Revealing ends the poll: publishing the tally while answers are
            // still open would let the last voters follow the room.
            poll.open = false;
            poll.revealed = true;
            poll.reveal_correct = matches!(mode, RevealMode::Correct | RevealMode::Both);
            let view = poll.view();
            let summary = summarise_poll(&view, mode);
            room.broadcast(&ServerMessage::Poll { poll: view });

            // The outcome lands in the chat, where the room is already
            // looking and where it stays readable after the popup is gone.
            let message = ChatMessage {
                id: Uuid::new_v4(),
                from: id,
                author,
                role: author_role,
                body: summary,
                at: now_millis(),
                kind: ChatKind::PollResults,
                poll: Some(poll_id),
            };
            room.push_chat(message.clone());
            room.broadcast(&ServerMessage::Chat { message });
            true
        }

        // ---------------------------------------------------------- the door
        ClientMessage::Admit { id: target } => {
            let Some((admitted, role)) = state.admit(room_id, id, target).await else {
                return true;
            };
            announce_join(state, room_id, admitted, role).await;
            let rooms = state.rooms.read().await;
            if let Some(room) = rooms.get(room_id) {
                room.notify_moderators(&ServerMessage::KnockWithdrawn { id: target });
            }
            true
        }

        ClientMessage::Deny { id: target } => {
            if let Some(outbox) = state.withdraw_knock(room_id, target, Some(id)).await {
                let _ = outbox.send(ServerMessage::Denied {
                    reason: "A moderator did not let you in.".into(),
                });
            }
            true
        }

        // ------------------------------------------------------- room policy
        ClientMessage::Settings { whiteboard, guest_media, allow_recording } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            if !room.participants.get(&id).is_some_and(|p| p.role.can_moderate()) {
                return true;
            }
            if let Some(value) = whiteboard {
                room.settings.whiteboard = value;
                if !value {
                    room.board.open = false;
                }
            }
            if let Some(value) = guest_media {
                room.settings.guest_media = value;
            }
            if let Some(value) = allow_recording {
                room.settings.allow_recording = value;
            }
            let settings = room.settings;
            room.broadcast(&ServerMessage::SettingsChanged { settings });

            // Withdrawing permission has to reach the people it applies to,
            // not just the moderator who changed it.
            if !settings.guest_media {
                let revoked: Vec<ParticipantId> = room
                    .participants
                    .values()
                    .filter(|p| !p.role.can_moderate() && (p.media.mic || p.media.cam || p.media.screen))
                    .map(|p| p.id)
                    .collect();
                for target in revoked {
                    if let Some(participant) = room.participants.get_mut(&target) {
                        participant.media.mic = false;
                        participant.media.cam = false;
                        participant.media.screen = false;
                        let state = participant.media;
                        room.broadcast(&ServerMessage::Media { id: target, state });
                    }
                }
            }
            if !room.board.open {
                room.broadcast(&ServerMessage::BoardOpen { open: false });
            }
            true
        }
    }
}

/// Turns a revealed poll into the line that goes into the chat.
fn summarise_poll(poll: &crate::protocol::PollView, mode: RevealMode) -> String {
    let mut lines = vec![format!("Poll results — {}", poll.question)];

    if matches!(mode, RevealMode::Counts | RevealMode::Both) {
        for (index, option) in poll.options.iter().enumerate() {
            let count = poll.counts.get(index).copied().unwrap_or(0);
            let share = if poll.total == 0 { 0 } else { count * 100 / poll.total };
            let mark = if poll.correct == Some(index) { " (correct)" } else { "" };
            lines.push(format!("{share}%  {option}{mark}"));
        }
        lines.push(match poll.total {
            1 => "1 vote".to_string(),
            n => format!("{n} votes"),
        });
    } else if let Some(index) = poll.correct {
        if let Some(option) = poll.options.get(index) {
            lines.push(format!("The answer was: {option}"));
        }
    }

    lines.join("\n")
}

async fn moderate(
    state: &AppState,
    room_id: &str,
    actor: ParticipantId,
    target: ParticipantId,
    action: ModAction,
) {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(room_id) else { return };

    let Some(actor_role) = room.participants.get(&actor).map(|p| p.role) else { return };
    if !actor_role.can_moderate() || actor == target {
        return;
    }
    let Some(target_role) = room.participants.get(&target).map(|p| p.role) else { return };
    // The host is not actionable by anyone, including other moderators.
    if target_role == Role::Host {
        return;
    }

    match action {
        // Advisory: the client mutes itself. The server cannot switch off a
        // microphone it has no connection to, so it does not pretend to.
        ModAction::RequestMute => {
            room.send_to(target, ServerMessage::Moderated { by: actor, action });
        }

        ModAction::Remove => {
            room.send_to(target, ServerMessage::Moderated { by: actor, action });
            if room.participants.remove(&target).is_some() {
                room.broadcast(&ServerMessage::Left { id: target });
            }
        }

        // Only the host changes who can moderate.
        ModAction::PromoteModerator | ModAction::DemoteModerator => {
            if actor_role != Role::Host {
                return;
            }
            let role = if matches!(action, ModAction::PromoteModerator) {
                Role::Moderator
            } else {
                Role::Guest
            };
            if let Some(participant) = room.participants.get_mut(&target) {
                participant.role = role;
            }
            room.broadcast(&ServerMessage::RoleChanged { id: target, role });
        }
    }
}
