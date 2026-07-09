---
name: waves-db
description: Use whenever running knex commands, writing or reviewing migrations, writing raw SQL or backfills, querying the prod DB from a local machine, or writing any SQL/knex WHERE clause involving timestamps. Covers the DB traps that have each caused real incidents — wrong knexfile discovery, the ET/timestamptz window leak, edited-in-place migrations, unverified raw SQL, prod access from local, and the schema traps that produce wrong answers.
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

When authorized, three operational facts (not a recipe):
- The private `DATABASE_URL` is unreachable from outside Railway; the
  public endpoint lives in the **Postgres service's** env, not the app
  service's (the app service's value fails with SSL errors).
- Export the credential under a task-specific name (e.g. `PROD_RO_URL`)
  and have the script read that name explicitly — never set `DATABASE_URL`
  in your shell, so stray knex/node tooling that defaults to
  `DATABASE_URL` cannot silently target prod.
- Each Bash tool call is a fresh subshell — inline the env var in the same
  command; an `export` in a previous call does not persist.

Never print the URL or paste it into logs/PRs. Prod writes outside a
deployed migration additionally need Adam's explicit authorization, a stated
expected row count, and a dry-run first. Remember: direct prod DB writes
fire ZERO customer communications — that's sometimes the point (bulk
schedule inserts) and sometimes the bug (you expected a reminder to send).

## 4. Migrations

- Filename convention: `YYYYMMDD0000NN_short_name.js` in
  `server/models/migrations/`.
- **Never edit an already-run migration.** Knex tracks by filename — an
  edit is a silent no-op in every environment that already ran it. Ship a
  NEW migration instead, and re-check the PR's live merge state before
  pushing follow-up commits to it.
- House style: `exports.up = async function up(knex)` with a symmetric
  `down`; guard with `hasTable` on the first line and per-column
  `hasColumn` before `alterTable` — idempotent in both directions.
- Migrations that touch seeded/admin-editable rows must preserve admin edits
  (read-modify-write the row, don't overwrite wholesale) and write an audit
  row when an audit table exists. Exemplar:
  `server/models/migrations/20260611000003_pest_footprint_1750_bracket.js`.
- pg-function splice migrations (string-editing a function body): wrap the
  original IF condition in parentheses before AND-ing onto it; fixtures must
  be the verbatim `pg_get_functiondef` text from prod; simulate the splice
  against that prod text before merge.
- Migration **writes** get a dry-run inside `BEGIN; … ROLLBACK;` against a
  dev/preview Postgres branch that mirrors prod schema before merge —
  mocked tests miss type/constraint mismatches, and one failed migration
  blocks EVERY Railway deploy (migrations run pre-deploy). Never execute
  migration DDL/DML against prod from local, even wrapped in a rollback
  (it takes locks and can fire side effects, and the read-only role can't
  run writes anyway) — verify the schema/type assumptions the migration
  relies on via read-only SELECTs instead (§3, §5).
- After merging a PR that ships a migration, verify the deploy actually ran
  it (deploy log or `knex_migrations`) before relying on the new schema.

## 5. Raw SQL verification

- Any new raw SQL destined for prod is executed read-only against prod
  BEFORE the PR merges. Never trust column names/types from migration
  files — verify against the live schema (see traps below).
- `db.raw()` with request-derived input must use `?` placeholders; string
  interpolation is a SQL-injection P0 (AGENTS.md).

## 6. Schema truth traps (wrong-answer generators)

- `customers.active` is TRUE for leads. A "real customer" =
  `pipeline_stage IN (active_customer, won, at_risk)` — use the
  `whereRealCustomer` helper. `customers.status` does not exist.
  `member_since` is canonical; `customer_since` is dead.
- `referrals.id` is a UUID even though migration 000054 reads `increments`
  (a dead hasTable-guarded no-op). Migration text lies; prod schema doesn't.
- `scheduled_services.status` is gated by a CHECK constraint — a new status
  string without a migration extending the CHECK throws at runtime and CI
  won't catch it (AGENTS.md P0).
- `service_requests` backs TWO flows; its partial-unique dedup index only
  releases on terminal status — never remove the admin resolve PATCH.
- Verifying a reschedule: check `scheduled_date` + the HTTP 200 in Railway
  logs. `updated_at` and `reschedule_log` are dead signals (false
  negatives).
- Staging has its OWN database and vault key — never copy encrypted
  ciphertext between DBs, and failed staging twins are not prod failures.

## 7. Verification before "done"

Confirm data changes by SELECTing the affected rows (or matched/updated
counts for backfills), not by absence of errors. Migration merged ≠
migration ran. If something could not be verified (no dev DB in the
sandbox, no authorized prod access), say so explicitly instead of implying
verification happened.
