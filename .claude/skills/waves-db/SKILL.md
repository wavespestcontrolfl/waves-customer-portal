---
name: waves-db
description: Use whenever running knex commands, writing migrations, querying the prod DB from a local machine, or writing any SQL/knex WHERE clause involving timestamps. Covers the three DB traps that have each caused real incidents — wrong knexfile discovery, the ET/timestamptz window leak, and prod access from local.
---

# Waves DB rules

## 1. Always pass the knexfile

Every knex CLI invocation MUST name the knexfile explicitly, with the path
relative to your current working directory:

```
# from the repo root:
npx knex <command> --knexfile server/knexfile.js

# from server/:
npx knex <command> --knexfile knexfile.js
```

Without `--knexfile`, knex's default discovery picks the wrong config (or
none) depending on cwd, and has silently mis-targeted prod before. The flag
is resolved against cwd too — `--knexfile server/knexfile.js` run from
inside `server/` fails looking for `server/server/knexfile.js`. This
applies to `migrate:latest`, `migrate:make`, `seed:run` — all of it.

## 2. The timestamptz window leak

The portal's behavior layer is **all Eastern Time**, but storage is
`timestamptz` (UTC). The trap: interpolating a **naive ISO string** (no
offset) into a WHERE clause — Postgres reads it as UTC and your "today in ET"
window silently shifts 4–5 hours. That moves boundary rows into the wrong
day/week (reminders, digests, KPI windows).

Rules:
- Build ET boundaries with `server/utils/datetime-et.js`
  (`parseETDateTime`, `etDateString`) and pass real `Date` objects to knex —
  never hand-built `'YYYY-MM-DDT00:00:00'` strings.
- Crons are scheduled with `{ timezone: 'America/New_York' }` — keep their
  query windows in the same frame.
- When reviewing a diff, any string literal that looks like a timestamp
  inside `.where(...)` is a finding until proven offset-aware.

## 3. Local DB access — dev/preview by default, prod is break-glass

Default for agent sessions (per the AGENTS.md database policy): use a
Railway **dev or preview Postgres branch** as `DATABASE_URL`. Do not point a
session at production for routine work, and never run migrations or other
writes against prod from a local machine.

Prod access is **break-glass**: owner-authorized for the specific task,
read-only (SELECT), and through a restricted role when one exists for the
domain (e.g. `newsletter_verifier`) instead of the full-write URL. This
skill deliberately ships no copy/paste prod connection command — get the
credential for the restricted role from the owner at authorization time.

When authorized, two operational facts (not a recipe):
- The private `DATABASE_URL` is unreachable from outside Railway; the
  public endpoint lives in the **Postgres service's** env, not the app
  service's (the app service's value fails with SSL errors).
- Export the credential under a task-specific name (e.g. `PROD_RO_URL`)
  and have the script read that name explicitly — never set `DATABASE_URL`
  in your shell, so stray knex/node tooling that defaults to
  `DATABASE_URL` cannot silently target prod.

Never print the URL or paste it into logs/PRs.

## 4. Migrations

- Filename convention: `YYYYMMDD0000NN_short_name.js` in
  `server/models/migrations/`.
- Migrations that touch seeded/admin-editable rows must preserve admin edits
  (read-modify-write the row, don't overwrite wholesale) and write an audit
  row when an audit table exists. Exemplar:
  `server/models/migrations/20260611000003_pest_footprint_1750_bracket.js`.
- After merging a PR that ships a migration, verify the deploy actually ran
  it before relying on the new schema.
