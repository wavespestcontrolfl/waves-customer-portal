# Known Issues

Environmental + recurring issues that aren't yet bugs but bite often enough to deserve a note. Keep entries short. When an issue is fixed, delete its entry (don't leave a "resolved" tombstone — git log has that).

---

## Dev server port :3001 EADDRINUSE

**Symptom:** `npm run dev` logs `[UNCAUGHT EXCEPTION] listen EADDRINUSE: address already in use :::3001` repeatedly; nodemon exits and restarts, server never binds.

**Cause:** a previous node process (usually a stale nodemon from a prior session, occasionally the agent review queue listener) still holds the port.

**Fix:**
```bash
lsof -iTCP:3001 -sTCP:LISTEN       # find the PID
kill <pid>                          # polite first
kill -9 <pid>                       # if it ignores
```

Client Vite falls back to the next free port (5177, 5178…) and runs fine, but backend API calls from the client 404 because there's no server bound. Restart both after killing.

**Not yet worth fixing because:** cheap to diagnose once you know, and a permanent lockfile-style fix would need a dev-server supervisor we don't otherwise want. Revisit if it becomes weekly instead of occasional.

*Logged 2026-04-18 during PR 0 of the blog-schema arc.*
