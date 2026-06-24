# video/public — Remotion static assets

Drop a **licensed** background track here as `music.mp3` to enable the recap's music
bed. When the file is present, `render.mjs` passes `music: true` and the composition
plays it (`<Audio src={staticFile('music.mp3')} volume={0.4} />`); when it's absent,
the recap renders **silent**. Do NOT commit copyrighted audio — use a royalty-free /
properly-licensed track (library subscription or one-time-license).
