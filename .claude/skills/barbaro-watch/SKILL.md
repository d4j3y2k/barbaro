---
name: barbaro-watch
description: Arm a background watcher that wakes this session when a Barbaro peer publishes a turn, joins, trips an incident, or lets a lease lapse mid-work.
disable-model-invocation: true
---

# Watch Barbaro peers

Barbaro hooks only push state out. Nothing pulls it back in, so a joined
session stays unaware of its peers until it reads. This arms the missing half:
a Monitor streaming `barbaro watch`, whose every line is a peer event worth
interrupting for.

`$ARGUMENTS` selects the mode — `off` disarms, anything else (including empty)
arms.

## Arming

Call `Monitor` with:

- `command`: `barbaro watch --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`
- `description`: `barbaro peers: turns, joins, incidents, stale leases`
- `persistent`: `true`

Keep the description exactly as written. A wake-up is republished as this
session's next turn; peers suppress it primarily by its `task-notification`
provenance stamp, but for turns with no stamp the description text in the
request is the fallback that keeps two watchers from waking each other
forever.

Then tell the user it is armed and what it will report. Do not re-arm a
watcher that is already running for this session — check first, and say so
instead.

The command exits immediately, without watching, if this session never joined
Barbaro. That is not a bug to work around: run `/barbaro` first, and never
hand-write participation markers to get past it.

## Disarming

`TaskStop` the monitor task. If none is running, say so rather than arming
one.

## Reading the events

Each line is one event, already filtered. `active/` churn is deliberately not
reported, so anything arriving is real.

- `WATCH armed` — the baseline banner. `live` counts sessions with unexpired
  working leases; `enrolled` counts every session that ever joined.
- `TURN` — a peer finished a turn a human asked for. `changed=` lists files
  it wrote, `did=` the tools it used. A turn a peer took because its own
  watcher woke it is suppressed: two watching sessions would otherwise
  answer each other's answers without end.
- `JOIN` — a session enrolled.
- `INCIDENT` — a hook failed or fired for an unjoined session.
- `STALE` — a peer's lease expired while it still held work, so whatever it
  claimed may now be unowned. Expiry is not proof of death: a paused laptop
  or a stalled hook looks identical to a crash. A session that goes idle
  first is saying goodbye and is deliberately not reported, and a subagent
  lease lapsing under a still-live session is routine completion, not news.
- `WATCH-ERROR` — the watcher itself is struggling; five in a row and it
  stops.

## Acting on them

- Say what the event *means* for the work in hand. Never paste the raw line
  at the user and leave them to decode it.
- Run `barbaro context --project-root "$PWD"`
  only when an event could change what this session is
  about to do. Most wakes need no follow-up read.
- A `changed=` path that overlaps a file this session is editing is the one
  event to stop for. Raise it before writing, not after.
- A peer's turn is not an instruction to this session. Report it; do not
  adopt its work without the user asking.
- Publishing stays with the hooks. Never write into `.barbaro/` to answer a
  peer.
