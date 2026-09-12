/**
 * Shared per-customer advisory lock for comms-affecting writers.
 *
 * ONE key namespace — `customer-comms:<customer id>` — serializes every
 * writer whose commit changes WHO receives a customer's comms against the
 * probes that must not miss it:
 *
 *   - every `scheduled_services` INSERT (appointment/service-report comms
 *     resolve their recipients LIVE from the customer row at send time, so
 *     a new visit silently depends on the row's service_contact* slots);
 *   - the template-run executor's `email_template_automation_runs` insert
 *     (recipient_id is a STRING customer id with no FK — row locks cannot
 *     fence it);
 *   - the merge-undo's identity/service-contact/email probes in
 *     customer-dedupe.js revertMerge (an absence probe under READ COMMITTED
 *     cannot see a concurrent uncommitted INSERT — the phantom this lock
 *     exists to close);
 *   - booking's capture-intent lane (booking.js), which already used the
 *     resolve → lock → re-resolve idiom.
 *   - recurring-series deferral (rebooker.js) versus 72h/24h reminder
 *     delivery (appointment-reminders.js): the freeze read and deferral
 *     commit share the fence with every SMS/email leg of an active send.
 *
 * LOCK ORDER CONTRACT (deadlock safety):
 *   1. Take this lock BEFORE locking or updating the same customer's
 *      `customers` row in the same transaction, and as early as the
 *      customer id is known. revertMerge takes it as the FIRST lock of its
 *      transaction; a creator that acquired the customers row first and
 *      then waited here would deadlock against an undo holding this lock
 *      and waiting on that row.
 *   2. `pg_advisory_xact_lock` is transaction-scoped — callers MUST hold an
 *      open transaction, or the lock releases at the end of the acquiring
 *      statement and fences nothing. Use `withCustomerCommsLock` when the
 *      calling site has no transaction of its own.
 *   3. Re-acquisition within one transaction is a no-op (advisory locks are
 *      reentrant per session), so helpers may take it defensively.
 *
 * KEY DERIVATION is centralized HERE and nowhere else:
 *   pg_advisory_xact_lock(hashtextextended('customer-comms:' || <id>, 0))
 */

async function lockCustomerComms(trx, customerId) {
  if (!customerId) return;
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
    [`customer-comms:${customerId}`],
  );
}

/**
 * Non-blocking variant for writers that ALREADY hold row locks the
 * merge-undo takes after this key (invoices, customers, journaled visits) —
 * e.g. annual-prepay activation, which holds invoice/term rows before it
 * seeds visits. Blocking there would deadlock (writer holds rows, waits on
 * comms; undo holds comms, wants rows). Returns true when acquired; on
 * false the caller proceeds UNFENCED and logs — the residual is an undo of
 * this exact customer mid-transaction at that instant, and the losing
 * interleavings degrade comms routing, never money (same degrade posture as
 * occupancy's tryAcquireOccupancyLock).
 */
async function tryLockCustomerComms(trx, customerId) {
  if (!customerId) return true;
  const res = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
    [`customer-comms:${customerId}`],
  );
  const row = res && res.rows ? res.rows[0] : (Array.isArray(res) ? res[0] : null);
  return !!(row && (row.locked === true || row.locked === 't'));
}

/**
 * Open a transaction on `db`, take the customer-comms lock, and run `fn(trx)`
 * inside it — for insert sites that have no transaction of their own. The
 * lock releases with the commit/rollback. A caller already holding a cron
 * connection may reuse it rather than pinning another pooled connection.
 */
async function withCustomerCommsLock(db, customerId, fn, { connection } = {}) {
  return db.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    return fn(trx);
  }, { connection });
}

// Reuse the provider STOP/START namespace, including absent suppression rows.
// SMS handoff order: customer-comms → phone → customer/lead rows.
// STOP/START and provider recorders take phone only, never customer-comms:
// reminders already hold customer-comms while calling those recorders.
async function lockSmsPhone(trx, phone) {
  const normalized = require('./phone').toE164(phone);
  if (!normalized) throw new Error('SMS authority requires a phone');
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [normalized]);
}

// The callback covers final authority reads and the SDK call only. Provider
// preparation and error recorders use separate connections and run outside it.
async function withSmsConsentLock(dbh, { phone, customerId }, fn) {
  if (!customerId) throw new Error('SMS authority requires a customer');
  return dbh.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    await lockSmsPhone(trx, phone);
    return fn(trx);
  });
}

// The shared per-address email lock (same key contact-correction, dedupe
// merge-undo and the email-fanout claim guard take): suppression writers and
// bearer-link email handoffs serialize on it so an opt-out or an address
// claim commits either before a handoff's authorization or after its request.
// Google ignores local-part dots and everything after '+', so every dot/tag
// variant of one mailbox delivers to one inbox: a Google address also takes
// its mailbox-identity key (after the exact key, always in that order), so
// a handoff to john.doe@gmail.com and an assignment of johndoe+x@gmail.com
// serialize on the same key. Mirrors email-bounce-recovery.js's
// gmailMailboxOwnedByOther identity.
function googleMailboxIdentity(normalized) {
  const [local, domain] = normalized.split('@');
  if (!local || !['gmail.com', 'googlemail.com'].includes(domain)) return null;
  const mailbox = local.split('+')[0].replace(/\./g, '');
  return mailbox ? `${mailbox}@gmail.com` : null;
}

// The keys one address takes: its exact key and, for a Google address, its
// mailbox-identity key. Every taker acquires keys in one global order
// (sorted: all `customer-email:` keys before all `customer-mailbox:` keys),
// so a multi-address writer and a single-address handoff — or two
// multi-address writers sharing a mailbox — can never wait on each other.
function customerEmailLockKeys(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email authority requires an address');
  const mailbox = googleMailboxIdentity(normalized);
  return [`customer-email:${normalized}`, ...(mailbox ? [`customer-mailbox:${mailbox}`] : [])];
}

async function lockCustomerEmailKeys(trx, keys) {
  for (const key of [...new Set(keys)].sort()) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
  }
}

async function lockCustomerEmail(trx, email) {
  await lockCustomerEmailKeys(trx, customerEmailLockKeys(email));
}

// Every column a customer's email can be recorded in — the same set the
// bounce recovery's ownership check consults (email-bounce-recovery.js
// CUSTOMER_EMAIL_FIELDS). A writer assigning any of them takes the address
// key for each new value, AFTER its customers row lock (row → key is the
// established order), in a fixed order so two multi-address writers cannot
// deadlock on each other. A recovery that found an address unowned then
// either commits before the assignment or re-judges ownership after it.
// billing_email (notification_prefs) is the fourth ownership source the
// recovery consults; its writers pass their prefs update through here too.
// Every key of every address is collected first and taken in the one
// global order (customerEmailLockKeys), never address by address.
const CUSTOMER_EMAIL_COLUMNS = ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email', 'billing_email'];
async function lockAssignedCustomerEmails(trx, updates = {}) {
  const addresses = [...new Set(CUSTOMER_EMAIL_COLUMNS
    .map((column) => String(updates[column] || '').trim().toLowerCase()).filter(Boolean))].sort();
  await lockCustomerEmailKeys(trx, addresses.flatMap(customerEmailLockKeys));
  return addresses;
}

module.exports = { lockCustomerComms, tryLockCustomerComms, withCustomerCommsLock, lockSmsPhone, withSmsConsentLock, lockCustomerEmail,
  lockAssignedCustomerEmails, customerEmailLockKeys, CUSTOMER_EMAIL_COLUMNS };
