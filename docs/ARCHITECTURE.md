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

## Deliberate non-goals

- **No accounts.** Room codes are the access control. Anyone with the code and
  the address can join. Put it behind your own authentication if that is not
  enough.
- **No persistence.** Nothing is written to disk. Chat lives in memory,
  bounded to the last 200 messages per room, and is gone when the room empties.
- **No recording.** It would need a media server, which is the thing this
  design exists to avoid.
- **No third-party services.** The only external dependency a deployment can
  need is a TURN server, and you run that yourself.

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
