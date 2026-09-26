# Known Issues

Environmental + recurring issues that aren't yet bugs but bite often enough to deserve a note. Keep entries short. When an issue is fixed, delete its entry (don't leave a "resolved" tombstone — git log has that).

---

## Managed development runner reports an occupied port

`npm run dev` uses the managed runner and assigned per-worktree ports. Its
doctor preflight refuses startup when an assigned port is already occupied;
Vite uses `strictPort` and does not silently move to another port.

`npm run worktree:status` contacts only the authenticated control port recorded
for the current checkout. If it reports that checkout's managed runner as
running, stop it from the same checkout with `npm run worktree:stop`. It cannot
identify an arbitrary process listening on another assigned port.

The raw `npm run dev:server` command remains a separate nodemon entry point and
does not provide the managed runner's port allocation or ownership controls. If
status reports no matching runner (or refuses a different runner), inspect only
the exact port named by the doctor error:

```sh
lsof -nP -iTCP:<reported-port> -sTCP:LISTEN
ps -p <listener-pid> -o user=,pid=,ppid=,command=
lsof -a -p <listener-pid> -d cwd -Fn
ps -p <parent-pid> -o user=,pid=,ppid=,command=
```

Verify the OS user, command, working directory, and parent process before doing
anything. For a recognized raw `dev:server`, stop its original terminal with
Ctrl+C. If that terminal is gone and the process belongs to the intended
checkout, send `SIGTERM` to the verified nodemon supervisor, or to the exact
standalone listener when there is no supervisor, then rerun the same `lsof`
command to confirm the port was released. Do not use `killall`, `pkill`, a broad
PID list, or signal a process whose checkout and purpose are unknown. See
[`docs/development.md`](development.md) for managed setup, preflight, status,
and stop procedures.
