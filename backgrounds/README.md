# Backgrounds

Drop preset background photos here, then add a matching entry to the
`BACKGROUNDS` array near the top of the UI/INPUT section in `blockdrop.html`:

```js
const BACKGROUNDS = [
  { id: 'none', name: 'None', image: null },
  { id: 'city', name: 'City', image: 'backgrounds/city.jpg' },   // add one line per photo
];
```

- `id` — unique, used to remember the player's choice in `localStorage`.
- `name` — only shown for presets with no image (e.g. "None"); photo swatches
  show the thumbnail instead.
- `image` — path to the file in this folder.

Keep files reasonably small (a few hundred KB, not multi-MB originals) since
they load over the same connection as everything else on GitHub Pages —
`.jpg` or `.webp` at around 1600px on the long edge is plenty for a
full-screen background.
