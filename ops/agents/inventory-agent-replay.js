#!/usr/bin/env node
// READ-ONLY
//
// inventory-agent-replay.js — replays every past purchase line the live
// purchase-receipt sweep records (Amazon Delivered emails, SiteOne invoices)
// using the sweep's OWN line builders (amazonEmailLines,
// siteOneInvoiceLines — authentication, invoice-copy ownership, placeholders
// and holds included) and receipt-processor.js's OWN disposition
// (classifyItem, then lineDisposition with the agent on). For the lines that
// disposition hands to GATE_INVENTORY_AGENT it runs the REAL inventory-agent
// decision pipeline (decideForTitle, the exact function the live agent
// uses) and prints what WOULD happen. Never writes, never rings a bell,
// never moves stock, never creates a product or alias — this is
// `decideForTitle` alone, not `applyDecision`.
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
// Explicit 'false', never delete: the server modules load the checkout's
// .env (dotenv) as they are required, and dotenv fills in an ABSENT
// variable but never replaces one already set.
process.env.GATE_LLM_CALL_LEDGER = 'false';
process.env.GATE_LLM_CALL_TRACES = 'false';
process.env.GATE_LLM_DISPATCH_METRICS = 'false';
//
// The LLM leg costs real money/time per unresolved title, so --limit caps
// how many model DECISIONS are made (each one is a primary provider call
// plus, only when that answer is unusable, one fallback call — so at most
// twice --limit provider calls); everything past that is listed with its
// classifier status only.
//
//   railway run --service Postgres -- node ops/agents/inventory-agent-replay.js
//   railway run --service Postgres -- node ops/agents/inventory-agent-replay.js --limit=20
//   railway run --service Postgres -- node ops/agents/inventory-agent-replay.js --since=2026-06-01
//
// --since: a bare date is Eastern midnight (the portal is Eastern-only); a
// full ISO timestamp keeps its own offset.
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
// --limit caps model decisions (see the header: up to two paid provider
// calls each): a whole number, 0 allowed (list every line with its
// disposition, no calls), 50 when absent. A mistyped value ("5O", "-1")
// refuses to run rather than falling back to 50 real decisions.
function parseLimit(raw) {
  if (raw == null) return 50;
  if (!/^\d+$/.test(raw)) throw new Error(`--limit=${raw} is not a whole number of model decisions (0 lists every line with no calls)`);
  return Number(raw);
}

const server = (relative) => path.join(__dirname, '..', '..', 'server', relative);
const { classifyItem, lineDisposition, handedOffBy, AGENT_HANDOFF_STATUSES } = require(server('services/purchase-receipts/receipt-processor'));
const { loadMatchCatalog, normalizeForMatch } = require(server('services/purchase-receipts/product-matcher'));
const { parseAmazonDeliveredEmail, AMAZON_DELIVERY_FROM } = require(server('services/purchase-receipts/amazon-delivery-parser'));
const siteOne = require(server('services/purchase-receipts/siteone-invoices'));
const { amazonEmailLines, siteOneInvoiceLines, authenticated } = require(server('services/purchase-receipts/sweep'));
const { decideForTitle, loadActiveCatalog, siteOneLineFields } = require(server('services/purchase-receipts/inventory-agent'));
const { parseETDateTime, etDateString } = require(server('utils/datetime-et'));
const { dispatchWithFallback } = require(server('services/llm/call'));
// The shared pool: the sweep's own SiteOne builders read through it, and
// dispatchWithFallback's telemetry could write through it. PGOPTIONS makes
// it read-only like every connection here, and assertReadOnly proves that
// before anything else runs.
const sharedDb = require(server('models/db'));

// --since: a bare YYYY-MM-DD is Eastern midnight — new Date('2026-06-01')
// would be UTC midnight, 8 PM the day before in Eastern. A full timestamp
// keeps its own offset. An unreadable value refuses to run instead of
// silently replaying everything.
function parseSince(raw) {
  if (raw == null) return new Date('2000-01-01T00:00:00Z');
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = parseETDateTime(bareDate ? `${raw}T00:00` : raw);
  // An impossible calendar date (2026-02-30) would otherwise roll forward
  // (to March 2) and silently drop days — in a bare date or a full
  // timestamp alike: its YYYY-MM-DD must be a real day, and a bare date
  // must round-trip to that same Eastern day.
  if (Number.isNaN(date.getTime()) || !isRealCalendarDay(raw) || (bareDate && etDateString(date) !== raw)) {
    throw new Error(`--since=${raw} is not a date: use a real YYYY-MM-DD (Eastern midnight) or a full ISO timestamp`);
  }
  return date;
}

function isRealCalendarDay(raw) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!parts) return true; // no calendar prefix to check (Date parsing already vetted it)
  const [, y, m, d] = parts.map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

// Proves layer 1 above actually took: a real write statement through the
// SHARED db module that matches zero rows by construction, so nothing could
// change even if the guard somehow failed. Exported for a unit test that
// exercises the error-classification without a live database.
async function assertReadOnly(db) {
  let rejected = false;
  try {
    // products_catalog.name exists in every environment, so the check never
    // fails for a missing column. WHERE false: zero rows by construction,
    // never by assuming some id is impossible — Postgres still refuses the
    // statement itself when the transaction is read-only, which is all this
    // probe needs to see.
    await db.raw('UPDATE products_catalog SET name = name WHERE false');
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

// The live agent works its queue in purchase_receipt_lines.created_at
// order — the order the sweep actually recorded the lines (in one backfill
// sweep: every Amazon line, then the undelivered holds, then SiteOne), and
// each vendor's sweep scans its emails oldest first. So every line gets a
// SWEEP time on one basis: a line the live lane recorded, its recorded time;
// one it never recorded (a hand-off skip, or before the lane existed), the
// first recorded time of its vendor at or after its email arrived — the
// sweep that scanned it — else its email's time, but never before the first
// row its own shipment recorded at or after its arrival (the hold that
// skipped it, even when an unrelated line of that sweep came first). At one
// time, a recorded line before an unrecorded one, then email arrival order,
// then email, then line order.
function recordedTimes(rows) {
  return new Map(rows.map((row) => [rowKey(row), { vendor: row.vendor, shipmentKey: row.shipment_key, at: new Date(row.created_at).getTime() }]));
}

function inQueueOrder(lines, recorded) {
  const recordedTimesOf = {};
  for (const { vendor, shipmentKey, at } of recorded.values()) {
    (recordedTimesOf[vendor] ||= []).push(at);
    (recordedTimesOf[`${vendor}|${shipmentKey}`] ||= []).push(at);
  }
  for (const times of Object.values(recordedTimesOf)) times.sort((a, b) => a - b);
  const firstAtOrAfter = (group, received) => (recordedTimesOf[group] || []).find((at) => at >= received);
  const sweepTime = (line) => {
    const own = recorded.get(lineKey(line));
    if (own) return { at: own.at, unrecorded: 0 };
    const received = new Date(line.email.received_at).getTime();
    const sweep = firstAtOrAfter(line.vendor, received) ?? received;
    return { at: Math.max(sweep, firstAtOrAfter(`${line.vendor}|${line.shipmentKey}`, received) ?? sweep), unrecorded: 1 };
  };
  return lines.map((line, index) => ({ line, ...sweepTime(line), received: new Date(line.email.received_at).getTime(), index }))
    .sort((a, b) => (a.at - b.at) || (a.unrecorded - b.unrecorded) || (a.received - b.received)
      || String(a.line.email.id).localeCompare(String(b.line.email.id)) || (a.index - b.index))
    .map(({ line }) => line);
}

// Every line the live Amazon lane (sweep.js processReceiptEmail) records: an
// authenticated Delivered email's lines from the sweep's own
// amazonEmailLines (items through amazonLine, or the itemless no_items
// placeholder), numbered as the sweep numbers them. Shipped emails only feed
// the undelivered-shipment tracker, never stock.
async function amazonLines(conn, since) {
  const columns = ['id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'received_at', 'authentication_results'];
  const emails = await conn('emails').select(columns)
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM]).whereRaw('subject ILIKE ?', ['Delivered:%'])
    .where('received_at', '>=', since);
  const lines = [];
  for (const email of emails) {
    const parsed = parseAmazonDeliveredEmail(email);
    if (!parsed || !authenticated(email)) continue;
    amazonEmailLines(email, parsed).forEach((line, index) => {
      lines.push({ vendor: 'amazon', email, orderNumber: parsed.orderNumber, shipmentKey: parsed.shipmentKey, lineNo: index + 1, ...line });
    });
  }
  return lines;
}

// Every line the live SiteOne lane records, from the sweep's own
// siteOneInvoiceLines: authentication, the copy of each invoice the live
// lane owns, the unreadable-invoice placeholder, the zero lines a problem
// invoice keeps, and every hold. One unreadable invoice never stops the rest.
async function siteOneLines(since) {
  const lines = [];
  const failures = [];
  for (const email of await siteOne.findSiteOneInvoiceEmails(since)) {
    let found;
    try {
      found = await siteOneInvoiceLines(email, { now: Date.now(), since });
    } catch (err) {
      // Never silent: the summary lists every invoice the replay couldn't
      // read, and the run exits non-zero, so an incomplete replay never
      // passes for a complete one. (An invoice the live lane can't read is
      // not an error — siteOneInvoiceLines returns its 'unreadable'
      // placeholder line.)
      failures.push({ emailId: email.id, subject: email.subject, message: err.message });
      continue;
    }
    if (!found) continue;
    for (const line of found.lines) lines.push({ vendor: 'siteone', email, orderNumber: found.invoice.number, shipmentKey: found.invoice.number, ...line });
  }
  return { lines, failures };
}

// Every row the live lane has recorded, all time: the queue order
// (recordedTimes) and the rows the collectors above can't rebuild both come
// from it.
function recordedRows(conn) {
  return conn('purchase_receipt_lines')
    .select('vendor', 'order_number', 'shipment_key', 'line_no', 'status', 'email_id', 'created_at', 'raw_title', 'quantity');
}

function rowKey(row) {
  return lineKey({ vendor: row.vendor, orderNumber: row.order_number, shipmentKey: row.shipment_key, lineNo: row.line_no });
}

// Recorded rows the replay doesn't rebuild from their OWN email, placed on
// the timeline at the time they were recorded. The live table holds one row
// per line and the first writer owns it, so a recorded row always owns its
// line against any OTHER email that rebuilds it (see dedupe) — only a line
// rebuilt from the row's own email is replayed in its place. That covers:
//   - an undelivered-shipment hold (undelivered-shipments.js, from a Shipped
//     email the collectors don't read);
//   - a row whose email was deleted (email_id is ON DELETE SET NULL): the
//     live agent can't check it for duplicates, so it holds it for a person;
//   - a row from before --since, so a hand-off recorded before the window
//     still stops a later email, as the live whole-table checks do.
// Undelivered holds and deleted-email rows recorded inside the window are
// reported; every other such row only feeds the rules.
function tableOnlyLines(rows, rebuiltFrom, since) {
  return rows.filter((row) => !row.email_id || !rebuiltFrom.get(rowKey(row))?.has(row.email_id)).map((row) => {
    const inWindow = new Date(row.created_at) >= since;
    const report = !inWindow ? null : (!row.email_id && 'email_deleted') || (row.status === 'no_delivery_email' && row.status) || null;
    return {
      vendor: row.vendor, orderNumber: row.order_number, shipmentKey: row.shipment_key, lineNo: row.line_no,
      email: { id: row.email_id, received_at: row.created_at },
      item: { title: row.raw_title, quantity: Number(row.quantity) }, recordedStatus: row.status, report,
    };
  });
}

// The live lane's own purchase-line identity — purchase_receipt_lines'
// unique (vendor, order_number, shipment_key, line_no), with a missing order
// number keyed 'unknown' as receipt-processor.js keys it. Two emails for the
// same line are one line; the same title bought on two orders is two.
function lineKey(line) {
  return [line.vendor, line.orderNumber || 'unknown', line.shipmentKey, line.lineNo].join('|');
}

// One line per identity. The live table holds exactly one row per line and
// its first writer owns it, so for a line the live lane recorded (`owners`:
// line key -> the recorded row's email_id, null when that email was deleted)
// only the owner survives — rebuilt from the owner's own email, else the
// recorded row itself (tableOnlyLines) — whichever copy sorts first. A line
// never recorded keeps its first copy in queue order.
function recordedOwners(rows) {
  return new Map(rows.map((row) => [rowKey(row), row.email_id]));
}

function dedupe(lines, owners = new Map()) {
  const seen = new Set();
  return lines.filter((line) => {
    const key = lineKey(line);
    if (owners.has(key) && !line.recordedStatus && line.email.id !== owners.get(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The agent's validated PROPOSAL (decideForTitle), never the final write:
// the live apply step still runs its own checks under its locks — a nearby
// manual restock or count (a possible duplicate), the catalog changing
// underneath, an application unit already in use — and can still hold it.
function decisionSummary(decision) {
  if (decision.status !== 'logged') return `${decision.status}${decision.reason ? `: ${decision.reason}` : ''}`;
  const created = decision.kind === 'new_product' ? ` (NEW PRODUCT: "${decision.newProduct.name}", category ${decision.newProduct.category})` : '';
  const containerNote = decision.kind === 'existing' && decision.setContainerSize ? ` (would set container_size to "${decision.setContainerSize}")` : '';
  return `PROPOSES LOGGING ${decision.amount} ${decision.unit}${created}${containerNote}`;
}

// The catalog changes the live agent makes when it carries out a proposal
// (inventory-agent.js applyDecision): a new product (with its container
// size), a container size on a product that had none, and — for a title the
// rules couldn't match — an alias of that exact title to the chosen product.
// Whether a change survives is decided only at apply time (a nearby manual
// restock, an application unit in use, … roll it back), so the replay never
// treats one as made: every line is decided against the SAVED catalog, and
// a later line the rules would take once an earlier change is made is
// marked as depending on it — both outcomes shown, never one assumed.
function emptyProposals() {
  return { products: [], containerSizes: new Map(), aliases: [] };
}

function recordProposal(proposals, { outcome, found, title }) {
  const decision = outcome.decision;
  if (!decision || decision.status !== 'logged') return;
  let productId;
  if (decision.kind === 'new_product') {
    productId = `proposed-product-${proposals.products.length + 1}`;
    proposals.products.push({
      id: productId, name: decision.newProduct.name, category: decision.newProduct.category,
      container_size: decision.newProduct.containerSize || null, inventory_unit: decision.newProduct.inventoryUnit || null, active: true,
    });
  } else if (decision.kind === 'existing' && decision.product) {
    productId = decision.product.id;
    if (decision.setContainerSize) proposals.containerSizes.set(productId, decision.setContainerSize);
  } else {
    return;
  }
  if (!found.productId) proposals.aliases.push({ productId, aliasName: title });
}

// A loadMatchCatalog snapshot with the proposals so far layered on.
function catalogWithProposals({ aliasRows, products }, proposals) {
  const sized = (row) => (proposals.containerSizes.has(row.id) ? { ...row, container_size: proposals.containerSizes.get(row.id) } : row);
  const allProducts = [...products.map(sized), ...proposals.products];
  const byId = new Map(allProducts.map((row) => [row.id, row]));
  const proposedAliases = proposals.aliases.filter((a) => byId.has(a.productId)).map((a) => ({ ...byId.get(a.productId), alias_name: a.aliasName }));
  return { aliasRows: [...aliasRows.map(sized), ...proposedAliases], products: allProducts };
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

// Counts one line the live lane settles without the agent, and returns its row.
function settledRow(state, line, status, text = '') {
  state.tally[status] = (state.tally[status] || 0) + 1;
  return { line, status, text };
}

// The agent's answer for one line it would take: a reused one when the same
// question was already asked, '--limit reached' past the cap, or a real
// decideForTitle call against the saved catalog.
async function agentProposal(conn, line, found, state, { recordEffects = true } = {}) {
  const siteOneFields = line.vendor === 'siteone' ? await siteOneLineFields(conn, { email_id: line.email.id, line_no: line.lineNo }) : null;
  const question = JSON.stringify([line.vendor, line.item.title, line.item.quantity, siteOneFields]);
  const earlier = state.decided.get(question);
  if (earlier) return `${earlier} (same as an earlier line)`;
  if (state.llmCalls >= state.limit) return '(skipped — --limit reached)';
  // The active catalog reloads before every decision, as the live runner
  // reloads it per line — staff can add a product or alias while this
  // replay waits on the model. (A new product's category comes from the
  // agent's own fixed canonical list, not a DB read, so there's no
  // categories-load to do here any more.)
  const catalog = await loadActiveCatalog(conn);
  state.llmCalls += 1;
  const outcome = await decideForTitle(conn, dispatchWithFallback, {
    rawTitle: line.item.title, quantity: line.item.quantity, vendor: line.vendor, siteOneFields,
  }, catalog);
  const text = outcomeSummary(outcome);
  // A failed call is never reused: the next identical line asks again.
  if (outcome.llmFailed) {
    state.llmFailures += 1;
    return text;
  }
  if (recordEffects) recordProposal(state.proposals, { outcome, found, title: line.item.title });
  state.decided.set(question, text);
  return text;
}

// How the earlier proposals' catalog changes, all made, would reach this
// line (asked before its own proposal is added): 'rules' when the receipt
// rules would then take it; 'context' when they change anything the agent's
// decision reads for it — its match (status or product), or a product whose
// name or alias shares a word with the title, which is what the candidate
// list and the duplicate-name check are built from; null when none do.
// Deliberately broad: a mark only says the answer might differ.
async function earlierProposalReach(savedCatalog, line, found, proposals) {
  const { products, aliases, containerSizes } = proposals;
  if (line.forcedStatus || !(products.length || aliases.length || containerSizes.size)) return null;
  const catalog = catalogWithProposals(savedCatalog, proposals);
  const after = await classifyItem(line.item, null, catalog);
  if (after.status === 'logged') return 'rules';
  if (after.status !== found.status || (after.productId || null) !== (found.productId || null)) return 'context';
  const titleWords = new Set(normalizeForMatch(line.item.title).split(' ').filter(Boolean));
  const touched = new Set([...products.map((p) => p.id), ...containerSizes.keys(), ...aliases.map((a) => a.productId)]);
  const names = [
    ...catalog.products.filter((p) => touched.has(p.id)).map((p) => p.name),
    ...catalog.aliasRows.filter((row) => touched.has(row.id)).map((row) => row.alias_name),
  ];
  const sharesWord = names.some((name) => normalizeForMatch(name).split(' ').some((word) => word && titleWords.has(word)));
  return sharesWord ? 'context' : null;
}

// The shipment hand-off rule (receipt-processor.js handedOffBy) applied to
// the lines this replay has recorded so far — never to today's table, which
// already holds this very line and everything after it.
function shipmentId(line) {
  return `${line.vendor}|${line.shipmentKey}`;
}

function recordLine(state, line, status) {
  if (!state.recorded.has(shipmentId(line))) state.invoiceOwner.set(shipmentId(line), line.email.id);
  const rows = state.recorded.get(shipmentId(line)) || [];
  rows.push({ status, email_id: line.email.id });
  state.recorded.set(shipmentId(line), rows);
}

// One line's row, in queue order: the live lane's own checks first
// (receipt-processor.js processReceiptLine records nothing for a line with
// no shipment key, or on a shipment already handed to a person), then its
// disposition against the saved catalog, then — for a line it hands to the
// agent — whether an earlier proposal's catalog change would let the rules
// take it instead, and the agent's own proposal for when that change
// doesn't survive (see emptyProposals).
async function replayLine(conn, line, state) {
  if (line.recordedStatus) {
    recordLine(state, line, line.recordedStatus);
    if (!line.report) return null;
    const heldForPerson = [...AGENT_HANDOFF_STATUSES, 'agent_pending'].includes(line.recordedStatus);
    return settledRow(state, line, line.report, line.report === 'email_deleted'
      ? `recorded as ${line.recordedStatus}; its email is gone${heldForPerson ? ' — the live agent holds it for a person' : ''}` : '');
  }
  if (!line.shipmentKey) return settledRow(state, line, 'no_shipment_key');
  // sweep.js siteOneInvoiceLines: the store and billing copies of one
  // invoice — the first copy that records a line owns it, and the live sweep
  // drops every other copy whole. Its check reads the table, which holds
  // nothing for an invoice from before the lane, so the replay applies the
  // same rule to the lines IT has recorded so far.
  const owner = line.vendor === 'siteone' && state.invoiceOwner.get(shipmentId(line));
  if (owner && owner !== line.email.id) return settledRow(state, line, 'other_invoice_copy');
  if (handedOffBy(state.recorded.get(shipmentId(line)) || [], line.email.id)) return settledRow(state, line, 'handed_to_person');
  const found = line.forcedStatus
    ? { status: line.forcedStatus, productId: null, product: null }
    : await classifyItem(line.item, conn);
  const disposition = lineDisposition(found, line, { agentOn: true });
  recordLine(state, line, disposition.status);
  if (disposition.status !== 'agent_pending') {
    return settledRow(state, line, disposition.status, disposition.product ? `matched: ${disposition.product.name}` : '');
  }
  state.handedToAgent += 1;
  const reach = await earlierProposalReach(await loadMatchCatalog(conn), line, found, state.proposals);
  // A dependent line's proposal is only the answer when the earlier changes
  // do NOT all survive, so its own change never joins the all-survive view.
  const proposal = await agentProposal(conn, line, found, state, { recordEffects: !reach });
  if (!reach) return { line, status: `agent (${found.status})`, text: proposal };
  state.dependsOnEarlier += 1;
  const lead = reach === 'rules'
    ? "the receipt rules take it IF an earlier proposal's catalog change survives; otherwise"
    : "an earlier proposal's catalog change, if it survives, can change this decision; against the saved catalog";
  return { line, status: `agent (${found.status})`, text: `${lead}: ${proposal}` };
}

function printReport(rows, state, siteOneFailures) {
  console.log('');
  console.log(['title', 'vendor', 'disposition', 'what happens'].map((h, i) => h.padEnd([62, 9, 26, 0][i])).join(' | '));
  console.log('-'.repeat(120));
  for (const row of rows) {
    console.log([row.line.item.title.slice(0, 60).padEnd(62), row.line.vendor.padEnd(9), row.status.padEnd(26), row.text].join(' | '));
  }
  console.log('');
  const counts = Object.entries(state.tally).sort(([a], [b]) => a.localeCompare(b)).map(([status, n]) => `${status} ${n}`).join(', ');
  console.log(`Without the agent: ${counts || 'nothing'}.`);
  console.log(`${state.handedToAgent} line(s) the agent would take; ${state.llmCalls} model decision(s), each at most two paid provider calls (--limit=${state.limit} decisions).`);
  console.log('Proposals are what the agent would PROPOSE; the live apply step can still hold one under its own checks '
    + '(a nearby manual restock or count, the catalog changing underneath, an application unit already in use).');
  console.log('Every line is decided against the saved catalog. '
    + `${state.dependsOnEarlier} line(s) an earlier proposal's catalog change reaches (the rules would take it, or its match or `
    + 'related products change) are marked; their decision above is against the saved catalog, for when that change does not survive.');
  // An incomplete replay never passes for a complete one: each gap is
  // listed and the run exits 1.
  if (state.llmFailures) {
    console.log('');
    console.log(`INCOMPLETE: ${state.llmFailures} line(s) got no decision because the model was unavailable (see "LLM unavailable" above).`);
    process.exitCode = 1;
  }
  if (siteOneFailures.length) {
    console.log('');
    console.log(`INCOMPLETE: ${siteOneFailures.length} SiteOne invoice email(s) could not be read, so their lines are missing above:`);
    for (const failure of siteOneFailures) console.log(`  email ${failure.emailId} "${failure.subject}": ${failure.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const since = parseSince(arg('since'));
  const limit = parseLimit(arg('limit'));
  await assertReadOnly(sharedDb);
  const conn = readOnlyConn();
  try {
    const [amazon, siteOneRead, tableRows] = await Promise.all([amazonLines(conn, since), siteOneLines(since), recordedRows(conn)]);
    const rebuiltFrom = new Map();
    for (const line of [...amazon, ...siteOneRead.lines]) {
      if (!rebuiltFrom.has(lineKey(line))) rebuiltFrom.set(lineKey(line), new Set());
      rebuiltFrom.get(lineKey(line)).add(line.email.id);
    }
    const tableOnly = tableOnlyLines(tableRows, rebuiltFrom, since);
    // In the live queue's order (see recordedTimes): hand-offs and proposed
    // catalog changes apply to what comes after, and --limit caps the same
    // lines the live agent would reach first.
    const lines = dedupe(inQueueOrder([...amazon, ...siteOneRead.lines, ...tableOnly], recordedTimes(tableRows)), recordedOwners(tableRows));
    console.log(`Since ${since.toISOString()}: ${amazon.length} Amazon and ${siteOneRead.lines.length} SiteOne line(s) rebuilt from their emails, `
      + `${tableOnly.filter((line) => line.report).length} recorded line(s) with no email to rebuild from `
      + '(undelivered-shipment holds, deleted emails), before dedupe.');

    // One paid call per distinct question: `decided` maps each asked
    // question (title, quantity, vendor, invoice evidence) to its answer.
    const state = {
      limit, tally: {}, handedToAgent: 0, llmCalls: 0, llmFailures: 0,
      decided: new Map(), recorded: new Map(), invoiceOwner: new Map(), proposals: emptyProposals(), dependsOnEarlier: 0,
    };
    const rows = [];
    for (const line of lines) {
      const row = await replayLine(conn, line, state);
      if (row) rows.push(row);
    }
    printReport(rows, state, siteOneRead.failures);
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

module.exports = {
  assertReadOnly, parseSince, parseLimit, lineKey, dedupe, recordedOwners, inQueueOrder, tableOnlyLines, emptyProposals, earlierProposalReach, recordProposal, catalogWithProposals, replayLine,
};
