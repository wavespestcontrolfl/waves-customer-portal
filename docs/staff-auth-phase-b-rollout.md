# Staff authentication Phase B rollout

Phase B advances active Staff timer writers from generation 1 to generation 2,
revokes every pre-Phase-B Staff session, and adds password change/reset support.
It follows the Phase A schema rollout from PR #2603 and must use a controlled
maintenance window.

## Preconditions

- Phase A is deployed and `npm run --silent audit:staff-rollout -- --json`
  passes from the Phase A release.
- The standalone Phase-A-compatible B0 maintenance-gate release has been
  reviewed and is ready to deploy before this Phase B release. Do not combine
  B0 and B1 into one deploy.
- Arrange the maintenance window and clock out every active Staff timer before
  closing the B0 gate. The Phase B migration independently refuses to run while
  any timer remains active.
- Confirm the production SendGrid configuration and identify a real Staff
  admin mailbox that can verify reset-email delivery after deploy. The audit
  and migration require at least one active admin account.
- Confirm `STAFF_PASSWORD_RESET_ORIGIN` is unset or exactly
  `https://portal.wavespestcontrol.com`. Production reset credentials are
  pinned to that HTTPS origin and reject preview or legacy portal URLs.
- Do not run the credential-rotation script before the reset flow is live and
  its email delivery has been verified.

## Deploy

1. Deploy the standalone B0 maintenance-gate release with
   `STAFF_MAINTENANCE_MODE` unset (or `false`). Confirm `/api/health` reports
   `staffMaintenance.enabled: false` before changing the variable.
2. Set `STAFF_MAINTENANCE_MODE=true` in Railway and redeploy/restart that same
   B0 release. Wait for every process that started with the gate disabled to
   stop and for its Staff sockets to disconnect. Do not start B1 while any old
   process can still accept a Staff request.
3. Verify B0 on both `https://portal.wavespestcontrol.com` and the direct
   Railway public domain (plus any other origin that reaches the service):
   - `/api/health` returns 200 with `staffMaintenance.enabled: true`.
   - Staff HTTP routes return 503 with code `STAFF_MAINTENANCE`, `Retry-After`,
     and `Cache-Control: no-store`; a Staff Socket.io handshake is rejected.
   - A public/customer smoke request still succeeds.
   - An authenticated Bouncie geozone webhook still returns 200 and reports
     `staffMaintenanceSuppressed: true`, without starting or stopping a timer.
4. Run the Phase A release's Staff audit once more and require zero blockers,
   zero incomplete checks, and zero active timers. Then merge/deploy the
   reviewed B1 Phase B PR while the gate remains `true`. The production
   migration itself rejects any run without that exact maintenance setting.
5. Railway runs `npm run db:migrate` before starting B1. The auth migration
   locks Staff identities and `time_entries`, advances the database writer
   fence to generation 2, adds the credential-version/reset schema, bumps
   Staff credential versions, and deactivates existing Staff push
   subscriptions in one transaction.
6. Keep the gate enabled until every B0 process drains and only the expected B1
   commit serves traffic. Confirm the Railway deployment commit, health still
   reports `staffMaintenance.enabled: true`, and application logs contain no
   unexpected errors or HTTP 5xx responses. Run the B1 audit and require zero
   blockers and zero incomplete checks:

   ```bash
   npm run --silent audit:staff-rollout -- --json
   ```

7. Set `STAFF_MAINTENANCE_MODE=false` (or remove it) and redeploy/restart B1.
   Wait for every gate-enabled process to drain. On both production origins,
   prove health reports `false` and only the expected B1 commit is serving.
8. Use the controlled admin mailbox to request a real forgot-password email
   and consume its one-time link end to end. Confirm the
   password-change-required route behavior, then verify login, HTTP API,
   Socket.io, push re-subscription, and clock-in/job/break/clock-out. If reset
   delivery or consumption fails, re-enable the gate and do not rotate legacy
   credentials.

## Retire the repository-known legacy password

The application rejects the retired password as soon as Phase B is live. The
separate rotation step replaces matching stored hashes only after the reset
channel is proven.

1. Run a read-only candidate audit and retain the database name, target
   fingerprint, candidate count, and candidate fingerprint from that exact run:

   ```bash
   npm run rotate:legacy-staff-passwords
   ```

2. Re-run with all four confirmations and the delivery guard. The script
   aborts if the database or candidate set changed:

   ```bash
   STAFF_PASSWORD_RESET_DELIVERY_VERIFIED=true \
     npm run rotate:legacy-staff-passwords -- --apply \
       --confirm-database=<database> \
       --confirm-target=<target-sha256> \
       --confirm-candidates=<count> \
       --confirm-fingerprint=<sha256>
   ```

3. Run the candidate audit again and require zero candidates, then re-run the
   Staff rollout audit and production smoke.

The script never prints email addresses, password hashes, reset tokens, or
replacement credentials.

## Recovery boundary

- Before the migration commits, a failed B1 deploy leaves the B0 release
  serving with the gate enabled.
- Once the generation-2 migration commits, Phase B is forward-only. If B1 does
  not become healthy, leave B0's gate enabled and fix B1 forward. Do not disable
  the gate, roll the application back to a pre-gate Phase A release, or run the
  migration down: Phase A accepts unversioned 30-day Staff JWTs and the retired
  password, so dropping the credential-version boundary would undo session
  revocation.
- After legacy credential rotation, do not roll back to an application that
  lacks the reset flow. The randomized replacement credentials are not
  recoverable; fix forward.
