# AGmeet

A self-hosted meeting and online-class platform. Video and audio travel
directly between browsers; the server carries signalling only. That is what
lets it run on a small VPS and start in milliseconds.

- **Rust server** — one static binary, ~1.7 MB, no database, no external
  services.
- **No frontend framework** — ~15 KB of JavaScript over the wire, gzipped.
- **Peer-to-peer media** — the server never sees or forwards a video frame.
- **Nothing to install** — participants open a link.

## Quick start

```bash
# 1. Build the client
cd web && npm install && npm run build && cd ..

# 2. Build and run the server
cd server && cargo build --release && cd ..
AGMEET_STATIC_DIR=web/dist ./server/target/release/agmeet-server
```

Open <http://localhost:8080>. To try it with two participants, open the room
link in a second browser window.

With Docker:

```bash
docker compose up --build
```

### Development

```bash
# Terminal 1 — the server
cd server && cargo run

# Terminal 2 — the client, with hot reload and a proxy to the server
cd web && npm run dev
```

## Configuration

Everything is an environment variable; there is no config file to manage.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGMEET_BIND` | `0.0.0.0:8080` | Address to listen on. |
| `AGMEET_STATIC_DIR` | `web/dist` | Directory holding the built client. |
| `AGMEET_MAX_ROOM_SIZE` | `16` | Participants allowed in one room. |
| `AGMEET_ICE_SERVERS` | *(empty)* | JSON array of `RTCIceServer` objects. |
| `AGMEET_LOG` | `agmeet_server=info` | `tracing` filter. |

### HTTPS is not optional in production

Browsers only release the camera and microphone in a **secure context**:
HTTPS, or `localhost`. Over plain HTTP on a LAN address the lobby will say so
rather than fail silently, but nobody will be able to join with media.

Put AGmeet behind a reverse proxy that terminates TLS and forwards both `/`
and `/ws`. With Caddy that is two lines:

```
meet.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

### ICE, STUN and TURN

An empty `AGMEET_ICE_SERVERS` is correct on a single network: peers find each
other with host candidates alone. Across the internet they need help.

```bash
AGMEET_ICE_SERVERS='[
  {"urls":"stun:turn.example.org:3478"},
  {"urls":"turn:turn.example.org:3478","username":"agmeet","credential":"..."}
]'
```

`docker-compose.yml` carries a commented-out `coturn` service to run your own.
Nothing here depends on a third-party STUN or TURN provider.

## How many people fit in a room

Media is a full mesh: each participant sends one copy of their stream to every
other participant. The **server** cost is flat and tiny no matter what — it
moves small JSON frames. The limit is each participant's **uplink**.

| Cameras on | Uplink needed per participant | Verdict |
| --- | --- | --- |
| 4 | ~3 Mbit/s | comfortable |
| 8 | ~7 Mbit/s | fine on most connections |
| 12+ | ~11 Mbit/s and rising | a class where only the teacher has video |

For a classroom of thirty with one camera and thirty listeners, the mesh is
the *right* shape: the teacher sends thirty streams, everyone else sends
almost nothing. For thirty simultaneous cameras it is the wrong shape, and
you want an SFU — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for where
that would slot in.

## Keyboard

| Key | Action |
| --- | --- |
| <kbd>M</kbd> | Microphone |
| <kbd>V</kbd> | Camera |
| <kbd>H</kbd> | Raise or lower hand |
| <kbd>C</kbd> | Chat |
| <kbd>P</kbd> | Participants |
| <kbd>Esc</kbd> | Close the open menu |

Keys are ignored while a text field has focus.

## Tests

The tests drive two real Chromium peers against a running server, so they
exercise the actual WebRTC path rather than a mock.

```bash
# with the server running on :8080 and the client built
cd tests && npm install && npx playwright install chromium && npm test
```

Two environment variables, both optional: `AGMEET_URL` to point at a server
somewhere other than `http://127.0.0.1:8080`, and `CHROMIUM_PATH` to use a
Chromium that is already on the machine instead of downloading one.

`meeting.test.mjs` covers joining, peer-to-peer video, chat, media state,
moderation, the adaptive grid and the mobile layout. `accessibility.test.mjs`
composites every glass layer to check text contrast against WCAG AA, and
verifies that every control is keyboard reachable and named.

## Project layout

```
server/          Rust: signalling, room state, static file serving
  src/protocol.rs  the wire format, mirrored by web/src/types.ts
  src/room.rs      in-memory room registry
  src/signaling.rs the WebSocket endpoint
web/             TypeScript client, no framework
  src/rtc.ts       the peer mesh
  src/media.ts     devices, screen capture, speech detection
  src/styles/      the design system, tokens first
  src/ui/          stage, dock, panel, lobby, shell
tests/           browser tests
docs/            architecture and design notes
```

## Licence

MIT — see [LICENSE](LICENSE).

> Chosen so the project is as easy as possible to adopt and fork. If you would
> rather stop a hosted fork being closed up, AGPL-3.0 is the usual choice for
> self-hosted network software: replace `LICENSE` with the text from
> <https://www.gnu.org/licenses/agpl-3.0.txt> and set `license` to
> `"AGPL-3.0-or-later"` in `server/Cargo.toml` and `web/package.json`.
