# Staff Phase-B maintenance gate

`STAFF_MAINTENANCE_MODE` is the deployment interlock for the Staff Phase-B
authentication migration. Only the exact lowercase value `true` enables it.
While enabled, Staff API routes, valid Staff bearer tokens on other routes, and
Staff Socket.io connections receive `STAFF_MAINTENANCE`; customer and public
traffic remain online.

This gate release is deliberately Phase-A-compatible and must be deployed on
its own before any Phase-B migration. Railway environment variables are read
when each process starts: setting the flag cannot close an older process that
started with it off.

## Rollout sequence

1. Deploy this maintenance-gate release by itself, with
   `STAFF_MAINTENANCE_MODE` unset (or `false`). Do not combine this prerequisite
   deploy with the Phase-B schema or authentication changes. Confirm
   `/api/health` reports `staffMaintenance.enabled: false`. Announce the
   maintenance window and have every Staff user close any active job, break,
   and shift timer while the normal clock-out APIs are still available. Run
   the Phase-A release's read-only audit against the intended production
   database and require `ok: true`, zero incomplete checks, and an
   `active_staff_timers` count of zero:

   ```bash
   npm run --silent audit:staff-rollout -- --json
   ```
2. Set `STAFF_MAINTENANCE_MODE=true` in Railway and deploy the same gate-aware
   release. Wait until the deployment is healthy and every instance from the
   previous deployment has stopped; do not start Phase B while an old instance
   that started with the flag off can still accept a Staff timer write or
   keep an already-upgraded Staff socket alive. Confirm Railway shows no old
   Phase-A process or replica remaining. If that cannot be proven, scale the
   service to zero to terminate the old processes/sockets, then restart only
   gate-aware instances with the flag set to `true`. An external ingress rule
   may supplement this step by blocking HTTP and new `/socket.io` handshakes,
   but it cannot terminate an already-open WebSocket and is not a substitute
   for draining or stopping the old instances. Re-run the same read-only audit
   after the drain and again require zero active timers, zero blockers, and
   zero incomplete checks before starting Phase B. If a timer remains, do not
   edit it directly or start the migration: redeploy B0 with the gate disabled,
   drain the gate-enabled fleet, close the timer through the normal Staff flow,
   and repeat the gate-and-drain sequence.
3. Verify the closed gate against both the canonical production domain and the
   direct Railway public domain (plus any other origin that can reach the
   service); an edge-only result does not prove the application gate is closed:
   - `GET /api/health` returns 200 and `staffMaintenance.enabled: true`.
   - Any request to `/api/admin/auth/login`, `/api/tech/...`,
     `/api/dispatch/...`, or `/api/knowledge/...` returns 503, a
     `STAFF_MAINTENANCE` code, `Retry-After`, and `Cache-Control: no-store`.
   - `/api/stripe/terminal/...`, `/api/bouncie/auth`, and
     `/api/bouncie/callback` also return the same 503. Customer-authenticated
     `/api/bouncie/vehicles` and `/api/bouncie/location` remain available.
   - An authenticated Bouncie geozone webhook still returns 200 and is logged,
     but reports `staffMaintenanceSuppressed: true`; it must not start or stop a
     Staff timer while the gate is closed.
   - The separate Bouncie live-tracking receiver may continue refreshing the
     customer map, but its GPS arrival detector reports `staff_maintenance`
     internally and must not auto-mark a service on property or change its
     semantic Staff lifecycle state.
   - A public/customer smoke request still succeeds.
   - A previously connected Staff socket was disconnected by the old-instance
     drain, and an already-signed-in Staff browser cannot reconnect it.
4. Run the Phase-B migration and deploy the Phase-B application while the gate
   stays enabled. Wait for every gate-aware Phase-A instance to drain, verify
   only the Phase-B revision remains, and complete the gated schema/session
   post-deploy audits and smokes. Do not bulk-rotate credentials yet.
5. Set `STAFF_MAINTENANCE_MODE=false` (or remove it), deploy/restart, and verify
   on both the canonical and direct Railway domains that health reports `false`
   after every gate-enabled process drains and only the Phase-B revision is
   serving. The forgot/reset endpoints cannot be tested while the global
   `/api/admin` gate is enabled. Phase B rejects a retired legacy password
   before its later physical rotation, so opening only the Phase-B fleet does
   not restore that login path.
6. Exercise forgot-password email delivery and consume the reset link end to end
   with a controlled account. If this fails, re-enable the gate and do not run
   the bulk rotation.
7. Only after reset delivery is proven, run the legacy-credential rotation and
   session revocation under the Phase-B script's database locks and rollout
   fingerprint, send reset instructions, and complete the post-rotation
   audit/smoke tests.

If Phase B fails, leave the gate enabled while investigating. Never restore an
application revision older than the Phase-A schema writer fence or this
maintenance gate.
