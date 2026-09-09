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
    ChatMessage, ClientMessage, ModAction, ParticipantId, Role, ServerMessage,
};
use crate::room::{now_millis, AppState, JoinError};

/// Longest chat message accepted, in characters.
const MAX_CHAT_LEN: usize = 2000;

/// Reactions are a fixed vocabulary rather than free text: the client renders
/// each one as a specific icon, and an unknown value would render as nothing.
const REACTIONS: [&str; 6] = ["thumbsup", "clap", "heart", "smile", "surprised", "question"];

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
            (None, ClientMessage::Join { room, room_name, name, classroom, media }) => {
                match state
                    .join(&room, room_name, classroom, name, media, outbox.clone())
                    .await
                {
                    Ok((id, role)) => {
                        session = Some((room.clone(), id));
                        announce_join(&state, &room, id, role).await;
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
            };
            room.push_chat(message.clone());
            room.broadcast(&ServerMessage::Chat { message });
            true
        }

        ClientMessage::Media { state: media } => {
            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(room_id) else { return true };
            let Some(participant) = room.participants.get_mut(&id) else { return true };
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
    }
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
