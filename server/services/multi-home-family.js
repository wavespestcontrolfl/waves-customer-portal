const { randomUUID } = require('node:crypto');
const logger = require('./logger');
const { recordAuditEvent } = require('./audit-log');

/**
 * "Same family" link between customer profiles (owner 2026-11-04).
 *
 * Staff link two or more profiles so the 10% Multi-Home Discount counts them
 * as one multi-home family. The link lives in multi_home_family_members and
 * NEVER touches customers.has_multi_home, which other readers use to mean
 * "this one profile has 2+ premises". Linking sends nothing and changes no
 * price; only the discount eligibility readers ask familyMultiHomeEligible.
 */

const TABLE = 'multi_home_family_members';
const AUDIT_LINK = 'multi_home_family_link';
const AUDIT_UNLINK = 'multi_home_family_unlink';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Decision 3 (owner 2026-11-27): only live customer stages qualify for Same
// family links and Multi-Home eligibility; leads/lost/churned and internal
// test accounts are excluded, and two profiles at the same address cannot link.
const LIVE_FAMILY_STAGES = Object.freeze(['active_customer', 'won', 'at_risk']);

function familyError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, isOperational: true, code: 'multi_home_family' });
}

function hasUsableServiceStreet(row) {
  const { addressMatchKey } = require('./customer-address-fanout');
  return Boolean(addressMatchKey(row?.address_line1));
}

function isEligibleFamilyCustomer(row) {
  if (!row || row.deleted_at || row.active !== true) return false;
  if (!LIVE_FAMILY_STAGES.includes(String(row.pipeline_stage || ''))) return false;
  if (!hasUsableServiceStreet(row)) return false;
  const { isInternalTestContact } = require('./internal-test-customers');
  return !isInternalTestContact({
    customerId: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
  });
}

function sameHomeAddress(a, b) {
  const { addressMatchKey, homesDiffer } = require('./customer-address-fanout');
  const keyA = addressMatchKey(a?.address_line1);
  const keyB = addressMatchKey(b?.address_line1);
  if (!keyA || !keyB) return false;
  return !homesDiffer(a, b);
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Postgres returns uuids in lower case; compare and store them the same way.
function normalizeId(value) {
  return String(value).toLowerCase();
}

function displayName(row) {
  const name = [row.first_name, row.last_name].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return name || row.company_name || 'Unnamed customer';
}

function displayAddress(row) {
  const street = [row.address_line1, row.address_line2].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
  const place = [row.city, [row.state, row.zip].filter(Boolean).join(' ')].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
  return [street, place].filter(Boolean).join(', ');
}

/**
 * The family a customer is in, with every live member profile.
 * Soft-deleted profiles are left out. Not linked: { familyId: null, members: [] }.
 */
async function familyMembers(conn, rawCustomerId) {
  const customerId = normalizeId(rawCustomerId);
  const own = await conn(TABLE).where({ customer_id: customerId }).first('family_id');
  if (!own) return { familyId: null, members: [] };
  const rows = await conn(TABLE)
    .join('customers', 'customers.id', `${TABLE}.customer_id`)
    .where(`${TABLE}.family_id`, own.family_id)
    .whereNull('customers.deleted_at')
    .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.company_name',
      'customers.email', 'customers.phone',
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
      'customers.active', 'customers.pipeline_stage', 'customers.deleted_at')
    .orderBy([{ column: 'customers.last_name' }, { column: 'customers.first_name' }, { column: 'customers.id' }]);
  return {
    familyId: own.family_id,
    members: rows.map((row) => ({
      id: row.id,
      name: displayName(row),
      address: displayAddress(row),
      active: row.active === true,
      pipelineStage: row.pipeline_stage || null,
      qualifies: isEligibleFamilyCustomer(row),
      isSelf: row.id === customerId,
    })),
  };
}

function countDistinctHomes(rows) {
  const unique = [];
  for (const row of rows) {
    if (!unique.some((existing) => sameHomeAddress(existing, row))) unique.push(row);
  }
  return unique.length;
}

/**
 * True only when the customer is in a family with 2+ live qualifying customer
 * profiles at distinct addresses (active, not soft-deleted, live customer stage,
 * not an internal test account). Fails closed: any error answers false.
 */
async function liveFamilySize(conn, customerId) {
  const mine = normalizeId(customerId);
  const own = await conn(TABLE).where({ customer_id: mine }).first('family_id');
  if (!own) return 0;
  const rows = await conn(TABLE)
    .join('customers', 'customers.id', `${TABLE}.customer_id`)
    .where(`${TABLE}.family_id`, own.family_id)
    .where('customers.active', true)
    .whereIn('customers.pipeline_stage', LIVE_FAMILY_STAGES)
    .whereNull('customers.deleted_at')
    .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.email', 'customers.phone',
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
      'customers.active', 'customers.pipeline_stage', 'customers.deleted_at');
  const qualifying = (rows || []).filter(isEligibleFamilyCustomer);
  if (!qualifying.some((r) => normalizeId(r.id) === mine)) return 0;
  return countDistinctHomes(qualifying);
}

async function familyMultiHomeEligible(conn, customerId) {
  if (!customerId) return false;
  const id = normalizeId(customerId);
  try {
    // Inside a caller's transaction (a locked recheck), read under a
    // savepoint: a failed lookup then rolls back only the savepoint and the
    // caller's transaction stays usable for its own refusal.
    const size = conn && conn.isTransaction
      ? await conn.transaction((sp) => liveFamilySize(sp, id))
      : await liveFamilySize(conn, id);
    return size >= 2;
  } catch (err) {
    if (err && err.code === '42P01') return false;
    logger.warn(`[multi-home-family] eligibility lookup failed, treating as not linked: ${err.message}`);
    return false;
  }
}

async function loadLinkable(trx, customerId, label) {
  const row = await trx('customers').where({ id: customerId }).first(
    'id', 'first_name', 'last_name', 'email', 'phone',
    'address_line1', 'address_line2', 'city', 'state', 'zip',
    'active', 'deleted_at', 'pipeline_stage',
  );
  if (!row || row.deleted_at) throw familyError(`The ${label} profile was not found.`, 409);
  if (row.active !== true) throw familyError(`The ${label} profile is not active. Only active profiles can be linked.`, 409);
  if (!LIVE_FAMILY_STAGES.includes(String(row.pipeline_stage || ''))) {
    throw familyError(`The ${label} profile is not an active customer. Only active customers can be linked as Same family.`, 409);
  }
  if (!hasUsableServiceStreet(row)) {
    throw familyError(`The ${label} profile has no street address yet. Add a service address before linking as Same family.`, 409);
  }
  const { isInternalTestContact } = require('./internal-test-customers');
  if (isInternalTestContact({
    customerId: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
  })) {
    throw familyError(`The ${label} profile is an internal test account and cannot be linked.`, 409);
  }
  return row;
}

// Every link and unlink takes this one transaction-scoped lock first, so family
// changes run one at a time. In READ COMMITTED a FOR UPDATE read that waited
// does not see rows another transaction inserted meanwhile; after this lock,
// every later statement sees each committed change (an unlink can never miss a
// profile a concurrent link just added and strand it in a one-profile family).
// Staff make these changes rarely, so one lock for all families is cheap.
const FAMILY_CHANGES_LOCK_KEY = `${TABLE}:changes`;
async function lockFamilyChanges(trx) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [FAMILY_CHANGES_LOCK_KEY]);
}

// The same lock in SHARED mode, for a writer that must see the family unchanged until its own transaction ends (the
// Multi-Home Discount job re-checks "source and target are still one family" under it). Applies run together; a link
// or unlink (exclusive) waits for them, and they wait for it. Take it FIRST in the transaction, before any row lock,
// so the lock order stays the one link/unlink use (advisory lock, then customer rows).
async function lockFamilyChangesShared(trx) {
  await trx.raw('SELECT pg_advisory_xact_lock_shared(hashtext(?))', [FAMILY_CHANGES_LOCK_KEY]);
}

async function lockCustomers(trx, ids) {
  await trx('customers').whereIn('id', [...ids].sort()).orderBy('id').forUpdate().select('id');
}

async function insertMembers(trx, familyId, customerIds, actorId) {
  for (const customerId of customerIds) {
    await trx(TABLE).insert({ customer_id: customerId, family_id: familyId, linked_by: actorId || null });
    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: actorId || null,
      action: AUDIT_LINK,
      resource_type: 'customer',
      resource_id: customerId,
      metadata: { familyId },
      trx,
      critical: true,
    });
  }
}

function planLink(mineRow, otherRow, customerId, otherCustomerId) {
  if (mineRow && otherRow) {
    if (mineRow.family_id === otherRow.family_id) return { familyId: mineRow.family_id, add: [] };
    throw familyError('Both profiles are already in different families. Unlink one first.', 409);
  }
  if (mineRow) return { familyId: mineRow.family_id, add: [otherCustomerId] };
  if (otherRow) return { familyId: otherRow.family_id, add: [customerId] };
  return { familyId: randomUUID(), add: [customerId, otherCustomerId] };
}

async function pruneSingleMemberOrphan(trx, row) {
  if (!row) return null;
  const members = await trx(TABLE).where({ family_id: row.family_id }).forUpdate().select('id');
  if (members.length === 1) {
    await trx(TABLE).where({ id: members[0].id }).del();
    return null;
  }
  return row;
}

async function loadFamilyAddresses(trx, familyIds) {
  const ids = [...new Set((familyIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return trx(TABLE)
    .join('customers', 'customers.id', `${TABLE}.customer_id`)
    .whereIn(`${TABLE}.family_id`, ids)
    .whereNull('customers.deleted_at')
    .select('customers.id', 'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip');
}

async function linkInTransaction(trx, { customerId, otherCustomerId, actorId }) {
  await lockFamilyChanges(trx);
  await lockCustomers(trx, [customerId, otherCustomerId]);
  const mineProfile = await loadLinkable(trx, customerId, 'first');
  const otherProfile = await loadLinkable(trx, otherCustomerId, 'other');
  if (sameHomeAddress(mineProfile, otherProfile)) {
    throw familyError('Both profiles share the same service address. Link distinct homes as Same family, or merge duplicate profiles instead.', 409);
  }
  const rows = await trx(TABLE).whereIn('customer_id', [customerId, otherCustomerId]).forUpdate().select('id', 'customer_id', 'family_id');
  const mineRow = await pruneSingleMemberOrphan(trx, rows.find((row) => row.customer_id === customerId));
  const otherRow = await pruneSingleMemberOrphan(trx, rows.find((row) => row.customer_id === otherCustomerId));
  const plan = planLink(mineRow, otherRow, customerId, otherCustomerId);
  if (plan.add && plan.add.length) {
    const familyIds = [mineRow?.family_id, otherRow?.family_id].filter(Boolean);
    if (familyIds.length) {
      const members = await loadFamilyAddresses(trx, familyIds);
      const joiner = plan.add.includes(otherCustomerId) ? otherProfile : mineProfile;
      if ((members || []).some((m) => normalizeId(m.id) !== normalizeId(joiner.id) && sameHomeAddress(joiner, m))) {
        throw familyError('A profile at this service address is already in that family. Link distinct homes as Same family, or merge duplicate profiles instead.', 409);
      }
    }
    await insertMembers(trx, plan.familyId, plan.add, actorId);
  }
}

/**
 * Link two profiles as the same family. Idempotent when they already share a
 * family. Two different families are refused (409): unlink one first.
 */
async function linkFamily(conn, { customerId, otherCustomerId, actorId = null } = {}) {
  if (!isUuid(customerId) || !isUuid(otherCustomerId)) throw familyError('Both profile ids must be valid.', 400);
  const mine = normalizeId(customerId);
  const other = normalizeId(otherCustomerId);
  if (mine === other) throw familyError('A profile cannot be linked to itself.', 400);
  try {
    await conn.transaction((trx) => linkInTransaction(trx, { customerId: mine, otherCustomerId: other, actorId }));
  } catch (err) {
    if (err && err.code === '23505') throw familyError('One of these profiles was linked by someone else just now. Reload and try again.', 409);
    throw err;
  }
  return familyMembers(conn, mine);
}

// Runs inside a transaction that ALREADY holds lockFamilyChanges(trx) and the
// customer row lock. Removes customerId from its family and dissolves a
// one-member orphan, returning surviving formerMemberIds for post-commit review
// alerts (Decision 2).
async function unlinkMemberInExistingTx(trx, customerId, actorId = null, { reason = null } = {}) {
  const mine = normalizeId(customerId);
  const own = await trx(TABLE).where({ customer_id: mine }).forUpdate().first('id', 'family_id');
  if (!own) return { removed: false, familyId: null, formerMemberIds: [] };
  const familyId = own.family_id;
  await trx(TABLE).where({ id: own.id }).del();
  await recordAuditEvent({
    actor_type: 'admin', actor_id: actorId || null, action: AUDIT_UNLINK, resource_type: 'customer',
    resource_id: mine, metadata: { familyId, ...(reason ? { reason } : {}) }, trx, critical: true,
  });
  // A one-profile family means nothing: drop the last member too.
  const left = await trx(TABLE).where({ family_id: familyId }).forUpdate().select('id', 'customer_id');
  const formerMemberIds = (left || []).map((r) => normalizeId(r.customer_id));
  if (left.length === 1) {
    await trx(TABLE).where({ id: left[0].id }).del();
    await recordAuditEvent({
      actor_type: 'admin', actor_id: actorId || null, action: AUDIT_UNLINK, resource_type: 'customer',
      resource_id: left[0].customer_id, metadata: { familyId, reason: 'last_member' }, trx, critical: true,
    });
  }
  return { removed: true, familyId, formerMemberIds };
}

async function unlinkInTransaction(trx, { customerId, actorId }) {
  await lockFamilyChanges(trx);
  await lockCustomers(trx, [customerId]);
  return unlinkMemberInExistingTx(trx, customerId, actorId);
}

const DROP_REASON_LABELS = {
  unlinked: 'family unlinked',
  archived: 'linked profile archived',
  cancelled: 'linked profile cancelled',
};

async function countUpcomingMultiHomeDiscountedVisits(conn, customerId) {
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const preset = await conn('discounts').where({ discount_key: 'multi_home' }).first('id');
  if (!preset?.id) return 0;
  const row = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .where((q) => {
      q.where((upcoming) => {
        upcoming.where('scheduled_date', '>=', today)
          .whereIn('status', ['pending', 'confirmed']);
      }).orWhere('status', 'rescheduled');
    })
    .where((q) => {
      q.where('discount_id', preset.id)
        .orWhere('line_discount_id', preset.id)
        .orWhereExists(function addonMultiHome() {
          this.select(1)
            .from('scheduled_service_addons as ssa')
            .whereRaw('ssa.scheduled_service_id = scheduled_services.id')
            .andWhere('ssa.discount_id', preset.id);
        });
    })
    .count('* as cnt')
    .first();
  return Number(row?.cnt || 0);
}

// Decision 2 (owner 2026-11-27): when a Same-Family group drops below 2 live
// homes (unlink, archive, or cancellation) while a surviving member still
// carries an active Multi-Home discount on upcoming visits, raise an office
// review alert. Never auto-changes prices and never texts/emails customers.
async function alertFamilyDropBelowTwo(conn, { formerMemberIds = [], departedCustomerId = null, reason = 'unlinked', includeDeparted = false } = {}) {
  const departedNorm = normalizeId(departedCustomerId || '');
  const ids = [...new Set((formerMemberIds || []).map((id) => normalizeId(id)).filter((id) => id && (includeDeparted || id !== departedNorm)))];
  if (!ids.length) return 0;
  let alerted = 0;
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const reasonLabel = DROP_REASON_LABELS[reason] || 'family changed';
  for (const memberId of ids) {
    try {
      const member = await conn('customers')
        .where({ id: memberId })
        .whereNull('deleted_at')
        .first('id', 'first_name', 'last_name', 'company_name', 'active', 'has_multi_home', 'pipeline_stage');
      if (!member || member.active !== true || member.has_multi_home === true) continue;
      if (await familyMultiHomeEligible(conn, memberId)) continue;
      const upcomingCount = await countUpcomingMultiHomeDiscountedVisits(conn, memberId);
      if (upcomingCount <= 0) continue;
      const name = displayName(member).slice(0, 28);
      const visitWord = upcomingCount === 1 ? 'visit' : 'visits';
      await raiseAdminAlert('billing', {
        area: 'Billing',
        severity: 'needs-you',
        who: 'person',
        subject: { type: 'customer', id: memberId },
        doneWhen: 'multi_home_discount_reviewed',
        action: 'Review Multi-Home Discount after family change',
        why: `${name} now has under 2 active family homes (${reasonLabel}) with ${upcomingCount} discounted upcoming ${visitWord}.`,
        link: `/admin/customers?customerId=${memberId}`,
      }, {
        dedupeKey: `family-drop-below-two:${memberId}:${departedCustomerId || reason}`,
        dedupeOpenOnly: true,
      });
      alerted += 1;
    } catch (err) {
      logger.warn(`[multi-home-family] drop-below-two review alert skipped for ${memberId}: ${err.message}`);
    }
  }
  return alerted;
}

async function alertFamilyDropForDepartedMember(conn, { customerId, reason = 'cancelled', scoped = false, churned = true } = {}) {
  if (scoped || !churned || !customerId) return 0;
  try {
    const family = await familyMembers(conn, customerId);
    const survivors = (family?.members || []).filter((m) => !m.isSelf).map((m) => m.id);
    if (!survivors.length) return 0;
    return await alertFamilyDropBelowTwo(conn, {
      formerMemberIds: survivors,
      departedCustomerId: customerId,
      reason,
    });
  } catch (err) {
    logger.warn(`[multi-home-family] departed-member drop check skipped for ${customerId}: ${err.message}`);
    return 0;
  }
}

/**
 * Take a profile out of its family. Not linked is a no-op success (the answer
 * is the empty family), so a double click or a stale screen never errors.
 */
async function unlinkFamily(conn, { customerId, actorId = null } = {}) {
  if (!isUuid(customerId)) throw familyError('The profile id must be valid.', 400);
  const mine = normalizeId(customerId);
  const res = await conn.transaction((trx) => unlinkInTransaction(trx, { customerId: mine, actorId }));
  if (!conn.isTransaction && res?.removed && res.formerMemberIds?.length) {
    // Manual unlinks leave the departing member active at one home too, so alert
    // them alongside survivors if they still carry Multi-Home pricing without flag.
    await alertFamilyDropBelowTwo(conn, {
      formerMemberIds: [...res.formerMemberIds, mine],
      departedCustomerId: mine,
      reason: 'unlinked',
      includeDeparted: true,
    });
  }
  return familyMembers(conn, mine);
}

module.exports = {
  LIVE_FAMILY_STAGES,
  hasUsableServiceStreet,
  isEligibleFamilyCustomer,
  sameHomeAddress,
  familyMembers,
  familyMultiHomeEligible,
  linkFamily,
  unlinkFamily,
  unlinkMemberInExistingTx,
  alertFamilyDropBelowTwo,
  alertFamilyDropForDepartedMember,
  isUuid,
  lockFamilyChanges,
  lockFamilyChangesShared,
  _test: { AUDIT_LINK, AUDIT_UNLINK, FAMILY_CHANGES_LOCK_KEY, LIVE_FAMILY_STAGES, countUpcomingMultiHomeDiscountedVisits },
};
