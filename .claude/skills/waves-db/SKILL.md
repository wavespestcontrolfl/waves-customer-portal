---
name: waves-db
description: Use whenever running knex commands, writing migrations, querying the prod DB from a local machine, or writing any SQL/knex WHERE clause involving timestamps. Covers the three DB traps that have each caused real incidents — wrong knexfile discovery, the ET/timestamptz window leak, and prod access from local.
---

# Waves DB rules

## 1. Always pass the knexfile

Every knex CLI invocation MUST be:

```
npx knex <command> --knexfile server/knexfile.js
```

Without `--knexfile`, knex's default discovery picks the wrong config (or
none) depending on cwd, and has silently mis-targeted prod before. This
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

## 3. Prod DB from a local machine

The private `DATABASE_URL` is unreachable from outside Railway. Use the
public URL from the **Postgres service** (the app service's env does NOT
carry a usable one — connecting with it fails with SSL errors):

```
PUB=$(railway variables -s Postgres --json | python3 -c "import json,sys; print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])")
DATABASE_URL="$PUB" node <script>      # or under: railway run -s waves-customer-portal -- ...
```

Never print the URL. Read-only exploration should prefer a restricted role
when one exists for the domain (e.g. `newsletter_verifier`).

## 4. Migrations

- Filename convention: `YYYYMMDD0000NN_short_name.js` in
  `server/models/migrations/`.
- Migrations that touch seeded/admin-editable rows must preserve admin edits
  (read-modify-write the row, don't overwrite wholesale) and write an audit
  row when an audit table exists. Exemplar:
  `server/models/migrations/20260611000003_pest_footprint_1750_bracket.js`.
- After merging a PR that ships a migration, verify the deploy actually ran
  it before relying on the new schema.
