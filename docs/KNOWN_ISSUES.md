# Known Issues

Environmental + recurring issues that aren't yet bugs but bite often enough to deserve a note. Keep entries short. When an issue is fixed, delete its entry (don't leave a "resolved" tombstone — git log has that).

---

## Managed development runner reports an occupied port

`npm run dev` uses the managed runner and assigned per-worktree ports. Its
doctor preflight refuses startup when an assigned port is already occupied;
Vite uses `strictPort` and does not silently move to another port.

Run `npm run worktree:status` to identify the owning checkout, then stop that
checkout with `npm run worktree:stop`. See [`docs/development.md`](development.md)
for setup, preflight, status, and stop procedures.

The raw `npm run dev:server` command remains a separate nodemon entry point and
does not provide the managed runner's port allocation or ownership controls.
