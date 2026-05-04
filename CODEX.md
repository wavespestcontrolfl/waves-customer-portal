# CODEX.md - Waves Customer Portal

Codex-specific setup notes for local/sandbox sessions.

## Database Setup

`server/knexfile.js` reads `process.env.DATABASE_URL`. If it is missing, the
Postgres client can fall back to a database named after the OS user, which does
not exist in many Codex sandboxes. Because `package.json` runs
`npm run db:migrate` before `npm run dev`, missing database config can prevent
the dev server from starting.

Preferred setup:

```sh
DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>?sslmode=require
```

Use a Railway dev or preview Postgres branch. Do not use production.

If no dev database is available, skip migrations in the sandbox and verify the
parts that do not require Postgres:

```sh
npm run dev:client
npm run build
```

For backend, endpoint, migration, or data-flow work, get a real dev
`DATABASE_URL` before claiming end-to-end DB verification. If migrations were
not run locally, say that explicitly in the final answer or PR summary.
