'use strict';

/**
 * The record of what was mailed (mailer step 3): which new-home homes got a postcard, in which batch, and the price
 * printed on the label (migration 20261124160000). The one writer of mailed_at, mail_batch and mailed_price is
 * markBatch below, called by ops/agents/mark-mail-batch.js. The table itself refuses any later change to a mailed row's
 * price or mailed record (a BEFORE UPDATE trigger, code 23514).
 *
 * The label of a home shows its MONTHLY price (annual / 12 from whole cents, the same toPrice as the admin list and the
 * home's page), the office line to text and the date the price is held until (PRICE_HOLD_DAYS from the day it was marked).
 * The name and the office line are frozen in the snapshot too (mailed_price.label), for a reprint.
 * Nothing here sends anything and no paid service is called.
 */

const db = require('../../models/db');
const { toPrice } = require('../prospects/mail-list');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { resolveServiceLocation, matchServiceLocation } = require('../../config/locations');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');

const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const PLAN = 'pest_quarterly';
const PRICE_HOLD_DAYS = 60;
const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PRICE_COLUMNS = ['id', 'status', 'price_status', 'price_annual', 'price_setup_fee', 'priced_at', 'mailed_at', 'mail_batch', 'mailed_price'];
// What marking reads of a home: its price, the address for the customer check, and what the label prints.
const MARK_COLUMNS = [...PRICE_COLUMNS, 'address_line1', 'city', 'state', 'zip', 'recipient_names', 'page_slug', 'page_token'];

/** What the label shows, frozen: dollars as numbers (the unit of price_annual), monthly from whole cents. */
function snapshotOf(row) {
  const price = toPrice(row);
  if (price.annual == null || price.setupFee == null || !(price.annual > 0)) return null;
  return { plan: PLAN, annual: price.annual, monthly: price.monthly, setupFee: price.setupFee, pricedAt: price.pricedAt };
}

/** The printed price of a mailed row as the page shows it ({ monthly, annual, setupFee, pricedAt }), or null. */
function printedPriceOf(row) {
  if (!row || !row.mailed_at) return null;
  let snap = row.mailed_price;
  if (typeof snap === 'string') {
    try { snap = JSON.parse(snap); } catch { snap = null; }
  }
  if (!snap || ![snap.annual, snap.monthly, snap.setupFee].every((n) => Number.isFinite(n))) return null;
  // pricedAt leaves only as an ISO time string; any other stored value (an object, a bad date) reads as null.
  const pricedTime = typeof snap.pricedAt === 'string' ? new Date(snap.pricedAt) : null;
  const pricedAt = pricedTime && Number.isFinite(pricedTime.getTime()) ? pricedTime.toISOString() : null;
  return { monthly: snap.monthly, annual: snap.annual, setupFee: snap.setupFee, pricedAt };
}

/**
 * What the label prints besides the price, frozen with it at marking: { name, nameCheck, textNumber, officeByDefault }.
 * The page address (page_slug) is not frozen here: the public lookup resolves the row's own slug, which is written once
 * and never changed (prospect-store assignPageSlug), so the label always prints the address that reaches the home.
 */
function labelFieldsOf(row) {
  const { name, check } = labelName(row.recipient_names);
  const office = officeLineOf(row);
  return { name, nameCheck: check, textNumber: office.number, officeByDefault: office.byDefault };
}

/**
 * The label fields a mailed row was printed with (mailed_price.label), or null for a row marked before they were kept or
 * a snapshot that does not hold them. A reprint of a batch uses these, so a later change of the Clerk's names or of an
 * office line never makes the second print differ from the cards in the mail.
 */
function printedLabelOf(row) {
  if (!row || !row.mailed_at) return null;
  let snap = row.mailed_price;
  if (typeof snap === 'string') {
    try { snap = JSON.parse(snap); } catch { snap = null; }
  }
  const label = snap && snap.label;
  if (!label || typeof label.name !== 'string' || typeof label.textNumber !== 'string' || !label.textNumber) return null;
  return {
    name: label.name,
    nameCheck: label.nameCheck === true,
    textNumber: label.textNumber,
    officeByDefault: label.officeByDefault === true,
  };
}

/**
 * True when the home is no longer a stranger to Waves: a customers row (customer, lead or cancelled) is at its address
 * (the list's own check, prospect-store addressKnownToWaves) or a member is at or near it (the price pass's check,
 * home-quote memberStatusOf). The list and the price pass ran these days before; marking runs them again, so a home
 * that called or signed up since gets no postcard. Strict: a lookup that cannot finish throws, and nothing is marked.
 * (`deps.knownToWaves` of markBatch, wouldMark and labelsFor replaces it in a test with no customers table.)
 */
async function knownToWavesNow(row, conn) {
  const { addressKnownToWaves } = require('./prospect-store');
  if (await addressKnownToWaves(row.address_line1, row.zip, conn)) return true;
  const quote = require('./home-quote');
  return (await quote.memberStatusOf(row, quote.memberAtAddressOn(conn))) !== null;
}

/** The Eastern calendar day the hold ends, "YYYY-MM-DD": PRICE_HOLD_DAYS after the day the label was marked. */
function heldUntilOf(mailedAt) {
  if (!mailedAt) return null;
  const at = new Date(mailedAt);
  if (Number.isNaN(at.getTime())) return null;
  return etDateString(addETDays(at, PRICE_HOLD_DAYS));
}

/** "2027-01-19" -> "Jan 19" (the label's own wording). */
function heldUntilLabel(day) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : null;
}

/** The price of one application, from whole cents (a quarterly plan is 4 applications a year), formatted like labelPrice. */
function perApplicationLabel(annual) {
  return labelPrice(Math.round(Math.round(Number(annual) * 100) / 4) / 100);
}

/** The monthly price as the label and the page print it: whole dollars bare, else two decimals. */
function labelPrice(monthly) {
  const n = Number(monthly);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);
const title = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/**
 * The names on the label from the Clerk's list ("LAST FIRST M" for each buyer): "Alex Tester", "Alex & Jamie Tester" for
 * one family name. { name, check: true } when a name is not that shape (a suffix, three words, a symbol): it is listed as
 * the Clerk wrote it, title case, and the person printing the labels looks at it.
 */
function labelName(recipientNames) {
  const people = [];
  let check = false;
  for (const raw of Array.isArray(recipientNames) ? recipientNames : []) {
    const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
    const plain = words.length >= 2 && words.length <= 3 && words.every((w) => /^[A-Za-z]+$/.test(w));
    const middle = words.length === 3 && words[2].length <= 2 && !SUFFIXES.has(words[2].toUpperCase());
    if (!plain || (words.length === 3 && !middle)) {
      check = true;
      people.push({ last: null, text: words.map(title).join(' ') });
    } else {
      people.push({ last: title(words[0]), text: title(words[1]) });
    }
  }
  if (!people.length) return { name: '', check: true };
  const lasts = people.map((p) => p.last);
  if (people.length > 1 && lasts[0] && lasts.every((l) => l === lasts[0])) {
    return { name: `${people.map((p) => p.text).join(' & ')} ${lasts[0]}`, check };
  }
  return {
    name: people.map((p) => (p.last ? `${p.text} ${p.last}` : p.text)).join(' & '),
    check,
  };
}

/** The office line the home texts: { number: "(941) 297-2817", byDefault } (byDefault: no city or ZIP named an office). */
function officeLineOf(row) {
  const place = { city: row.city, zip: row.zip };
  const matched = matchServiceLocation(place);
  const location = matched || resolveServiceLocation(place);
  const line = TWILIO_NUMBERS.locations[location.id];
  return { number: line ? line.formatted : location.phone, byDefault: !matched };
}

function checkBatch(batch) {
  if (typeof batch !== 'string' || !BATCH_RE.test(batch)) {
    throw new TypeError('batch: 1 to 40 letters, digits, dashes or underscores, starting with a letter or digit');
  }
}

function checkIds(ids) {
  if (ids == null) return null;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !ID_RE.test(id))) {
    throw new TypeError('ids: a list of prospect ids (uuid)');
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

// The homes that can be marked: eligible (a held-back home gets no card), priced, not yet mailed, on the new-home list.
function mailable(conn, ids) {
  const query = conn('mail_prospects')
    .where({ list_key: LIST_KEY, status: 'eligible', price_status: 'priced' })
    .whereNull('mailed_at')
    .whereNotNull('price_annual')
    .whereNotNull('price_setup_fee')
    .orderBy([{ column: 'recorded_date', order: 'asc' }, { column: 'id', order: 'asc' }]);
  return ids ? query.whereIn('id', ids) : query;
}

/**
 * Read only: the homes markBatch would mark now, with the price each would print. `ids` limits it to those prospects.
 * knownNow: the ready homes that are left out because Waves knows the address now (knownToWavesNow); they are in
 * notMailable too when `ids` named them.
 * @returns {Promise<{ homes: { id: string, monthly: number, annual: number, setupFee: number }[], knownNow: string[], notMailable: string[] }>}
 */
async function wouldMark({ ids } = {}, conn = db, deps = {}) {
  const known = deps.knownToWaves || knownToWavesNow;
  const list = checkIds(ids);
  const rows = await mailable(conn, list).select(...MARK_COLUMNS);
  const homes = [];
  const knownNow = [];
  for (const row of rows) {
    const snap = snapshotOf(row);
    if (!snap) continue;
    if (await known(row, conn)) knownNow.push(row.id);
    else homes.push({ id: row.id, monthly: snap.monthly, annual: snap.annual, setupFee: snap.setupFee });
  }
  const found = new Set(homes.map((h) => h.id));
  return { homes, knownNow, notMailable: list ? list.filter((id) => !found.has(id)) : [] };
}

/**
 * Mark the mailable homes (all of them, or `ids`) as mailed in `batch`, in ONE transaction: mailed_at = `now`, the batch
 * name and the frozen snapshot of the price the label prints. A mailed row is never touched again (the select skips it and
 * the update names mailed_at IS NULL), and a batch name that already has homes marks nothing (batchExists), so a second run of
 * the same call is a no-op even when more homes have been priced since.
 * The snapshot also keeps what the label prints besides the price (labelFieldsOf). A home Waves knows now is not marked
 * (knownNow).
 * @returns {Promise<{ marked: string[], knownNow?: string[], notMailable: string[], batchExists?: boolean }>}
 */
async function markBatch({ batch, ids, now = new Date() }, conn = db, deps = {}) {
  const known = deps.knownToWaves || knownToWavesNow;
  checkBatch(batch);
  const list = checkIds(ids);
  return conn.transaction(async (trx) => {
    // A batch name is used once, so a retry (or a second operator) can never add homes that priced since to a print run that
    // was already exported. The advisory lock makes two runs with one name take turns; the second sees the first's rows.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail_batch:${batch}`]);
    if (await trx('mail_prospects').where({ mail_batch: batch }).first('id')) return { marked: [], notMailable: list || [], batchExists: true };
    const rows = await mailable(trx, list).forUpdate().select(...MARK_COLUMNS);
    const marked = [];
    const knownNow = [];
    for (const row of rows) {
      const price = snapshotOf(row);
      if (!price) continue;
      // Checked again here, on this transaction: the home is left as it is (not marked, no status change) and reported.
      if (await known(row, trx)) { knownNow.push(row.id); continue; }
      const snap = { ...price, label: labelFieldsOf(row) };
      const updated = await trx('mail_prospects')
        .where({ id: row.id })
        .whereNull('mailed_at')
        .update({ mailed_at: now, mail_batch: batch, mailed_price: JSON.stringify(snap), updated_at: trx.fn.now() });
      if (updated) marked.push(row.id);
    }
    const done = new Set(marked);
    return { marked, knownNow, notMailable: list ? list.filter((id) => !done.has(id)) : [] };
  });
}

// One label row from a home, the price it prints and its label fields.
function labelRowOf(row, priceNow, fields) {
  return {
    name: fields.name,
    price: labelPrice(priceNow.monthly),
    perApplication: perApplicationLabel(priceNow.annual),
    slug: row.page_slug || null,
    token: row.page_token,
    textNumber: fields.textNumber,
    // The last day the printed price is held, as the label words it ("Jan 23"); booking honors it (home-book.js).
    heldUntil: heldUntilLabel(heldUntilOf(row.mailed_at)),
    // The one-time setup fee the page shows and booking applies (null when there is none), so the label can say it.
    setupFee: Number(priceNow.setupFee) > 0 ? labelPrice(priceNow.setupFee) : null,
  };
}

/**
 * Read only: the label rows [{ name, price, perApplication, slug, token, textNumber, heldUntil, setupFee }] for the homes of `batch`, or (no batch)
 * for the homes markBatch would mark at `now`. price is the monthly price the label shows; for a marked home it is the frozen
 * snapshot; heldUntil counts from its mailed_at. Also returns the prospect ids whose name or office needs a look.
 */
async function labelsFor({ batch, ids } = {}, conn = db, deps = {}) {
  const known = deps.knownToWaves || knownToWavesNow;
  const list = checkIds(ids);
  if (batch !== undefined && batch !== null) checkBatch(batch);
  const columns = MARK_COLUMNS;
  let query;
  if (batch) {
    query = conn('mail_prospects').where({ list_key: LIST_KEY, mail_batch: batch })
      .orderBy([{ column: 'recorded_date', order: 'asc' }, { column: 'id', order: 'asc' }]);
    if (list) query = query.whereIn('id', list);
  } else {
    query = mailable(conn, list);
  }
  const rows = await query.select(...columns);
  const labels = [];
  const nameCheck = [];
  const officeByDefault = [];
  for (const row of rows) {
    const printed = row.mailed_at ? printedPriceOf(row) : null;
    const priceNow = printed || snapshotOf(row);
    if (!priceNow || priceNow.monthly == null) continue;
    // A home not yet marked is listed only if markBatch would mark it now.
    if (!row.mailed_at && await known(row, conn)) continue;
    // A marked home prints what it was marked with; one marked before the fields were kept is worked out again.
    const fields = printedLabelOf(row) || labelFieldsOf(row);
    if (fields.nameCheck) nameCheck.push(row.id);
    if (fields.officeByDefault) officeByDefault.push(row.id);
    labels.push(labelRowOf(row, priceNow, fields));
  }
  return { labels, nameCheck, officeByDefault };
}

module.exports = {
  markBatch, wouldMark, labelsFor, snapshotOf, printedPriceOf, printedLabelOf, labelFieldsOf, knownToWavesNow, heldUntilOf, heldUntilLabel, labelPrice, perApplicationLabel, labelName, officeLineOf,
  PRICE_HOLD_DAYS, PLAN, BATCH_RE,
};
