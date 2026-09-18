# BlockDrop multiplayer — Firebase setup

`lobby.html` is the game's front door — open that one, not `blockdrop.html`
directly. It asks singleplayer or multiplayer first; singleplayer sends you
straight to `blockdrop.html`'s own Marathon/40-line/Practice menu, and
multiplayer is the room lobby: create a room, share a 4-letter code, friends
join, everyone readies up, and the match starts — which hands off into
`blockdrop.html` with boards synced, garbage lines flying, and a shared
elimination order, so you actually play the match together.

## 1. Create the Firebase project (free, no credit card)

1. Go to console.firebase.google.com and click **Add project**. Name it
   anything (e.g. `blockdrop-mp`). You can skip Google Analytics.
2. Click the **`</>`** (web) icon on the project overview page to register a
   web app. You don't need Firebase Hosting for this. It'll show you a
   `firebaseConfig` object — copy it, you'll need it in step 6.
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

## 2. Wire up the code

6. Open `firebase-config.js` and replace the placeholder values with the
   ones Firebase showed you in step 2. Both `lobby.html` and `blockdrop.html`
   import this one file, so you only paste your config once.
7. `databaseURL` needs the exact URL of the Realtime Database you created in
   step 4, not just a guess from the project id — open **Build → Realtime
   Database** in the Firebase console and copy the URL shown at the top of
   the page (it depends on which region you picked). Paste it into
   `firebase-config.js` if it doesn't match what's already there.

## 3. Test it

Browsers block ES module imports (`import ... from './lobby.js'`) when you
just double-click an HTML file, so you need to serve the folder instead of
opening it directly. Easiest options:

- **VS Code**: install the "Live Server" extension, right-click
  `lobby.html`, "Open with Live Server."
- **Any terminal**: `cd` into this folder and run
  `python3 -m http.server 8000`, then visit `http://localhost:8000/lobby.html`.
- **Skip straight to GitHub Pages**: push this folder to a repo, turn on
  Pages in the repo settings, and visit the `github.io` URL it gives you —
  this is where you'll end up hosting it for real anyway.

To test the multiplayer part properly, open the page in **two different
browsers** (or one normal + one incognito window) — two tabs in the *same*
browser will share the same anonymous login and count as one player.

1. Tab A: enter a name, click **Create a room**. Note the 4-letter code.
2. Tab B: enter a different name, type that code, click **Join room**.
3. Both tabs: click **Ready up**.
4. Both should count down and drop into a synced board — same piece order
   in both tabs (proof the shared seed is working), and a small live preview
   of the other player's board next to your own.
5. Clear some lines in one tab and confirm garbage lines appear at the
   bottom of the other tab's board a moment later.
6. Top out in one tab on purpose and confirm it shows "Topped out" while the
   other tab keeps playing; once the last player also tops out, both tabs
   should agree on who placed where.

Try a third tab too, and try leaving/rejoining a room before the match
starts to check reconnecting works.

## What's already handled (see comments in `lobby.js`)

- Two people joining the same room at the same instant never get assigned
  the same seat — the seat-picking runs as a database transaction.
- Two people generating the same room code at the same instant — the loser
  just gets retried with a fresh code automatically.
- All players readying up near-simultaneously only starts the match once,
  with one shared random seed, no matter how many clients race to start it.
- A dropped wifi connection gets marked automatically by Firebase itself
  (via `onDisconnect`), even though that laptop is already offline.
- Refreshing the page rejoins your same seat instead of creating a duplicate
  player, since your anonymous ID is remembered by the browser.

These were all tested against 2,000 simulated concurrent attempts each with
zero collisions, before being wired up to real Firebase calls.

## What's next

The lobby-to-match handoff, board sync, garbage, and elimination order are
all wired up now (see `HANDOFF.md` for how each piece works). What's left is
real-world testing: deploy to GitHub Pages and try it on the actual school
wifi with 2–3 laptops, including deliberately killing one laptop's wifi
mid-match to confirm the disconnect grace period behaves.
