/**
 * Empty duplicate customer delete — the domain half of the Intelligence Bar
 * tool delete_duplicate_customer (tool definition, gate and dispatch live in
 * services/intelligence-bar/customer-lifecycle-tools.js).
 * server/services/duplicate-customer-delete.js
 *
 * Owner ruling 2026-10-07 (Q3): "soft-delete for empty stubs only (no visits,
 * invoices, payments), carded, restorable." The bar may soft-delete ONE
 * customer record that holds nothing — typically an "Unknown" stub that
 * shares a real customer's phone. A record with ANY history is refused and
 * pointed at merge_customers, which moves that history onto the real record.
 *
 * No new delete: the commit runs the customer page's own DELETE
 * /api/admin/customers/:id handler through archiveCustomerAsAdmin
 * (routes/admin-customers.js) — same billing wind-down guard, deletion gate,
 * newsletter relink and `customer.archive` audit row. Restore is that
 * route's PATCH /:id/restore.
 *
 * "Empty" is read from the merge engine's own readers (customer-dedupe.js),
 * never a hand-kept table list:
 *   - loserAutoBlockers: the auto-merge's "not a shell" list (Stripe
 *     profile, portal login, payer, billing mode, monthly rate, live stage,
 *     and the payment / invoice / visit / contract / credit tables);
 *   - previewMergeEffects: every row in every table that points at the
 *     customer (declared FKs, every *customer_id column, and the polymorphic
 *     notification / email pointers) — the same set a merge would move;
 *   - customer_plan_rates and field_credit_allocations, which that sweep
 *     deliberately skips, are counted here directly.
 * Two pointer kinds are not history and are allowed: ONE primary saved
 * property (created automatically from the customer's address) and the
 * nightly derived health score.
 *
 * Two-step (WRITE_TWO_STEP_TOOL_NAMES): an unconfirmed call is
 * mutation-free and returns the card. The preview carries the stub's
 * version (`_version`) and every check result, so the route's fingerprint
 * pin refuses Confirm when either changed. The commit then re-checks the
 * approved version and every check INSIDE the archive transaction, under
 * the customer row lock, before any write.
 */

const db = require('../models/db');
const logger = require('./logger');

// Tables a pointer may sit in without making the record "not empty".
// customer_properties is allowed only as ONE primary row (checked below).
const DERIVED_TABLES = new Set(['customer_health_scores']);

// The card's check list, in order. Each names what it covers; a table the
// sweep finds that no category names lands in `other`.
const CHECKS = [
  { key: 'visits', label: 'Visits', tables: ['scheduled_services'] },
  { key: 'service_records', label: 'Service records', tables: ['service_records'] },
  { key: 'invoices', label: 'Invoices', tables: ['invoices'] },
  {
    key: 'payments',
    label: 'Payments, saved cards, Stripe profile',
    tables: ['payments', 'payment_methods', 'estimate_deposits', 'estimate_card_holds'],
    blockers: ['stripe_customer_id'],
  },
  { key: 'estimates', label: 'Estimates', tables: ['estimates'] },
  { key: 'leads', label: 'Leads', tables: ['leads'] },
  {
    key: 'messages',
    label: 'Calls, texts, emails',
    match: (table) => /(call|sms|email|message|conversation|notification|voicemail|outbox)/.test(table),
  },
  { key: 'properties', label: 'Saved properties (one auto-created primary allowed)', tables: ['customer_properties'] },
  { key: 'plan_rates', label: 'Plan-rate ledger', tables: ['customer_plan_rates'] },
  {
    key: 'billing',
    label: 'Monthly rate, plan, billing',
    tables: ['customer_contracts', 'annual_prepay_terms', 'termite_bonds', 'customer_discounts'],
    blockers: ['monthly_rate', 'billing_mode', 'third_party_payer', 'live_stage'],
  },
  { key: 'portal_login', label: 'Portal login', tables: ['customer_refresh_tokens'], blockers: ['portal_login'] },
  {
    key: 'referral_credit',
    label: 'Referral or credit balance',
    tables: ['referral_promoters', 'customer_credit_ledger', 'field_credit_allocations'],
  },
  { key: 'other', label: 'Other linked records' },
];

const BLOCKER_LABELS = {
  stripe_customer_id: 'a Stripe customer profile',
  portal_login: 'a portal login',
  third_party_payer: 'a third-party payer',
  billing_mode: 'a billing mode',
  monthly_rate: 'a monthly rate',
  live_stage: 'a live customer stage',
};

function categoryFor(table) {
  const base = String(table).split('.')[0];
  for (const check of CHECKS) {
    if (check.tables?.includes(base)) return check.key;
    if (check.match?.(base)) return check.key;
  }
  return 'other';
}

function phone10(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const last4 = (phone) => phone10(phone).slice(-4) || String(phone || '').replace(/\D/g, '').slice(-4) || '????';

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

async function loadStub(customerId, conn = db) {
  return conn('customers').where({ id: customerId })
    .select('*', db.raw('updated_at::text AS version'), db.raw("to_char(created_at, 'YYYY-MM-DD') AS created_on"))
    .first();
}

// Live customers that share the stub's phone (last 10 digits) or email —
// read only, shown on the card so the operator sees which record stays.
async function findLiveTwins(stub) {
  const phone = phone10(stub.phone);
  const email = String(stub.email || '').trim().toLowerCase();
  if (!phone && !email) return [];
  const rows = await db('customers')
    .whereNull('deleted_at')
    .whereNot('id', stub.id)
    .where((q) => {
      if (phone) q.orWhereRaw("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone]);
      if (email) q.orWhereRaw('lower(email) = ?', [email]);
    })
    .select('id', 'first_name', 'last_name', 'phone', 'email', db.raw("to_char(created_at, 'YYYY-MM-DD') AS created_on"))
    .orderBy('created_at', 'asc')
    .limit(3);
  return rows.map((r) => {
    const shares = [phone && phone10(r.phone) === phone ? 'phone' : null,
      email && String(r.email || '').trim().toLowerCase() === email ? 'email' : null].filter(Boolean);
    return {
      customer_id: r.id,
      name: customerName(r),
      phone_last4: last4(r.phone),
      created_on: r.created_on || null,
      shares: shares.join(' and ') || 'phone or email',
    };
  });
}

async function countTable(table, customerId, conn = db) {
  try {
    const row = await conn(table).where({ customer_id: customerId }).count({ n: '*' }).first();
    return Number(row?.n || 0);
  } catch (err) {
    logger.warn(`[intelligence-bar] delete_duplicate_customer: count failed for ${table}: ${err.message}`);
    return 'unknown';
  }
}

// Every check's result for one customer. `found` maps a check key to the
// list of things found ("2 scheduled_services", "a portal login"); an empty
// list is a clean check. A count that could not be read is "could not be
// checked" — it blocks, like a found row (fail closed). `conn` is the
// archive transaction on the commit's locked re-check.
async function readEmptiness(stub, conn = db) {
  const { loserAutoBlockers, previewMergeEffects } = require('./customer-dedupe');
  const { hasMembership } = require('./membership-state');
  const found = Object.fromEntries(CHECKS.map((c) => [c.key, []]));
  const add = (key, text) => { if (!found[key].includes(text)) found[key].push(text); };
  const countText = (table, n) => (n === 'unknown' ? `${table} (could not be checked)` : `${n} ${table}`);

  const blockers = await loserAutoBlockers(conn, stub);
  for (const blocker of blockers) {
    const label = BLOCKER_LABELS[blocker];
    if (label) {
      const check = CHECKS.find((c) => c.blockers?.includes(blocker));
      add(check ? check.key : 'other', label);
    } else {
      // A blocker table ("invoices", or "invoices (check failed)").
      const table = String(blocker).replace(/ \(check failed\)$/, '');
      add(categoryFor(table), blocker.endsWith('(check failed)') ? `${table} (could not be checked)` : `${table} rows`);
    }
  }

  const { moving } = await previewMergeEffects(conn, stub.id, stub.id);
  for (const [key, n] of Object.entries(moving || {})) {
    // fk_sweep: 'unknown' (the table list itself failed) lands in `other`
    // as "could not be checked", like any unreadable count.
    if (key === 'total_rows') continue;
    if (DERIVED_TABLES.has(key)) continue;
    if (key === 'customer_properties' && n === 1) {
      const primary = await conn('customer_properties').where({ customer_id: stub.id, is_primary: true }).count({ n: '*' }).first();
      if (Number(primary?.n || 0) === 1) continue;
    }
    // A table the blocker list already named reads once, with its count.
    const category = categoryFor(key);
    found[category] = found[category].filter((t) => t !== `${key} rows`);
    add(category, countText(key, n));
  }

  // Tables the merge sweep skips on purpose (its own ledgers).
  for (const table of ['customer_plan_rates', 'field_credit_allocations']) {
    const n = await countTable(table, stub.id, conn);
    if (n !== 0) add(categoryFor(table), countText(table, n));
  }

  if (hasMembership({ waveguard_tier: stub.waveguard_tier, monthly_rate: 0 })) add('billing', `a ${stub.waveguard_tier} plan tier`);
  if (Number(stub.account_credits || 0) > 0) add('referral_credit', `$${Number(stub.account_credits).toFixed(2)} account credit`);

  return found;
}

function notEmptyRefusal(found) {
  const blocking = CHECKS.filter((c) => found[c.key].length);
  if (!blocking.length) return null;
  const named = blocking.map((c) => `${c.label}: ${found[c.key].join(', ')}`).join('; ');
  return {
    error: `This record is not empty, so the bar will not delete it. Found — ${named}. Use merge_customers to fold it into the real customer (that moves its history), or delete it from the customer page after review.`,
    code: 'not_empty',
    found: Object.fromEntries(blocking.map((c) => [c.key, found[c.key]])),
  };
}

const RESTORE_LINE = 'Restorable: the admin restore route (PATCH /api/admin/customers/:id/restore) brings it back. The customer page has no Restore button yet.';
const NO_MESSAGE_LINE = 'No customer message is sent';

async function previewDeleteDuplicateCustomer(customerId) {
  const stub = await loadStub(customerId);
  if (!stub) return { error: 'customer_id does not match a customer', code: 'record_unavailable' };
  if (stub.deleted_at) return { error: 'This customer is already deleted — nothing to do.', code: 'record_unavailable' };

  const refusal = notEmptyRefusal(await readEmptiness(stub));
  if (refusal) return refusal;

  const twins = await findLiveTwins(stub);
  const checks = Object.fromEntries(CHECKS.map((c) => [c.label, 'none']));
  const stubLine = `${customerName(stub)} (…${last4(stub.phone)}), created ${stub.created_on || 'unknown date'}`;
  const twinLine = twins.length
    ? twins.map((t) => `${t.name} (…${t.phone_last4}), created ${t.created_on || 'unknown date'} — shares ${t.shares}; stays as is`).join(' | ')
    : 'No other live customer shares this phone or email';
  return {
    preview: true,
    customer_id: stub.id,
    stub: { name: customerName(stub), phone_last4: last4(stub.phone), created_on: stub.created_on || null },
    duplicate_of: twins,
    checks,
    restore: RESTORE_LINE,
    customer_message: NO_MESSAGE_LINE,
    _version: stub.version,
    // Curated card lines (routes/admin-intelligence-bar.js PINNED_DISPLAY_BUILDERS).
    card: {
      delete: stubLine,
      duplicate_of: twinLine,
      checks,
      restore: RESTORE_LINE,
      customer_message: NO_MESSAGE_LINE,
    },
    note_to_operator: `${customerName(stub)} holds nothing (every check above is none). Confirm soft-deletes it through the customer page's own delete. Nothing was changed yet.`,
  };
}

// The decisive check runs INSIDE the archive transaction, after the
// customer row lock and before any write (archiveCustomerAsAdmin's
// precheck): the record must still be live, still at the approved version
// (the card's `_version`, pinned by the route), and still empty. A throw
// rolls the archive back. Writers that add history rows do not take the
// customer row lock, so a row that commits after this read attaches to a
// soft-deleted, restorable record — the same as against the page's delete.
async function commitDeleteDuplicateCustomer(customerId, actionContext, approvedVersion = null) {
  const changed = (error, code) => Object.assign(new Error(error), { previewChanged: true, code });
  const precheck = async (trx) => {
    const row = await loadStub(customerId, trx);
    if (!row || row.deleted_at) throw changed('This customer is already deleted or no longer exists.', 'record_unavailable');
    if (approvedVersion && String(row.version) !== String(approvedVersion)) {
      throw changed('This customer record changed after the card was shown. Ask again for a fresh card.', 'version_changed');
    }
    const refusal = notEmptyRefusal(await readEmptiness(row, trx));
    if (refusal) throw changed(refusal.error, refusal.code);
  };
  const { archiveCustomerAsAdmin } = require('../routes/admin-customers');
  let reply;
  try {
    reply = await archiveCustomerAsAdmin({
      customerId,
      actor: { technicianId: actionContext.technicianId || null, userAgent: 'intelligence-bar:delete_duplicate_customer' },
      precheck,
    });
  } catch (err) {
    if (err && err.previewChanged) return { error: err.message, code: err.code, preview_changed: true };
    throw err;
  }
  const { status, json } = reply;
  if (status === 200 && json?.success) {
    logger.info(`[intelligence-bar] delete_duplicate_customer soft-deleted customer ${customerId}`);
    return { success: true, customer_id: customerId, deleted: true, restore: RESTORE_LINE, customer_message: NO_MESSAGE_LINE };
  }
  const message = json?.message || json?.error || `Delete failed (HTTP ${status})`;
  return { error: message, ...(status === 404 ? { preview_changed: true } : {}) };
}

module.exports = {
  previewDeleteDuplicateCustomer,
  commitDeleteDuplicateCustomer,
  RESTORE_LINE,
  NO_MESSAGE_LINE,
  _test: { CHECKS, categoryFor, readEmptiness, findLiveTwins },
};
