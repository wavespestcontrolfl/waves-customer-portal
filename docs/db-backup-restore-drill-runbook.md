# DB backup + restore drill — runbook

Stripe is the payment processor, not a system of record. The Railway Postgres
instance holds every customer, invoice, visit, lead, and transcript. Railway
keeps volume backups on its side; this lane adds an **independent, encrypted,
offsite copy every night** and — the part that actually matters — **proves
each copy restores** by loading it into a throwaway Postgres and comparing row
counts. A failed drill fails the workflow run **and emails contact@** through
SendGrid from a separate job, so a hung dump that hits the timeout still
alerts. GitHub's own run-failure emails depend on each user's notification
settings, so they are a second channel, not the guarantee.

Workflow: `.github/workflows/db-backup-drill.yml` (nightly 07:30 UTC, also
`workflow_dispatch`). Restore script: `ops/backup/restore.sh`.

## One-time setup (owner)

Until every secret below exists the workflow **fails on purpose** at its first
step. Do not "fix" that by making it skip — a silently skipped backup is the
failure this lane exists to prevent.

1. **Cloudflare R2 bucket.** Cloudflare dashboard → R2 → Create bucket, e.g.
   `waves-db-backups`. Location hint: Eastern North America. Then Object
   lifecycle rules → add a rule deleting objects older than **35 days** under
   the `waves-portal/` prefix (`latest.json` is overwritten nightly and never
   ages out).
2. **R2 API token.** R2 → Manage R2 API Tokens → Create: permission
   *Object Read & Write*, scoped to that one bucket. Note the Access Key ID,
   Secret Access Key, and the account id shown in the S3 endpoint
   (`https://<account id>.r2.cloudflarestorage.com`).
3. **Encryption key.** `openssl rand -base64 48`. Store it in the password
   manager as well — a backup nobody can decrypt is no backup, and GitHub
   never shows a secret again after it is saved.
4. **Database URL.** The Postgres service's `DATABASE_PUBLIC_URL` on Railway
   (the public proxy — GitHub runners cannot reach `postgres.railway.internal`).
5. **GitHub repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `BACKUP_DATABASE_URL` | the `DATABASE_PUBLIC_URL` from step 4 |
   | `BACKUP_ENCRYPTION_KEY` | step 3 |
   | `R2_ACCOUNT_ID` | step 2 |
   | `R2_ACCESS_KEY_ID` | step 2 |
   | `R2_SECRET_ACCESS_KEY` | step 2 |
   | `R2_BACKUP_BUCKET` | bucket name from step 1 |
   | `SENDGRID_API_KEY` | the portal's existing SendGrid key (Railway var of the same name) — sends the failure email from contact@ |

6. Actions → **db-backup-drill** → *Run workflow*. The run summary shows a
   source/restored table with a verdict per sentinel table. Green here is the
   first proof the business has ever had that its database restores.
7. Prove the alert channel once: temporarily remove `R2_BACKUP_BUCKET`, run
   the workflow, confirm the "DB backup drill FAILED" email lands in
   contact@, then restore the secret. Also turn on GitHub → Settings →
   Notifications → Actions → *Failed workflows only* as the second channel.

## What a run does

1. Installs `postgresql-client-18` (prod is Postgres 18; the client must be at
   least the server major or `pg_dump` refuses).
2. Samples row counts on the sentinel tables (`customers`, `invoices`,
   `payments`, `scheduled_services`, `service_records`, `leads`,
   `knex_migrations`).
3. Stamps the cutoff, then `pg_dump --format=custom` (compressed,
   table-selectable), AES-256 encrypts it, uploads
   `waves-portal/YYYY/MM/waves-portal-<cutoff>.dump.enc` and its immutable
   manifest `…<cutoff>.json` (key, cutoff, plaintext sha256, sizes, source
   counts).
4. Deletes the local dump, **downloads the uploaded object back**, decrypts,
   verifies the sha256, and `pg_restore`s it into a `pgvector/pgvector:pg18`
   container.
5. Compares counts. `knex_migrations` must match exactly; the others tolerate
   max(5, 1%) drift because prod keeps writing between the sample and the
   snapshot. Any table at zero, any drift beyond tolerance, or a missing
   `vector` extension fails the run.
6. Only after every check passes, publishes `waves-portal/latest.json`. A
   failed drill leaves the pointer at the previous proven backup.

Expected duration: roughly 10–20 minutes at today's ~1.2 GB.

## Real disaster: restoring to Railway

**Never restore over the live instance.** The script connects first and
refuses any target that already holds tables; only an empty database is
accepted. `RESTORE_REPLACE_EXISTING=yes` overrides that for a database you
intend to erase — never the live one. Replace mode drops and recreates the
`public` schema first, so nothing added after the backup survives.

1. Railway → the project → **+ New → Database → PostgreSQL**. Railway's
   Postgres image ships pgvector. Copy its `DATABASE_PUBLIC_URL`.
2. Pick the backup: read `waves-portal/latest.json` in the bucket for the
   newest key, or list `waves-portal/YYYY/MM/` for an older point in time —
   every object has its own immutable `<same name>.json` manifest (cutoff,
   sha256, source counts) beside it.
   Download it (Cloudflare dashboard, or `aws s3 cp --endpoint-url
   https://<account id>.r2.cloudflarestorage.com s3://<bucket>/<key> .` with
   the R2 token in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
3. With a local `pg_restore` ≥ 18 (`brew install postgresql@18`):

   ```sh
   BACKUP_ENCRYPTION_KEY='<from the password manager>' \
   ops/backup/restore.sh waves-portal-<stamp>.dump.enc '<new instance DATABASE_PUBLIC_URL>'
   ```

4. Spot-check: `psql '<url>' -c 'select count(*) from customers'` against the
   `source_counts` in that backup's manifest; `select max(name) from knex_migrations`
   against the newest file in `server/models/migrations/`.
5. Point **every** database consumer at the new instance's **private** URL
   (`postgres.railway.internal`) and redeploy each: the portal service
   `waves-customer-portal` AND `seo-pipeline-worker` (it imports
   `server/models/db` and writes through `DATABASE_URL`). A consumer left on
   the old instance keeps mutating a divergent database.
6. Reconcile the loss window: everything written after the backup's `cutoff`
   (in the manifest — stamped *before* the dump started, so it is
   conservative) up to the cutover. Stripe does **not** replay events it
   already delivered with a 2xx: list every event since the cutoff in the
   Stripe dashboard (Developers → Events) and re-send each to the webhook
   endpoint, or apply them by hand — payments, refunds, and subscription
   changes included. Twilio inbound messages are not replayed either; read
   the gap from the Twilio message log. Do this before reopening the office.
7. Delete the decrypted `.dump` from the laptop (the script writes it mode
   0600, but it is still the entire customer database in plaintext).

## Kill switch / rotation

- Disable: Actions → db-backup-drill → ··· → *Disable workflow*. Removing
  `BACKUP_DATABASE_URL` also stops it (loudly).
- Rotate the encryption key: set the new `BACKUP_ENCRYPTION_KEY`; objects
  written before rotation still need the old key, so keep it in the password
  manager for the 35-day lifecycle window.
- Rotate the R2 token or the database password: update the matching secret;
  the next run proves it.

## Known limits

- Nightly = up to 24 hours of exposure. Railway's own volume backups remain
  the first line for a same-day rollback; this lane is the independent one.
- The drill proves the dump restores and the sentinel tables are intact. It
  does not prove application-level consistency; the migration count check is
  the closest proxy.
- Postgres major upgrades on Railway must be mirrored in the workflow: the
  `postgresql-client-N` package and the `pgvector/pgvector:pgN` image.
- GitHub disables scheduled workflows in a repository with no commits for
  60 days. This repo commits daily; if that ever stops, re-enable the
  workflow by hand (Actions → db-backup-drill → *Enable workflow*).
- The failure email itself depends on the SendGrid key being valid. A run
  whose alert step also fails is visible only in the Actions tab — the
  second channel above exists for exactly that case.
