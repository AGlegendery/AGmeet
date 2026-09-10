//! AGmeet server.
//!
//! Serves the built client and a WebSocket endpoint for room signalling.
//! Media is peer-to-peer, so this process stays flat under load: it holds a
//! socket and a little state per participant and forwards small JSON frames.

mod protocol;
mod room;
mod signaling;

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use room::{valid_room_id, AppState, Config};

/// What a prospective joiner is told about a room before entering it.
///
/// Deliberately thin: whether it exists, what it is called, how many people
/// are in it, and what the door asks for. Enough to label a button honestly
/// and no more — the participant list is nobody's business until they are in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomInfo {
    exists: bool,
    name: Option<String>,
    lock: Option<protocol::RoomLock>,
    participants: usize,
    /// Somebody is at the door. Lets the client say "the host has been asked"
    /// rather than leaving an approval-gated room looking broken.
    waiting: usize,
}

async fn room_info(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Json<RoomInfo> {
    if !valid_room_id(&id) {
        return Json(RoomInfo { exists: false, name: None, lock: None, participants: 0, waiting: 0 });
    }
    let rooms = state.rooms.read().await;
    Json(match rooms.get(&id) {
        Some(room) => RoomInfo {
            exists: true,
            name: Some(room.name.clone()),
            lock: Some(room.settings.lock),
            participants: room.participants.len(),
            waiting: room.waiting.len(),
        },
        None => RoomInfo { exists: false, name: None, lock: None, participants: 0, waiting: 0 },
    })
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

/// ICE servers are supplied as a JSON array so any RTCIceServer field
/// (`urls`, `username`, `credential`) can be passed through untouched.
///
/// An empty list is a valid configuration: peers on the same network connect
/// using host candidates alone. See the README for adding STUN/TURN.
fn ice_servers() -> Vec<serde_json::Value> {
    let raw = env_or("AGMEET_ICE_SERVERS", "");
    if raw.trim().is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
        Ok(servers) => servers,
        Err(error) => {
            tracing::error!(%error, "AGMEET_ICE_SERVERS is not a JSON array; ignoring it");
            Vec::new()
        }
    }
}

fn config() -> Config {
    let max_room_size = env_or("AGMEET_MAX_ROOM_SIZE", "16")
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .unwrap_or(16);

    Config {
        bind: env_or("AGMEET_BIND", "0.0.0.0:8080"),
        static_dir: env_or("AGMEET_STATIC_DIR", "web/dist"),
        ice_servers: ice_servers(),
        max_room_size,
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("AGMEET_LOG")
                .unwrap_or_else(|_| "agmeet_server=info,tower_http=warn".into()),
        )
        .init();

    let config = config();
    let bind = config.bind.clone();
    let static_dir = config.static_dir.clone();
    let max_room_size = config.max_room_size;
    let ice_count = config.ice_servers.len();

    // Every unmatched path falls back to index.html so a shared room link
    // opens the client directly instead of 404ing.
    let index = ServeFile::new(format!("{static_dir}/index.html"));
    let assets = ServeDir::new(&static_dir).fallback(index);

    let state = Arc::new(AppState::new(config));

    let app = Router::new()
        .route("/ws", get(signaling::upgrade))
        .route("/api/room/{id}", get(room_info))
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .with_state(state)
        .fallback_service(assets)
        .layer(CompressionLayer::new())
        // getUserMedia and getDisplayMedia require a secure context. This
        // header does not create one; it prevents the page from being framed
        // by another origin. Serve over HTTPS in production.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("SAMEORIGIN"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ));

    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, bind = %bind, "could not bind");
            std::process::exit(1);
        }
    };

    tracing::info!(
        bind = %bind,
        static_dir = %static_dir,
        max_room_size,
        ice_servers = ice_count,
        "AGmeet is listening"
    );
    if ice_count == 0 {
        tracing::info!(
            "no ICE servers configured: peers will connect on the local network only"
        );
    }

    let server = axum::serve(listener, app).with_graceful_shutdown(shutdown());
    if let Err(error) = server.await {
        tracing::error!(%error, "server stopped");
    }
}

async fn shutdown() {
    let interrupt = async {
        tokio::signal::ctrl_c().await.ok();
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
    tracing::info!("shutting down");
}
