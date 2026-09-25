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
- **`README.md`** — short, player-facing project overview and a link to play.

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
  published (see "Firebase project setup" below for the exact rules —
  simple "must be signed in, must know the room code" rules; not designed
  to stop cheating between friends, just accidents/strangers).
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
- ✅ **Garbage lines.** `sendAttack()` in `lobby.js` files every attack as
  its own `push()` child under `rooms/CODE/attacks/MATCHID/TARGETUID`
  (`{from, lines}`), so simultaneous attacks from two players both land.
  Receiving is a **claim-and-delete transaction** (`claimAttacks()`) so
  garbage can't be double-applied if it fires twice before the delete is
  visible. Scoping the inbox to a `matchId` (minted by `tryStartMatch`) is
  what fixed "garbage at the very start of a round": the previous round's
  last attack could still be in flight when the room was reset for the
  rematch, and it used to survive into the next match as a stale
  `pendingGarbage`. Now a late write can only reach the old match's inbox.
  `tryStartMatch` and `resetForRematch` also rebuild player nodes from lobby
  fields only (`name/slot/ready/connected`).
- ✅ **Synced start.** `tryStartMatch` writes a shared `startAt` on the
  server clock (`watchServerClock()` uses `.info/serverTimeOffset`); every
  client counts its 3-2-1 down to that instant instead of to whenever its
  own page finished loading.
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

## Firebase project setup (already done once — for reference)

### 1. Create the Firebase project (free, no credit card)
1. Go to console.firebase.google.com and click **Add project**. Name it
   anything (e.g. `blockdrop-mp`). You can skip Google Analytics.
2. Click the **`</>`** (web) icon on the project overview page to register a
   web app. You don't need Firebase Hosting for this. It'll show you a
   `firebaseConfig` object — copy it, you'll need it below.
3. Go to **Build → Authentication → Get started**, open the **Sign-in
   method** tab, and enable **Anonymous**. This gives each browser a stable,
   private ID without anyone needing to make an account.
4. Go to **Build → Realtime Database → Create Database**. Pick a location
   close to you and your friends, and start in **locked mode**.
5. Open the **Rules** tab of the Realtime Database and replace the contents
   with the block below, then click **Publish**:

   ```json
   {
     "rules": {
       "rooms": {
         "$code": {
           ".read": "auth != null",
           ".write": "auth != null"
         }
       },
       ".read": false,
       ".write": false
     }
   }
   ```

   This means: nobody can read or write anything without being signed in
   (anonymous sign-in counts), and only people who already know a room's
   4-letter code can see or touch that room. It doesn't stop a friend from
   editing another friend's data on purpose — that's fine here, since you're
   not trying to stop cheating between people you trust, just avoid random
   internet strangers and accidental bugs.

### 2. Wire up the code
6. Open `firebase-config.js` and replace the placeholder values with the
   ones Firebase showed you in step 2. Both `lobby.html` and `blockdrop.html`
   import this one file, so you only paste your config once.
7. `databaseURL` needs the exact URL of the Realtime Database you created in
   step 4, not just a guess from the project id — open **Build → Realtime
   Database** in the Firebase console and copy the URL shown at the top of
   the page (it depends on which region you picked).

A Firebase web `apiKey` is meant to be public client-side — it doesn't grant
data access by itself, the rules above do. If GitHub's secret scanner flags
`firebase-config.js`, the real fix is restricting the key in Google Cloud
Console (APIs & Services → Credentials → the key → Application restrictions
→ limit it to your GitHub Pages domain), not hiding the file — a static
site can't hide a client-side value from anyone visiting the live page
anyway.

### 3. Test a full match
Browsers block ES module imports (`import ... from './lobby.js'`) when you
just double-click an HTML file, so multiplayer needs to be served over
http, not opened directly. Locally: VS Code's "Live Server" extension, or
`python3 -m http.server 8000` and visit `http://localhost:8000/lobby.html`.
Singleplayer works fine opened directly either way.

To test the multiplayer part properly, open the page in **two different
browsers** (or one normal + one incognito window) — two tabs in the *same*
browser share the same anonymous login and count as one player. Two
windows on the *same laptop* also risk Chrome throttling/freezing whichever
tab is backgrounded, which can look like a wifi disconnect — for a real
test, use two separate devices.

1. Tab A: enter a name, click **Create a room**. Note the 4-letter code.
2. Tab B: enter a different name, type that code, click **Join room**.
3. Both tabs: click **Ready up** — should count down and drop into a synced
   board with live opponent previews.
4. Clear some lines in one tab and confirm garbage lands on the other after
   its next piece locks (not mid-fall).
5. Top out in one tab and confirm the match declares a winner and both tabs
   return to a fresh ready-up screen in the same room.

## What's already handled (see comments in `lobby.js`)
- Two people joining the same room at the same instant never get assigned
  the same seat — the seat-picking runs as a database transaction.
- Two people generating the same room code at the same instant — the loser
  just gets retried with a fresh code automatically.
- All players readying up near-simultaneously only starts the match once,
  with one shared random seed, no matter how many clients race to start it.
- A dropped wifi connection gets marked automatically by Firebase itself
  (via `onDisconnect`), even though that laptop is already offline — but
  only mid-match; closing the browser in the lobby (or explicitly leaving)
  removes you for real, and deletes the room once it's empty.
- Refreshing the page rejoins your same seat instead of creating a duplicate
  player, since your anonymous ID is remembered by the browser.
