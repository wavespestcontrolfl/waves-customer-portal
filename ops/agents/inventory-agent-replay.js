#!/usr/bin/env node
// READ-ONLY
//
// inventory-agent-replay.js — collects every past purchase title (SiteOne
// invoice lines + Amazon Delivered/Shipped item titles), runs the exact
// deterministic classifier (receipt-processor.js's classifyItem) on each,
// and for the ones it could NOT resolve (unmatched / needs_size /
// size_mismatch — the same three statuses GATE_INVENTORY_AGENT hands off)
// runs the REAL inventory-agent decision pipeline (decideForTitle, the
// exact function the live agent uses) and prints what WOULD happen. Never
// writes, never rings a bell, never moves stock, never creates a product or
// alias — this is `decideForTitle` alone, not `applyDecision`.
//
// A single-connection pool sets the SESSION (not just one transaction) to
// READ ONLY once at connect time, so ANY write on THAT pool is refused by
// Postgres itself. That alone isn't the whole process, though:
// dispatchWithFallback's real LLM calls (the whole point of this script) go
// through server/services/llm-dispatch-metrics.js when GATE_LLM_CALL_LEDGER /
// GATE_LLM_CALL_TRACES / GATE_LLM_DISPATCH_METRICS are on, which writes
// through the SHARED server/models/db pool — a completely different
// connection this script's own pool has no say over (2026-09-27 pre-push
// review P1). Two independent layers close that gap, both set before this
// file requires ANY service module (below):
//   1. PGOPTIONS='-c default_transaction_read_only=on' — node-postgres
//      (confirmed here: pg@8.20, node_modules/pg/lib/connection-parameters.js
//      — `val('options', config)` falls back to `process.env.PGOPTIONS`
//      whenever the connection config doesn't set `options` itself, exactly
//      like libpq) sends it as the startup `options` parameter on EVERY
//      connection this process opens, this script's own pool included, so
//      the shared db module's pool is read-only too, however it's used.
//   2. The three telemetry gates are forced off for this process, so the
//      writing code paths themselves are never even reached — belt and
//      suspenders in case PGOPTIONS were ever not honored (a future pg
//      version, some other connection config overriding `options`, …).
// assertReadOnly() below then PROVES layer 1 actually took, with a real
// (zero-row, so nothing could ever change even if it somehow succeeded)
// write attempt through the shared db module — the script refuses to run
// at all unless Postgres itself rejects it.
process.env.PGOPTIONS = '-c default_transaction_read_only=on';
// The shared server/models/db pool reads DATABASE_URL. Under a local
// `railway run` that is Railway's internal address, unreachable from here,
// so point it at the public URL before any server module is loaded.
// The public proxy needs TLS, and the knexfile only turns it on under
// NODE_ENV=production — the same PGSSLMODE=no-verify setup as the other
// `railway run` scripts (see archive-catalog-service.js), unless the URL or
// the environment already says how.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}
delete process.env.GATE_LLM_CALL_LEDGER;
delete process.env.GATE_LLM_CALL_TRACES;
delete process.env.GATE_LLM_DISPATCH_METRICS;
//
// The LLM leg costs real money/time per unresolved title, so --limit caps
// how many get a live call; everything past that is listed with its
// classifier status only.
//
//   railway run --service Postgres -- node ops/agents/inventory-agent-replay.js
//   railway run --service Postgres -- node ops/agents/inventory-agent-replay.js --limit=20
//   railway run --service Postgres -- node ops/agents/inventory-agent-replay.js --since=2026-06-01
//
// Uses DATABASE_PUBLIC_URL (the owner's railway run recipe) — do not run
// this against production from a session; the primary runs it. (Checked
// only when run directly, at the bottom of this file — never when a test
// requires this module for assertReadOnly.)
const path = require('path');
const knex = require('knex');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
// --limit=0 is valid: list every title with its classifier status, no LLM calls.
const LIMIT_ARG = Number(arg('limit', '50'));
const LIMIT = Number.isInteger(LIMIT_ARG) && LIMIT_ARG >= 0 ? LIMIT_ARG : 50;
const SINCE = new Date(arg('since', '2000-01-01T00:00:00Z'));

const server = (relative) => path.join(__dirname, '..', '..', 'server', relative);
const { classifyItem, AGENT_HANDOFF_STATUSES } = require(server('services/purchase-receipts/receipt-processor'));
const { parseAmazonDeliveredEmail, parseAmazonShippedEmail, AMAZON_DELIVERY_FROM, AMAZON_SHIPPED_FROM } = require(server('services/purchase-receipts/amazon-delivery-parser'));
const siteOne = require(server('services/purchase-receipts/siteone-invoices'));
const { decideForTitle, loadAllowedCategories, loadActiveCatalog, siteOneLineFields } = require(server('services/purchase-receipts/inventory-agent'));
const { siteOneHold } = require(server('services/purchase-receipts/sweep'));
const { dispatchWithFallback } = require(server('services/llm/call'));
// The shared pool dispatchWithFallback's telemetry can write through —
// required here ONLY so assertReadOnly can prove it's read-only too; every
// actual read below goes through this script's own dedicated pool.
const sharedDb = require(server('models/db'));

// Proves layer 1 above actually took: a real write statement through the
// SHARED db module that matches zero rows (a fabricated id), so nothing
// could change even if the guard somehow failed. Exported for a unit test
// that exercises the error-classification without a live database.
async function assertReadOnly(db) {
  let rejected = false;
  try {
    // products_catalog.name exists in every environment, before or after
    // this lane's migration, so the check never fails for a missing column.
    await db.raw("UPDATE products_catalog SET name = name WHERE id = '00000000-0000-0000-0000-000000000000'::uuid");
  } catch (err) {
    if (!/read-only transaction/i.test(err.message)) {
      throw new Error(`read-only self-check errored, but not with the expected read-only rejection — refusing to run: ${err.message}`);
    }
    rejected = true;
  }
  if (!rejected) {
    throw new Error('READ-ONLY SELF-CHECK FAILED: a write statement did not error. Refusing to run — PGOPTIONS may not be honored in this environment.');
  }
}

function readOnlyConn() {
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_PUBLIC_URL,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (pgConn, done) => {
        pgConn.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', (err) => done(err, pgConn));
      },
    },
  });
}

async function amazonTitles(conn, since) {
  const items = [];
  // from_address is required: both Amazon parsers check the sender first.
  const columns = ['id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'received_at'];
  const delivered = await conn('emails').select(columns)
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM]).whereRaw('subject ILIKE ?', ['Delivered:%']).where('received_at', '>=', since);
  for (const email of delivered) {
    for (const item of parseAmazonDeliveredEmail(email)?.items || []) items.push({ vendor: 'amazon', title: item.title, quantity: item.quantity ?? 1 });
  }
  const shipped = await conn('emails').select(columns)
    .whereRaw('LOWER(from_address) = ?', [AMAZON_SHIPPED_FROM]).whereRaw('subject ILIKE ?', ['Shipped:%']).where('received_at', '>=', since);
  for (const email of shipped) {
    for (const item of parseAmazonShippedEmail(email)?.items || []) items.push({ vendor: 'amazon', title: item.title, quantity: item.quantity ?? 1 });
  }
  return items;
}

async function siteOneTitles(conn, since) {
  const items = [];
  for (const email of await siteOne.findSiteOneInvoiceEmails(since, conn)) {
    let invoice;
    try {
      invoice = await siteOne.readSiteOneInvoice(email, Date.now(), conn);
    } catch {
      continue; // one unreadable invoice never stops the rest
    }
    items.push(...siteOneReplayItems(email, invoice));
  }
  return items;
}

// The SiteOne lines the live sweep would hand the agent, each keeping its
// email id and invoice line number so the replay can read the same invoice
// evidence (siteOneLineFields) processOneLine gives the model. A
// zero-quantity line is never recorded, and a line the sweep holds for a
// person (siteOneHold: a return, an unverified UOM or invoice) never
// reaches the agent — both are left out, as the live lane leaves them out.
function siteOneReplayItems(email, invoice) {
  if (!invoice || invoice.pending || !Array.isArray(invoice.lines)) return [];
  return invoice.lines
    .filter((line) => line.quantity !== 0 && !siteOneHold(invoice.problem, line.quantity, line.uom))
    .map((line) => ({ vendor: 'siteone', title: line.title, quantity: line.quantity, emailId: email.id, lineNo: line.lineNo }));
}

// One title, one quantity — the same title bought several times over the
// years is one row in the printed table.
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.vendor}|${item.title.trim().toLowerCase()}|${item.quantity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function decisionSummary(decision) {
  if (decision.status !== 'logged') return `${decision.status}${decision.reason ? `: ${decision.reason}` : ''}`;
  const created = decision.kind === 'new_product' ? ` (NEW PRODUCT: "${decision.newProduct.name}", category ${decision.newProduct.category})` : '';
  const containerNote = decision.kind === 'existing' && decision.setContainerSize ? ` (would set container_size to "${decision.setContainerSize}")` : '';
  return `WOULD LOG ${decision.amount} ${decision.unit}${created}${containerNote}`;
}

// decideForTitle answers one of three ways: the model couldn't be reached,
// the receipt rules themselves now resolve the title (so the live agent
// would post it by those rules without asking the model), or a validated
// decision.
function outcomeSummary(outcome) {
  if (outcome.llmFailed) return `LLM unavailable (${outcome.reason || 'no_json'})`;
  if (outcome.rulesResolve) return 'the receipt rules resolve it now (no model call)';
  return decisionSummary(outcome.decision);
}

async function main() {
  await assertReadOnly(sharedDb);
  const conn = readOnlyConn();
  try {
    const [amazon, siteOneItems] = await Promise.all([amazonTitles(conn, SINCE), siteOneTitles(conn, SINCE)]);
    const items = dedupe([...amazon, ...siteOneItems]);
    console.log(`${items.length} distinct past purchase title(s) since ${SINCE.toISOString().slice(0, 10)} `
      + `(${amazon.length} Amazon item mention(s), ${siteOneItems.length} SiteOne line mention(s) before dedupe).`);

    const rows = [];
    let unresolvedCount = 0;
    let llmCalls = 0;
    let allowedCategories = null;
    let catalog = null;

    for (const item of items) {
      const classified = await classifyItem({ title: item.title, quantity: item.quantity }, conn);
      if (!AGENT_HANDOFF_STATUSES.includes(classified.status)) {
        rows.push({ ...item, classifierStatus: classified.status, decisionText: classified.product ? `matched: ${classified.product.name}` : '' });
        continue;
      }
      unresolvedCount += 1;
      if (llmCalls >= LIMIT) {
        rows.push({ ...item, classifierStatus: classified.status, decisionText: '(skipped — --limit reached)' });
        continue;
      }
      if (!allowedCategories) {
        // Read-only: the catalog can't change under this replay, so one load
        // serves every title (the live agent reloads per line only because
        // its own writes can add products mid-run).
        allowedCategories = await loadAllowedCategories(conn);
        catalog = await loadActiveCatalog(conn);
      }
      llmCalls += 1;
      const siteOneFields = item.vendor === 'siteone' ? await siteOneLineFields(conn, { email_id: item.emailId, line_no: item.lineNo }) : null;
      const outcome = await decideForTitle(conn, dispatchWithFallback, { rawTitle: item.title, quantity: item.quantity, vendor: item.vendor, siteOneFields }, { allowedCategories, ...catalog });
      rows.push({ ...item, classifierStatus: classified.status, decisionText: outcomeSummary(outcome) });
    }

    console.log('');
    console.log(['title', 'vendor', 'classifier status', 'what the agent would do'].map((h, i) => h.padEnd([62, 9, 16, 0][i])).join(' | '));
    console.log('-'.repeat(110));
    for (const row of rows) {
      console.log([row.title.slice(0, 60).padEnd(62), row.vendor.padEnd(9), row.classifierStatus.padEnd(16), row.decisionText].join(' | '));
    }
    console.log('');
    console.log(`${unresolvedCount} title(s) the deterministic classifier could not resolve on its own; ${llmCalls} got a real LLM decision (--limit=${LIMIT}).`);
  } finally {
    await conn.destroy();
    await sharedDb.destroy();
  }
}

if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- node ops/agents/inventory-agent-replay.js');
    process.exit(2);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { assertReadOnly, siteOneReplayItems };
