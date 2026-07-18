# ops/agents — recurring operator & agent scripts

Scripts that operate the live business (prod DB reads, Railway env hygiene,
Stripe verification) and kept dying in per-session scratchpads. Anything an
operator or agent session reaches for twice gets promoted here.

**This folder is tooling, not application code.** Nothing in here is imported
by the server or client, and nothing here runs on a schedule — every script is
invoked by a human or an agent session, on purpose, from the repo root.

## Conventions (enforced — reviewers treat violations as P1)

1. Every script declares `READ-ONLY` or `MUTATES` in its header comment and in
   the index below.
2. `MUTATES` scripts are **dry-run by default** and only write when passed
   `--execute`. The dry run prints exactly what would change.
3. No secrets, tokens, customer names, or invoice numbers in filenames or file
   contents. Credentials come from the environment at runtime (`railway run`
   injects them); results print to stdout only.
4. Promotion rule: the second time a scratchpad script gets used, it moves
   here with a header comment and an index entry.

## Index

| Script | Mode | What it does |
|---|---|---|
| `pull-page-tokens.js` | READ-ONLY | Pulls one recent live token per customer-facing token-gated page type (estimate, pay, receipt, report, track, …) so those pages can be opened for visual review. |
| `retention-purge.js` | MUTATES (dry-run default) | Dismisses all `pending_approval` retention outreach drafts (`status` → `rejected`), audit-tagged and reversible. |
| `railway-var-cleanup.sh` | MUTATES (dry-run default) | Deletes named Railway service variables one at a time, with confirmation of what exists first. |
| `completion-lane-coverage.js` | READ-ONLY | B0 catalog coverage audit: classifies every active service into a completion lane via `server/config/completion-lane-registry.js` and exits 1 on defects (generic fall-throughs, unlisted stragglers, no-decision keys). |
| `mcp-stdio.js` | READ-ONLY | stdio ↔ HTTP bridge for the portal's `/api/mcp` MCP knowledge server, so stdio-transport MCP clients (e.g. `claude mcp add`) can use the read-only knowledge tools. Needs `MCP_SERVICE_TOKEN`; endpoint stays gated behind `GATE_MCP_READ_TOOLS`. |

## Prod read-only access recipe

The portal's `DATABASE_URL` points at `postgres.railway.internal`, which is
unreachable from a local machine (`ENOTFOUND`). For read-only prod queries:

- **Postgres:** `railway run --service Postgres node <script>` and connect via
  `process.env.DATABASE_PUBLIC_URL` (the public proxy). Node scripts here use
  `pg` with `ssl: { rejectUnauthorized: false }`.
- **Stripe:** write a Node script using `require('stripe')` +
  `process.env.STRIPE_SECRET_KEY` and run it with `railway run node <script>`
  from the repo root — the secret stays inside the subprocess. If the script
  lives outside the repo, set `NODE_PATH="$PWD/node_modules"`.
- **Deploy status:** `railway deployment list` from the repo root.
- Railway services are `waves-customer-portal`, `Postgres`, and
  `seo-pipeline-worker`.

Prod access is still gated by Railway auth (`railway login`) — these recipes
grant nothing by themselves. Keep every prod-touching script scoped to exactly
what was asked; never dump full tables or the variable store.

## Usage

```sh
# Read-only: grab one live token per public page type
railway run --service Postgres node ops/agents/pull-page-tokens.js

# Dry-run (default), then real run, of the retention draft purge
railway run --service Postgres node ops/agents/retention-purge.js
railway run --service Postgres node ops/agents/retention-purge.js --execute

# Preview, then delete, dead Railway vars (each delete can trigger a redeploy)
ops/agents/railway-var-cleanup.sh GATE_VOICE_AGENT META_CAPI_TEST_EVENT_CODE
ops/agents/railway-var-cleanup.sh --execute GATE_VOICE_AGENT META_CAPI_TEST_EVENT_CODE
```
