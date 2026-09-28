/**
 * Plaid bank sync (GATE_PLAID_SYNC) — live bank/card feed into the
 * bank_transactions STAGING table, next to the statement-CSV import.
 *
 * Source-agnostic by design: a synced transaction becomes the same kind of
 * staging row a CSV line does (source='plaid'), and the existing
 * deterministic matcher / review UI take it from there. Nothing here writes
 * to `expenses` or reconciles a payout.
 *
 * Identity: POSTED transactions only — pending ones are skipped, because
 * Plaid retracts a pending id when it posts (under a new id). A posted
 * transaction's id is stable, so re-syncing is idempotent
 * (row_hash = sha256('plaid|' + transaction_id), unique).
 *
 * CSV overlap: every account carries a `sync_from` cutoff (default = the
 * day after that label's latest CSV row) so a feed never re-imports days a
 * statement already covered — the two sources have different descriptions
 * and could not be deduped against each other after the fact.
 *
 * Access tokens are pgcrypto-encrypted at rest (PLAID_TOKEN_KEY, falling
 * back to DATA_HYGIENE_VAULT_KEY). With no key, connecting FAILS CLOSED.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const plaid = require('./plaid-client');
const bankImport = require('./bank-import');
const { isInfrastructureError } = require('./vendor-credentials');
const { etDateString } = require('../utils/datetime-et');

const MAX_SYNC_PAGES = 400;             // 400 × 500 = 200k transactions per run (two years for a small business is a few thousand)
const MAX_PAGINATION_RESTARTS = 3;
const MAX_MATCHING_PASSES = 20;           // × 500 rows per hourly run; the next hour continues
const MAX_AMOUNT = 9999999999.99;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;       // numeric(12,2) ceiling, as the CSV parser

// ── token vault ─────────────────────────────────────────────────────────────

function tokenKeys() {
  return [...new Set([process.env.PLAID_TOKEN_KEY, process.env.DATA_HYGIENE_VAULT_KEY].filter(Boolean))];
}

function hasTokenKey() {
  return tokenKeys().length > 0;
}

function encryptedTokenRaw(conn, token) {
  const key = tokenKeys()[0];
  if (!key) throw new Error('plaid token key missing');
  return conn.raw('armor(pgp_sym_encrypt(?, ?))', [String(token), key]);
}

// Tries every candidate key (primary first). A wrong key is pgcrypto's
// data error → next key; an infrastructure failure is rethrown SANITIZED —
// knex puts bindings (ciphertext AND key) in its error message.
async function decryptToken(conn, enc) {
  if (!enc) return null;
  for (const key of tokenKeys()) {
    try {
      const r = await conn.raw('SELECT pgp_sym_decrypt(dearmor(?), ?) AS t', [enc, key]);
      const t = r && r.rows && r.rows[0] && r.rows[0].t;
      if (t) return t;
    } catch (e) {
      if (!isInfrastructureError(e)) continue;
      const err = new Error(`plaid token decrypt failed: database error${e && e.code != null ? ` ${String(e.code)}` : ''}`);
      err.code = e && e.code != null ? String(e.code) : undefined;
      throw err;
    }
  }
  return null;
}

// ── pure mapping ────────────────────────────────────────────────────────────

function defaultAccountType(acct) {
  return acct && acct.type === 'credit' ? 'card' : 'bank';
}

// Loans and investments aren't spend — they start disabled.
function defaultEnabled(acct) {
  return !!acct && (acct.type === 'depository' || acct.type === 'credit');
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function defaultLabel(institutionName, acct) {
  const inst = slug(institutionName).split('-').slice(0, 2).join('-') || 'bank';
  const kind = acct && acct.type === 'credit' ? 'card' : (slug(acct && acct.subtype) || 'account');
  const mask = slug(acct && acct.mask);
  return [inst, kind, mask].filter(Boolean).join('-').slice(0, 100);
}

function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function plaidRowHash(transactionId) {
  return crypto.createHash('sha256').update(`plaid|${transactionId}`).digest('hex');
}

// Why a Plaid transaction is not staged — checked in order, the first hit
// names the skip. `correction`: the transaction is already staged, so the
// NEW-row gates (account known + enabled, start-date cutoff) don't apply — a
// bank correction to a row we hold must never be dropped because it moved
// the date earlier or the feed was since switched off.
const SKIP_RULES = [
  ['no_id', c => !c.txn || !c.txn.transaction_id],
  ['unknown_account', c => !c.correction && !c.account],
  ['account_disabled', c => !c.correction && !c.account.enabled],
  ['pending', c => !!c.txn.pending],
  ['currency', c => !!c.txn.iso_currency_code && c.txn.iso_currency_code !== 'USD'],
  ['bad_date', c => !isDateStr(c.txn.date)],
  ['before_sync_from', c => !c.correction && c.txn.date < (toDateOnly(c.account.sync_from) || '')],
  ['bad_amount', c => !Number.isFinite(c.n)],
  ['zero_amount', c => c.amount === 0],
  ['amount_too_large', c => c.amount > MAX_AMOUNT],
];

// Plaid → staging row, or { skip: reason }. Plaid's sign convention: a
// POSITIVE amount is money leaving the account (purchase / debit) for both
// depository and credit accounts; negative is money coming in. On a
// correction, label/type stay the staged row's own (supersedeUnmatchedRow).
function mapTransaction(txn, account, { correction = false } = {}) {
  const n = Number(txn && txn.amount);
  const ctx = { txn, account, correction, n, amount: Math.round(Math.abs(n) * 100) / 100 };
  const failed = SKIP_RULES.find(([, fails]) => fails(ctx));
  if (failed) return { skip: failed[0] };
  const description = String(txn.name || txn.merchant_name || 'Plaid transaction').replace(/\s+/g, ' ').trim().slice(0, 500) || 'Plaid transaction';
  return {
    row: {
      account_label: account ? account.account_label : null,
      account_type: account ? account.account_type : null,
      txn_date: txn.date,
      description,
      amount: ctx.amount,
      direction: n > 0 ? 'debit' : 'credit',
      source: 'plaid',
      source_file: null,
      row_hash: plaidRowHash(txn.transaction_id),
      plaid_transaction_id: txn.transaction_id,
      plaid_account_id: txn.account_id || null,
    },
  };
}

// pg returns DATE columns as JS Dates at local midnight unless a type parser
// is set — normalize either shape to 'YYYY-MM-DD'.
function toDateOnly(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function isLoginRequired(err) {
  return !!err && (err.errorCode === 'ITEM_LOGIN_REQUIRED' || err.errorCode === 'PENDING_EXPIRATION'
    || err.errorCode === 'PENDING_DISCONNECT' || err.errorCode === 'INVALID_CREDENTIALS');
}

// ── read model ──────────────────────────────────────────────────────────────

// Labels the CSV import (or an earlier feed) already uses — the setup form
// offers them so a Plaid account can continue an existing statement series,
// and their last date drives the default sync_from.
async function existingLabels(conn = db) {
  const rows = await conn('bank_transactions')
    .select(conn.raw('upper(trim(account_label)) as key'))
    .min('account_label as account_label')
    .min('account_type as account_type')
    .max('txn_date as last_date')
    .count('* as n')
    .groupByRaw('upper(trim(account_label))')
    .orderByRaw('upper(trim(account_label))');
  return rows.map(r => ({
    label: r.account_label,
    accountType: r.account_type,
    lastDate: toDateOnly(r.last_date),
    rows: parseInt(r.n, 10),
  }));
}

async function defaultSyncFrom(label, conn = db) {
  const row = await conn('bank_transactions')
    .whereRaw('upper(trim(account_label)) = upper(?)', [label])
    .max('txn_date as last_date')
    .first();
  const last = toDateOnly(row && row.last_date);
  if (last) return addDaysStr(last, 1);
  return `${etDateString(new Date()).slice(0, 4)}-01-01`;
}

function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    mask: a.mask,
    plaidType: a.plaid_type,
    plaidSubtype: a.plaid_subtype,
    accountLabel: a.account_label,
    accountType: a.account_type,
    syncFrom: toDateOnly(a.sync_from),
    enabled: !!a.enabled,
  };
}

// Which days a bank feed covers for this label, for the CSV upload's
// overlap guard (called under its per-label lock):
//  - live: a connected, enabled feed covers its start date onward;
//  - history: every DAY the feed actually imported rows for — still
//    covered after the feed is disabled, disconnected or its start date
//    moved, because those rows stay in staging. Day-level, not a min..max
//    span: a gap between two feed periods stays open to statements. A day
//    the feed covered with no transactions has none to duplicate either.
// `dates` = the CSV's own dates, which bound the history read.
async function feedCoverageForLabel(conn, label, dates = []) {
  const canonical = String(label).trim();
  const live = await conn('plaid_accounts as pa')
    .join('plaid_items as pi', 'pi.id', 'pa.plaid_item_id')
    // 'setup' = mapping not confirmed yet, nothing imports; setupItem
    // checks CSV overlap when it is confirmed
    .whereNotIn('pi.status', ['removed', 'setup'])
    .where('pa.enabled', true)
    .whereRaw('upper(trim(pa.account_label)) = upper(?)', [canonical])
    .min('pa.sync_from as cutoff')
    .min('pa.account_type as account_type')
    .first();
  const liveFrom = toDateOnly(live && live.cutoff);
  const fedDays = new Set();
  const sorted = [...new Set(dates)].sort();
  if (sorted.length) {
    const rows = await conn('bank_transactions')
      .whereRaw('upper(trim(account_label)) = upper(?)', [canonical])
      .where({ source: 'plaid' })
      .whereBetween('txn_date', [sorted[0], sorted[sorted.length - 1]])
      .distinct('txn_date');
    for (const r of rows) fedDays.add(toDateOnly(r.txn_date));
  }
  return {
    liveFrom,
    // a feed configured on this label fixes its account type even before
    // its first row lands (label uniqueness ⇒ at most one live account)
    liveType: liveFrom ? (live.account_type || null) : null,
    fedDays: [...fedDays].sort(),
    isCovered: (d) => (!!liveFrom && d >= liveFrom) || fedDays.has(d),
  };
}

async function getStatus() {
  const items = await db('plaid_items').whereNot({ status: 'removed' }).orderBy('created_at', 'asc');
  const accounts = items.length
    ? await db('plaid_accounts').whereIn('plaid_item_id', items.map(i => i.id)).orderBy('name', 'asc')
    : [];
  const readable = new Map();
  for (const i of items) readable.set(i.id, !!(await decryptToken(db, i.access_token_enc)));
  return {
    configured: plaid.isConfigured(),
    tokenKey: hasTokenKey(),
    env: plaid.plaidEnv(),
    items: items.map(i => ({
      id: i.id,
      tokenReadable: readable.get(i.id),
      institutionName: i.institution_name,
      status: i.status,
      lastSyncedAt: i.last_synced_at,
      lastError: i.last_error,
      accounts: accounts.filter(a => a.plaid_item_id === i.id).map(publicAccount),
    })),
    existingLabels: await existingLabels(),
  };
}

// ── connect / setup / disconnect ────────────────────────────────────────────

async function createLinkToken({ clientUserId, itemId } = {}) {
  if (!itemId) return plaid.createLinkToken({ clientUserId });
  const item = await db('plaid_items').where({ id: itemId }).first();
  if (!item || item.status === 'removed') {
    const e = new Error('connection not found'); e.status = 404; throw e;
  }
  const accessToken = await decryptToken(db, item.access_token_enc);
  if (!accessToken) {
    const e = new Error('stored bank token cannot be read — disconnect and connect again'); e.status = 409; throw e;
  }
  return plaid.createLinkToken({ clientUserId, accessToken });
}

// Link's onSuccess → exchange, store the (encrypted) token, list accounts.
// The item stays in 'setup' — nothing syncs until the operator confirms each
// account's label / type / start date.
async function connectItem({ publicToken, institutionName }) {
  if (!hasTokenKey()) {
    const e = new Error('no encryption key configured (PLAID_TOKEN_KEY) — refusing to store a bank token'); e.status = 503; throw e;
  }
  const { accessToken, itemId } = await plaid.exchangePublicToken(publicToken);
  const instName = String(institutionName || '').trim().slice(0, 200) || null;
  // The connection is LIVE at Plaid from here. Store the (encrypted) token
  // FIRST, on its own: every later failure then leaves a visible
  // connection the operator can disconnect (which revokes it), never an
  // orphan nobody can see or revoke.
  let created;
  try {
    [created] = await db('plaid_items').insert({
      item_id: itemId,
      institution_name: instName,
      access_token_enc: encryptedTokenRaw(db, accessToken),
      status: 'setup',
    }).returning(['id']);
  } catch (err) {
    try {
      await plaid.removeItem(accessToken);
    } catch (cleanupErr) {
      // both failed: the item id (never the token) is the operator's handle
      // for removing it in the Plaid dashboard
      logger.error(`[plaid-sync] ORPHANED Plaid item ${itemId}: could not store it (${err.code || 'database error'}) or revoke it (${cleanupErr.errorCode || cleanupErr.message}) — remove it in the Plaid dashboard`);
    }
    throw new Error(`could not save the bank connection: ${err.code ? `database error ${err.code}` : 'database error'}`);
  }
  try {
    const { accounts, institutionId } = await plaid.getAccounts(accessToken);
    const defaults = [];
    const usedLabels = new Set();
    for (const a of accounts) {
      let label = defaultLabel(instName, a);
      for (let n = 2; usedLabels.has(label.toUpperCase()); n++) label = `${defaultLabel(instName, a).slice(0, 95)}-${n}`;
      usedLabels.add(label.toUpperCase());
      defaults.push({ a, label, syncFrom: await defaultSyncFrom(label) });
    }
    await db.transaction(async (trx) => {
      await trx('plaid_items').where({ id: created.id }).update({ institution_id: institutionId, updated_at: trx.fn.now() });
      if (defaults.length) {
        await trx('plaid_accounts').insert(defaults.map(({ a, label, syncFrom }) => ({
          plaid_item_id: created.id,
          account_id: a.account_id,
          name: String(a.name || a.official_name || 'Account').slice(0, 200),
          mask: a.mask ? String(a.mask).slice(0, 10) : null,
          plaid_type: a.type ? String(a.type).slice(0, 30) : null,
          plaid_subtype: a.subtype ? String(a.subtype).slice(0, 50) : null,
          account_label: label,
          account_type: defaultAccountType(a),
          sync_from: syncFrom,
          enabled: defaultEnabled(a),
        })));
      }
    });
  } catch (err) {
    const reason = err instanceof plaid.PlaidError ? err.message
      : `could not save the bank connection: ${err.code ? `database error ${err.code}` : 'database error'}`;
    // revoke + forget when possible; otherwise the stored row stays (still
    // in 'setup', so nothing syncs) with the reason, and Disconnect retries
    const revoked = await plaid.removeItem(accessToken).then(() => true, () => false);
    if (revoked) await db('plaid_items').where({ id: created.id }).del().catch(() => {});
    else {
      await db('plaid_items').where({ id: created.id }).update({
        last_error: `${reason} — could not be revoked automatically; disconnect it`.slice(0, 500),
        updated_at: db.fn.now(),
      }).catch(() => {});
    }
    if (err instanceof plaid.PlaidError) throw err;
    throw new Error(reason);
  }
  return created.id;
}

const ACCOUNT_TYPE_NOUN = { bank: 'a bank account', card: 'a credit card' };

function badRequest(msg) {
  const e = new Error(msg); e.status = 400; return e;
}

// Confirm (or later edit) an item's account mapping, then activate it.
// Enabling an account that was off, or moving a start date EARLIER, resets
// the sync cursor: the transactions Plaid already delivered for it were
// skipped, and only a full re-sync (idempotent on transaction id) brings
// them back.
async function setupItem(itemId, input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) throw badRequest('accounts[] is required');
  const today = etDateString(new Date());
  const cleaned = input.map((a) => {
    const label = typeof a.accountLabel === 'string' ? a.accountLabel.trim() : '';
    if (typeof a.id !== 'string' || !UUID_RE.test(a.id)) throw badRequest('each account needs its id');
    if (!label || label.length > 100) throw badRequest('account label is required (max 100 chars)');
    if (!['bank', 'card'].includes(a.accountType)) throw badRequest("account type must be 'bank' or 'card'");
    if (!isDateStr(a.syncFrom)) throw badRequest('start date must be YYYY-MM-DD');
    // the day after today is the cutoff for a CSV series imported through
    // today (defaultSyncFrom = last row + 1) — anything later is refused
    if (a.syncFrom > addDaysStr(today, 1)) throw badRequest('start date can be at most tomorrow');
    return { id: a.id, label, accountType: a.accountType, syncFrom: a.syncFrom, enabled: a.enabled === true };
  });
  const enabledLabels = cleaned.filter(a => a.enabled).map(a => a.label.toUpperCase());
  if (new Set(enabledLabels).size !== enabledLabels.length) throw badRequest('two accounts cannot share a label — each feed needs its own');

  await db.transaction(async (trx) => {
    const item = await trx('plaid_items').where({ id: itemId }).forUpdate().first();
    if (!item || item.status === 'removed') { const e = new Error('connection not found'); e.status = 404; throw e; }
    const current = await trx('plaid_accounts').where({ plaid_item_id: itemId });
    // exactly the stored account set: every id once, none missing
    const ids = new Set(cleaned.map(a => a.id));
    if (ids.size !== cleaned.length || ids.size !== current.length || current.some(a => !ids.has(a.id))) {
      throw badRequest('account list does not match this connection — reload and try again');
    }
    const byId = new Map(current.map(a => [a.id, a]));
    // Every enabled label's lock FIRST (sorted — a fixed order across
    // concurrent setups and syncs), THEN the ownership + type reads: a
    // concurrent setup of another connection claiming the same label either
    // committed before these reads (and is seen) or waits behind the lock.
    // Same lock the CSV upload takes for the label→type invariant.
    for (const label of [...enabledLabels].sort()) {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`bank-import-label:${label}`]);
    }
    const others = await trx('plaid_accounts as pa')
      .join('plaid_items as pi', 'pi.id', 'pa.plaid_item_id')
      .whereNot('pa.plaid_item_id', itemId)
      .whereNot('pi.status', 'removed')
      .where('pa.enabled', true)
      .select('pa.account_label');
    const otherLabels = new Set(others.map(o => String(o.account_label).trim().toUpperCase()));
    for (const a of cleaned.filter(x => x.enabled)) {
      if (otherLabels.has(a.label.toUpperCase())) {
        throw badRequest(`"${a.label}" is already fed by another bank connection`);
      }
      const existing = await trx('bank_transactions')
        .whereRaw('upper(trim(account_label)) = upper(?)', [a.label])
        .first('account_type');
      if (existing && existing.account_type !== a.accountType) {
        throw badRequest(`"${a.label}" is already imported as ${ACCOUNT_TYPE_NOUN[existing.account_type]} — keep that type, or use a different label`);
      }
      // Rows from another source for this label — a CSV statement, or an
      // EARLIER feed of the same bank account (a replacement connection
      // gets new transaction ids) — can't be deduped against this feed,
      // so it must start AFTER the last day they cover. This account's
      // own rows are excluded: re-syncing them is idempotent by id.
      // Checked under the label lock the CSV upload also takes.
      const prior = await trx('bank_transactions')
        .whereRaw('upper(trim(account_label)) = upper(?)', [a.label])
        .where(q => q.where({ source: 'csv' })
          .orWhere(q2 => q2.where({ source: 'plaid' }).whereRaw('plaid_account_id is distinct from ?', [byId.get(a.id).account_id])))
        .max('txn_date as last_date')
        .first();
      const lastPrior = toDateOnly(prior.last_date);
      if (lastPrior && a.syncFrom <= lastPrior) {
        throw badRequest(`"${a.label}" already has rows from a statement or an earlier feed through ${lastPrior} — start the feed on ${addDaysStr(lastPrior, 1)} or later`);
      }
    }
    let resetCursor = false;
    for (const a of cleaned) {
      const prev = byId.get(a.id);
      if (a.enabled && (!prev.enabled || a.syncFrom < toDateOnly(prev.sync_from))) resetCursor = true;
      await trx('plaid_accounts').where({ id: a.id }).update({
        account_label: a.label,
        account_type: a.accountType,
        sync_from: a.syncFrom,
        enabled: a.enabled,
        updated_at: trx.fn.now(),
      });
    }
    const patch = { updated_at: trx.fn.now() };
    if (item.status === 'setup') patch.status = 'active';
    // a never-synced item has no cursor to reset; an active one restarts
    if (resetCursor && item.sync_cursor) patch.sync_cursor = null;
    await trx('plaid_items').where({ id: itemId }).update(patch);
  });
}

// After a successful update-mode Link (re-auth), the item can sync again.
async function markReconnected(itemId) {
  const n = await db('plaid_items')
    .where({ id: itemId })
    .whereIn('status', ['login_required', 'error'])
    .update({ status: 'active', last_error: null, updated_at: db.fn.now() });
  return n > 0;
}

// `confirmedRemovedAtPlaid`: the stored token can't be read (key missing or
// rotated), so this app cannot revoke the connection itself. Without the
// operator's explicit confirmation that it was removed on Plaid's side, the
// ciphertext is kept — restoring the key makes a normal disconnect work.
async function disconnectItem(itemId, { confirmedRemovedAtPlaid = false } = {}) {
  const item = await db('plaid_items').where({ id: itemId }).first();
  if (!item || item.status === 'removed') { const e = new Error('connection not found'); e.status = 404; throw e; }
  const accessToken = await decryptToken(db, item.access_token_enc);
  if (accessToken) {
    try {
      await plaid.removeItem(accessToken);
    } catch (err) {
      // already gone at Plaid = the goal; anything else is surfaced and the
      // connection stays so the operator can retry
      if (err.errorCode !== 'ITEM_NOT_FOUND') throw err;
    }
  } else if (item.access_token_enc && !confirmedRemovedAtPlaid) {
    const e = new Error('the stored bank token cannot be read (check PLAID_TOKEN_KEY), so the connection cannot be revoked from here — restore the key, or remove it in Plaid first and confirm');
    e.status = 409;
    throw e;
  }
  await db.transaction(async (trx) => {
    await trx('plaid_items').where({ id: itemId }).update({
      status: 'removed', access_token_enc: null, sync_cursor: null, updated_at: trx.fn.now(),
    });
    await trx('plaid_accounts').where({ plaid_item_id: itemId }).update({ enabled: false, updated_at: trx.fn.now() });
  });
}

// ── sync ────────────────────────────────────────────────────────────────────

// One complete pagination run, consolidated to each transaction's LATEST
// state: a transaction added on page 1 and corrected (or withdrawn) on page
// 3 is applied once, as its final version — never as two staged versions
// where the insert-conflict rule would keep the stale one.
async function fetchAllChanges(accessToken, startCursor) {
  for (let attempt = 0; attempt <= MAX_PAGINATION_RESTARTS; attempt++) {
    const latest = new Map(); // transaction_id → { txn } | { removed: true }
    let cursor = startCursor;
    let hasMore = true;
    let pages = 0;
    try {
      while (hasMore) {
        // Plaid's contract: a cursor from the MIDDLE of a pagination run is
        // not a valid restart point — only a complete run may be committed
        if (++pages > MAX_SYNC_PAGES) throw new Error(`more than ${MAX_SYNC_PAGES * 500} changed transactions in one sync — nothing applied`);
        const page = await plaid.transactionsSync(accessToken, cursor);
        // removals after additions: a transaction both added and removed on
        // one page ends removed
        const entries = [
          ...[...(page.added || []), ...(page.modified || [])].map(t => [t, { txn: t }]),
          ...(page.removed || []).map(r => [r, { removed: true }]),
        ].filter(([t]) => t && t.transaction_id);
        for (const [t, state] of entries) latest.set(t.transaction_id, state);
        cursor = page.next_cursor || cursor;
        hasMore = !!page.has_more;
      }
      const upserts = [];
      const removedIds = [];
      for (const [id, v] of latest) {
        if (v.removed) removedIds.push(id); else upserts.push(v.txn);
      }
      return { upserts, removedIds, nextCursor: cursor };
    } catch (err) {
      // Plaid's documented recovery: restart the whole pagination loop from
      // the cursor the loop STARTED with
      if (err.errorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_PAGINATION_RESTARTS) continue;
      throw err;
    }
  }
  throw new Error('transactions sync kept changing during pagination');
}

function sameMoneyFields(row, r) {
  return toDateOnly(row.txn_date) === r.txn_date && Number(row.amount) === r.amount
    && row.direction === r.direction && row.description === r.description;
}

async function applyChanges(trx, accountsById, changes) {
  // `skips` = per-transaction reasons; a whole-run skip is the separate
  // string `skipped` on syncItem's result
  const counts = { inserted: 0, updated: 0, deleted: 0, flagged: 0, skips: {} };
  const skip = (reason) => { counts.skips[reason] = (counts.skips[reason] || 0) + 1; };

  // label→type invariant under the same per-label lock the CSV upload takes
  const labels = [...new Set([...accountsById.values()].filter(a => a.enabled).map(a => a.account_label.trim().toUpperCase()))].sort();
  for (const label of labels) {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`bank-import-label:${label}`]);
    const acct = [...accountsById.values()].find(a => a.enabled && a.account_label.trim().toUpperCase() === label);
    const existing = await trx('bank_transactions')
      .whereRaw('upper(trim(account_label)) = upper(?)', [label])
      .whereNot('account_type', acct.account_type)
      .first('account_type');
    if (existing) {
      throw new Error(`"${acct.account_label}" is already imported with a different account type — fix the account mapping`);
    }
  }

  // Row-locked up front: the matcher or an operator claiming a row between
  // our read and our write would otherwise make a status-conditional write
  // miss, and the change would be lost as the cursor moves past it.
  const existingById = new Map();
  const ids = changes.upserts.map(t => t.transaction_id);
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await trx('bank_transactions')
      .whereIn('plaid_transaction_id', ids.slice(i, i + 500))
      .forUpdate()
      .select('id', 'status', 'plaid_transaction_id', 'txn_date', 'amount', 'direction', 'description', 'suggestion');
    for (const row of rows) existingById.set(row.plaid_transaction_id, row);
  }

  const toInsert = [];
  // a correction that makes a STAGED transaction unstageable (zeroed out,
  // non-USD, malformed) must not leave the old values live — it is handled
  // like a withdrawal: unmatched rows go, reviewed rows get flagged
  const withdrawnByCorrection = [];
  for (const txn of changes.upserts) {
    const existing = existingById.get(txn.transaction_id);
    const m = mapTransaction(txn, accountsById.get(txn.account_id), { correction: !!existing });
    if (m.skip) {
      skip(m.skip);
      if (existing) withdrawnByCorrection.push(txn.transaction_id);
      continue;
    }
    const r = m.row;
    if (!existing) { toInsert.push(r); continue; }
    // Nothing to change when the bank's latest version is the row's own (a
    // re-send after a cursor reset, or a correction the bank reverted) or
    // the version the operator already dismissed (they kept the row's
    // values) — and any correction or withdrawal parked since is obsolete.
    const dismissed = existing.suggestion && existing.suggestion.plaidDismissed;
    if (sameMoneyFields(existing, r) || (dismissed && sameMoneyFields(dismissed, r))) {
      if (bankImport.hasUnresolvedBankChange(existing)) await clearParkedChange(trx, [existing.id]);
      continue;
    }
    if (existing.status === 'unmatched') {
      // the bank's newest values win (superseding any correction parked
      // while the row was reviewed) — by REPLACING the row, never editing
      // its money fields in place; see supersedeUnmatchedRow
      await supersedeUnmatchedRow(trx, existing.id, r);
      counts.updated++;
    } else {
      // a reviewed row is never rewritten under the operator — the change
      // parks on the row (replacing an older parked one) for them to judge
      await trx('bank_transactions').where({ id: existing.id }).update({
        // a valid version supersedes an earlier withdrawal (e.g. zeroed, then restored)
        suggestion: trx.raw("(coalesce(suggestion, '{}'::jsonb) - 'plaidRemoved') || ?::jsonb", [JSON.stringify({
          plaidModified: { txn_date: r.txn_date, amount: r.amount, direction: r.direction, description: r.description },
        })]),
        updated_at: trx.fn.now(),
      });
      counts.flagged++;
    }
  }

  for (let i = 0; i < toInsert.length; i += 500) {
    const batch = await trx('bank_transactions')
      .insert(toInsert.slice(i, i + 500))
      .onConflict('row_hash')
      .ignore()
      .returning(['id']);
    counts.inserted += batch.length;
  }

  const removedIds = [...changes.removedIds, ...withdrawnByCorrection];
  for (let i = 0; i < removedIds.length; i += 500) {
    // lock first, THEN decide per row: deciding by two status-filtered
    // statements let a row unlinked between them escape both (neither
    // deleted nor flagged) while the cursor moved past the withdrawal
    const locked = await trx('bank_transactions')
      .whereIn('plaid_transaction_id', removedIds.slice(i, i + 500))
      .forUpdate()
      .select('id', 'status', 'suggestion');
    const unmatched = locked.filter(r => r.status === 'unmatched').map(r => r.id);
    // a withdrawal the operator already dismissed is not raised again, and a
    // correction parked since it is obsolete (the bank's latest = withdrawn)
    const dismissedGone = (r) => !!(r.suggestion && r.suggestion.plaidDismissed && r.suggestion.plaidDismissed.removed);
    const reviewed = locked.filter(r => r.status !== 'unmatched' && !dismissedGone(r)).map(r => r.id);
    const obsolete = locked.filter(r => r.status !== 'unmatched' && dismissedGone(r) && bankImport.hasUnresolvedBankChange(r)).map(r => r.id);
    if (unmatched.length) counts.deleted += await trx('bank_transactions').whereIn('id', unmatched).del();
    if (obsolete.length) await clearParkedChange(trx, obsolete);
    if (reviewed.length) {
      counts.flagged += await trx('bank_transactions').whereIn('id', reviewed).update({
        suggestion: trx.raw("coalesce(suggestion, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ plaidRemoved: true })]),
        updated_at: trx.fn.now(),
      });
    }
  }
  return counts;
}

function clearParkedChange(trx, ids) {
  return trx('bank_transactions').whereIn('id', ids).update({
    suggestion: trx.raw("coalesce(suggestion, '{}'::jsonb) - 'plaidModified' - 'plaidRemoved'"),
    updated_at: trx.fn.now(),
  });
}

// Staged rows' money fields (date / amount / direction / description) are
// never edited in place: every claim path (matcher, create-expense, link,
// refund) reads a row and then claims it with a status-only CAS, so an
// in-place edit between its read and its claim would book the OLD values.
// A correction instead deletes the unmatched row and inserts a fresh one
// with the same Plaid identity — a racing claim then finds its row gone,
// its CAS affects nothing, and it rolls back as it already does for a lost
// race. Caller holds the row lock (FOR UPDATE) inside `trx`. Only the
// durable human history in `suggestion` carries over — rejected / unlinked
// targets (so the matcher can't re-propose a link the operator already
// turned down) and audit records. Everything DERIVED from the old values
// (category, transfer flag, noMatch, parked candidates) and the parked
// bank change itself is dropped: the replacement is a fresh row the
// matcher and categorizer judge on its new values.
const DURABLE_SUGGESTION_KEYS = ['lastUnlink', 'rejectedExpenseIds', 'rejectedPayoutIds', 'bankingRejectedPayoutIds', 'autoRevert', 'releasedRefundOf'];

async function supersedeUnmatchedRow(trx, rowId, values) {
  const old = await trx('bank_transactions').where({ id: rowId, status: 'unmatched' }).first('*');
  if (!old) return null;
  const carried = Object.fromEntries(DURABLE_SUGGESTION_KEYS.filter(k => old.suggestion && old.suggestion[k] !== undefined).map(k => [k, old.suggestion[k]]));
  await trx('bank_transactions').where({ id: rowId, status: 'unmatched' }).del();
  const [row] = await trx('bank_transactions').insert({
    account_label: old.account_label,
    account_type: old.account_type,
    source: old.source,
    source_file: old.source_file,
    row_hash: old.row_hash,
    plaid_transaction_id: old.plaid_transaction_id,
    plaid_account_id: old.plaid_account_id,
    txn_date: values.txn_date,
    amount: values.amount,
    direction: values.direction,
    description: String(values.description).slice(0, 500),
    suggestion: Object.keys(carried).length ? carried : null,
  }).returning(['id']);
  return row.id;
}

async function registerNewAccounts(item, accessToken, unknownIds) {
  const { accounts } = await plaid.getAccounts(accessToken);
  const existing = await db('plaid_accounts').where({ plaid_item_id: item.id }).select('account_label');
  const used = new Set(existing.map(r => String(r.account_label).trim().toUpperCase()));
  const rows = [];
  for (const a of accounts.filter(x => unknownIds.includes(x.account_id))) {
    let label = defaultLabel(item.institution_name, a);
    for (let n = 2; used.has(label.toUpperCase()); n++) label = `${defaultLabel(item.institution_name, a).slice(0, 95)}-${n}`;
    used.add(label.toUpperCase());
    rows.push({
      plaid_item_id: item.id,
      account_id: a.account_id,
      name: String(a.name || a.official_name || 'Account').slice(0, 200),
      mask: a.mask ? String(a.mask).slice(0, 10) : null,
      plaid_type: a.type ? String(a.type).slice(0, 30) : null,
      plaid_subtype: a.subtype ? String(a.subtype).slice(0, 50) : null,
      account_label: label,
      account_type: defaultAccountType(a),
      sync_from: await defaultSyncFrom(label),
      enabled: false,
    });
  }
  // Conditioned on the item row as this sync observed it (row_version, as
  // recordFailure): a run that registered these accounts — and an operator
  // who confirmed them — while this one waited on Plaid is newer, so a stale
  // discovery rolls back instead of pausing a confirmed feed. The next run
  // re-checks against the current account list.
  return db.transaction(async (trx) => {
    const n = await trx('plaid_items')
      .where({ id: item.id })
      .whereRaw('updated_at::text = ?', [item.row_version])
      .whereNot({ status: 'removed' })
      .update({
        status: 'setup',
        last_error: rows.length
          ? 'The bank reported a new or re-issued account — confirm the accounts below to resume syncing'
          : `The bank sent transactions for an account it does not list (${unknownIds.join(', ').slice(0, 200)}) — reconnect this bank`,
        updated_at: trx.fn.now(),
      });
    if (!n) return false;
    if (rows.length) await trx('plaid_accounts').insert(rows).onConflict('account_id').ignore();
    return true;
  });
}

// Conditioned on the item row as this sync observed it (row_version): a
// reconnect or another sync that landed meanwhile is newer than this
// failure, so a stale ITEM_LOGIN_REQUIRED can't re-park a connection that
// already recovered. Returns the recorded status, or null when superseded.
async function recordFailure(item, err) {
  const status = isLoginRequired(err) ? 'login_required' : 'error';
  try {
    const n = await db('plaid_items')
      .where({ id: item.id })
      .whereRaw('updated_at::text = ?', [item.row_version])
      .whereNot({ status: 'removed' })
      .update({
        status,
        last_error: String(err.message || 'sync failed').slice(0, 500),
        updated_at: db.fn.now(),
      });
    return n ? status : null;
  } catch (e) {
    logger.error(`[plaid-sync] could not record failure for item ${item.id}: ${e.message}`);
    return status;
  }
}

async function syncItem(itemId, { runMatching = true } = {}) {
  // row_version = updated_at as exact text (a JS Date would drop the
  // microseconds and never compare equal) — recordFailure's CAS token
  const item = await db('plaid_items').where({ id: itemId }).first('*', db.raw('updated_at::text as row_version'));
  if (!item) { const e = new Error('connection not found'); e.status = 404; throw e; }
  if (item.status === 'removed') return { itemId, skipped: 'removed' };
  if (item.status === 'setup') return { itemId, skipped: 'setup' };
  let result;
  try {
    const accessToken = await decryptToken(db, item.access_token_enc);
    if (!accessToken) throw new Error('stored bank token cannot be read — disconnect and connect again');
    const startCursor = item.sync_cursor || null;
    const changes = await fetchAllChanges(accessToken, startCursor);
    // Plaid can re-issue an account under a NEW account_id (e.g. after a
    // rename it can't reconcile). Its transactions would skip as
    // unknown_account while the cursor moved past them — so the run stops
    // here, before anything is applied, registers the account(s) (off by
    // default) and puts the connection back in setup for the operator.
    const known = new Set((await db('plaid_accounts').where({ plaid_item_id: itemId }).select('account_id')).map(r => r.account_id));
    const unknownIds = [...new Set(changes.upserts.map(t => t.account_id).filter(id => id && !known.has(id)))];
    if (unknownIds.length) {
      const paused = await registerNewAccounts(item, accessToken, unknownIds);
      return { itemId, skipped: paused ? 'new_accounts' : 'concurrent' };
    }
    result = await db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`plaid-item:${itemId}`]);
      // compare-and-swap on the cursor: a concurrent run that already
      // applied this window wins; re-applying is harmless but moving the
      // cursor BACKWARDS would not be
      const fresh = await trx('plaid_items').where({ id: itemId }).forUpdate().first('sync_cursor', 'status');
      if (!fresh || fresh.status === 'removed') return { skipped: 'removed' };
      // a concurrent run found a new account and handed the connection back
      // to the operator — nothing applies (and the status is never flipped
      // back to active) until they confirm the accounts
      if (fresh.status === 'setup') return { skipped: 'setup' };
      if ((fresh.sync_cursor || null) !== startCursor) return { skipped: 'concurrent' };
      // The mapping is read HERE, under the item row lock setupItem also
      // takes: an edit that committed while Plaid was answering (account
      // disabled, relabeled, start date moved later) applies to this batch
      // instead of being overwritten by a mapping read before the request.
      const accounts = await trx('plaid_accounts').where({ plaid_item_id: itemId });
      const accountsById = new Map(accounts.map(a => [a.account_id, a]));
      const counts = await applyChanges(trx, accountsById, changes);
      await trx('plaid_items').where({ id: itemId }).update({
        sync_cursor: changes.nextCursor,
        status: 'active',
        last_error: null,
        last_synced_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      return counts;
    });
  } catch (err) {
    const status = await recordFailure(item, err);
    logger.warn(`[plaid-sync] item ${itemId} sync failed (${status}): ${err.message}`);
    return { itemId, error: err.message, status };
  }

  let matching = null;
  let matchingError = null;
  // a correction replaces its row (updated) — fresh values to match too
  if (runMatching && (result.inserted > 0 || result.updated > 0)) {
    try {
      matching = await bankImport.runDeterministicMatching({ limit: 500 });
    } catch (err) {
      logger.warn(`[plaid-sync] item ${itemId} synced but the matching pass failed: ${err.message}`);
      matchingError = 'transactions synced, but the matching pass failed — use "Run matching" to retry';
    }
  }
  return { itemId, ...result, matching, matchingError };
}

// Cron entry: every connected item that isn't waiting on a human re-auth.
// Items are independent — one bank's failure never stops the next. Matching
// runs here on its own, not only when this hour's sync inserted rows: one
// bounded pass after a large first sync leaves work behind, and a quiet feed
// would otherwise never pick it up. Passes repeat while work remains.
async function syncAllItems() {
  if (!plaid.isConfigured()) return { skipped: 'not_configured' };
  const items = await db('plaid_items').whereIn('status', ['active', 'error']).select('id');
  const results = [];
  for (const { id } of items) {
    try {
      results.push(await syncItem(id, { runMatching: false }));
    } catch (err) {
      results.push({ itemId: id, error: err.message });
    }
  }
  let matchingPasses = 0;
  let matchingError = null;
  if (items.length) {
    try {
      let more = true;
      while (more && matchingPasses < MAX_MATCHING_PASSES) {
        matchingPasses++;
        more = (await bankImport.runDeterministicMatching({ limit: 500 })).moreRemaining;
      }
    } catch (err) {
      logger.warn(`[plaid-sync] hourly matching pass failed: ${err.message}`);
      matchingError = err.message;
    }
  }
  return { items: results.length, results, matchingPasses, matchingError };
}

module.exports = {
  getStatus,
  createLinkToken,
  connectItem,
  setupItem,
  markReconnected,
  disconnectItem,
  syncItem,
  syncAllItems,
  // pure helpers (tests)
  mapTransaction,
  defaultLabel,
  defaultAccountType,
  defaultEnabled,
  plaidRowHash,
  isLoginRequired,
  toDateOnly,
  supersedeUnmatchedRow,
  feedCoverageForLabel,
  ACCOUNT_TYPE_NOUN,
  _private: { applyChanges, fetchAllChanges, decryptToken, defaultSyncFrom, existingLabels },
};
