// MUTATES (dry-run default; pass --execute to write)
//
// Stamp an explicit customers.billing_mode on NULL-mode rows (#3140
// resolution 2026-08-07): the ruled remediation for rate-bearing rows whose
// lane is currently INFERRED (billing_mode NULL). The owner rules the lane
// per customer and passes each ruling on the command line — this script
// carries NO customer identifiers of its own.
//
// Rules:
// - Rulings arrive as repeatable `--mode-map <uuid>=<lane>` args (lane must
//   be a real BILLING_MODES value — the runtime lane module is the only
//   taxonomy; if it cannot load, ABORT).
// - Dry run (default): reads each ruled row, prints the exact planned
//   UPDATE (current lane/tier/rate/stage beside the ruled lane), flags any
//   row that fails preconditions, and prints the exact --execute command —
//   including the `--expect-rate <uuid>=<cents>` pins for the rates it just
//   observed.
// - --execute: requires an --expect-rate pin for EVERY ruled row (copy them
//   from the dry run). Each customer commits in its OWN transaction:
//   SELECT ... FOR UPDATE, then re-assert under the lock that
//   (1) billing_mode is still NULL, (2) monthly_rate cents still equal the
//   pinned value, (3) pipeline_stage is a real customer stage
//   (active_customer / won / at_risk). Any failed precondition skips that
//   customer with a printed reason — never a partial write.
// - The write is billing_mode ONLY (+ updated_at) plus an audit_log row.
//   monthly_rate is NEVER touched, so the plan-rate ledger's Sigma==scalar
//   invariant is preserved by construction and the 7:25a watch stays green.
// - No customer comms fire (direct DB write, no service hooks).
//
// Run (repo root):
//   railway run --service Postgres node ops/agents/stamp-billing-mode.js \
//     --mode-map <uuid>=per_application [--mode-map <uuid>=<lane> ...]
//   ... then re-run with --execute plus the --expect-rate pins the dry run printed.

const path = require('path');
const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));

const EXECUTE = process.argv.includes('--execute');

// One lane taxonomy — the runtime module (see backfill-plan-rate-ledger.js
// for the same abort-don't-diverge rule).
let BILLING_MODES;
try {
  ({ BILLING_MODES } = require(path.join(__dirname, '..', '..', 'server', 'services', 'billing-lane')));
  if (!Array.isArray(BILLING_MODES) || !BILLING_MODES.length) throw new Error('BILLING_MODES missing');
} catch (loadErr) {
  console.error(`ABORT: billing-lane module unavailable (${loadErr.message}) — run via \`railway run\` from the repo root so server modules can load.`);
  process.exit(1);
}

const REAL_STAGES = ['active_customer', 'won', 'at_risk'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectArg(flag) {
  const out = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${flag}=`)) out.push(argv[i].slice(flag.length + 1));
  }
  return out;
}

function parsePairs(flag, valueLabel, validate) {
  const map = new Map();
  for (const raw of collectArg(flag)) {
    const eq = raw.indexOf('=');
    const id = eq > 0 ? raw.slice(0, eq).trim().toLowerCase() : '';
    const value = eq > 0 ? raw.slice(eq + 1).trim() : '';
    if (!UUID_RE.test(id)) {
      console.error(`ABORT: ${flag} entry '${raw}' — expected <customer-uuid>=<${valueLabel}>.`);
      process.exit(1);
    }
    const parsed = validate(value, raw);
    if (map.has(id)) {
      console.error(`ABORT: duplicate ${flag} entry for ${id}.`);
      process.exit(1);
    }
    map.set(id, parsed);
  }
  return map;
}

const modeMap = parsePairs('--mode-map', 'lane', (value, raw) => {
  if (!BILLING_MODES.includes(value)) {
    console.error(`ABORT: --mode-map entry '${raw}' — lane must be one of: ${BILLING_MODES.join(', ')}.`);
    process.exit(1);
  }
  return value;
});

const expectRate = parsePairs('--expect-rate', 'cents', (value, raw) => {
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < 0) {
    console.error(`ABORT: --expect-rate entry '${raw}' — expected integer cents (e.g. 3633).`);
    process.exit(1);
  }
  return cents;
});

if (!modeMap.size) {
  console.error('Usage: node ops/agents/stamp-billing-mode.js --mode-map <uuid>=<lane> [--mode-map ...] [--execute --expect-rate <uuid>=<cents> ...]');
  process.exit(1);
}

if (EXECUTE) {
  const missing = [...modeMap.keys()].filter((id) => !expectRate.has(id));
  if (missing.length) {
    console.error(`ABORT: --execute requires an --expect-rate pin for every ruled row (missing: ${missing.join(', ')}). Run the dry run first and copy its pins.`);
    process.exit(1);
  }
}

const cents = (rate) => Math.round((Number(rate) || 0) * 100);

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('ABORT: no DATABASE_PUBLIC_URL/DATABASE_URL — run via `railway run --service Postgres`.');
    process.exit(1);
  }
  // Railway's public proxy needs TLS; a localhost test DB has none.
  const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  let failures = 0;
  let written = 0;
  const pins = [];
  try {
    for (const [id, lane] of modeMap) {
      const { rows } = await client.query(
        'SELECT id, billing_mode, waveguard_tier, monthly_rate, per_application_fee, pipeline_stage, deleted_at FROM customers WHERE id = $1',
        [id],
      );
      const row = rows[0];
      if (!row) { console.log(`SKIP ${id}: no such customer`); failures += 1; continue; }
      const problems = [];
      if (row.billing_mode != null) problems.push(`billing_mode already '${row.billing_mode}'`);
      if (!REAL_STAGES.includes(row.pipeline_stage)) problems.push(`pipeline_stage '${row.pipeline_stage}' is not a real customer stage`);
      if (row.deleted_at != null) problems.push('row is soft-deleted');
      const rateCents = cents(row.monthly_rate);

      if (!EXECUTE) {
        console.log(`PLAN ${id}: billing_mode NULL -> '${lane}'`
          + ` | tier=${row.waveguard_tier || '(none)'} rate=$${(rateCents / 100).toFixed(2)}`
          + ` per_app_fee=${row.per_application_fee == null ? '(null)' : `$${Number(row.per_application_fee).toFixed(2)}`}`
          + ` stage=${row.pipeline_stage}`
          + (problems.length ? ` | BLOCKED: ${problems.join('; ')}` : ''));
        if (!problems.length) pins.push({ id, lane, rateCents });
        if (problems.length) failures += 1;
        continue;
      }

      // --execute: per-customer transaction, re-assert under lock.
      await client.query('BEGIN');
      try {
        const locked = (await client.query(
          'SELECT id, billing_mode, monthly_rate, pipeline_stage, deleted_at FROM customers WHERE id = $1 FOR UPDATE',
          [id],
        )).rows[0];
        const lockedProblems = [];
        if (!locked) lockedProblems.push('row vanished');
        else {
          if (locked.billing_mode != null) lockedProblems.push(`billing_mode already '${locked.billing_mode}'`);
          if (cents(locked.monthly_rate) !== expectRate.get(id)) lockedProblems.push(`monthly_rate moved (${cents(locked.monthly_rate)}c != pinned ${expectRate.get(id)}c)`);
          if (!REAL_STAGES.includes(locked.pipeline_stage)) lockedProblems.push(`pipeline_stage '${locked.pipeline_stage}' is not a real customer stage`);
          if (locked.deleted_at != null) lockedProblems.push('row is soft-deleted');
        }
        if (lockedProblems.length) {
          await client.query('ROLLBACK');
          console.log(`SKIP ${id}: ${lockedProblems.join('; ')}`);
          failures += 1;
          continue;
        }
        await client.query(
          'UPDATE customers SET billing_mode = $2, updated_at = now() WHERE id = $1',
          [id, lane],
        );
        await client.query(
          `INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ('system', NULL, 'billing.mode.stamp', 'customer', $1, $2::jsonb)`,
          [id, JSON.stringify({
            mode: lane,
            previous_mode: null,
            monthly_rate_cents: expectRate.get(id),
            source: 'ops/agents/stamp-billing-mode.js',
            ruling: '#3140 resolution 2026-08-07 — owner-ruled lane stamp; monthly_rate untouched',
          })],
        );
        await client.query('COMMIT');
        console.log(`WROTE ${id}: billing_mode NULL -> '${lane}' (audit_log billing.mode.stamp)`);
        written += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log(`SKIP ${id}: transaction failed (${err.message})`);
        failures += 1;
      }
    }
  } finally {
    await client.end();
  }

  if (!EXECUTE) {
    console.log(`\nDRY RUN — nothing written. ${modeMap.size - failures}/${modeMap.size} row(s) pass preconditions.`);
    if (pins.length) {
      // Only rows that PASSED ride into the suggested command — a blocked
      // row's ruling should be re-examined, not carried along.
      console.log('To execute, re-run with:');
      console.log(`  railway run --service Postgres node ops/agents/stamp-billing-mode.js ${pins.map((p) => `--mode-map ${p.id}=${p.lane}`).join(' ')} ${pins.map((p) => `--expect-rate ${p.id}=${p.rateCents}`).join(' ')} --execute`);
    }
  } else {
    console.log(`\nDONE: ${written} written, ${failures} skipped.`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
