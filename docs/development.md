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
