'use strict';

// Bid kit Product List sync (GATE_BID_KIT_PRODUCT_LIST_SYNC, dark; needs GATE_BID_KIT too). Once a day, right after the expiry
// check in the 6 a.m. ET compliance slot, the kit's "Product list" paper is rebuilt from the visit records: every product
// applied on a visit in the last 12 months, with active ingredient, EPA Reg. No., and Label and SDS links (a PDF, built in
// services/pdf/product-list-pdf.js). Same list as last time = nothing happens (no file, no bell).
//
// A changed list replaces the file. Owner ruling 2026-10-25: "if they are bought from siteone, they should auto sign off in the
// bid section". So the kit signs the new file off itself (no signer, an activity row marked auto) when ALL of these hold:
//   - this job built the file it is replacing (a stored snapshot whose file is still the one on the row),
//   - that file was signed off (a version nobody vouched for is never vouched for by a later SiteOne-only change),
//   - the list is complete (every registered pesticide has its label and SDS, every pesticide category row has an EPA number),
//   - every product that was ADDED or CHANGED has a logged SiteOne purchase line. A removed product (not used in 12 months)
//     is SiteOne-safe.
// Anything else replaces the file, leaves it NOT signed off and raises ONE admin bell (one open episode per item; a later run
// rewrites it). Nothing is sent to a customer, an agency or anyone else; the outputs are the kit row, its private file, activity
// rows and the admin bell. Gate off = the job returns before any query.
const crypto = require('node:crypto');
const db = require('../models/db');
const { bidKitLive, bidKitProductListSyncLive } = require('../config/feature-gates');
const store = require('./bid-kit-store');
const files = require('./bid-kit-files');
const episodes = require('./admin-alert-episodes');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const logger = require('./logger');
const { errorTag } = require('./bid-kit-log');
const { composeAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction } = require('./admin-alert-names');
const { validEpaRegNumber } = require('./epa-reg-number');
const { buildProductListPdf, fileNameFor } = require('./pdf/product-list-pdf');
const { WAVES_BUSINESS_NAME, WAVES_FDACS_LICENSE_NUMBER } = require('../constants/business');

const ITEM_KEY = 'product_list';
const AREA = 'Estimates';
const CATEGORY = 'system';
const KEY_PREFIX = 'bid-kit:product-list:';
const keyFor = (itemId) => `${KEY_PREFIX}${itemId}`;
const AUTO_SIGN_OFF = 'siteone_purchases';
const WINDOW_SQL = "now() - interval '365 days'";
const MAX_NAMED = 2; // names in the bell's one sentence; the rest go to its full text

// A category that must carry an EPA registration number (a row here with the "N/A" placeholder makes the list incomplete).
// Adjuvants are left out on purpose: they carry no registration.
const PESTICIDE_CATEGORIES = new Set([
  'insecticide', 'herbicide', 'fungicide', 'termiticide', 'rodenticide', 'miticide', 'nematicide', 'pgr', 'igr',
  'bait', 'mole bait', 'termite bait', 'mosquito',
]);
const isPesticideCategory = (category) => PESTICIDE_CATEGORIES.has(String(category || '').trim().toLowerCase());

// ---- the list ----

// Every product applied in the last 12 months, once each. Read only.
async function readProductRows(conn = db) {
  const rows = await conn('service_products as sp')
    .join('products_catalog as p', 'p.id', 'sp.product_id')
    .whereRaw(`sp.created_at > ${WINDOW_SQL}`)
    .groupBy('p.id', 'p.name', 'p.category', 'p.active_ingredient', 'p.epa_reg_number', 'p.label_url', 'p.sds_url')
    .select('p.id as product_id', 'p.name', 'p.category', 'p.active_ingredient', 'p.epa_reg_number', 'p.label_url', 'p.sds_url')
    .count('sp.id as uses');
  return sortRows(rows);
}

// Category (empty last), then name, then id so the order never depends on the database.
function sortRows(rows) {
  const category = (row) => String(row.category || '').trim().toLowerCase();
  return [...rows].sort((a, b) => {
    const ca = category(a);
    const cb = category(b);
    if (ca !== cb) return !ca ? 1 : !cb ? -1 : ca.localeCompare(cb);
    return String(a.name || '').localeCompare(String(b.name || '')) || String(a.product_id).localeCompare(String(b.product_id));
  });
}

// ---- change detection ----

const text = (value) => String(value == null ? '' : value).trim();
const short = (value) => crypto.createHash('sha1').update(text(value)).digest('hex').slice(0, 10);

// One row as the kit remembers it: the product id and name, and a short hash of each field the PDF shows. The hashes keep the
// stored snapshot small (the kit list sends every row's details to the page) while still telling WHICH field changed.
function snapshotOf(row) {
  return {
    id: String(row.product_id),
    name: text(row.name),
    ai: short(row.active_ingredient),
    epa: short(row.epa_reg_number),
    label: short(row.label_url),
    sds: short(row.sds_url),
  };
}

const FIELD_WORDS = { name: 'name', ai: 'active ingredient', epa: 'EPA number', label: 'label link', sds: 'SDS link' };

function fingerprintOf(snapshots) {
  const sorted = [...snapshots].sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash('sha256').update(JSON.stringify(sorted.map((s) => [s.id, s.name, s.ai, s.epa, s.label, s.sds]))).digest('hex');
}

// What moved between two snapshots: products added, products removed, and products whose name or a shown field changed.
function diffSnapshots(previous, next) {
  const before = new Map((previous || []).map((s) => [s.id, s]));
  const after = new Map((next || []).map((s) => [s.id, s]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) { added.push({ id, name: now.name }); continue; }
    const fields = Object.keys(FIELD_WORDS).filter((field) => was[field] !== now[field]);
    if (fields.length) changed.push({ id, name: now.name, fields });
  }
  for (const [id, was] of before) if (!after.has(id)) removed.push({ id, name: was.name });
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return { added: added.sort(byName), removed: removed.sort(byName), changed: changed.sort(byName) };
}

// Complete = every registered pesticide has both links, and no pesticide-category product lacks its EPA number.
function listIsComplete(rows) {
  return rows.every((row) => {
    if (validEpaRegNumber(row.epa_reg_number)) return Boolean(text(row.label_url) && text(row.sds_url));
    return !isPesticideCategory(row.category);
  });
}

// The auto sign-off rule, as a table. `previous`: 'ok' (this job built the file on the row), 'first_run' (no snapshot) or
// 'file_replaced' (the file on the row is not the one this job stored). `bought`: a Set of product ids with a logged SiteOne
// purchase line. Returns { auto, reasons, outside }: reasons is empty exactly when auto is true; outside is the added or
// changed products with no SiteOne purchase.
function decideSignOff({ previous, wasSignedOff, complete, diff, bought }) {
  const reasons = [];
  let outside = [];
  if (previous !== 'ok') reasons.push(previous);
  if (!complete) reasons.push('incomplete');
  if (previous === 'ok') {
    outside = [...diff.added, ...diff.changed].filter((product) => !bought.has(product.id));
    if (outside.length) reasons.push('not_siteone');
    if (!wasSignedOff) reasons.push('unsigned_before');
  }
  return { auto: reasons.length === 0, reasons, outside };
}

// Products with at least one logged SiteOne purchase line. A product's best_vendor is the cheapest price, not where it was
// bought, so it is never used here.
async function siteOnePurchased(ids, conn = db) {
  if (!ids.length) return new Set();
  const rows = await conn('purchase_receipt_lines')
    .where({ vendor: 'siteone', status: 'logged' })
    .whereIn('product_id', ids)
    .distinct('product_id');
  return new Set(rows.map((row) => String(row.product_id)));
}

// ---- words ----

// A product name as one clean phrase inside a bell sentence (no stop, slash, bracket or underscore the notification rules refuse).
const tidy = (name) => text(name).replace(/[[\]!_/]+/g, ' ').replace(/\.(?=\s|$)/g, '').replace(/\s+/g, ' ').trim();

function joinNames(products, limit = MAX_NAMED) {
  const names = products.map((product) => tidy(product.name));
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

// The segments of the bell's one sentence, most important first.
function segmentsFor({ diff, decision }) {
  const outside = new Set(decision.outside.map((product) => product.id));
  const addedOut = diff.added.filter((product) => outside.has(product.id));
  const changedOut = diff.changed.filter((product) => outside.has(product.id));
  const segments = [];
  if (addedOut.length) segments.push(`Added ${joinNames(addedOut)} (not a SiteOne purchase)`);
  if (changedOut.length) segments.push(`${joinNames(changedOut)} changed (not a SiteOne purchase)`);
  if (decision.reasons.includes('incomplete')) segments.push('a pesticide is missing its EPA number, label or SDS');
  const quiet = diff.added.length - addedOut.length + diff.changed.length - changedOut.length + diff.removed.length;
  if (quiet && segments.length) segments.push(`${quiet} other ${quiet === 1 ? 'change' : 'changes'}`);
  if (!segments.length) {
    const n = diff.added.length + diff.changed.length + diff.removed.length;
    segments.push(`${n} ${n === 1 ? 'change' : 'changes'}`);
  }
  if (decision.reasons.includes('unsigned_before')) segments.push('the earlier version is still not signed off');
  return segments;
}

const productLine = (label, products) => (products.length ? `${label}: ${products.map((p) => tidy(p.name)).join(', ')}.` : '');

// The full text for "Show full text": every product, what changed, and why a person is asked.
function detailFor({ diff, decision, previous }) {
  if (previous === 'first_run') return 'Product list: the list now rebuilds itself every day from the products applied in the last 12 months. This is the first rebuilt version. Check it once and sign it off.';
  if (previous === 'file_replaced') return 'Product list: the file on the kit was replaced by hand since the last rebuild, so the daily rebuild replaced it with the current list. Check it and sign it off.';
  const outside = new Set(decision.outside.map((product) => product.id));
  const mark = (products) => products.map((p) => ({ ...p, name: outside.has(p.id) ? `${p.name} (not a SiteOne purchase)` : p.name }));
  const changedWords = diff.changed.map((p) => ({ ...p, name: `${p.name} (${p.fields.map((f) => FIELD_WORDS[f]).join(', ')})` }));
  const lines = [
    productLine('Added', mark(diff.added)),
    productLine('Changed', mark(changedWords)),
    productLine('Removed', diff.removed),
    decision.reasons.includes('incomplete') ? 'The list is incomplete: a pesticide is missing its EPA number, label or SDS.' : '',
    decision.reasons.includes('unsigned_before') ? 'The earlier version is still not signed off.' : '',
    'Check the product list and sign off.',
  ].filter(Boolean);
  return `Product list: ${lines.join(' ')}`.slice(0, 1900);
}

function specFor(itemId, whyText) {
  return {
    area: AREA,
    action: fitAction(AREA, 'the product list', [(n) => `check ${n} and sign off`, () => 'check the product list']),
    why: cutAtWord(whyText, MAX_WHY_CHARS),
    severity: 'needs-you',
    link: `/admin/bids?tab=kit&item=${itemId}`,
    subject: { type: 'check', id: itemId },
    doneWhen: 'product_list_signed_off',
    who: 'person',
  };
}

// The words of the bell for one decision: { spec, detail }. A product name that trips the notification copy rules costs the
// names, never the bell: the count-only sentence is used instead.
function alertFor(itemId, { diff, decision, previous }) {
  const detail = detailFor({ diff, decision, previous });
  if (previous === 'first_run') return { spec: specFor(itemId, 'The list now rebuilds itself; check this version once.'), detail };
  if (previous === 'file_replaced') return { spec: specFor(itemId, 'The file was replaced by hand; check the rebuilt list.'), detail };
  const named = `${segmentsFor({ diff, decision }).join('; ')}; check and sign off.`;
  try {
    composeAdminAlert(specFor(itemId, named));
    return { spec: specFor(itemId, named), detail };
  } catch {
    const n = diff.added.length + diff.changed.length + diff.removed.length;
    return { spec: specFor(itemId, `${n} ${n === 1 ? 'change' : 'changes'} to the list; check it and sign off.`), detail };
  }
}

// ---- the run ----

const refOf = (key) => crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16);

async function closeBell(itemId, reason, resolution) {
  return episodes.closeAdminAlertKeys(db, [keyFor(itemId)], reason, { resolution });
}

// What this run will do about the list: how it relates to the file on the row, what changed, and whether the kit signs it off.
async function planRebuild(item, rows, snapshots, info) {
  const prior = item.details && item.details.product_list_sync;
  let previous = 'first_run';
  if (prior && Array.isArray(prior.rows)) previous = fileIsOurs(prior, info) ? 'ok' : 'file_replaced';
  const diff = previous === 'ok' ? diffSnapshots(prior.rows, snapshots) : { added: [], removed: [], changed: [] };
  const bought = previous === 'ok' ? await siteOnePurchased([...diff.added, ...diff.changed].map((product) => product.id)) : new Set();
  const decision = decideSignOff({ previous, wasSignedOff: Boolean(item.attested_at), complete: listIsComplete(rows), diff, bought });
  return { previous, diff, decision };
}

// The file on the row is the one this job stored last time (a hand upload since then has another key).
const fileIsOurs = (prior, info) => Boolean(prior && info && info.key && prior.file_ref === refOf(info.key));

// Builds the PDF, stores it and puts it on the row in one fenced update. When the owner must be asked, the bell's words go into
// the SAME update as `pending_alert`, so a failure or a stop before the bell is raised leaves the words on the row and the next
// run raises it. Returns { outcome } or { skipped }; throws on a failed write.
async function storeRebuild(item, { rows, snapshots, fingerprint, plan, now }) {
  const asOf = catalog.etToday(now);
  const buffer = await buildProductListPdf({ rows, asOf, businessName: WAVES_BUSINESS_NAME, licenseNumber: WAVES_FDACS_LICENSE_NUMBER });
  const stored = await files.putFile(item.id, { buffer, originalname: fileNameFor(asOf), mimetype: 'application/pdf', size: buffer.length });
  const { decision } = plan;
  const pending = decision.auto ? null : alertFor(item.id, plan);
  let outcome;
  try {
    outcome = await store.replaceFile(item.id, stored, item.updated_at, {
      attestBySystem: decision.auto,
      details: {
        product_list_sync: {
          fingerprint, built_at: now.toISOString(), file_ref: refOf(stored.key), rows: snapshots,
          ...(pending ? { pending_alert: { why: pending.spec.why, detail: pending.detail } } : {}),
        },
      },
    });
  } catch (err) {
    // Delete the new object only when the row is known not to point at it (the route's rule).
    if (err && err.bidKitOutcome === 'rolled_back') await files.deleteFile(stored.key);
    else logger.warn(`[bid-kit] product list file replacement outcome unknown for item ${item.id}; the new stored file was kept`);
    throw err;
  }
  if (outcome.conflict || outcome.notFound) {
    // The owner changed the row since it was read: skip, never overwrite. Tomorrow's run starts from the row as it is.
    await files.deleteFile(stored.key);
    logger.info(`[bid-kit] product list sync skipped: the item ${outcome.conflict ? 'changed while the list was built' : 'is gone'}`);
    return { skipped: outcome.conflict ? 'conflict' : 'not_found' };
  }
  if (outcome.oldKey) await files.deleteFile(outcome.oldKey);
  return { outcome };
}

// Raises the one bell (idempotent: the same key and version dedupe onto the open row). Returns whether it rang.
async function raiseBell(itemId, why, detail, fingerprint) {
  const composed = composeAdminAlert(specFor(itemId, why));
  const raised = await episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
    bell: true,
    dedupeKey: keyFor(itemId),
    // One open episode: a later rebuild rewrites this row (and rings it again, because the list changed again).
    dedupeVersion: fingerprint,
    refreshOnDedupe: true,
    detail,
    link: composed.link,
    metadata: { bidKitItemId: itemId, ...composed.metadata },
  });
  return Boolean(raised && raised.rang);
}

// Removes the pending words once the bell is raised (or no longer needed). A small fenced update: it only runs against the
// stored list it was raised for, never touches the sign-off, and returns the row as it is afterwards (its version moved).
async function clearPending(itemId, fingerprint) {
  const outcome = await store.updateItem(itemId, (row) => {
    const sync = row.details && row.details.product_list_sync;
    if (!sync || !sync.pending_alert || sync.fingerprint !== fingerprint) return { patch: {} };
    const { pending_alert: _gone, ...rest } = sync;
    return { patch: { details: JSON.stringify({ ...row.details, product_list_sync: rest }) } };
  });
  return outcome.item || null;
}

// After a committed replacement: the activity rows, then either the automatic sign-off (any open bell is closed) or the one bell.
async function reportRebuild(item, { snapshots, fingerprint, plan }) {
  const { diff, decision } = plan;
  const names = (products) => products.map((product) => product.name).slice(0, 20);
  await store.logActivity(null, 'bid_kit_file_uploaded', 'Product list (product_list) file uploaded by the daily rebuild',
    { bid_kit_item_id: item.id, item_key: ITEM_KEY, fields: ['file'], auto: 'product_list_sync', products: snapshots.length });
  if (decision.auto) {
    await store.logActivity(null, 'bid_kit_attested', 'Product list (product_list) attested automatically: only products bought from SiteOne changed',
      { bid_kit_item_id: item.id, item_key: ITEM_KEY, auto: AUTO_SIGN_OFF, added: names(diff.added), changed: names(diff.changed), removed: names(diff.removed) });
    await closeBell(item.id, 'signed_off', 'Cleared: the product list was signed off automatically');
    logger.info(`[bid-kit] product list rebuilt and signed off automatically added=${diff.added.length} changed=${diff.changed.length} removed=${diff.removed.length}`);
    return { changed: true, signedOff: true, rang: false };
  }
  const { spec, detail } = alertFor(item.id, plan);
  const rang = await raiseBell(item.id, spec.why, detail, fingerprint);
  try {
    await clearPending(item.id, fingerprint);
  } catch (err) {
    // The words stay on the row; the next run raises the same bell again (a silent dedupe) and clears them.
    logger.warn(`[bid-kit] clearing the pending product list bell failed: ${errorTag(err)}`);
  }
  logger.info(`[bid-kit] product list rebuilt, needs sign-off reasons=${decision.reasons.join(',')}`);
  return { changed: true, signedOff: false, rang, reasons: decision.reasons };
}

// A bell whose words were saved with the file but not raised (a failure or a stop in between). Runs first, every day, before the
// unchanged-list return. Signed off in the meantime = nothing to raise, just clear. Returns the row as it is afterwards.
async function settlePending(item) {
  const sync = item.details && item.details.product_list_sync;
  if (!sync || !sync.pending_alert) return item;
  try {
    if (!item.attested_at) await raiseBell(item.id, sync.pending_alert.why, sync.pending_alert.detail, sync.fingerprint);
    return (await clearPending(item.id, sync.fingerprint)) || item;
  } catch (err) {
    logger.warn(`[bid-kit] raising the pending product list bell failed: ${errorTag(err)}`);
    return item;
  }
}

// Daily. Returns { skipped } with the gate off or nothing to do; otherwise { changed: false } or
// { changed: true, signedOff, rang }. A failure is logged with a fixed line and returned as { failed }; it never throws.
async function runBidKitProductListSync({ now = new Date() } = {}) {
  if (!bidKitLive() || !bidKitProductListSyncLive()) return { skipped: 'gate_off' };
  try {
    let item = (await store.listItems()).find((row) => row.kind === 'document' && row.item_key === ITEM_KEY);
    if (!item) return { skipped: 'no_item' };
    // The owner signed the open version off by hand: its bell has done its job.
    if (item.attested_at && (await episodes.openAdminAlertKeys(db, keyFor(item.id))).includes(keyFor(item.id))) {
      await closeBell(item.id, 'signed_off', 'Cleared: the product list was signed off');
    }
    item = await settlePending(item);
    const rows = await readProductRows();
    if (!rows.length) {
      logger.warn('[bid-kit] product list sync found no applied products; the file was left alone');
      return { skipped: 'no_products' };
    }
    const snapshots = rows.map(snapshotOf);
    const fingerprint = fingerprintOf(snapshots);
    const prior = item.details && item.details.product_list_sync;
    const info = await store.fileInfo(item.id);
    // Unchanged only while the file on the row is still the one this job stored: a file replaced by hand is rebuilt and flagged.
    if (prior && prior.fingerprint === fingerprint && fileIsOurs(prior, info)) return { changed: false };
    const plan = await planRebuild(item, rows, snapshots, info);
    const stored = await storeRebuild(item, { rows, snapshots, fingerprint, plan, now });
    if (stored.skipped) return { skipped: stored.skipped };
    return await reportRebuild(item, { snapshots, fingerprint, plan });
  } catch (err) {
    logger.warn(`[bid-kit] product list sync failed: ${errorTag(err)}`);
    return { failed: true };
  }
}

module.exports = {
  runBidKitProductListSync, readProductRows, sortRows, snapshotOf, fingerprintOf, diffSnapshots, listIsComplete, decideSignOff,
  siteOnePurchased, alertFor, detailFor, isPesticideCategory, keyFor, KEY_PREFIX, AUTO_SIGN_OFF, PESTICIDE_CATEGORIES,
};
