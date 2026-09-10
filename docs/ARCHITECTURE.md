# Architecture

## The one decision everything follows from

Media never touches the server.

A meeting server that forwards video is the expensive part of every
conferencing product: it terminates every stream, decides who receives what,
and its cost grows with the square of the participants. AGmeet does not have
one. Browsers connect directly to each other over WebRTC and the server
carries signalling — small JSON frames — over a WebSocket.

The consequences run through the whole system:

- No media pipeline, so no GPU, no bandwidth budget, no autoscaling.
- No database. Rooms exist while someone is in them and are dropped when the
  last participant leaves.
- The server holds a socket and roughly 200 bytes of state per participant.
- Cold start is a process exec.

The cost lands on the participants' uplinks instead, which is the trade
described in the README.

## Components

```
browser A ──── WebSocket (signalling, chat, room state) ────┐
    │                                                        │
    │  ◄── WebRTC: audio, camera, screen ──►                 ▼
    │                                                  agmeet-server
browser B ──── WebSocket ───────────────────────────────────┘
```

`server/src/protocol.rs` is the single definition of the wire format;
`web/src/types.ts` mirrors it by hand. Both use a `t` discriminator so each
side switches on one field. Signalling payloads (`SDP`, ICE candidates) pass
through the server as opaque JSON — it never parses them.

## The mesh

`web/src/rtc.ts`. Two decisions make it simple enough to trust.

**A deterministic offerer.** The server tells existing participants when
somebody joins; the newcomer only receives a snapshot. The peer that was
already in the room makes the offer. Because the roles can never be
symmetric, there is no negotiation glare and no need for the "perfect
negotiation" dance.

**Three transceivers, created up front, in a fixed order.**

| mid | kind | carries |
| --- | --- | --- |
| `0` | audio | microphone |
| `1` | video | camera |
| `2` | video | screen share |

Both sides agree on what each `mid` means, so a received track needs no extra
signalling to be routed. More usefully, media is attached and removed with
`replaceTrack`, which needs **no renegotiation at all**: muting, unmuting and
starting a screen share never re-run the offer/answer exchange, so tiles never
flicker and a screen share appears immediately.

Two details are load-bearing and were both bugs before they were fixed:

- `transceiver.mid` is `null` until a description has been applied. Attaching
  tracks before `setLocalDescription` matches nothing, and the offer goes out
  carrying no media.
- Applying a remote offer creates the answerer's transceivers as `recvonly`,
  because nothing is attached to them yet, and `replaceTrack` does not change
  a direction that is already set. The direction has to be asserted back to
  `sendrecv` before `createAnswer`, or that peer receives everything and sends
  nothing.

## Speech detection

Two mechanisms, chosen for cost.

- **Local**: an `AnalyserNode` on the local stream, with hysteresis and a hold
  window so the ring does not strobe between words.
- **Remote**: `RTCRtpReceiver.getSynchronizationSources()`, which carries the
  sender's own audio-level RTP header extension. One cheap poll covers every
  peer. The alternative — an `AudioContext` and analyser per participant —
  would mean N Web Audio graphs running continuously just to draw a ring.

Neither involves the server, so the active-speaker ring reacts at the speed of
the audio rather than a round trip.

## The adaptive grid

`web/src/ui/stage.ts`. CSS cannot do this: `auto-fit` does not know the
container's height and leaves the last row half empty.

The layout pass tries every column count from 1 to N, computes the resulting
tile size under a 16:9 constraint, and keeps the largest. It then publishes
both the count and the **exact pixel size** as custom properties. Publishing
the size matters: letting tiles stretch to a `1fr` column makes
`aspect-ratio` force a height the stage may not have, and the final row hangs
off the bottom behind the dock.

The tiles then lay out as a wrapping flex row, which centres a trailing
partial row — a grid would leave a hole beside the last tile.

## The whiteboard

`web/src/ui/board.ts`, `server/src/room.rs`.

Strokes travel over the same WebSocket as everything else, not over WebRTC
data channels. In a mesh a data channel would mean sending every stroke N
times and reconciling N arrival orders; through the server there is one
ordering, one buffer, and a late joiner gets the board by asking for it.

**Every coordinate is normalised to 0..1** against the board's own box before
it is sent. Nothing on the wire is in pixels. A stroke drawn on a phone lands
in the same place on a projector, and resizing the window reflows the drawing
rather than cropping it.

Points are sent while the pointer moves, batched one frame at a time, so
other people watch a line being drawn instead of waiting for it to appear
finished. The drawer is excluded from that broadcast: they already have the
ink on screen, and echoing it back would make their own line lag the pointer.

Three rules keep a shared append-only buffer safe:

- Strokes are owned. Appending to a stroke id somebody else created is
  refused, so a client cannot extend another participant's line by guessing
  an id, and undo only ever removes your own work.
- Everything is bounded — strokes per room, points per stroke, points per
  frame — and the oldest stroke is dropped rather than the board refusing to
  work.
- Colour and width are indices into fixed palettes, not free values. The wire
  stays small and a client cannot invent an unreadable colour.

A classroom board starts **locked**, so only the teacher draws until they
open it; any other room starts unlocked. Thirty people drawing at once is not
a lesson.

Erasing uses `destination-out` rather than painting the background colour.
The board is translucent over the stage, so a background-coloured stroke
would show as a smear.

## Polls

Votes are stored per participant so a second vote replaces the first, but
**only totals ever leave the server**. Nobody — including the host — can see
who chose what. A classroom poll people are afraid to answer tells you
nothing.

Participants see the tally only after they answer, or once the poll closes:
showing it first would steer the vote. Moderators see it immediately, because
they are running the poll, and making a teacher vote in their own question to
read the room is absurd.

## Room policy is enforced where the state changes

`server/src/signaling.rs`.

A client that hides a control is a convenience. The enforcement is in the
handler that mutates the state: a guest's `Media` update has `mic`, `cam` and
`screen` forced to false when the room forbids guest media, `recording` is
cleared when the room forbids it, and `BoardOpen` is refused outright in a
room created without a whiteboard. Withdrawing permission mid-session also
reaches the people it applies to — their media is cleared and rebroadcast —
rather than only greying out a button on the moderator's screen.

The passcode is hashed with SHA-256 on arrival and compared in constant time.
The room holds only the digest, so a memory dump or a stray log line cannot
hand out the credential, and it dies with the room like everything else.

### Capability is not Role

`Role` is who owns the room — host, moderator, guest — and decides who may
moderate whom. `Capability` is what a participant may *do*: microphone,
camera, screen, whiteboard, chat, attachments, moderation. They are checked
independently, because they answer different questions. A host always
moderates, whatever template they signed in under; a guest signed in as an
operator moderates too.

Declared media is filtered through both the room's policy and the person's own
capabilities, in that order, every time it changes. So a presenter whose role
carries no microphone cannot acquire one by editing a message, and neither can
a viewer by opening a second socket and signing in again.

An attachment is refused the same way: `caps.upload` is checked in the handler
that stores it, and the refusal is a message back to the sender rather than a
silent drop, so a client that shows the control by mistake still explains
itself.

A caution worth writing down: `#[serde(rename_all = "camelCase")]` on an enum
renames the **variants**, not the fields inside them. `Settings { guest_media }`
therefore never matched the `guestMedia` the client sent, and the setting
silently did nothing. Both message enums now carry `rename_all_fields` as
well.

## Moderation is advisory where it has to be

The server cannot switch off a microphone it has no connection to, so it does
not pretend to. `RequestMute` is delivered to the target, and the client mutes
itself. `Remove` is enforced: the participant is dropped from the room server
side as well as told.

The host is not actionable by anyone, including other moderators, and only the
host can change who moderates. When the host disconnects the role passes to
the longest-present moderator, or failing that the longest-present
participant, so a class is never left without anyone able to moderate.

## When the mesh is the wrong shape

Past roughly eight simultaneous cameras, each participant's uplink becomes the
limit. The fix is a Selective Forwarding Unit: every peer sends **one** stream
up, and the SFU forwards copies.

The current design leaves a clean seam for it. `PeerMesh` is the only module
that knows about `RTCPeerConnection`, and it already speaks a small interface
to the rest of the app (`onTrack`, `onAudio`, `onQuality`, `onSignal`). An SFU
client would implement the same interface against a single peer connection to
the server. The protocol needs one addition — a way to say "connect to the
SFU" instead of "connect to these peers" — and nothing above `rtc.ts` changes.

The server side is the larger piece of work. `webrtc-rs` would keep it in
process; `mediasoup` or LiveKit would be a second service. Either way it
should stay **optional**, selected per deployment, so a small install keeps
paying nothing for capacity it does not use.

## Liquid glass, and what it costs

`web/src/glass.ts`.

[`@ybouane/liquidglass`](https://github.com/ybouane/liquidglass) (MIT) is not
`backdrop-filter`. It rasterises the scene behind each panel onto a canvas and
runs a WebGL fragment shader over it — refraction, a bevel, a rim, a shadow —
every frame. That is why it looks like a material rather than a blurred
rectangle, and why it cannot simply be switched on for everyone.

**Three structural facts decided the integration.**

*Panels must be direct children of the root they refract.* That rules out the
sidebar, header and side panel: refracting those would mean making the whole
app the root and rasterising all of it every frame, to no benefit — they are
large and they sit still. Only genuinely floating bars are handed over: the
control dock, the whiteboard toolbar, and the lobby's camera controls.

*The renderer composites the root's children, not the root's own background.*
The stage used to paint its surface on itself, with the page's atmospheric
gradient behind it on `body::before`. Neither is a child, so the dock was
refracting an empty canvas and came out white with invisible icons. The fix
is `.stage__ground`: the stage's surface moved into a real child element that
the renderer can sample. It also carries a soft pool of light under the dock,
because glass only reads as glass when there is something behind it to bend.

*Nested video still gets the fast path.* A direct `img`/`video`/`canvas` child
is drawn with `drawImage`; a wrapper is walked for media descendants which are
also drawn directly, and only the wrapper's HTML chrome goes through
`html-to-image`, cached until it changes. Our videos are two levels down
inside `.stage__grid` and are handled correctly. The lobby's camera preview is
the best subject in the product — live video directly behind a floating pill.

**Matte is mostly subtraction.** The library's defaults are a glossy lens:
strong Fresnel, a specular hotspot, chromatic fringing. Removing the specular
and most of the Fresnel kills the two things that read as "polished", dropping
the fringing removes the last of it, and pushing `blurAmount` to 0.82 makes
the panel frost what is behind it instead of magnifying it. What remains is
refraction at the bevel and a soft rim, which is what thick sandblasted glass
actually does.

**The tier is earned, not assumed.** Detection runs before anything is
downloaded and the shader bundle is a lazy import reached only on the top
tier, so a weak client fetches one JavaScript file and never learns the other
exists. Software renderers (SwiftShader, llvmpipe) are detected through
`WEBGL_debug_renderer_info` and sent straight to `minimal`, as is anyone who
asked for reduced motion.

Then the guess is checked against reality. Capability flags describe hardware;
they cannot know the machine is also running a build, or that the room has
twelve cameras in it. The renderer publishes a measured `fps`, which is
sampled once a second; four consecutive seconds under 26 fps takes every
surface back to CSS glass and records the demotion for the session, because a
machine that failed once will fail again. All of it is client-side: the server
never learns a tier exists.

## Deliberate non-goals

- **No user accounts.** There is no sign-up, no profile and no identity that
  outlives a room. A room may hold its own roster — usernames, password
  digests and a role each — but that roster is part of the room and dies with
  it. For a class that meets weekly, the operator recreates it, or puts the
  deployment behind their own authentication.
- **No persistence.** Nothing is written to disk. Chat, attachments, the
  whiteboard and polls live in memory, each bounded, and all go when the room
  empties. An export button on the board would be a reasonable first thing to
  add.
- **No server-side recording.** Recording is local: the stage is composited
  onto a canvas, the audio mixed in the browser, and the WebM handed to the
  person who started it. Recording *through the server* would need a media
  server, which is the thing this design exists to avoid.
- **No third-party services.** The only external dependency a deployment can
  need is a TURN server, and you run that yourself.

## Two themes, one neutral

`web/src/styles/tokens.css`.

The neutral family is graphite — a true grey with no blue cast — so the
interface reads as a piece of hardware rather than a dark blue app, and violet
is reserved for action. Both themes share the accent and the shape, spacing,
type and motion scales; only the surface and text roles change.

The light theme is not an inversion. The greys stay graphite, the glass
becomes a white frost rather than a dark one, and the accent darkens so it
still carries white text: `#8b5cf6` gives white only 4.23:1, which is why the
colour that *fills* a control is `#7c3aed` at 5.7:1 while the lighter violet
survives as `--accent-bright` for text and glows on dark surfaces, where it is
never behind text.

Two things stay dark in both themes on purpose: video tiles and the
whiteboard. A light frame around a camera feed is glare, and light ink on a
dark board is what a projector actually shows well.

`tests/accessibility.test.mjs` composites every glass layer and audits both
themes across the dashboard and the meeting.

## Design system

`web/src/styles/tokens.css` is the single source of colour, glass, depth,
shape, type and motion. Screens compose those tokens; they do not invent
values.

Glass has four levels, chosen by an element's role rather than by how it
should look: the application surface, floating panels, dialogs and menus, and
critical floating controls. Each step is lighter, more blurred, brighter at
the edge and more deeply shadowed, so depth is legible without borders.

Two rules keep it readable:

- Text alphas are set so every level that carries meaning clears 4.5:1 on the
  glass it sits on. `--text-faint` does not, and is therefore decorative only.
- Where `backdrop-filter` is unsupported, the surfaces become **opaque**
  rather than merely less blurred, so text never lands on video.

`tests/accessibility.test.mjs` composites every layer and enforces the first
rule against the running app.
