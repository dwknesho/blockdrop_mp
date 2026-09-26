// ============================================================================
// lobby.js  — room creation / joining / ready-up / match-start logic.
// This file is the pure "talk to Firebase" layer. All the concurrency-unsafe
// spots identified in the plan are handled here with Firebase *transactions*,
// which are compare-and-swap operations: Firebase hands your function the
// CURRENT value right before it commits and retries automatically if two
// clients collide, so nobody's write is silently lost or overwritten.
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getDatabase, ref, runTransaction, onValue, onDisconnect, set, get, off, serverTimestamp, push, update
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const MAX_PLAYERS = 3;
// How far ahead of "everyone is ready" the match's shared GO moment is set.
// Covers the lobby -> game page load plus a 3-2-1, so a slower laptop still
// arrives before the countdown ends instead of starting behind everyone.
const MATCH_START_DELAY = 4500;
// No 0/O or 1/I — those two look identical in most fonts and cause mis-typed room codes.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function initFirebase(config){
  const app = initializeApp(config);
  return { db: getDatabase(app), auth: getAuth(app) };
}

// Anonymous auth gives every browser a stable uid (kept in IndexedDB across
// refreshes), which we use as the player's id — so a refresh rejoins the same
// slot instead of creating a duplicate player, and Firebase rules can check
// "only you can write your own player node."
export function signIn(auth){
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, user => { if (user){ unsub(); resolve(user); } }, reject);
    signInAnonymously(auth).catch(reject);
  });
}

export function randomCode(len = 4){
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// Everything a player node picks up DURING a match (their board broadcast,
// elimination time, the old pendingGarbage counter). None of it may survive
// into the next round — see tryStartMatch() for what went wrong when it did.
function lobbyFields(p){
  return { name: p.name, slot: p.slot, ready: !!p.ready, connected: !!p.connected };
}
// A late in-flight write (a board broadcast, say) that lands after its
// player already left recreates a stub node with no name or slot. Those are
// never real players, so they're dropped wherever the room is rebuilt.
const isRealPlayer = p => p && p.name != null && p.slot != null;

// --- Hazard: laptop clocks disagree by seconds, so "start at 12:00:05" in
// local time would start everyone at a different moment. Firebase measures
// each client's offset from the SERVER clock; adding it gives every client
// the same timeline to count down against. ---
export function watchServerClock(db){
  let offset = 0;
  const ready = new Promise(resolve => {
    onValue(ref(db, '.info/serverTimeOffset'), snap => { offset = snap.val() || 0; resolve(); });
  });
  return { now: () => Date.now() + offset, ready };
}

// --- Hazard: room-code collision. Two people could generate the same code
// at the same moment. Fixed by a check-then-create transaction: whoever's
// write lands first wins the code, the loser's transaction aborts (returns
// undefined) and we just try a fresh code. ---
export async function createRoom(db){
  for (let attempt = 0; attempt < 6; attempt++){
    const code = randomCode();
    const result = await runTransaction(ref(db, `rooms/${code}`), current => {
      if (current) return undefined;              // taken — abort, caller retries with a new code
      return { status: 'waiting', createdAt: Date.now(), players: {} };
    });
    if (result.committed) return code;
  }
  throw new Error('Could not allocate a room code — please try again.');
}

// --- Hazard: two players joining the same room at the same instant could
// both grab "slot 0". Fixed by running the slot assignment itself as a
// transaction on the players list, so the second joiner's transaction is
// retried against the post-first-join state and picks the NEXT open slot. ---
export async function joinRoom(db, code, uid, name){
  const statusSnap = await get(ref(db, `rooms/${code}/status`));
  if (!statusSnap.exists()) return { ok: false, reason: 'no-room' };
  if (statusSnap.val() !== 'waiting') return { ok: false, reason: 'in-progress' };

  const result = await runTransaction(ref(db, `rooms/${code}/players`), current => {
    current = current || {};
    // Build a NEW object rather than mutating `current` in place — same
    // reason as tryStartMatch()'s comment above: mutating the transaction's
    // input can stop the SDK's before/after diff from seeing a real change.
    // Rejoin, same slot — keeping only the lobby fields, so nothing from a
    // finished match (board, eliminatedAt, stale garbage) rides along.
    if (current[uid]) return { ...current, [uid]: { ...lobbyFields(current[uid]), connected: true } };
    const taken = new Set(Object.values(current).map(p => p.slot));
    let slot = -1;
    for (let i = 0; i < MAX_PLAYERS; i++) if (!taken.has(i)) { slot = i; break; }
    if (slot === -1) return undefined;           // full — abort
    return { ...current, [uid]: { name, slot, ready: false, connected: true } };
  });
  if (!result.committed) return { ok: false, reason: 'full' };

  // --- Hazard: closing the browser (or a real connection drop) while still
  // in the lobby, with no client left to clean anything up. Firebase runs
  // this REMOVE on our behalf from the server the moment our socket closes,
  // even though our laptop is already gone — so the room doesn't keep a
  // ghost player forever. This gets swapped for a softer "just mark
  // disconnected" handler once a match actually starts — see
  // markConnected() — so a wifi drop mid-match still gets a grace period
  // instead of vanishing outright. ---
  onDisconnect(ref(db, `rooms/${code}/players/${uid}`)).remove();
  return { ok: true, slot: result.snapshot.val()[uid].slot };
}

export function watchRoom(db, code, cb){
  const r = ref(db, `rooms/${code}`);
  onValue(r, snap => cb(snap.val()), err => console.error('[BlockDrop] watchRoom read failed:', err));
  return () => off(r);
}

export function setReady(db, code, uid, ready){
  return set(ref(db, `rooms/${code}/players/${uid}/ready`), ready);
}

// --- Hazard: an explicit "Leave" should clean up after itself instead of
// leaving a room with zero real players sitting in the database forever.
// Removing the player and checking emptiness has to happen as one atomic
// transaction on the whole room, not two separate writes — otherwise two
// people leaving at once could each see "1 player left" right before the
// other's write lands, and neither would delete the now-actually-empty
// room. ---
export async function leaveRoom(db, code, uid){
  const roomRef = ref(db, `rooms/${code}`);
  let unsub;
  await new Promise(resolve => { unsub = onValue(roomRef, () => resolve()); });
  try {
    await runTransaction(roomRef, room => {
      if (!room) return undefined;
      const players = { ...(room.players || {}) };
      delete players[uid];
      if (Object.keys(players).length === 0) return null;   // last one out — delete the room
      return { ...room, players };
    });
  } finally {
    unsub();
  }
}

// --- Hazard: all players ready up at nearly the same moment, and each
// client's code notices and tries to start the match — this must fire
// exactly once and hand out exactly one seed. Fixed by a transaction on the
// WHOLE room node: it re-checks "still waiting + everyone ready" against the
// freshest data at commit time, so only the first caller's write goes
// through; everyone else's transaction sees status already flipped and
// aborts. That single write also sets the shared piece-order seed, so no
// player can end up with better pieces than anyone else. ---
export async function tryStartMatch(db, code){
  const roomRef = ref(db, `rooms/${code}`);
  // --- Hazard: runTransaction can see `null` on its very first call if this
  // client has no already-synced local copy of the path yet — confirmed
  // against the live database, not just theory. When that happens the
  // update function below aborts immediately (room is falsy) instead of
  // ever finding out the room's real state, so the match silently never
  // starts. A one-off get() does NOT fix this — it doesn't leave the
  // transaction engine's cache warm. Only an actively-attached onValue
  // listener does, and it has to STAY attached through the transaction
  // call (detaching right after the first snapshot lets the cache go cold
  // again immediately, reproducing the same bug). So: attach, wait for one
  // real snapshot, transact while still attached, then detach. ---
  const clock = watchServerClock(db);
  let unsub;
  await Promise.all([clock.ready, new Promise(resolve => { unsub = onValue(roomRef, () => resolve()); })]);
  try {
    const result = await runTransaction(roomRef, room => {
      if (!room || room.status !== 'waiting') return undefined;
      const players = {};
      for (const [id, p] of Object.entries(room.players || {})) if (isRealPlayer(p)) players[id] = lobbyFields(p);
      const list = Object.values(players);
      if (list.length < 2 || !list.every(p => p.ready)) return undefined;
      // --- Hazard (the "garbage at the very start of a round" bug): the
      // previous round's last attack can still be in flight when the room
      // gets reset — the loser's client resets the instant it tops out,
      // while the winner, ~100ms behind, may be mid-combo. That write then
      // landed on the freshly reset room, and because this used to copy
      // `...room` and every player node forward untouched, it survived all
      // the way into the next match and hit on the first piece. Two fixes:
      // (1) the room is rebuilt here with ONLY lobby fields, and without the
      //     old `attacks` node at all;
      // (2) every match gets its own matchId, and attacks are filed under
      //     it (see sendAttack) — so even a write that lands later still can
      //     only ever reach the old match's inbox, which nobody reads. ---
      // Return a NEW object rather than mutating `room` in place — the SDK
      // diffs the before/after values to decide what to actually commit
      // and broadcast, and mutating the input can make that diff see no
      // change.
      const { attacks, ...rest } = room;
      return {
        ...rest,
        players,
        status: 'starting',
        seed: Math.floor(Math.random() * 2 ** 32),
        matchId: randomCode(8),
        startingAt: Date.now(),
        // One shared GO moment on the server's clock, so every player's
        // 3-2-1 ends at the same instant however fast their page loaded.
        startAt: clock.now() + MATCH_START_DELAY,
      };
    });
    return result.committed;
  } finally {
    unsub();
  }
}

// ============================================================================
// In-match sync (Phase 2). Everything below here is used by blockdrop.html
// once a match has started, not by lobby.html itself.
// ============================================================================

// --- Hazard: navigating from lobby.html to blockdrop.html closes the old
// page's realtime connection, which fires the onDisconnect handler armed
// during joinRoom() and marks the player disconnected — even though they're
// still here, just on a new page. Re-mark connected and re-arm onDisconnect
// on the new connection so the room doesn't think they left mid-handoff. ---
export function markConnected(db, code, uid){
  set(ref(db, `rooms/${code}/players/${uid}/connected`), true);
  onDisconnect(ref(db, `rooms/${code}/players/${uid}/connected`)).set(false);
}

// --- Hazard: every intentional page-to-page handoff in this app (lobby ->
// match, and match -> lobby again after it ends) closes a real connection,
// which fires whatever onDisconnect handler is currently armed for this
// player — lobby.html's whole-node .remove() (joinRoom) or blockdrop.html's
// narrower connected-flag .set(false) (markConnected) — even though nobody
// actually left. First time this bit us: navigating lobby -> match deleted
// the player a moment before the new page's markConnected() could react.
// Second time: navigating match -> lobby after a win could flip connected
// to false right as resetForRematch was trying to read it, making the room
// look abandoned ("Room closed") if that transaction's network round trip
// took even slightly longer than the fixed delay before navigating.
// Cancelling BOTH possible paths right before any such navigation — a
// no-op for whichever one isn't actually armed — closes both holes. ---
export function cancelDisconnectHandlers(db, code, uid){
  return Promise.all([
    onDisconnect(ref(db, `rooms/${code}/players/${uid}`)).cancel(),
    onDisconnect(ref(db, `rooms/${code}/players/${uid}/connected`)).cancel(),
  ]);
}

// Board updates are a plain `set()`, not a transaction — only the owning
// client ever writes its own board, so there's nothing to race against.
// Throttle the CALLER side to ~10/sec; this just does the write.
export function updateBoard(db, code, uid, summary){
  return set(ref(db, `rooms/${code}/players/${uid}/board`), summary);
}

// --- Hazard: two attackers targeting the same opponent at the same instant
// must both land. Every attack is its own push() child (push keys are
// unique and time-ordered), so there's no shared counter to race on at all.
// Each chunk keeps who sent it, so the receiver can animate it flying in
// from the right board. Attacks live under rooms/CODE/attacks/MATCHID/UID —
// scoped to one match, see tryStartMatch() for why. ---
export function sendAttack(db, code, matchId, targetUid, fromUid, chunks){
  const list = (chunks || []).filter(n => n > 0);
  if (!list.length || !matchId || !targetUid) return Promise.resolve();
  const inbox = ref(db, `rooms/${code}/attacks/${matchId}/${targetUid}`);
  const batch = {};
  for (const lines of list) batch[push(inbox).key] = { from: fromUid, lines };
  return update(inbox, batch);   // one multi-child write: all chunks arrive together, in order
}

// Claim everything in this player's inbox and delete it, atomically, so a
// slow client can't apply the same attack twice if this is called again
// before the delete is visible yet. Returns the chunks oldest first.
export async function claimAttacks(db, code, matchId, uid){
  let taken = null;
  const result = await runTransaction(ref(db, `rooms/${code}/attacks/${matchId}/${uid}`), current => {
    taken = current;   // overwritten on every retry — only the committed run counts
    return null;
  });
  if (!result.committed || !taken) return [];
  return Object.keys(taken).sort().map(k => taken[k]).filter(a => a && a.lines > 0);
}

// --- Hazard: "who topped out first" decides elimination order, but laptop
// clocks drift and wifi latency means Date.now() isn't trustworthy for that.
// Firebase's server timestamp sentinel is filled in by the database server
// at write time, so every client's elimination gets ordered by the same
// clock. No transaction needed here — only the eliminated player's own
// client ever writes their own eliminatedAt, so there's no race to resolve. ---
export function reportEliminated(db, code, uid){
  return set(ref(db, `rooms/${code}/players/${uid}/eliminatedAt`), serverTimestamp());
}

// Deterministic targeting: garbage always goes to whoever currently has the
// tallest stack among opponents still alive. Every client computes this the
// same way from the same synced room data, so there's no need to elect one
// client as the "referee" — ties break on slot number so it's still a single
// answer even if two stacks are exactly equal.
export function pickTarget(room, myUid){
  const candidates = Object.entries(room.players || {})
    .filter(([id, p]) => id !== myUid && p.connected && p.eliminatedAt == null && p.board);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b[1].board.height - a[1].board.height) || (a[1].slot - b[1].slot));
  return candidates[0][0];
}

// Once the match is down to one player (or zero) still connected and not
// eliminated, it's over. Reset the SAME room back to a fresh ready-up state
// — same code, same slots — so the group can rematch without re-sharing a
// code. Every client calls this independently when it notices the match has
// concluded; the transaction is a no-op if someone else's call already won,
// so it's safe to call from all of them at once, same as tryStartMatch.
export async function resetForRematch(db, code){
  const roomRef = ref(db, `rooms/${code}`);
  let unsub;
  await new Promise(resolve => { unsub = onValue(roomRef, () => resolve()); });
  try {
    const result = await runTransaction(roomRef, room => {
      if (!room || room.status === 'waiting') return undefined;
      const players = {};
      for (const [uid, p] of Object.entries(room.players || {})){
        if (!isRealPlayer(p) || !p.connected) continue;   // dropped mid-match and never came back — don't carry a ghost into the rematch lobby
        players[uid] = { ...lobbyFields(p), ready: false };
      }
      if (Object.keys(players).length === 0) return null;   // nobody left — delete the room instead of resetting to an empty one
      // Deliberately rebuilt from scratch: no seed, matchId or attacks carry over.
      return { status: 'waiting', createdAt: room.createdAt, players };
    });
    return result.committed;
  } finally {
    unsub();
  }
}
