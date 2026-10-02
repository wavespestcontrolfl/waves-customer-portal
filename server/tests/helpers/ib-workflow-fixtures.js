'use strict';

/**
 * Synthetic seeding primitives for the ten-workflow baseline. Names, phones and
 * addresses are invented (555 numbers, example.invalid emails, "Example"
 * streets); nothing here is a real customer. Every row the baseline creates is
 * tagged with MARK so a crashed earlier run can be swept before the next one
 * (soft delete: the bar's name resolution ignores deleted rows) and each case
 * can retire its own cast when it ends.
 */

const crypto = require('crypto');

const MARK = 'ib-workflow-baseline';
const uuid = () => crypto.randomUUID();
const phone = (last4) => `+1941555${String(last4).padStart(4, '0')}`;

// Calendar in America/New_York, the business's own clock.
// A weekday far enough ahead that no other suite's rows can share its calendar day.
const farWeekdayET = (weekday, weeksAhead) => nextWeekdayET(weekday, 7 * weeksAhead);
const et = () => require('../../utils/datetime-et');
const todayET = () => et().etDateString(new Date());
const plusDaysET = (days) => et().etDateString(et().addETDays(new Date(), days));
// Next occurrence (strictly after today) of a weekday, 0 = Sunday .. 6 = Saturday, as YYYY-MM-DD.
function nextWeekdayET(weekday, minDaysAhead = 1) {
  for (let i = minDaysAhead; i < minDaysAhead + 8; i += 1) {
    const day = plusDaysET(i);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === weekday) return day;
  }
  throw new Error('weekday not found');
}

/**
 * The test clock. The manifests are written against one calendar: "today" in them is CLOCK_ANCHOR (a Friday), so
 * "next Wednesday" is 2026-10-07 in every call. The route reads the real clock, so a literal date would be a past
 * date from the week after the anchor on. clockDate() moves a manifest date forward by whole weeks until the anchor
 * is not in the past: the weekday, the order and the gaps between the manifest's dates are kept, and while the real
 * date is the anchor (or earlier) the manifest date is used as written.
 */
const CLOCK_ANCHOR = '2026-10-02';
const dayNumber = (ymd) => Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 86400000);
const clockWeeksForward = () => Math.max(0, Math.ceil((dayNumber(todayET()) - dayNumber(CLOCK_ANCHOR)) / 7));
const clockDate = (ymd) => new Date((dayNumber(ymd) + 7 * clockWeeksForward()) * 86400000).toISOString().slice(0, 10);
const CLOCK_DATE_KEYS = new Set(['scheduled_date', 'new_date', 'date_from', 'date_to', 'date']);

class Cast {
  constructor(db) {
    this.db = db;
    this.aliases = new Map(); // manifest fixture key -> the real row id this case seeded for it
    this.customers = [];
    this.leads = [];
    this.technicians = [];
    this.productIds = [];
    this.notificationIds = [];
    this.cleanups = []; // async (db) => void, run by retire(); each case's own rows (invoices, estimates, stock) go here
  }

  /** Name the row this case seeded for a manifest fixture key (cust-pellham, murphy-lead-3, ...). Returns the row. */
  key(name, row) { this.aliases.set(name, row && row.id !== undefined ? row.id : row); return row; }

  /** A manifest call input with its fixture keys replaced by the seeded ids and its dates moved onto the test clock. */
  resolve(value, key) {
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolve(v, k)]));
    if (typeof value === 'string' && this.aliases.has(value)) return this.aliases.get(value);
    if (typeof value === 'string' && CLOCK_DATE_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return clockDate(value);
    return value;
  }

  /** Register cleanup for rows a case seeded outside the shared tables above. */
  onRetire(fn) { this.cleanups.push(fn); }

  async customer(over = {}) {
    const id = over.id || uuid();
    const row = {
      id, first_name: 'Synthetic', last_name: 'Customer', phone: phone(Math.floor(Math.random() * 9000) + 1000),
      email: `${id.slice(0, 8)}@example.invalid`, address_line1: '1 Example Grove', city: 'Sarasota', state: 'FL', zip: '34236',
      lead_source_detail: MARK, active: true, ...over,
    };
    await this.db('customers').insert(row);
    this.customers.push(id);
    return row;
  }

  async property(customerId, over = {}) {
    const row = {
      id: uuid(), customer_id: customerId, label: 'home', occupancy_type: 'owner_occupied', relationship: 'own_home', is_primary: false,
      address_line1: '1 Example Grove', city: 'Sarasota', state: 'FL', zip: '34236', active: true, source: 'baseline_fixture', ...over,
    };
    if (!row.address_key) row.address_key = require('../../services/customer-properties').addressKey(row);
    await this.db('customer_properties').insert(row);
    return row;
  }

  async lead(over = {}) {
    const id = over.id || uuid();
    const row = {
      id, first_name: null, last_name: 'Lead', phone: phone(Math.floor(Math.random() * 9000) + 1000), status: 'new',
      lead_synopsis: MARK, first_contact_at: new Date(Date.now() - 72 * 3600000), updated_at: new Date(Date.now() - 72 * 3600000), ...over,
    };
    await this.db('leads').insert(row);
    this.leads.push(id);
    return row;
  }

  async notification(over = {}) {
    const id = over.id || uuid();
    const row = { id, recipient_type: 'admin', category: 'system', title: 'Synthetic alert', link: '/admin/dashboard', metadata: {}, ...over };
    row.metadata = JSON.stringify({ ...(over.metadata || {}), fixture: MARK });
    await this.db('notifications').insert(row);
    this.notificationIds.push(id);
    return row;
  }

  async visit(customerId, over = {}) {
    const row = {
      id: uuid(), customer_id: customerId, scheduled_date: plusDaysET(3), window_start: '09:00', window_end: '11:00',
      time_window: '9:00 AM - 11:00 AM', window_display: '9-11 AM', service_type: 'Quarterly Pest Control Service', status: 'confirmed', source: 'baseline_fixture',
      estimated_price: 149, ...over,
    };
    await this.db('scheduled_services').insert(row);
    (this.visits = this.visits || []).push(row.id);
    return row;
  }

  /** A grouped stop: the service_visits row that two scheduled_services rows share through visit_id. */
  async visitGroup(customerId, over = {}) {
    const row = { id: uuid(), customer_id: customerId, scheduled_date: plusDaysET(3), window_start: '09:00', window_end: '11:00', stop_base_key: `baseline-${uuid().slice(0, 8)}`, status: 'open', created_by: 'baseline_fixture', ...over };
    await this.db('service_visits').insert(row);
    return row;
  }

  /** The one-time pest catalog row the booking requests name; seeded only when the migrated catalog has none. */
  async oneTimePestService(price = 149) {
    const existing = await this.db('services').where({ is_active: true }).whereRaw("lower(name) = 'one-time pest control service'").first();
    if (existing) { this.restoreService = this.restoreService || { id: existing.id, base_price: existing.base_price }; await this.db('services').where({ id: existing.id }).update({ base_price: price, price_range_min: null }); return existing; }
    const row = { id: uuid(), service_key: `pest_one_time_${uuid().slice(0, 6)}`, name: 'One-Time Pest Control Service', category: 'pest_control', billing_type: 'one_time', base_price: price, is_active: true, customer_visible: true, booking_enabled: true };
    await this.db('services').insert(row);
    this.insertedServiceId = row.id;
    return row;
  }

  /** A STOP on file: the opt-out the consent gate reads (notification_prefs.sms_enabled = false). */
  async optOut(customerId) {
    await this.db('notification_prefs').insert({ customer_id: customerId, sms_enabled: false }).onConflict('customer_id').merge({ sms_enabled: false }).catch(async () => {
      await this.db('notification_prefs').where({ customer_id: customerId }).update({ sms_enabled: false });
    });
  }

  async serviceRecord(customerId, over = {}) {
    const row = { id: uuid(), customer_id: customerId, service_date: plusDaysET(-14), service_type: 'Quarterly Pest Control Service', status: 'completed', ...over };
    await this.db('service_records').insert(row);
    return row;
  }

  async sms(customerId, over = {}) {
    const row = { id: uuid(), customer_id: customerId, direction: 'inbound', from_phone: '+19415550999', to_phone: '+19413335555', message_body: 'Synthetic message', status: 'received', message_type: 'manual', created_at: new Date(), ...over };
    await this.db('sms_log').insert(row);
    (this.smsIds = this.smsIds || []).push(row.id);
    return row;
  }

  /** An open promise from a call: the call row first (the commitments table joins on it), then the commitment. */
  async commitment(customerId, over = {}) {
    const callId = uuid();
    await this.db('call_log').insert({ id: callId, customer_id: customerId, status: 'completed', direction: 'inbound', from_phone: '+19415550999', to_phone: '+19413335555', created_at: new Date(Date.now() - 3600000) });
    const row = { id: uuid(), call_log_id: callId, commitment_key: `k-${uuid().slice(0, 8)}`, party: 'waves', kind: 'callback', description: 'Call them back about the quote',
      due_at: new Date(Date.now() + 40 * 60000), source: 'human', ...over };
    await this.db('call_commitments').insert(row);
    (this.commitmentIds = this.commitmentIds || []).push(row.id);
    return { ...row, call_log_id: callId };
  }

  /** Retire everything this cast created. Soft delete keeps foreign keys intact. */
  async retire() {
    const now = new Date();
    for (const fn of this.cleanups.reverse()) await Promise.resolve(fn(this.db)).catch(() => {});
    if (this.customers.length) await removeBillingRows(this.db, this.customers).catch(() => {});
    if (this.customers.length) {
      // Bookings made during the case must not crowd the next case's calendar.
      await this.db('scheduled_services').whereIn('customer_id', this.customers).whereNotIn('status', ['cancelled', 'completed']).update({ status: 'cancelled', cancelled_at: now }).catch(() => {});
      await this.db('customers').whereIn('id', this.customers).update({ deleted_at: now, active: false });
    }
    if (this.leads.length) await this.db('leads').whereIn('id', this.leads).update({ deleted_at: now });
    if ((this.commitmentIds || []).length) await this.db('call_commitments').whereIn('id', this.commitmentIds).update({ status: 'dismissed' }).catch(() => {});
    if (this.insertedServiceId) await this.db('services').where({ id: this.insertedServiceId }).update({ is_active: false }).catch(() => {});
    if (this.restoreService) await this.db('services').where({ id: this.restoreService.id }).update({ base_price: this.restoreService.base_price }).catch(() => {});
    if (this.notificationIds.length) await this.db('notifications').whereIn('id', this.notificationIds).update({ done_at: now, done_by: MARK });
    if (this.technicians.length) await this.db('technicians').whereIn('id', this.technicians).update({ active: false, employment_status: 'inactive' }).catch(() => {});
  }
}

const STOCK_SKU_PREFIX = 'IBWF-';

/** Billing and estimate rows the baseline seeded for customers: removed outright so account-wide readers never see them. */
async function removeBillingRows(db, customerIds) {
  const step = (fn) => Promise.resolve(fn()).catch(() => {});
  await step(() => db('customer_credit_ledger').whereIn('customer_id', customerIds).del());
  await step(() => db('collections_flags').whereIn('customer_id', customerIds).del());
  await step(() => db('payments').whereIn('customer_id', customerIds).del());
  await step(() => db('invoices').whereIn('customer_id', customerIds).del());
  await step(() => db('estimates').whereIn('customer_id', customerIds).del());
}

/** Stock products, their requests and movements, removed outright (the catalog is searched by name and is not filtered by active). */
async function removeStockRows(db, productIds) {
  const step = (fn) => Promise.resolve(fn()).catch(() => {});
  await step(() => db('vendor_orders').whereIn('restock_request_id', db('product_restock_requests').whereIn('product_id', productIds).select('id')).del());
  await step(() => db('product_restock_requests').whereIn('product_id', productIds).del());
  await step(() => db('product_inventory_movements').whereIn('product_id', productIds).del());
  await step(() => db('products_catalog').whereIn('id', productIds).del());
}

/** Sweep rows a crashed earlier run left behind. */
async function sweepStale(db) {
  const now = new Date();
  const stale = db('customers').where('lead_source_detail', MARK).select('id');
  const staleIds = (await db('customers').where('lead_source_detail', MARK).select('id')).map((r) => r.id);
  if (staleIds.length) await removeBillingRows(db, staleIds);
  const staleProducts = (await db('products_catalog').where('sku', 'like', `${STOCK_SKU_PREFIX}%`).select('id')).map((r) => r.id);
  if (staleProducts.length) await removeStockRows(db, staleProducts);
  await db('scheduled_services').whereIn('customer_id', stale).whereNotIn('status', ['cancelled', 'completed']).update({ status: 'cancelled', cancelled_at: now });
  await db('customers').where('lead_source_detail', MARK).whereNull('deleted_at').update({ deleted_at: now, active: false });
  await db('leads').where('lead_synopsis', MARK).whereNull('deleted_at').update({ deleted_at: now });
  await db('notifications').whereRaw("metadata->>'fixture' = ?", [MARK]).whereNull('done_at').update({ done_at: now, done_by: MARK });
}

module.exports = { CLOCK_ANCHOR, clockDate, MARK, STOCK_SKU_PREFIX, removeStockRows, removeBillingRows, Cast, uuid, phone, todayET, plusDaysET, nextWeekdayET, farWeekdayET, sweepStale };
