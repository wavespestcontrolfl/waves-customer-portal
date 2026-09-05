# Development and QA

Use one worktree per task. Run commands from that worktree's root. The managed
runner installs no packages and performs no migrations at startup.

## Fresh checkout

Use the Node version selected in CI (currently Node 20), then:

```sh
npm ci
npm run worktree:setup
npm run dev:doctor -- --frontend
npm run dev:managed-client
```

The runner prints the URL, checkout path, commit SHA and assigned ports. Its API,
Vite, debugger and control listener bind to loopback. Ports never silently move.
`npm run dev:client` remains the standalone frontend-only Vite command.

Create another checkout with `npm run worktree:create -- task-slug [destination]`.
This fetches origin/main, creates feat/task-slug, installs dependencies within
that checkout and assigns ports. An interrupted install can be resumed with
`npm ci` in the new checkout; do not share node_modules between worktrees.

## Dev database

Each backend worktree needs its own dedicated Railway dev/preview database.
Provision an empty database or synthetic fixture database, never a production
copy. Database creation is explicit; worktree creation does not spend money or
copy database credentials. Place only the selected dev credentials in the
ignored, permission-restricted `.tmp/dev/database.env`:

```dotenv
WAVES_DATABASE_ENVIRONMENT=preview
DATABASE_URL=postgresql://<dev-user>:<dev-password>@<dev-host>:<port>/<dev-db>
```

The environment label records your selection; it cannot establish a remote
server's identity. Verify the Railway project/environment/service before writing
this file. Never put a production URL here. Use a distinct database for each
worktree, including separate credentials where available.

```sh
chmod 600 .tmp/dev/database.env
npm run dev:migrate
npm run dev:doctor
npm run dev
```

`dev:doctor` performs read-only migration readiness checks. `dev:migrate` is the
explicit write step. Managed commands ignore the repository's `.env` and inherited
integration credentials, and disable boot/recovery jobs. This is a development
profile, not a replacement for OS network sandboxing; only synthetic databases
belong here. Raw `dev:server`, `start`, DB and operational commands remain separate
and use their existing environment behavior.

## Debug and stop

`npm run dev:debug` starts the same app with Node's inspector on the assigned
loopback inspector port. Attach your editor or Chrome Node inspector there.
Restart the runner after server code changes; Vite handles frontend HMR.

`npm run worktree:status` reports the managed runner's checkout and startup SHA.
`npm run worktree:stop` asks that runner to terminate its own children. It never
kills a process by port or a persisted PID. Stop before removing or moving a
checkout. State and test artifacts belong under `.tmp/`, outside the public root.

## Verification

- `npm run test:dev-workflow`: environment isolation and worktree allocation.
- `npm run dev:doctor -- --frontend`: dependency and port preflight without DB.
- `npm run build`: production compilation and domain/brand checks.
- `npm run audit:estimate-previews`: fixture-based visual and PDF checks.
- Backend or migration verification requires the configured dev database.

A frontend build or fixture preview is not end-to-end database evidence. Record
which checks ran and explicitly state when migrations/DB flows were not run.

## Browser preview QA

`npm run qa:previews` exercises the real portal, secure appointment, service report
and completion components with fictional fixtures at desktop and mobile widths.
`npm run audit:estimate-previews` retains the estimate interaction/PDF checks.
Both verify the Vite checkout stamp before using a running server. A server from
another checkout or commit is an error; restart it from the intended worktree.

Each audit starts and stops its own Vite process when needed. To use an existing
one, set QA_BASE_URL (general previews) or ESTIMATE_PREVIEW_BASE_URL (estimates)
to its local origin. The general preview audit blocks external requests and API
fallbacks. It writes screenshots, Playwright traces and commit/scenario metadata
under .tmp/qa/previews. Traces contain only the synthetic preview session; keep
real sessions out of this harness. Open a trace with `npx playwright show-trace`
and its zip path. CI retains evidence for seven days, including failed runs.

Browser previews are fixture-based UI evidence. They do not exercise the backend,
provider APIs or database and must not be described as full end-to-end QA.

## Application QA with a real database

After verifying and selecting a Railway dev/preview cluster as above:

```sh
npm run qa:database
npm run dev:migrate
npm run dev:doctor
npm run qa:e2e
npm run qa:cleanup
```

`qa:database` explicitly creates an empty database named for the worktree UUID
within the selected cluster, backs up the selection to `.tmp/dev/cluster.env`,
and selects the private database. It requires database-creation privileges.
It copies no application records. Keep the preview deployment on its original
database so its background jobs cannot process QA accounts. If doctor reports
a pending legacy placeholder after the first migration batch, run `dev:migrate`
again. Never use production credentials with these commands.

`qa:e2e` first runs `npm run build` in the managed frontend environment, so
assets left by an earlier checkout cannot satisfy a run. Build failures stop
before new fixtures are seeded. Each full run pays the build cost; `qa:seed`
and `qa:cleanup` do not build. Keep source files unchanged during a run.

It then creates fictional admin, technician and customer accounts with random
credentials and future appointments. It starts its own loopback API serving the
production frontend build. Browser logins exercise password auth and captured
OTP verification; API journeys check estimate acceptance retries, rescheduling
with an unassigned overlap and 90-minute duration, signed webhook settlement
and replay, completion, and report redaction. The browser renders the customer
portal, paid receipt and completed report against that database.

This is application integration coverage with browser journeys. Twilio OTP and
message delivery and Stripe charge lookup are simulated only in the QA process;
actual auth, signature verification, settlement and database code execute.
Provider credentials are excluded and unexpected HTTP/fetch calls are blocked.
This does not verify real provider delivery, checkout or device hardware.

Screenshots, trace, server log and a commit/step report live in `.tmp/qa/e2e`.
Credentials and captured OTPs are private files there; never commit or attach
them. Traces can contain short-lived synthetic session tokens. CI retains only
the report, screenshots and trace for seven days, then discards them.
`qa:seed` leaves a synthetic fixture for local inspection; `qa:cleanup` removes
only the recorded run's owned records and refuses a changed database selection.
The next E2E run also cleans its previous fixture before creating a new one.
Cleanup retains the private database/schema for future runs.
