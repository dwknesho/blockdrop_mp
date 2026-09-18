# BlockDrop

A Tetris-style puzzle game that runs entirely in the browser — play solo,
or with 2–3 friends in real time online.

**[Play it here](https://dwknesho.github.io/blockdrop_mp/)**

## Modes
- **Marathon** — survive as gravity speeds up
- **40 Lines** — clear 40 lines as fast as you can
- **Practice** — same rules as Marathon, but `Ctrl+Z` undoes your last piece
- **Multiplayer** — create a room, share the 4-letter code, and battle 2–3
  players live: synced boards, garbage lines, and a shared winner

## Controls
| Key | Action |
|---|---|
| ← → | Move |
| ↓ | Soft drop |
| Space | Hard drop |
| ↑ / X | Rotate right |
| Z / Ctrl | Rotate left |
| A | Rotate 180 |
| C / Shift | Hold |
| Esc | Pause (singleplayer) |
| R | Restart |
| Ctrl+Z | Undo last piece (Practice mode) |

## Running it yourself
Open `lobby.html` to start — it's the front door for both singleplayer and
multiplayer. No build step, no install; it's plain HTML/JS. Multiplayer
needs its own Firebase project — see `HANDOFF.md` for setup and how the
whole thing works under the hood.
