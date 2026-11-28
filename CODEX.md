# Codex development setup

Follow [docs/development.md](docs/development.md) for the shared worktree,
startup, debugging and QA procedure. Work from the task checkout, never another
session's branch. No production database access is part of local setup.

On the owner's multi-session Mac, install dependencies through the shared queue wrapper (never bare `npm ci`; fails closed if the wrapper is unavailable):

```sh
~/.claude/bin/npm-ci-serial
```

In isolated CI, cloud sandboxes, or other single-user machines, run `npm ci` instead. Then initialize and start the worktree:

```sh
npm run worktree:setup
npm run dev:doctor -- --frontend
npm run dev:managed-client
```

Backend work requires an explicitly selected Railway dev/preview database in
`.tmp/dev/database.env`. Run `npm run dev:migrate` explicitly, then `dev:doctor`
and `dev`. No migrations run automatically on app startup.

Before claiming end-to-end verification, run the flow against the real dev
schema and inspect the result. State when DB verification was unavailable.
