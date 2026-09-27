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
// READ ONLY once at connect time, so ANY write anywhere in this process —
// not just the ones this script intends — is refused by Postgres itself,
// not merely by this script's own restraint.
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
// this against production from a session; the primary runs it.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- node ops/agents/inventory-agent-replay.js');
  process.exit(2);
}
const path = require('path');
const knex = require('knex');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const LIMIT = Number(arg('limit', '50')) || 50;
const SINCE = new Date(arg('since', '2000-01-01T00:00:00Z'));

const server = (relative) => path.join(__dirname, '..', '..', 'server', relative);
const { classifyItem, AGENT_HANDOFF_STATUSES } = require(server('services/purchase-receipts/receipt-processor'));
const { parseAmazonDeliveredEmail, parseAmazonShippedEmail, AMAZON_DELIVERY_FROM, AMAZON_SHIPPED_FROM } = require(server('services/purchase-receipts/amazon-delivery-parser'));
const siteOne = require(server('services/purchase-receipts/siteone-invoices'));
const { decideForTitle, loadAllowedCategories } = require(server('services/purchase-receipts/inventory-agent'));
const { dispatchWithFallback } = require(server('services/llm/call'));

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
  const columns = ['id', 'gmail_id', 'subject', 'body_text', 'body_html', 'received_at'];
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
    if (!invoice || invoice.pending || !Array.isArray(invoice.lines)) continue;
    for (const line of invoice.lines) items.push({ vendor: 'siteone', title: line.title, quantity: line.quantity });
  }
  return items;
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

async function main() {
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
    let activeProducts = null;

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
        allowedCategories = await loadAllowedCategories(conn);
        activeProducts = await conn('products_catalog').where({ active: true }).select('id', 'name');
      }
      llmCalls += 1;
      const outcome = await decideForTitle(conn, dispatchWithFallback, { rawTitle: item.title, quantity: item.quantity, vendor: item.vendor, siteOneFields: null }, { allowedCategories, activeProducts });
      const decisionText = outcome.llmFailed ? `LLM unavailable (${outcome.reason || 'no_json'})` : decisionSummary(outcome.decision);
      rows.push({ ...item, classifierStatus: classified.status, decisionText });
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
