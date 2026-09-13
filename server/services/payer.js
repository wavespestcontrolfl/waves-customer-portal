/**
 * Third-party payer (Bill-To) service.
 *
 * A payer is a reusable Bill-To account that is NOT a customer. See the
 * 20260617000002_third_party_payers migration for the data model and the
 * resolution order. This module is the single place that:
 *   - resolves which payer (if any) bills a given invoice/job,
 *   - loads a payer for the invoice PDF + email reroute,
 *   - performs admin CRUD with light validation.
 *
 * Safety: resolveForInvoice() and attachToInvoice() NEVER throw — a payer
 * lookup must not be able to block invoicing. They fail soft to "self-pay".
 */

const db = require('../models/db');
const logger = require('./logger');

const PAYMENT_TERMS = ['due_on_receipt', 'net15', 'net30'];

// Canonical NET-terms day counts — the ONE place term tokens map to days.
// Consumed by payer statements (statement due dates) and commercial-proposal
// acceptance invoicing (proposal-win.js); anything else that turns a term
// into a date must read this map, never a local copy (codex #3297 r4c).
const PAYMENT_TERM_NET_DAYS = { net15: 15, net30: 30 };

// An invoice's AP delivery email is "frozen" to the snapshot once the invoice has
// been issued/delivered (or reached a terminal state). Before that — while it's
// still draft/scheduled/sending — the live active payer's current AP email wins
// so an operator's correction takes effect on a resend.
const AP_FROZEN_INVOICE_STATUSES = new Set([
  'sent', 'viewed', 'overdue', 'paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled',
]);

function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

function cleanOrNull(value, max) {
  const s = clean(value);
  if (!s) return null;
  return typeof max === 'number' ? s.slice(0, max) : s;
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function normalizeTerms(value) {
  const t = clean(value).toLowerCase();
  return PAYMENT_TERMS.includes(t) ? t : 'due_on_receipt';
}

// Build the { dbUpdates } object for create/update from a request body.
// Returns { error } on a validation failure. `partial` (PATCH/PUT-update)
// only writes provided keys; create requires display_name + a valid ap_email
// when one is supplied.
function buildPayerWrite(body = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('displayName') || has('display_name')) {
    const displayName = cleanOrNull(body.displayName ?? body.display_name, 160);
    if (!displayName) return { error: 'Payer name is required' };
    out.display_name = displayName;
  }
  if (has('companyName') || has('company_name')) out.company_name = cleanOrNull(body.companyName ?? body.company_name, 200);
  if (has('apEmail') || has('ap_email')) {
    const apEmail = cleanEmail(body.apEmail ?? body.ap_email);
    if (apEmail && !isEmailLike(apEmail)) return { error: 'Invalid AP email' };
    out.ap_email = apEmail || null;
  }
  if (has('apPhone') || has('ap_phone')) out.ap_phone = cleanOrNull(body.apPhone ?? body.ap_phone, 40);
  if (has('billingAddressLine1') || has('billing_address_line1')) out.billing_address_line1 = cleanOrNull(body.billingAddressLine1 ?? body.billing_address_line1, 200);
  if (has('billingCity') || has('billing_city')) out.billing_city = cleanOrNull(body.billingCity ?? body.billing_city, 120);
  if (has('billingState') || has('billing_state')) out.billing_state = cleanOrNull(clean(body.billingState ?? body.billing_state).toUpperCase(), 8);
  if (has('billingZip') || has('billing_zip')) out.billing_zip = cleanOrNull(body.billingZip ?? body.billing_zip, 16);
  if (has('paymentTerms') || has('payment_terms')) out.payment_terms = normalizeTerms(body.paymentTerms ?? body.payment_terms);
  if (has('requiresPo') || has('requires_po')) out.requires_po = !!(body.requiresPo ?? body.requires_po);
  if (has('taxExempt') || has('tax_exempt')) out.tax_exempt = !!(body.taxExempt ?? body.tax_exempt);
  if (has('taxExemptCert') || has('tax_exempt_cert')) out.tax_exempt_cert = cleanOrNull(body.taxExemptCert ?? body.tax_exempt_cert, 120);
  if (has('notes')) out.notes = cleanOrNull(body.notes, 2000);
  if (has('active')) out.active = !!body.active;

  return { dbUpdates: out };
}

async function listPayers({ search, includeInactive = false, limit = 100 } = {}) {
  let q = db('payers').select('*').orderBy('display_name', 'asc').limit(Math.min(Number(limit) || 100, 500));
  if (!includeInactive) q = q.where('active', true);
  const term = clean(search);
  if (term) {
    const like = `%${term.toLowerCase()}%`;
    q = q.where((b) => {
      b.whereRaw('LOWER(display_name) LIKE ?', [like])
        .orWhereRaw('LOWER(COALESCE(company_name, \'\')) LIKE ?', [like])
        .orWhereRaw('LOWER(COALESCE(ap_email, \'\')) LIKE ?', [like]);
    });
  }
  return q;
}

async function getPayer(id, database = db) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return database('payers').where({ id: pid }).first();
}

async function createPayer(body) {
  const { dbUpdates, error } = buildPayerWrite(body, { partial: false });
  if (error) return { error };
  const [row] = await db('payers').insert(dbUpdates).returning('*');
  return { payer: row };
}

/**
 * Find an existing ACTIVE payer by AP email (case-insensitive), else create one.
 * Used by automated linkage (e.g. the call pipeline) where the same owner-payer
 * recurs across many jobs and must NOT spawn a duplicate `payers` row each time.
 * An AP email is required — a payer with no email can't receive an invoice, so
 * we return { payer: null } rather than minting an unroutable Bill-To.
 * Never throws; returns { error } on a validation/DB problem so the caller can
 * fall back to booking without a payer.
 */
async function findOrCreatePayerByEmail(body = {}) {
  const apEmail = cleanEmail(body.apEmail ?? body.ap_email);
  if (!apEmail || !isEmailLike(apEmail)) return { payer: null };
  try {
    return await db.transaction(async (trx) => {
      // Atomic find-or-create: `payers.ap_email` has no unique index, so a bare
      // lookup-then-insert lets two concurrent call processors both miss the
      // existing row and insert DUPLICATE active payers for the same owner —
      // splitting AR across payer ids. A transaction-scoped advisory lock keyed
      // on the normalized email serializes same-email creators (different emails
      // never contend); the lock releases on commit/rollback.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [apEmail]);
      const matches = await trx('payers')
        .whereRaw('LOWER(ap_email) = ?', [apEmail])
        .orderBy('id', 'asc');
      const active = matches.find((p) => p.active !== false);
      if (active) return { payer: active, created: false };
      // An INACTIVE payer with this email means an operator deliberately
      // disabled that Bill-To — do NOT silently recreate it (that would defeat
      // the fail-closed deactivation and route a new invoice to a disabled AP
      // inbox). Leave it unlinked for review.
      if (matches.length > 0) return { payer: null, inactive: true };
      // buildPayerWrite validates/normalizes (same as createPayer); it requires
      // display_name, so fall back to the email local-part when the caller
      // couldn't name the payer.
      const displayName = cleanOrNull(body.displayName ?? body.display_name, 160)
        || apEmail.split('@')[0];
      const { dbUpdates, error } = buildPayerWrite(
        { ...body, ap_email: apEmail, display_name: displayName },
        { partial: false },
      );
      if (error) return { error };
      const [row] = await trx('payers').insert(dbUpdates).returning('*');
      return { payer: row, created: true };
    });
  } catch (err) {
    logger.warn(`[payer] findOrCreatePayerByEmail failed: ${err.message}`);
    return { error: err.message };
  }
}

async function updatePayer(id, body) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) return { error: 'Invalid payer id' };
  const existing = await getPayer(pid);
  if (!existing) return { error: 'Payer not found', notFound: true };
  const { dbUpdates, error } = buildPayerWrite(body, { partial: true });
  if (error) return { error };
  if (Object.keys(dbUpdates).length === 0) return { payer: existing };
  dbUpdates.updated_at = new Date();
  // Reactivating a payer changes the live Bill-To decision for every customer
  // and job that still references it, without touching their rows. The
  // combined-visit invoice claim holds this payer row FOR SHARE while it
  // resolves ownership, so any write carrying `active` takes the row FOR
  // UPDATE and decides the transition from that locked row (a pre-lock
  // snapshot could read the payer as active while a concurrent deactivation
  // and a send claim land in between): an activation waits for the claim to
  // commit and is then refused while the homeowner send it would redirect is
  // in flight (the same 409 the payer_id writers raise).
  if (Object.prototype.hasOwnProperty.call(dbUpdates, 'active')) {
    return db.transaction(async (trx) => {
      // OWNERSHIP ROWS FIRST (Codex #4311 r27 P2): the withdrawal below
      // (withdrawPacketInvoicesForOwner → resolvePacketOwnershipLocked) takes
      // customer and member rows before payer rows, and every competing
      // ownership writer (customer edit, merge, job Bill-To) does the same and
      // then waits on this payer row. Locking the payer first and the customer
      // rows afterwards is the inverse order, and PostgreSQL aborts one side.
      // Taking the referencing rows FOR SHARE here — before the payer row —
      // puts this transaction on the established order; the set is re-read
      // under the payer lock below, and the withdrawal re-locks per packet.
      // ADVISORY LOCKS FIRST, then ownership rows (local audit): the
      // combined-session fences take `pay.combined.customer` per customer, and
      // the job Bill-To writer takes it before it touches member rows. Taking
      // rows first here and the advisory lock later is the inverse order, and
      // the two writers deadlock. The set is re-checked under the payer lock
      // below; a reference that appears after this point refuses rather than
      // proceeding on a partial prelock.
      const referencingCustomerIds = [...new Set([
        ...await trx('customers').where({ payer_id: pid }).whereNull('deleted_at').pluck('id'),
        ...await trx('scheduled_services').where({ payer_id: pid }).whereNotNull('customer_id').pluck('customer_id'),
      ].map(String))].sort();
      if (referencingCustomerIds.length) {
        await require('./pay-combined').lockCombinedCustomers(trx, referencingCustomerIds);
        await trx('customers').whereIn('id', referencingCustomerIds).orderBy('id').forShare().select('id');
        // EVERY member of a packet this payer reaches, not only the members
        // that name it (Codex #4311 r29 P2): the withdrawal resolves
        // ownership per packet and takes ALL its billed members, so a member
        // held by a concurrent job Bill-To edit — one that names no payer
        // itself — is a row this transaction will wait for later. Locking
        // the whole membership up front keeps both sides on one order.
        await trx('scheduled_services')
          .where((q) => q.where({ payer_id: pid })
            .orWhereIn('id', trx('visit_completion_packet_items')
              .whereIn('packet_id', trx('visit_completion_packet_items as direct')
                .whereIn('direct.scheduled_service_id', trx('scheduled_services as ref').where('ref.payer_id', pid).select('ref.id'))
                .select('direct.packet_id'))
              .select('scheduled_service_id'))
            .orWhereIn('id', trx('visit_completion_packet_items')
              .whereIn('packet_id', trx('visit_completion_packet_items as owned')
                .join('invoices', 'invoices.visit_completion_packet_id', 'owned.packet_id')
                .whereIn('invoices.customer_id', referencingCustomerIds)
                .select('owned.packet_id'))
              .select('scheduled_service_id')))
          .orderBy('id').forShare().select('id');
      }
      const current = await trx('payers').where({ id: pid }).forUpdate().first();
      if (!current) return { error: 'Payer not found', notFound: true };
      // The reference set is RE-READ under the payer lock (Codex #4311 r31
      // P2): a customer or job assigned to this payer between the prelock and
      // the lock would be withdrawn below while its ownership rows were never
      // prelocked — the same payer↔ownership inversion, one reference later.
      // A grown set refuses rather than proceeding on a partial prelock; the
      // caller retries and the new reference is prelocked from the start.
      const referencesUnderLock = [...new Set([
        ...await trx('customers').where({ payer_id: pid }).whereNull('deleted_at').pluck('id'),
        ...await trx('scheduled_services').where({ payer_id: pid }).whereNotNull('customer_id').pluck('customer_id'),
      ].map(String))].sort();
      if (dbUpdates.active === true && current.active !== true
        && referencesUnderLock.some((id) => !referencingCustomerIds.includes(id))) {
        return { error: 'A Bill-To change landed while this payer was being activated — try again.',
          conflict: true, code: 'payer_references_changed' };
      }
      const activating = dbUpdates.active === true && current.active !== true;
      if (activating && await require('./visit-completion-packets').packetInvoiceSendInFlight({ payerId: pid }, trx)) {
        return { error: 'A combined-visit invoice for a customer or job billed to this payer is being sent; try again in a moment.',
          conflict: true, code: 'invoice_send_in_flight' };
      }
      // A reactivation moves every referencing customer's debt to this
      // payer without touching their rows: the same fence the payer_id
      // writers apply runs for each of them — an unconfirmed combined
      // pay-page session is released, and in-flight combined money defers
      // the activation (its settlement never re-resolves ownership).
      if (activating) {
        const referencing = [...new Set([
          ...await trx('customers').where({ payer_id: pid }).whereNull('deleted_at').pluck('id'),
          ...await trx('scheduled_services').where({ payer_id: pid }).whereNotNull('customer_id').pluck('customer_id'),
        ].map(String))];
        const PayCombined = require('./pay-combined');
        // ONE verdict over ALL referencing customers (Codex #4311 r27 P2): the
        // per-customer loop this replaces cancelled the first customer's
        // confirmable session and only then discovered a second customer's
        // in-flight payment — the activation was refused, but a Stripe cancel
        // does not roll back with this transaction, so an uninvolved
        // homeowner lost a live pay-page session for nothing. The batched
        // fence verifies every session before cancelling any.
        const release = await PayCombined.releaseUnconfirmedCombinedSessionsForCustomers(trx, referencing);
        if (release.inFlight > 0) {
          return { error: 'A combined bank payment for a customer billed to this payer is still in flight; retry the activation after it settles or fails.',
            conflict: true, code: 'combined_payment_in_flight' };
        }
      }
      const [row] = await trx('payers').where({ id: pid }).update(dbUpdates).returning('*');
      // With the payer live again, every self-pay combined-visit invoice of a
      // referencing customer or job is withdrawn to it.
      if (activating) {
        const Packets = require('./visit-completion-packets');
        await Packets.withdrawPacketInvoicesForOwner(trx, { payerId: pid });
        // …and RE-JUDGE the packets that were already withdrawn to someone
        // else (local audit): a packet whose first billed member references
        // this payer while another member references an active one was
        // stamped for THAT payer. Reactivating this one changes the live
        // answer, and the stamp, packet error and office alert would keep
        // naming the wrong AP account. Scoped by customer, not by payer id —
        // filtering on this payer would skip exactly the stamps that name
        // another.
        for (const customerId of [...new Set([
          ...await trx('customers').where({ payer_id: pid }).whereNull('deleted_at').pluck('id'),
          ...await trx('scheduled_services').where({ payer_id: pid }).whereNotNull('customer_id').pluck('customer_id'),
        ].map(String))].sort()) {
          await Packets.reconcileWithdrawnPacketInvoices(trx, { customerId });
        }
      }
      // A deactivation that waited on a send claim's payer lock arrives after
      // that claim withdrew the homeowner invoice to this payer: with the
      // payer inactive, live ownership is self-pay again, so the withdrawn
      // invoice returns to its queue (the worker re-judges ownership on its
      // claim) and the hold the withdrawal set is lifted.
      if (dbUpdates.active === false && current.active !== false) {
        await require('./visit-completion-packets').reconcileWithdrawnPacketInvoices(trx, { payerId: pid });
      }
      return { payer: row };
    });
  }
  const [row] = await db('payers').where({ id: pid }).update(dbUpdates).returning('*');
  return { payer: row };
}

/**
 * Resolve the bill-to payer for an invoice context.
 * Precedence: scheduled_service.payer_id ?? customer.payer_id.
 * po_number comes only from the scheduled service (PO is per-job).
 * Never throws — returns { payerId: null, poNumber: null } on any problem.
 */
// Frozen bill-to subset stored on the invoice at creation. Uses the SAME keys
// as the payers row so the PDF / pay page / email renderers (which read
// invoice.payer) work unchanged whether they get a live row or a snapshot.
function payerSnapshot(payer) {
  if (!payer) return null;
  return {
    display_name: payer.display_name || null,
    company_name: payer.company_name || null,
    ap_email: payer.ap_email || null,
    billing_address_line1: payer.billing_address_line1 || null,
    billing_city: payer.billing_city || null,
    billing_state: payer.billing_state || null,
    billing_zip: payer.billing_zip || null,
  };
}

function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const obj = JSON.parse(value);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// Column guard for scheduled_services.self_pay_override (migration
// 20260713000001). Selecting it unguarded on a pre-migration database would
// error the whole scheduled-service lookup — and on the fail-soft path that
// silently DROPS an existing per-job payer_id/PO. Introspection result is
// cached process-wide on success (migrations run pre-deploy, so a booted
// process's schema is stable); introspection that itself fails (e.g. mocked
// databases in tests) assumes the modern schema and is NOT cached.
let selfPayColumnCache = null;
async function scheduledServicesHasSelfPay(database) {
  if (selfPayColumnCache !== null) return selfPayColumnCache;
  try {
    const present = await database.schema.hasColumn('scheduled_services', 'self_pay_override');
    selfPayColumnCache = present;
    return present;
  } catch {
    return true;
  }
}

async function resolveForInvoice({ database = db, customerId, customer = null, scheduledServiceId = null, throwOnError = false } = {}) {
  const SELF_PAY = { payerId: null, poNumber: null, taxExempt: false, snapshot: null, paymentTerms: null };
  // throwOnError: callers whose contract is "skip on uncertainty" (e.g. the
  // deposit-abandonment nudge must NOT text a payer-billed homeowner just because
  // a lookup blipped) pass this to get a genuine DB/schema failure re-thrown
  // instead of the silent self-pay fallback. The per-query .catch guards are
  // lifted in that mode so those errors reach the throwing path. Default false =
  // unchanged fail-soft behavior for every existing caller.
  const softNull = (p) => (throwOnError ? p : p.catch(() => null));
  try {
    let payerId = null;
    let poNumber = null;
    let selfPayOverride = false;

    // The owning customer of this invoice; used to scope the per-job lookup so
    // a stale/mismatched scheduledServiceId can never snapshot a DIFFERENT
    // customer's payer onto this invoice.
    const ownerCustomerId = customerId || customer?.id || null;

    if (scheduledServiceId) {
      const ssWhere = { id: scheduledServiceId };
      if (ownerCustomerId) ssWhere.customer_id = ownerCustomerId;
      const ssCols = ['payer_id', 'po_number'];
      if (await scheduledServicesHasSelfPay(database)) ssCols.push('self_pay_override');
      const ss = await softNull(database('scheduled_services')
        .where(ssWhere)
        .first(ssCols));
      if (ss) {
        if (ss.payer_id) payerId = ss.payer_id;
        if (clean(ss.po_number)) poNumber = clean(ss.po_number);
        selfPayOverride = ss.self_pay_override === true;
      }
    }

    if (!payerId) {
      // Explicit per-job self-pay: the visit is pinned to "customer pays
      // (self)", so the account-default payer must NOT be inherited. A concrete
      // per-job payer_id above still wins (the write path keeps the two
      // mutually exclusive), so the flag only blocks the fallback.
      if (selfPayOverride) return SELF_PAY;
      let cust = customer;
      if (!cust && customerId) {
        cust = await softNull(database('customers').where({ id: customerId }).first('payer_id'));
      }
      if (cust && cust.payer_id) payerId = cust.payer_id;
    }

    if (!payerId) return SELF_PAY;

    // Only honor an ACTIVE payer link. A deactivated payer falls back to
    // self-pay rather than silently sending invoices to a dead AP inbox.
    const payer = await softNull(getPayer(payerId, database));
    if (!payer || payer.active === false) return SELF_PAY;

    return {
      payerId,
      poNumber,
      taxExempt: !!payer.tax_exempt,
      snapshot: payerSnapshot(payer),
      // Phase 2: drives the accrual-vs-instant-invoice branch in invoice.create().
      paymentTerms: payer.payment_terms || 'due_on_receipt',
    };
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[payer] resolveForInvoice failed (falling back to self-pay): ${err.message}`);
    return SELF_PAY;
  }
}

/**
 * Load and attach `invoice.payer` when the invoice carries a payer_id snapshot.
 * Mutates and returns the same invoice object. Never throws.
 */
async function attachToInvoice(invoice, database = db) {
  if (!invoice || invoice.payer) return invoice;
  // Prefer the frozen bill-to snapshot taken at creation — it survives later
  // edits/deactivation of the payer row, so an issued invoice/receipt keeps
  // its original Bill-To and routes to the AP email it was billed to.
  const parsed = parseSnapshot(invoice.payer_snapshot);
  if (parsed) {
    // Clone so a live AP-email recovery below never mutates the STORED snapshot
    // in place — Postgres returns jsonb as a parsed object, and downstream
    // (persistPayerApIfNeeded) must still see that the stored snapshot lacked an
    // AP email to know it needs to freeze the recovered one.
    const snap = { ...parsed };
    // "Issued/delivered" is determined by the persistent sent_at timestamp, not
    // the live status: sendViaSMSAndEmail claims a sendable invoice by flipping
    // its status to 'sending' BEFORE this attach runs (claimInvoiceForSend), so a
    // resend of an already-sent/viewed payer invoice would otherwise look
    // undelivered. sent_at survives the claim (COALESCE-set on first delivery,
    // never cleared), so it correctly classifies an issued invoice as frozen.
    const apIsFrozen = !!invoice.sent_at
      || AP_FROZEN_INVOICE_STATUSES.has(String(invoice.status || '').toLowerCase());

    // ISSUED invoice: the frozen bill-to is an immutable record of who it was
    // billed to — keep the snapshot even if the payer was later edited or
    // deactivated (round-3 intent: "an issued invoice keeps its Bill-To"). Only
    // recover a live AP email if the snapshot never captured one (minted before
    // ops filled it in).
    if (apIsFrozen) {
      if (!isEmailLike(snap.ap_email) && invoice.payer_id) {
        try {
          const live = await getPayer(invoice.payer_id, database);
          if (live && live.active !== false && live.ap_email && isEmailLike(live.ap_email)) {
            snap.ap_email = live.ap_email;
          }
        } catch (err) {
          logger.warn(`[payer] attachToInvoice live AP-email recovery failed for invoice ${invoice.id}: ${err.message}`);
        }
      }
      invoice.payer = snap;
      return invoice;
    }

    // UNFROZEN invoice (draft/scheduled/sending, never delivered): not yet a
    // record of issue, so it requires a live ACTIVE payer. A payer cleared or
    // deactivated after minting makes the invoice UNATTACHABLE (invoice.payer is
    // left unset) so the delivery paths FAIL CLOSED — the operator reactivates or
    // corrects the bill-to instead of silently sending to the stale snapshot AP
    // inbox. The live ACTIVE payer's AP email is preferred so a correction takes
    // effect on a resend. (A snapshot with no payer_id link can't be re-verified;
    // routing keys off payer_id so it stays self-pay — keep it for display.)
    if (!invoice.payer_id) {
      invoice.payer = snap;
      return invoice;
    }
    try {
      const live = await getPayer(invoice.payer_id, database);
      if (live && live.active !== false) {
        // The live ACTIVE payer controls AP routing for an undelivered invoice:
        // use its current AP email if valid, otherwise CLEAR the (possibly stale)
        // creation-snapshot AP email so delivery FAILS CLOSED rather than sending
        // to an old address. Identity stays for display; payerRecipient() returns
        // null without a valid AP email, so send/preview/project paths fail closed.
        snap.ap_email = (live.ap_email && isEmailLike(live.ap_email)) ? live.ap_email : null;
        invoice.payer = snap;
      }
      // missing/inactive live payer → leave invoice.payer unset (fail closed)
    } catch (err) {
      logger.warn(`[payer] attachToInvoice live lookup failed for invoice ${invoice.id}: ${err.message}`);
      // fail closed for unfrozen invoices on lookup error
    }
    return invoice;
  }
  // Legacy invoices created before payer_snapshot existed fall back to the live
  // payer row, still guarding against a payer deactivated before a draft
  // invoice was ever sent (no snapshot = no issued bill-to of record yet).
  if (!invoice.payer_id) return invoice;
  try {
    const payer = await getPayer(invoice.payer_id, database);
    if (payer && payer.active !== false) invoice.payer = payer;
  } catch (err) {
    logger.warn(`[payer] attachToInvoice failed for invoice ${invoice.id}: ${err.message}`);
  }
  return invoice;
}

/**
 * Freeze the AP email an invoice was actually DELIVERED to onto its
 * payer_snapshot, so the (async) receipt + pay/receipt pages keep routing to the
 * same AP contact even if the payer row is later edited/deactivated. Covers a
 * live-recovered email, an operator one-off, or the first send of a legacy
 * invoice. No-ops once the snapshot already carries the delivered address. Never
 * throws — a bookkeeping write must not break a successful send.
 */
async function freezeApEmail(invoice, deliveredEmail, database = db) {
  try {
    if (!invoice || !invoice.payer_id) return;
    const email = cleanEmail(deliveredEmail);
    if (!email || !isEmailLike(email)) return;
    const stored = parseSnapshot(invoice.payer_snapshot);
    if (stored && cleanEmail(stored.ap_email) === email) return; // already frozen with this AP email
    const base = (invoice.payer && typeof invoice.payer === 'object') ? invoice.payer : (stored || {});
    const snap = { ...base, ap_email: email };
    await database('invoices').where({ id: invoice.id }).update({ payer_snapshot: JSON.stringify(snap) });
    invoice.payer = snap;
  } catch (err) {
    logger.warn(`[payer] freezeApEmail failed for invoice ${invoice && invoice.id}: ${err.message}`);
  }
}

// Recipient object for the invoice email reroute. Returns null when the payer
// has no usable AP email (caller then falls back to the customer billing
// contact, so a misconfigured payer never strands the invoice with no path).
function payerRecipient(payer) {
  if (!payer) return null;
  const email = cleanEmail(payer.ap_email);
  if (!email || !isEmailLike(email)) return null;
  return {
    email,
    name: cleanOrNull(payer.company_name || payer.display_name, 120) || '',
    role: 'payer',
  };
}

module.exports = {
  PAYMENT_TERMS,
  PAYMENT_TERM_NET_DAYS,
  buildPayerWrite,
  listPayers,
  getPayer,
  createPayer,
  findOrCreatePayerByEmail,
  updatePayer,
  resolveForInvoice,
  attachToInvoice,
  freezeApEmail,
  payerRecipient,
  payerSnapshot,
  scheduledServicesHasSelfPay,
  _private: { isEmailLike, normalizeTerms, parseSnapshot },
};
