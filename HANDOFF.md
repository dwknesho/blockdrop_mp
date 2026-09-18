# BlockDrop — project handoff

## What this is
A Tetris clone called **BlockDrop**, built so a small group of friends can
play together after tetr.io got blocked on school wifi. Runs in the browser,
hosted for free (GitHub Pages), multiplayer for 2–3 players via Firebase's
free Realtime Database tier. Avoids the name "Tetris" on purpose — that's a
trademark, and clones using the name get takedown notices.

## Files in this folder
- **`blockdrop.html`** — the game. Self-contained for single-player (open it
  directly in a browser, no build step, no server needed). Internally split
  into four parts, marked with comments: `ENGINE` (pure game logic, no DOM —
  `// ENGINE START` / `// ENGINE END`), `RENDERER` (canvas drawing), `UI/INPUT`
  (keyboard, menus, the main loop — all one classic `<script>`), and a fourth
  `<script type="module">` at the bottom that only activates when the page is
  opened as `blockdrop.html?room=CODE` (i.e. via the lobby) — it syncs boards,
  sends/receives garbage, and reports eliminations over Firebase. That module
  needs to be served over http, not opened as `file://`, because it uses ES
  module imports — single-player is unaffected either way.
- **`lobby.html`** + **`lobby.js`** — the multiplayer room lobby: create a
  room, get a 4-letter code, friends join, everyone readies up, match starts
  with a shared random seed, then redirects into `blockdrop.html?room=CODE`.
  Also needs to be served over http, not opened as a `file://` URL.
- **`firebase-config.js`** — the one place the Firebase project config is
  pasted; imported by both `lobby.html` and `blockdrop.html`.
- **`README.md`** — step-by-step Firebase console setup + how to test a full
  match with two browsers.

## Current status
- ✅ Single-player engine: SRS rotation with wall kicks, 7-bag randomizer,
  hold, ghost piece, hard drop, lock delay, T-spin/mini-T-spin detection,
  back-to-back, combo, all-clear scoring, garbage-line math (Tetris = 4 lines
  sent, etc. — see `COMBO_ATTACK` and `scoreClear()` in the engine).
- ✅ Three modes: Marathon (gravity ramps every 10 lines), 40-line Sprint,
  and Practice (no gravity, Ctrl+Z undoes the last placed piece — full
  history/replay support in `Game.saveSnapshot()` / `Game.undo()`).
- ✅ Adjustable DAS/ARR/soft-drop speed, saved to `localStorage`.
- ✅ All-black theme, works in light/dark OS mode.
- ✅ Multiplayer lobby: Firebase Realtime Database + Anonymous Auth. Room
  create/join/ready/start, with every known race condition handled via
  Firebase transactions (see the big comments in `lobby.js` for each one):
    - two players joining at the same instant → transaction on the seat list
    - two rooms generated with the same code → check-then-create transaction
    - everyone readying up simultaneously → transaction on the whole room
      node, flips status once, hands out one shared piece-order seed
    - wifi dropping mid-session → `onDisconnect()` marks it server-side
    - refreshing the page → anonymous auth uid persists, rejoins same seat
  This logic was stress-tested against 2,000 simulated concurrent attempts
  per scenario (join races, start races, code collisions) with zero
  collisions before being wired to real Firebase calls.
- ✅ Firebase project already created by the user (project id `blockdrop-mp`),
  Anonymous auth enabled, Realtime Database created, security rules
  published (see `README.md` for the exact rules — simple "must be signed
  in, must know the room code" rules; not designed to stop cheating between
  friends, just accidents/strangers).
- ✅ **Lobby → game handoff.** `lobby.html` redirects to
  `blockdrop.html?room=CODE` once `tryStartMatch` flips the room to
  `starting`. The multiplayer module (bottom of `blockdrop.html`) re-signs-in
  anonymously (same uid as the lobby, since Firebase Auth persists it),
  re-marks itself `connected` (the page navigation itself trips the lobby
  page's `onDisconnect`, so this has to happen again on the new page — see
  `markConnected` in `lobby.js`), runs its own 3-2-1 countdown, then calls
  `Game.start('versus', room.seed)` — the existing seeded-RNG engine handles
  the rest untouched, aside from one line in `scoreClear()` so `'versus'`
  levels up like marathon does.
- ✅ **Board broadcast.** Each client sends a compact summary (10-bit row
  bitmasks + score/lines/stack height) via `updateBoard()` on a 100ms
  `setInterval` (≈10/sec) — see `boardSummary()` in `blockdrop.html`. Skips
  the write when nothing changed since the last tick.
- ✅ **Opponent previews.** Small canvases built per opponent from the room's
  player list, redrawn from each other player's broadcast board on every
  Firebase update.
- ✅ **Garbage lines.** `sendGarbage()` in `lobby.js` runs an **increment
  transaction** on the target's `pendingGarbage` so simultaneous attacks from
  two players both land. Receiving is a **claim-and-zero transaction**
  (`consumeGarbage()`) so garbage can't be double-applied if it fires twice
  before the zero-write is visible.
- ✅ **Targeting rule.** `pickTarget()` in `lobby.js` — tallest stack among
  connected, non-eliminated opponents, using each attacker's own latest
  synced view of the room; ties break on slot number so it's still a single
  deterministic answer. This is "best effort" consistency across clients
  (bounded by the ~100ms broadcast lag), which is fine for friends and matches
  the project's no-anti-cheat stance.
- ✅ **Elimination ordering.** `reportEliminated()` writes
  `players/{uid}/eliminatedAt` as a Firebase **server timestamp**, once, from
  the eliminated player's own client only (no transaction needed — nobody
  else ever writes that field, so there's no race). Standings sort by that
  timestamp, descending; still-alive players always outrank eliminated ones.
- ⬜ **Not built yet / still to do:**
    1. Deploy the whole thing to GitHub Pages and test on the actual school
       wifi with 2–3 laptops, deliberately killing one laptop's wifi
       mid-match to confirm the disconnect grace period works.
    2. No rematch flow yet — after a match ends, "Back to lobby" is the only
       way out; the room itself isn't reset for a second round, so going back
       through **Create a room** again is the current path to playing again.

`firebase-config.js`'s `databaseURL` is confirmed
(`asia-southeast1`, from the actual console page — not a guess).

## Design decisions worth knowing
- **Client-authoritative, no anti-cheat.** These are friends playing
  together, not strangers — there's no server validating every move. Keep
  it that way; adding server-side move validation would be a lot of extra
  work for no real benefit here.
- **Firebase Realtime Database**, not Firestore — chosen for the free tier
  (100 concurrent connections, no card needed) and because transactions map
  cleanly onto the race conditions above.
- **Everything else stays a plain static site.** No backend server, no
  build step — just static files on GitHub Pages talking straight to
  Firebase. Keep new features consistent with that if possible.

## First message to send Claude Code
Something like: *"Read HANDOFF.md and the other files in this folder, then
help me test the multiplayer match end-to-end and get it deployed to GitHub
Pages."*
