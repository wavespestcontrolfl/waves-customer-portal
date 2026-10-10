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
 *   - every table that sweep deliberately skips (REPOINT_EXCLUDED_TABLES:
 *     plan rates, credit allocations, location reviews, merge journal,
 *     dismissals) is counted here directly from the engine's own list.
 * Two pointer kinds are not history and are allowed: ONE primary saved
 * property (created automatically from the customer's address) and the
 * nightly derived health score.
 *
 * Two-step (WRITE_TWO_STEP_TOOL_NAMES): an unconfirmed call is
 * mutation-free and returns the card. The preview carries the stub's
 * version (`_version`) and every check result, so the route's fingerprint
 * pin refuses Confirm when either changed. The commit then re-checks the
 * approved version and every check INSIDE the archive transaction, under
 * the customer row lock, before any write, and once more after the commit
 * (commit-then-verify: a record that gained history is restored at once).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

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
  { key: 'properties', label: 'Saved properties (one untouched auto-created primary allowed)', tables: ['customer_properties'] },
  { key: 'customer_text', label: 'Notes and service contacts' },
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

// Key columns of the merge-excluded tables that are not keyed on
// customer_id (a merge or a "not duplicates" decision involving the record).
const EXCLUDED_TABLE_KEYS = {
  customer_merge_journal: ['winner_customer_id', 'loser_customer_id'],
  customer_duplicate_dismissals: ['customer_id_a', 'customer_id_b'],
};

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

// The columns the automatic primary-property backfill writes
// (customer-properties.js ensurePrimaryCore) plus row bookkeeping. Any other
// column holding a value is operator data, and makes the property history.
const AUTO_PRIMARY_COLUMNS = new Set([
  'id', 'customer_id', 'label', 'occupancy_type', 'relationship', 'is_primary',
  'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude',
  'property_type', 'lawn_type', 'property_sqft', 'lot_sqft', 'bed_sqft', 'linear_ft_perimeter',
  'palm_count', 'canopy_type', 'address_key', 'source', 'active', 'created_at', 'updated_at',
]);
// The automatic neighborhood lookup (neighborhood-access.js) stamps these
// with source 'county'; any other source is an office entry.
const AUTO_NEIGHBORHOOD_COLUMNS = ['neighborhood_id', 'neighborhood_source', 'county_subdivision', 'neighborhood_checked_at'];

const isBlank = (v) => v === null || v === undefined || v === false || String(v).trim() === ''
  || (typeof v === 'object' && !(v instanceof Date) && Object.keys(v).length === 0);

// The exact row ensurePrimaryCore (customer-properties.js) writes from this
// customer when it backfills the primary: same defaults, same copies.
function backfilledPrimaryValues(customer) {
  const props = require('./customer-properties');
  const mirror = ['address_line1', 'city', 'zip', 'latitude', 'longitude', 'property_type', 'lawn_type',
    'property_sqft', 'lot_sqft', 'bed_sqft', 'linear_ft_perimeter', 'palm_count', 'canopy_type'];
  return {
    ...Object.fromEntries(mirror.map((column) => [column, customer[column] ?? null])),
    label: customer.profile_label || 'Primary',
    occupancy_type: props.defaultOccupancyForContactRole(customer.contact_role),
    relationship: props.defaultRelationshipForContactRole(customer.contact_role),
    address_line2: customer.address_line2 || null,
    state: customer.state || 'FL',
    address_key: props.addressKey({ address_line1: customer.address_line1, address_line2: customer.address_line2, city: customer.city, zip: customer.zip }),
  };
}

const sameValue = (a, b) => {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  const na = Number(a);
  const nb = Number(b);
  return (Number.isFinite(na) && Number.isFinite(nb)) ? na === nb : String(a).trim() === String(b).trim();
};

// What makes a saved property more than the untouched automatic primary:
// another source (manual, call_pipeline, self_book), not primary, inactive,
// any backfilled column whose value differs from what the backfill writes
// from this customer (an edited occupancy, relationship, label, address or
// measurement — editManualProperty keeps source 'backfill'), an office
// neighborhood entry, or any other column with a value.
function primaryPropertyEdits(property, customer) {
  const edits = [];
  if (property.source !== 'backfill') edits.push(`source ${property.source || 'unknown'}`);
  if (property.is_primary !== true) edits.push('not the primary');
  if (property.active === false) edits.push('inactive');
  for (const [column, value] of Object.entries(backfilledPrimaryValues(customer))) {
    if (!sameValue(property[column], value)) edits.push(`edited ${column}`);
  }
  if (property.neighborhood_source && property.neighborhood_source !== 'county') edits.push('an office neighborhood entry');
  for (const [column, value] of Object.entries(property)) {
    if (AUTO_PRIMARY_COLUMNS.has(column) || AUTO_NEIGHBORHOOD_COLUMNS.includes(column)) continue;
    if (!isBlank(value)) edits.push(column);
  }
  return edits;
}

// Customer-owned text the merge carries onto the survivor: the notes it
// appends (customer-dedupe predictNoteAppends — its own column list) and the
// service-contact slots. Deleting would strand it on the archived row.
function customerOwnedText(stub, predictNoteAppends) {
  const notes = Object.keys(predictNoteAppends({}, stub));
  const contacts = Object.entries(stub)
    .filter(([column, value]) => /^service_contact\d?_(name|phone|email)$/.test(column) && !isBlank(value))
    .map(([column]) => column);
  return [...notes, ...contacts];
}

function maskEmail(address) {
  const text = String(address || '').trim();
  if (!text) return null;
  const [local, domain] = text.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `(***) ***-${digits.slice(-4)}` : null;
}

function identityLine(row) {
  const parts = [maskPhone(row.phone) && `phone ${maskPhone(row.phone)}`, maskEmail(row.email) && `email ${maskEmail(row.email)}`].filter(Boolean);
  return `${customerName(row)} (${parts.join(', ') || 'no phone or email'}), created ${row.created_on || 'unknown date'}`;
}

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

// The date a record was created, as the office sees it: the repo's Eastern
// calendar date (utils/datetime-et etDateString). The database session runs
// in UTC, so formatting the timestamp in SQL puts an evening record on the next
// day.
const createdOnET = (row) => (row.created_at ? etDateString(new Date(row.created_at)) : null);

async function loadStub(customerId, conn = db) {
  const row = await conn('customers').where({ id: customerId })
    .select('*', db.raw('updated_at::text AS version'))
    .first();
  return row ? { ...row, created_on: createdOnET(row) } : row;
}

// Above this many records sharing the contact the bar does not decide.
const TWIN_LIMIT = 25;

// Live customers that share the stub's phone (last 10 digits) or email —
// whole rows, because the engine's keep/discard decision reads them.
async function findLiveTwins(stub, conn = db) {
  const phone = phone10(stub.phone);
  const email = String(stub.email || '').trim().toLowerCase();
  if (!phone && !email) return [];
  const rows = await conn('customers')
    .whereNull('deleted_at')
    .whereNot('id', stub.id)
    .where((q) => {
      if (phone) q.orWhereRaw("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone]);
      if (email) q.orWhereRaw('lower(email) = ?', [email]);
    })
    .select('*')
    .orderBy('created_at', 'asc')
    .limit(TWIN_LIMIT);
  return rows.filter((r) => String(r.id) !== String(stub.id)).map((r) => ({ ...r, created_on: createdOnET(r) }));
}

function twinView(stub, r) {
  const phone = phone10(stub.phone);
  const email = String(stub.email || '').trim().toLowerCase();
  const shares = [phone && phone10(r.phone) === phone ? 'phone' : null,
    email && String(r.email || '').trim().toLowerCase() === email ? 'email' : null].filter(Boolean);
  return {
    customer_id: r.id,
    name: customerName(r),
    phone_masked: maskPhone(r.phone),
    email_masked: maskEmail(r.email),
    created_on: r.created_on || null,
    shares: shares.join(' and ') || 'phone or email',
  };
}

// The selected record must be a duplicate the existing merge machinery would
// accept, not merely one that loses a keep/discard comparison. Reused as is
// (customer-dedupe.js):
//   - duplicatePairEligibility(twin, stub): the duplicate queue's own verdict
//     on the pair — phone identity clusters, name and address conflicts
//     (red tier, address conflict), live/active state, operator "not a
//     duplicate" dismissals. Same call executeMerge makes under its lock.
//   - rowLevelMergeConflict + dbLevelMergeConflict: every other refusal the
//     merge executor raises (billing, payer, a loser in a multi-property
//     account with other live members, ...).
// The queue is phone-keyed and there is no email-keyed pair check, so a
// record whose only link is a shared email is refused. Account ownership has
// one case the merge handles by promoting the winner (a primary profile with
// siblings in its account); a delete has no winner to promote, so it refuses.
// Refusals never name a person (the route runs the preview before validating
// the target).
async function accountPrimaryRefusal(stub, conn) {
  if (!stub.account_id || stub.is_primary_profile !== true) return null;
  const sibling = await conn('customers')
    .where({ account_id: stub.account_id })
    .whereNull('deleted_at')
    .whereNot('id', stub.id)
    .first('id');
  if (!sibling) return null;
  return {
    error: 'This record is the primary profile of a multi-property account that has other live members — deleting it would strand them. Reconcile the account first, or use merge_customers.',
    code: 'account_primary_has_members',
  };
}

async function duplicateRoleRefusal(stub, twins, conn) {
  if (!twins.length) {
    return { error: 'No live duplicate found — this tool only removes a duplicate of a real customer (no other live record shares its phone or email).', code: 'no_duplicate' };
  }
  if (twins.length >= TWIN_LIMIT) {
    return { error: `At least ${TWIN_LIMIT} live records share this phone or email — resolve these from the duplicates queue instead.`, code: 'too_many_duplicates' };
  }
  const phone = phone10(stub.phone);
  const phoneTwins = phone ? twins.filter((r) => phone10(r.phone) === phone) : [];
  if (!phoneTwins.length) {
    return {
      error: 'The only live record linked to this one shares an email, not a phone. The duplicate queue is phone-based and the bar has no email duplicate check, so it will not delete this record. Use merge_customers or the customer page.',
      code: 'email_only_duplicate',
    };
  }
  const { duplicatePairEligibility, rowLevelMergeConflict, dbLevelMergeConflict } = require('./customer-dedupe');
  let firstVerdict = null;
  let retained = null;
  for (const twin of phoneTwins) {
    const verdict = await duplicatePairEligibility(twin.id, stub.id, conn);
    if (verdict.eligible) { retained = twin; break; }
    firstVerdict = firstVerdict || verdict;
  }
  if (!retained) {
    return {
      error: `The duplicate queue does not list this record as a mergeable duplicate of the record sharing its phone (${firstVerdict?.code || 'not_in_queue'}: ${firstVerdict?.reason || 'pair is not a queue candidate'}). Select the other record, or use merge_customers.`,
      code: 'not_a_mergeable_duplicate',
      pair_code: firstVerdict?.code || 'not_in_queue',
    };
  }
  const conflict = rowLevelMergeConflict(retained, stub) || await dbLevelMergeConflict(conn, retained, stub);
  if (conflict) {
    return { error: `The merge path would refuse this duplicate (${conflict.code}: ${conflict.message}). Use merge_customers after resolving it.`, code: 'merge_conflict', merge_code: conflict.code };
  }
  const accountRefusal = await accountPrimaryRefusal(stub, conn);
  if (accountRefusal) return accountRefusal;
  return { retained };
}

async function countTable(table, customerId, conn = db, columns = ['customer_id']) {
  try {
    const row = await conn(table).where((q) => { for (const column of columns) q.orWhere(column, customerId); }).count({ n: '*' }).first();
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
  const { loserAutoBlockers, previewMergeEffects, REPOINT_EXCLUDED_TABLES, predictNoteAppends } = require('./customer-dedupe');
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
      const [property] = await conn('customer_properties').where({ customer_id: stub.id }).select('*');
      const edits = property ? primaryPropertyEdits(property, stub) : ['could not be read'];
      if (!edits.length) continue;
      add('properties', `1 customer_properties (${edits.join(', ')})`);
      continue;
    }
    // A table the blocker list already named reads once, with its count.
    const category = categoryFor(key);
    found[category] = found[category].filter((t) => t !== `${key} rows`);
    add(category, countText(key, n));
  }

  // Every table the merge sweep skips on purpose (REPOINT_EXCLUDED_TABLES:
  // plan rates, credit allocations, location reviews, merge journal and
  // dismissals), read from the engine's own list so a new exclusion is
  // counted too. An unknown key column reads "could not be checked".
  for (const table of REPOINT_EXCLUDED_TABLES) {
    const n = await countTable(table, stub.id, conn, EXCLUDED_TABLE_KEYS[table]);
    if (n !== 0) add(categoryFor(table), countText(table, n));
  }

  for (const column of customerOwnedText(stub, predictNoteAppends)) add('customer_text', column);

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

const RESTORE_LINE = 'Restorable: an admin can bring it back (PATCH /api/admin/customers/:id/restore); the customer page has no Restore button yet. If history lands on the record while it is being deleted, the bar restores it at once and says so.';
const NO_MESSAGE_LINE = 'No customer message is sent';

async function previewDeleteDuplicateCustomer(customerId) {
  const stub = await loadStub(customerId);
  if (!stub) return { error: 'customer_id does not match a customer', code: 'record_unavailable' };
  if (stub.deleted_at) return { error: 'This customer is already deleted — nothing to do.', code: 'record_unavailable' };

  const refusal = notEmptyRefusal(await readEmptiness(stub));
  if (refusal) return refusal;
  const twinRows = await findLiveTwins(stub);
  const role = await duplicateRoleRefusal(stub, twinRows, db);
  if (role.error) return role;

  const twins = twinRows.map((r) => ({ ...twinView(stub, r), retained: String(r.id) === String(role.retained.id) }));
  const checks = Object.fromEntries(CHECKS.map((c) => [c.label, 'none']));
  const stubLine = identityLine(stub);
  const twinLine = twinRows.map((r, i) => `${identityLine(r)} — shares ${twins[i].shares}${twins[i].retained ? '; the duplicate queue keeps this one' : ''}; stays as is`).join(' | ');
  return {
    preview: true,
    customer_id: stub.id,
    stub: { name: customerName(stub), phone_masked: maskPhone(stub.phone), email_masked: maskEmail(stub.email), created_on: stub.created_on || null },
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
// (the card's `_version`, pinned by the route), still empty, and still a
// duplicate the merge machinery accepts.
//
// What the row lock does and does not fence. The archive takes FOR UPDATE on
// the customer row, which conflicts with the FOR KEY SHARE every foreign-key
// child insert takes on its parent: a visit or invoice insert in flight
// finishes before the lock is granted, and a new one waits for the commit. A
// pointer with no foreign key (a call, text or lead matched by phone or
// email, a polymorphic notification pointer) takes no such lock, and no
// shared advisory lock exists that every history writer takes (the merge
// executor says the same, lockSameNameGroupRows). So after the archive
// commits the same emptiness check runs again on the committed state; if
// anything attached in the window, the record is restored at once through
// the customer page's own restore handler and the operator is told.
async function commitDeleteDuplicateCustomer(customerId, actionContext, approvedVersion = null) {
  const changed = (error, code) => Object.assign(new Error(error), { previewChanged: true, code });
  const precheck = async (trx) => {
    const row = await loadStub(customerId, trx);
    if (!row || row.deleted_at) throw changed('This customer is already deleted or no longer exists.', 'record_unavailable');
    if (approvedVersion && String(row.version) !== String(approvedVersion)) {
      throw changed('This customer record changed after the card was shown. Ask again for a fresh card.', 'version_changed');
    }
    const refusal = notEmptyRefusal(await readEmptiness(row, trx))
      || await duplicateRoleRefusal(row, await findLiveTwins(row, trx), trx);
    if (refusal && refusal.error) throw changed(refusal.error, refusal.code);
  };
  const { archiveCustomerAsAdmin, restoreCustomerAsAdmin } = require('../routes/admin-customers');
  const actor = { technicianId: actionContext.technicianId || null, userAgent: 'intelligence-bar:delete_duplicate_customer' };
  let reply;
  try {
    reply = await archiveCustomerAsAdmin({ customerId, actor, precheck });
  } catch (err) {
    if (err && err.previewChanged) return { error: err.message, code: err.code, preview_changed: true };
    throw err;
  }
  const { status, json } = reply;
  if (status === 200 && json?.success) {
    const late = await historyAppearedAfterCommit(customerId);
    if (late) return restoreAfterLateHistory(customerId, late, restoreCustomerAsAdmin, actor);
    logger.info(`[intelligence-bar] delete_duplicate_customer soft-deleted customer ${customerId}`);
    return { success: true, customer_id: customerId, deleted: true, restore: RESTORE_LINE, customer_message: NO_MESSAGE_LINE };
  }
  const message = json?.message || json?.error || `Delete failed (HTTP ${status})`;
  return { error: message, ...(status === 404 ? { preview_changed: true } : {}) };
}

// Commit-then-verify: the emptiness check again, on committed state, outside
// the archive transaction. An unreadable result counts as history (fail
// closed) — a restore is cheap and safe, a delete over unknown history is not.
async function historyAppearedAfterCommit(customerId) {
  try {
    const row = await loadStub(customerId);
    if (!row) return { found: { other: ['the record could not be re-read'] } };
    return notEmptyRefusal(await readEmptiness(row));
  } catch (err) {
    logger.error(`[intelligence-bar] delete_duplicate_customer post-commit check failed for ${customerId}: ${err.message}`);
    return { found: { other: ['the post-delete check could not run'] } };
  }
}

async function restoreAfterLateHistory(customerId, late, restoreCustomerAsAdmin, actor) {
  const named = Object.entries(late.found || {}).map(([key, list]) => `${key}: ${list.join(', ')}`).join('; ');
  let restored = false;
  try {
    const { status, json } = await restoreCustomerAsAdmin({ customerId, actor });
    restored = status === 200 && json?.success === true;
  } catch (err) {
    logger.error(`[intelligence-bar] delete_duplicate_customer restore after late history failed for ${customerId}: ${err.message}`);
  }
  if (!restored) {
    logger.error(`[intelligence-bar] delete_duplicate_customer: history appeared on ${customerId} after the delete and the restore did not complete`);
    return {
      error: `History appeared on this record while it was being deleted (${named}) and the automatic restore did not complete. Restore it now with PATCH /api/admin/customers/${customerId}/restore, then use merge_customers.`,
      code: 'history_appeared_restore_failed',
      deleted: true,
    };
  }
  logger.warn(`[intelligence-bar] delete_duplicate_customer: history appeared on ${customerId} after the delete; restored (${named})`);
  return {
    error: `Not deleted: history appeared on this record while it was being deleted (${named}), so it was restored. Use merge_customers to fold it into the real customer.`,
    code: 'history_appeared_restored',
    deleted: false,
    restored: true,
  };
}

module.exports = {
  previewDeleteDuplicateCustomer,
  commitDeleteDuplicateCustomer,
  RESTORE_LINE,
  NO_MESSAGE_LINE,
  _test: { CHECKS, categoryFor, readEmptiness, findLiveTwins, primaryPropertyEdits, maskEmail, maskPhone },
};
