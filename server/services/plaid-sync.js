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
const { isInfrastructureError } = require('./vendor-credentials');
const { etDateString } = require('../utils/datetime-et');

const MAX_SYNC_PAGES = 100;             // 100 × 500 = 50k transactions per run
const MAX_PAGINATION_RESTARTS = 3;
const MAX_AMOUNT = 9999999999.99;       // numeric(12,2) ceiling, as the CSV parser

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

// Plaid → staging row, or { skip: reason }. Plaid's sign convention: a
// POSITIVE amount is money leaving the account (purchase / debit) for both
// depository and credit accounts; negative is money coming in.
function mapTransaction(txn, account) {
  if (!txn || !txn.transaction_id) return { skip: 'no_id' };
  if (!account) return { skip: 'unknown_account' };
  if (!account.enabled) return { skip: 'account_disabled' };
  if (txn.pending) return { skip: 'pending' };
  if (txn.iso_currency_code && txn.iso_currency_code !== 'USD') return { skip: 'currency' };
  const date = txn.date;
  if (!isDateStr(date)) return { skip: 'bad_date' };
  const syncFrom = typeof account.sync_from === 'string' ? account.sync_from : toDateOnly(account.sync_from);
  if (syncFrom && date < syncFrom) return { skip: 'before_sync_from' };
  const n = Number(txn.amount);
  if (!Number.isFinite(n)) return { skip: 'bad_amount' };
  const amount = Math.round(Math.abs(n) * 100) / 100;
  if (amount === 0) return { skip: 'zero_amount' };
  if (amount > MAX_AMOUNT) return { skip: 'amount_too_large' };
  const description = String(txn.name || txn.merchant_name || 'Plaid transaction').replace(/\s+/g, ' ').trim().slice(0, 500) || 'Plaid transaction';
  return {
    row: {
      account_label: account.account_label,
      account_type: account.account_type,
      txn_date: date,
      description,
      amount,
      direction: n > 0 ? 'debit' : 'credit',
      source: 'plaid',
      source_file: null,
      row_hash: plaidRowHash(txn.transaction_id),
      plaid_transaction_id: txn.transaction_id,
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

async function getStatus() {
  const items = await db('plaid_items').whereNot({ status: 'removed' }).orderBy('created_at', 'asc');
  const accounts = items.length
    ? await db('plaid_accounts').whereIn('plaid_item_id', items.map(i => i.id)).orderBy('name', 'asc')
    : [];
  return {
    configured: plaid.isConfigured(),
    tokenKey: hasTokenKey(),
    env: plaid.plaidEnv(),
    items: items.map(i => ({
      id: i.id,
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
  let accounts;
  let institutionId;
  try {
    ({ accounts, institutionId } = await plaid.getAccounts(accessToken));
  } catch (err) {
    await plaid.removeItem(accessToken).catch(() => {});
    throw err;
  }
  const instName = String(institutionName || '').trim().slice(0, 200) || null;
  const defaults = [];
  const usedLabels = new Set();
  for (const a of accounts) {
    let label = defaultLabel(instName, a);
    for (let n = 2; usedLabels.has(label.toUpperCase()); n++) label = `${defaultLabel(instName, a).slice(0, 95)}-${n}`;
    usedLabels.add(label.toUpperCase());
    defaults.push({ a, label, syncFrom: await defaultSyncFrom(label) });
  }
  let created;
  try {
    created = await db.transaction(async (trx) => {
      const [item] = await trx('plaid_items').insert({
        item_id: itemId,
        institution_id: institutionId,
        institution_name: instName,
        access_token_enc: encryptedTokenRaw(trx, accessToken),
        status: 'setup',
      }).returning(['id']);
      if (defaults.length) {
        await trx('plaid_accounts').insert(defaults.map(({ a, label, syncFrom }) => ({
          plaid_item_id: item.id,
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
      return item;
    });
  } catch (err) {
    // the token is live at Plaid but not stored here — revoke it rather than
    // leave a connection nobody can see or disconnect
    await plaid.removeItem(accessToken).catch(() => {});
    throw new Error(`could not save the bank connection: ${err.code ? `database error ${err.code}` : 'database error'}`);
  }
  return created.id;
}

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
    if (typeof a.id !== 'string') throw badRequest('each account needs its id');
    if (!label || label.length > 100) throw badRequest('account label is required (max 100 chars)');
    if (!['bank', 'card'].includes(a.accountType)) throw badRequest("account type must be 'bank' or 'card'");
    if (!isDateStr(a.syncFrom)) throw badRequest('start date must be YYYY-MM-DD');
    if (a.syncFrom > today) throw badRequest('start date cannot be in the future');
    return { id: a.id, label, accountType: a.accountType, syncFrom: a.syncFrom, enabled: a.enabled === true };
  });
  const enabledLabels = cleaned.filter(a => a.enabled).map(a => a.label.toUpperCase());
  if (new Set(enabledLabels).size !== enabledLabels.length) throw badRequest('two accounts cannot share a label — each feed needs its own');

  await db.transaction(async (trx) => {
    const item = await trx('plaid_items').where({ id: itemId }).forUpdate().first();
    if (!item || item.status === 'removed') { const e = new Error('connection not found'); e.status = 404; throw e; }
    const current = await trx('plaid_accounts').where({ plaid_item_id: itemId });
    const byId = new Map(current.map(a => [a.id, a]));
    if (cleaned.some(a => !byId.has(a.id)) || cleaned.length !== current.length) {
      throw badRequest('account list does not match this connection — reload and try again');
    }
    // label uniqueness across OTHER live connections' enabled accounts
    const others = await trx('plaid_accounts as pa')
      .join('plaid_items as pi', 'pi.id', 'pa.plaid_item_id')
      .whereNot('pa.plaid_item_id', itemId)
      .whereNot('pi.status', 'removed')
      .where('pa.enabled', true)
      .select('pa.account_label');
    const otherLabels = new Set(others.map(o => String(o.account_label).trim().toUpperCase()));
    let resetCursor = false;
    for (const a of cleaned) {
      if (a.enabled && otherLabels.has(a.label.toUpperCase())) {
        throw badRequest(`"${a.label}" is already fed by another bank connection`);
      }
      if (a.enabled) {
        // Same label→type invariant (and the same advisory lock) as the CSV
        // upload: one account_type per canonical label.
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`bank-import-label:${a.label.toUpperCase()}`]);
        const existing = await trx('bank_transactions')
          .whereRaw('upper(trim(account_label)) = upper(?)', [a.label])
          .first('account_type');
        if (existing && existing.account_type !== a.accountType) {
          const asWhat = existing.account_type === 'bank' ? 'a bank account' : 'a credit card';
          throw badRequest(`"${a.label}" is already imported as ${asWhat} — keep that type, or use a different label`);
        }
      }
      const prev = byId.get(a.id);
      const prevFrom = toDateOnly(prev.sync_from);
      if (a.enabled && (!prev.enabled || a.syncFrom < prevFrom)) resetCursor = true;
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

async function disconnectItem(itemId) {
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
  }
  await db.transaction(async (trx) => {
    await trx('plaid_items').where({ id: itemId }).update({
      status: 'removed', access_token_enc: null, sync_cursor: null, updated_at: trx.fn.now(),
    });
    await trx('plaid_accounts').where({ plaid_item_id: itemId }).update({ enabled: false, updated_at: trx.fn.now() });
  });
}

// ── sync ────────────────────────────────────────────────────────────────────

async function fetchAllChanges(accessToken, startCursor) {
  for (let attempt = 0; attempt <= MAX_PAGINATION_RESTARTS; attempt++) {
    const added = [];
    const modified = [];
    const removed = [];
    let cursor = startCursor;
    let hasMore = true;
    let pages = 0;
    try {
      while (hasMore) {
        if (++pages > MAX_SYNC_PAGES) break; // resumes from the saved cursor next run
        const page = await plaid.transactionsSync(accessToken, cursor);
        added.push(...(page.added || []));
        modified.push(...(page.modified || []));
        removed.push(...(page.removed || []));
        cursor = page.next_cursor || cursor;
        hasMore = !!page.has_more;
      }
      return { added, modified, removed, nextCursor: cursor, complete: !hasMore };
    } catch (err) {
      // Plaid's documented recovery: restart the whole pagination loop from
      // the cursor the loop STARTED with
      if (err.errorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_PAGINATION_RESTARTS) continue;
      throw err;
    }
  }
  throw new Error('transactions sync kept changing during pagination');
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

  const toInsert = [];
  for (const txn of changes.added) {
    const m = mapTransaction(txn, accountsById.get(txn.account_id));
    if (m.skip) { skip(m.skip); continue; }
    toInsert.push(m.row);
  }

  for (const txn of changes.modified) {
    const m = mapTransaction(txn, accountsById.get(txn.account_id));
    if (m.skip) { skip(m.skip); continue; }
    const r = m.row;
    const existing = await trx('bank_transactions').where({ plaid_transaction_id: r.plaid_transaction_id }).first('id', 'status', 'txn_date', 'amount', 'direction', 'description');
    if (!existing) { toInsert.push(r); continue; }
    if (existing.status === 'unmatched') {
      counts.updated += await trx('bank_transactions')
        .where({ id: existing.id, status: 'unmatched' })
        .update({
          txn_date: r.txn_date, description: r.description, amount: r.amount, direction: r.direction,
          updated_at: trx.fn.now(),
        });
    } else {
      // a reviewed row is never rewritten under the operator — the change
      // parks on the row for them to judge
      await trx('bank_transactions').where({ id: existing.id }).update({
        suggestion: trx.raw("coalesce(suggestion, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
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

  const removedIds = changes.removed.map(r => r && r.transaction_id).filter(Boolean);
  for (let i = 0; i < removedIds.length; i += 500) {
    const slice = removedIds.slice(i, i + 500);
    counts.deleted += await trx('bank_transactions')
      .whereIn('plaid_transaction_id', slice)
      .where({ status: 'unmatched' })
      .del();
    counts.flagged += await trx('bank_transactions')
      .whereIn('plaid_transaction_id', slice)
      .whereNot({ status: 'unmatched' })
      .update({
        suggestion: trx.raw("coalesce(suggestion, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ plaidRemoved: true })]),
        updated_at: trx.fn.now(),
      });
  }
  return counts;
}

async function recordFailure(itemId, err) {
  const status = isLoginRequired(err) ? 'login_required' : 'error';
  await db('plaid_items').where({ id: itemId }).whereNot({ status: 'removed' }).update({
    status,
    last_error: String(err.message || 'sync failed').slice(0, 500),
    updated_at: db.fn.now(),
  }).catch((e) => logger.error(`[plaid-sync] could not record failure for item ${itemId}: ${e.message}`));
  return status;
}

async function syncItem(itemId, { runMatching = true } = {}) {
  const item = await db('plaid_items').where({ id: itemId }).first();
  if (!item) { const e = new Error('connection not found'); e.status = 404; throw e; }
  if (item.status === 'removed') return { itemId, skipped: 'removed' };
  if (item.status === 'setup') return { itemId, skipped: 'setup' };
  let result;
  try {
    const accessToken = await decryptToken(db, item.access_token_enc);
    if (!accessToken) throw new Error('stored bank token cannot be read — disconnect and connect again');
    const startCursor = item.sync_cursor || null;
    const changes = await fetchAllChanges(accessToken, startCursor);
    result = await db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`plaid-item:${itemId}`]);
      // compare-and-swap on the cursor: a concurrent run that already
      // applied this window wins; re-applying is harmless but moving the
      // cursor BACKWARDS would not be
      const fresh = await trx('plaid_items').where({ id: itemId }).forUpdate().first('sync_cursor', 'status');
      if (!fresh || fresh.status === 'removed') return { skipped: 'removed' };
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
      return { ...counts, complete: changes.complete };
    });
  } catch (err) {
    const status = await recordFailure(itemId, err);
    logger.warn(`[plaid-sync] item ${itemId} sync failed (${status}): ${err.message}`);
    return { itemId, error: err.message, status };
  }

  let matching = null;
  let matchingError = null;
  if (runMatching && result.inserted > 0) {
    try {
      matching = await require('./bank-import').runDeterministicMatching({ limit: 500 });
    } catch (err) {
      logger.warn(`[plaid-sync] item ${itemId} synced but the matching pass failed: ${err.message}`);
      matchingError = 'transactions synced, but the matching pass failed — use "Run matching" to retry';
    }
  }
  return { itemId, ...result, matching, matchingError };
}

// Cron entry: every connected item that isn't waiting on a human re-auth.
// Items are independent — one bank's failure never stops the next.
async function syncAllItems() {
  if (!plaid.isConfigured()) return { skipped: 'not_configured' };
  const items = await db('plaid_items').whereIn('status', ['active', 'error']).select('id');
  const results = [];
  for (const { id } of items) {
    try {
      results.push(await syncItem(id));
    } catch (err) {
      results.push({ itemId: id, error: err.message });
    }
  }
  return { items: results.length, results };
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
  _private: { applyChanges, fetchAllChanges, decryptToken, defaultSyncFrom, existingLabels },
};
