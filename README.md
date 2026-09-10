# AGmeet

A self-hosted meeting and online-class platform. Video and audio travel
directly between browsers; the server carries signalling only. That is what
lets it run on a small VPS and start in milliseconds.

- **Rust server** — one static binary, ~1.7 MB, no database, no external
  services.
- **No frontend framework** — ~15 KB of JavaScript over the wire, gzipped.
- **Peer-to-peer media** — the server never sees or forwards a video frame.
- **Nothing to install** — participants open a link.
- **Classroom tools** — a shared whiteboard, polls that pop up and report back
  to the chat, and local recording you download or discard.
- **Room policy** — open, passcode, or admit each arrival by hand; guests'
  cameras and recording are the operator's call, enforced by the server.
- **Light and dark** — graphite neutrals, violet for action, both themes
  contrast-checked.
- **Liquid glass, if the machine can afford it** — a real WebGL refraction
  shader on the floating bars, gated on the client's capabilities and its
  measured frame rate.

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

## How a room works

There is no account and no sidebar. Everything you decide happens before you
are in a room:

1. **Dashboard** — open a room (name, code, door policy, whiteboard, guest
   media, recording), or join one by code or by pasting a link.
2. **Lobby** — check the camera and microphone, and meet the door. A passcode
   room asks for one here; an approval room says **Ask to join the room**
   rather than *Join*, and waits.
3. **Room** — the stage takes the whole window. The only things left to
   configure are the room itself and the appearance, and both are in the
   header.

A room exists while someone is in it. Its code is its link, so
`https://your-server/r/std-sr2-rrp` is all anybody needs.

### The door

| Policy | What happens |
| --- | --- |
| Open | Anyone with the link walks in. |
| Passcode | Everyone is asked for a shared code, hashed with SHA-256 on arrival and never stored in the clear. |
| Ask to join | A moderator admits or refuses each arrival. The joiner is told they are waiting, not left on a spinner. |

The first person through the door hosts, whatever the policy says — otherwise
an approval-gated room could never be opened.

### Recording

Recording happens on the recorder's own machine: the stage is composited onto
a canvas, the audio is mixed in the browser, and the result is a WebM you
either download or discard when you stop. **Nothing is uploaded and nothing is
stored on the server** — the room is only told that it is being recorded, so
everybody can see the indicator. Whether anyone but a moderator may record is
a room setting.

### Polls

A poll pops up over the stage and can always be dismissed. Answering closes
it, and a notice stays in the chat so anyone can go back in and change their
answer until the operator ends the poll. Ending it locks the answers;
revealing publishes the tally, the correct option, or both, into the chat
where the room is already looking. Votes are counted, never attributed.

## Visual tiers

The floating bars — the meeting control dock, the whiteboard toolbar, the
lobby's camera controls — can be rendered with a genuine refraction shader
([`@ybouane/liquidglass`](https://github.com/ybouane/liquidglass), MIT) rather
than a CSS blur. It is beautiful and it is not free, so it is earned:

| Tier | What runs | Who gets it |
| --- | --- | --- |
| `full` | WebGL liquid glass on the floating bars | WebGL2, a real GPU, 4+ cores, >4 GB, pointer device |
| `enhanced` | CSS `backdrop-filter`, the standard look | Mobile, few cores, modest memory |
| `minimal` | Opaque surfaces, no blur anywhere | Software renderers, reduced-motion, slow displays |

Three things make this safe on old hardware:

1. **The tier is decided before anything is downloaded.** The 17 KB shader
   bundle is a lazy import reached only on `full`; a weak client fetches one
   JavaScript file and never learns the other exists.
2. **`minimal` removes blur rather than reducing it.** A 2px backdrop blur
   costs nearly what a 32px one does and looks like a mistake, so that tier
   goes flat and opaque instead.
3. **A watchdog overrules the guess.** Capability flags describe hardware;
   they cannot know this laptop is also running a build, or that this room
   has twelve cameras in it. The renderer's measured frame rate is sampled
   once a second, and four consecutive seconds under 26 fps drops every
   surface back to CSS glass for the rest of the session.

None of it reaches the server. The tier is a property of the browser in front
of it.

To pin a tier yourself:

```js
localStorage.setItem("agmeet.glass", "full"); // or "enhanced" / "minimal"
```

## Keyboard

| Key | Action |
| --- | --- |
| <kbd>M</kbd> | Microphone |
| <kbd>V</kbd> | Camera |
| <kbd>H</kbd> | Raise or lower hand |
| <kbd>C</kbd> | Chat |
| <kbd>P</kbd> | Participants |
| <kbd>O</kbd> | Polls |
| <kbd>B</kbd> | Whiteboard (hosts and moderators) |

Appearance and room policy live in the room header. The theme is dark by
default rather than following the OS: a stage is mostly video, and video sits
better on a dark ground.
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

`room.test.mjs` covers the dashboard, the three door policies, guest-media
policy, recording, and both themes. `glass.test.mjs` asserts that a weak client resolves to a lower tier and
never requests the shader bundle, and that a forced `full` client renders the
shader canvas. `meeting.test.mjs` covers joining, peer-to-peer video, chat, media state,
moderation, the adaptive grid and the mobile layout. `classroom.test.mjs`
covers the whiteboard and polls, reading the canvas pixels on the receiving
side to prove ink actually crossed the wire. `accessibility.test.mjs`
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
  src/glass.ts     capability tiers, lazy loading, the frame-rate watchdog
  src/recorder.ts  local canvas + audio recording
  src/theme.ts     light and dark
  src/ui/          dashboard, lobby, shell, stage, dock, panel, board, polls
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
