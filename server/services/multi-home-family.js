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

function familyError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, isOperational: true, code: 'multi_home_family' });
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
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
      'customers.active')
    .orderBy([{ column: 'customers.last_name' }, { column: 'customers.first_name' }, { column: 'customers.id' }]);
  return {
    familyId: own.family_id,
    members: rows.map((row) => ({
      id: row.id,
      name: displayName(row),
      address: displayAddress(row),
      active: row.active === true,
      isSelf: row.id === customerId,
    })),
  };
}

/**
 * True only when the customer is in a family with 2+ member profiles that are
 * both active and not soft-deleted. Fails closed: any error (including a
 * missing table before the migration ran) answers false.
 */
async function liveFamilySize(conn, customerId) {
  const own = await conn(TABLE).where({ customer_id: customerId }).first('family_id');
  if (!own) return 0;
  const row = await conn(TABLE)
    .join('customers', 'customers.id', `${TABLE}.customer_id`)
    .where(`${TABLE}.family_id`, own.family_id)
    .where('customers.active', true)
    .whereNull('customers.deleted_at')
    .count('* as cnt')
    .first();
  return Number(row?.cnt || 0);
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
  const row = await trx('customers').where({ id: customerId }).first('id', 'active', 'deleted_at');
  if (!row || row.deleted_at) throw familyError(`The ${label} profile was not found.`, 409);
  if (row.active !== true) throw familyError(`The ${label} profile is not active. Only active profiles can be linked.`, 409);
  return row;
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

async function linkInTransaction(trx, { customerId, otherCustomerId, actorId }) {
  await lockCustomers(trx, [customerId, otherCustomerId]);
  await loadLinkable(trx, customerId, 'first');
  await loadLinkable(trx, otherCustomerId, 'other');
  // FOR UPDATE: an unlink running at the same time locks these rows too, so it
  // either sees the profile this link adds or finishes first (and this read
  // then skips the row it deleted) — never a one-profile family left behind.
  const rows = await trx(TABLE).whereIn('customer_id', [customerId, otherCustomerId]).forUpdate().select('customer_id', 'family_id');
  const mineRow = rows.find((row) => row.customer_id === customerId);
  const otherRow = rows.find((row) => row.customer_id === otherCustomerId);
  const plan = planLink(mineRow, otherRow, customerId, otherCustomerId);
  if (plan.add && plan.add.length) await insertMembers(trx, plan.familyId, plan.add, actorId);
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

async function unlinkInTransaction(trx, { customerId, actorId }) {
  await lockCustomers(trx, [customerId]);
  const own = await trx(TABLE).where({ customer_id: customerId }).forUpdate().first('id', 'family_id');
  if (!own) return false;
  const familyId = own.family_id;
  const removed = [own.id];
  await trx(TABLE).where({ id: own.id }).del();
  await recordAuditEvent({
    actor_type: 'admin', actor_id: actorId || null, action: AUDIT_UNLINK, resource_type: 'customer',
    resource_id: customerId, metadata: { familyId }, trx, critical: true,
  });
  // A one-profile family means nothing: drop the last member too.
  const left = await trx(TABLE).where({ family_id: familyId }).forUpdate().select('id', 'customer_id');
  if (left.length === 1) {
    await trx(TABLE).where({ id: left[0].id }).del();
    removed.push(left[0].id);
    await recordAuditEvent({
      actor_type: 'admin', actor_id: actorId || null, action: AUDIT_UNLINK, resource_type: 'customer',
      resource_id: left[0].customer_id, metadata: { familyId, reason: 'last_member' }, trx, critical: true,
    });
  }
  return removed.length > 0;
}

/**
 * Take a profile out of its family. Not linked is a no-op success (the answer
 * is the empty family), so a double click or a stale screen never errors.
 */
async function unlinkFamily(conn, { customerId, actorId = null } = {}) {
  if (!isUuid(customerId)) throw familyError('The profile id must be valid.', 400);
  const mine = normalizeId(customerId);
  await conn.transaction((trx) => unlinkInTransaction(trx, { customerId: mine, actorId }));
  return familyMembers(conn, mine);
}

module.exports = {
  familyMembers,
  familyMultiHomeEligible,
  linkFamily,
  unlinkFamily,
  isUuid,
  _test: { AUDIT_LINK, AUDIT_UNLINK },
};
