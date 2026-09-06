# Codex development setup

Follow [docs/development.md](docs/development.md) for the shared worktree,
startup, debugging and QA procedure. Work from the task checkout, never another
session's branch. No production database access is part of local setup.

```sh
npm ci
npm run worktree:setup
npm run dev:doctor -- --frontend
npm run dev:managed-client
```

Backend work requires an explicitly selected Railway dev/preview database in
`.tmp/dev/database.env`. Run `npm run dev:migrate` explicitly, then `dev:doctor`
and `dev`. No migrations run automatically on app startup.

Before claiming end-to-end verification, run the flow against the real dev
schema and inspect the result. State when DB verification was unavailable.
