// DEPRECATED — Square has been removed. Migrated to Stripe.
// This file is kept for reference only. Safe to delete.

/**
 * Square Bulk Import Service
 *
 * 8-phase import from Square into the Waves portal DB:
 *   1. syncAllCustomers     — reuses SquareCustomerSync + notes parsing
 *   2. syncAllHistory       — pages portal customers, calls SquareHistorySync per batch
 *   3. syncAllBookings      — pages Square Bookings API → scheduled_services (with no_show/booking_source)
 *   4. syncAllInvoices      — pages Square Invoices API → invoices table
 *   5. syncAllPayments      — pages Square Payments API → payments table
 *   6. syncAllSubscriptions — cross-ref customer_subscriptions with recurring customers
 *   7. syncRefunds          — sweep payments for refund status + card details
 *   8. recalculate totals
 *
 * Master: runFullImport() — runs all 8 then recalculates customer totals.
 * Cleanup: cleanupImportedData() — dedup, fix descriptions, update totals.
 */

const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const SquareCustomerSync = require('./square-customer-sync');
const SquareHistorySync = require('./square-history-sync');
let Client, Environment;
try { ({ Client, Environment } = require('square')); } catch { Client = null; Environment = null; }
const crypto = require('crypto');

let squareClient, bookingsApi, invoicesApi, paymentsApi, customersApi;
if (!Client) {
  logger.warn('[square-bulk-import] Square SDK not installed — bulk import features disabled');
} else if (config.square?.accessToken) {
  squareClient = new Client({
    accessToken: config.square.accessToken,
    environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
  });
  bookingsApi = squareClient.bookingsApi;
  invoicesApi = squareClient.invoicesApi;
  paymentsApi = squareClient.paymentsApi;
  customersApi = squareClient.customersApi;
}

function cleanPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SquareBulkImport = {
  // =========================================================================
  // Phase 1: Sync All Customers
  // =========================================================================
  async syncAllCustomers({ onProgress } = {}) {
    logger.info('[bulk-import] Phase 1: syncAllCustomers starting');
    if (onProgress) onProgress({ phase: 'customers', status: 'running', message: 'Syncing customers from Square...' });

    const result = await SquareCustomerSync.sync();

    // ── Enhanced: parse Square notes for gate codes, pet info, etc. ──
    let notesParsed = 0;
    try {
      if (customersApi) {
        const customers = await db('customers')
          .whereNotNull('square_customer_id')
          .select('id', 'square_customer_id');

        for (const cust of customers) {
          try {
            const { result: sqResult } = await customersApi.retrieveCustomer(cust.square_customer_id);
            const sqCust = sqResult?.customer;
            if (!sqCust) continue;

            const updates = {};
            if (sqCust.note) {
              updates.square_notes = sqCust.note;
              const parsed = this._parseCustomerNotes(sqCust.note);
              if (parsed.gate_code) updates.gate_code = parsed.gate_code;
              if (parsed.pet_info) updates.pet_info = parsed.pet_info;
              if (parsed.preferred_time) updates.preferred_time = parsed.preferred_time;
              if (parsed.access_notes) updates.access_notes = parsed.access_notes;
              if (parsed.is_commercial) updates.tags = JSON.stringify(['commercial']);
            }
            if (sqCust.groups?.length) {
              updates.square_groups = JSON.stringify(sqCust.groups.map(g => ({ id: g.id, name: g.name })));
            }
            if (sqCust.createdAt) {
              updates.square_created_at = new Date(sqCust.createdAt);
            }

            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date();
              await db('customers').where({ id: cust.id }).update(updates);
              notesParsed++;
            }

            await delay(50); // light rate limiting
          } catch { /* skip individual customer note errors */ }
        }
      }
    } catch (err) {
      logger.warn(`[bulk-import] Notes parsing partial failure: ${err.message}`);
    }

    result.notesParsed = notesParsed;
    logger.info(`[bulk-import] Phase 1 done: ${result.totalFetched} fetched, ${result.created} created, ${result.updated} updated, ${notesParsed} notes parsed`);
    if (onProgress) onProgress({ phase: 'customers', status: 'done', ...result });
    return result;
  },

  /**
   * Parse Square customer notes for structured data
   */
  _parseCustomerNotes(note) {
    if (!note) return {};
    const lower = note.toLowerCase();
    const result = {};

    // Gate code patterns: "gate code: 1234", "gate: #5678", "code 9999"
    const gateMatch = note.match(/gate\s*(?:code)?[:\s#-]*(\w{2,10})/i);
    if (gateMatch) result.gate_code = gateMatch[1];

    // Pet info: "dog", "cat", "2 dogs", "pit bull", "pets in yard"
    const petMatch = note.match(/((?:\d+\s+)?(?:dog|cat|puppy|kitten|pit\s*bull|german\s*shepherd|lab|retriever|pet)s?(?:\s+(?:in\s+)?(?:yard|backyard|house|inside|outside))?)/i);
    if (petMatch) result.pet_info = petMatch[1].trim();

    // Time preferences: "morning", "afternoon", "after 2pm", "before 10am", "8am-12pm"
    const timeMatch = note.match(/((?:morning|afternoon|evening|(?:after|before)\s+\d{1,2}\s*(?:am|pm)|\d{1,2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}\s*(?:am|pm)))/i);
    if (timeMatch) result.preferred_time = timeMatch[1].trim();

    // Commercial detection
    if (lower.includes('commercial') || lower.includes('business') || lower.includes('office') || lower.includes('restaurant') || lower.includes('warehouse')) {
      result.is_commercial = true;
    }

    // Access notes — anything about access, lock, key, side gate, back door
    const accessMatch = note.match(/((?:side|back|rear|front)\s+(?:gate|door|entrance)|locked|key\s+(?:under|in|at)|let\s+(?:yourself|self)\s+in|knock|ring|call\s+(?:before|when|on).*)/i);
    if (accessMatch) result.access_notes = accessMatch[0].trim();

    return result;
  },

  // =========================================================================
  // Phase 2: Sync All History (orders → service_records + payments per customer)
  // =========================================================================
  async syncAllHistory({ onProgress, batchSize = 10, delayBetweenBatches = 2000 } = {}) {
    logger.info('[bulk-import] Phase 2: syncAllHistory starting');

    const customers = await db('customers')
      .whereNotNull('square_customer_id')
      .select('id', 'first_name', 'last_name', 'square_customer_id');

    const total = customers.length;
    let processed = 0, totalServices = 0, totalPayments = 0;
    const errors = [];

    for (let i = 0; i < total; i += batchSize) {
      const batch = customers.slice(i, i + batchSize);

      for (const cust of batch) {
        try {
          const result = await SquareHistorySync.syncCustomer(cust.id);
          totalServices += result.services || 0;
          totalPayments += result.payments || 0;
        } catch (err) {
          errors.push({ customerId: cust.id, name: `${cust.first_name} ${cust.last_name}`, error: err.message });
        }
        processed++;
      }

      if (onProgress) {
        onProgress({ phase: 'history', status: 'running', processed, total, totalServices, totalPayments, errors: errors.length });
      }

      // Delay between batches to avoid rate limiting
      if (i + batchSize < total) {
        await delay(delayBetweenBatches);
      }
    }

    logger.info(`[bulk-import] Phase 2 done: ${processed} customers, ${totalServices} services, ${totalPayments} payments, ${errors.length} errors`);
    if (onProgress) onProgress({ phase: 'history', status: 'done', processed, total, totalServices, totalPayments, errors: errors.length });
    return { processed, total, totalServices, totalPayments, errors: errors.slice(0, 50) };
  },

  // =========================================================================
  // Phase 3: Sync All Bookings → scheduled_services
  // =========================================================================
  async syncAllBookings({ startDate, endDate, onProgress } = {}) {
    logger.info('[bulk-import] Phase 3: syncAllBookings starting');
    if (!bookingsApi) throw new Error('Square Bookings API not configured');

    const locationId = config.square?.locationId || process.env.SQUARE_LOCATION_ID;
    const start = startDate ? new Date(startDate).toISOString() : new Date(Date.now() - 365 * 86400000).toISOString();
    const end = endDate ? new Date(endDate).toISOString() : new Date(Date.now() + 90 * 86400000).toISOString();

    let cursor;
    let totalFetched = 0, created = 0, skipped = 0;
    const errors = [];

    // Build a customer map: square_customer_id → portal customer id
    const custRows = await db('customers').whereNotNull('square_customer_id').select('id', 'square_customer_id');
    const customerMap = {};
    for (const c of custRows) customerMap[c.square_customer_id] = c.id;

    do {
      let response;
      try {
        response = await bookingsApi.listBookings(
          100, cursor, undefined, undefined, locationId || undefined, start, end
        );
      } catch (err) {
        // Retry without location
        try {
          response = await bookingsApi.listBookings(100, cursor, undefined, undefined, undefined, start, end);
        } catch (err2) {
          const detail = err2.errors?.[0]?.detail || err2.message;
          throw new Error(`Square Bookings API failed: ${detail}`);
        }
      }

      const bookings = response.result?.bookings || [];
      cursor = response.result?.cursor;
      totalFetched += bookings.length;

      for (const bk of bookings) {
        try {
          const customerId = customerMap[bk.customerId];
          if (!customerId) { skipped++; continue; }

          // Dedup by square_booking_id
          if (bk.id) {
            const existing = await db('scheduled_services').where({ square_booking_id: bk.id }).first();
            if (existing) { skipped++; continue; }
          }

          const scheduledDate = bk.startAt ? new Date(bk.startAt).toISOString().split('T')[0] : null;
          if (!scheduledDate) { skipped++; continue; }

          const startTime = bk.startAt ? new Date(bk.startAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
          const durationMins = bk.appointmentSegments?.[0]?.durationMinutes || 60;
          const endDate = bk.startAt ? new Date(new Date(bk.startAt).getTime() + durationMins * 60000) : null;
          const endTime = endDate ? endDate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : null;

          const serviceType = bk.sellerNote || bk.customerNote || 'Service';

          // Map booking status
          let status = 'pending';
          const isNoShow = bk.status === 'NO_SHOW';
          if (bk.status === 'ACCEPTED') status = 'confirmed';
          else if (bk.status === 'CANCELLED_BY_CUSTOMER' || bk.status === 'CANCELLED_BY_SELLER') status = 'cancelled';
          else if (bk.status === 'DECLINED') status = 'cancelled';
          else if (isNoShow) status = 'cancelled';

          await db('scheduled_services').insert({
            customer_id: customerId,
            scheduled_date: scheduledDate,
            window_start: startTime,
            window_end: endTime,
            service_type: serviceType.substring(0, 100),
            status,
            square_booking_id: bk.id,
            source: 'square',
            notes: bk.customerNote || bk.sellerNote || null,
            no_show: isNoShow,
            booking_source: bk.source || 'SQUARE',
          });
          created++;
        } catch (err) {
          errors.push({ bookingId: bk.id, error: err.message });
          skipped++;
        }
      }

      if (onProgress) {
        onProgress({ phase: 'bookings', status: 'running', totalFetched, created, skipped, errors: errors.length });
      }

      logger.info(`[bulk-import] Bookings page: ${bookings.length} (cursor: ${cursor ? 'yes' : 'done'})`);
    } while (cursor);

    logger.info(`[bulk-import] Phase 3 done: ${totalFetched} fetched, ${created} created, ${skipped} skipped`);
    if (onProgress) onProgress({ phase: 'bookings', status: 'done', totalFetched, created, skipped, errors: errors.length });
    return { totalFetched, created, skipped, errors: errors.slice(0, 50) };
  },

  // =========================================================================
  // Phase 4: Sync All Invoices
  // =========================================================================
  async syncAllInvoices({ onProgress } = {}) {
    logger.info('[bulk-import] Phase 4: syncAllInvoices starting');
    if (!invoicesApi) throw new Error('Square Invoices API not configured');

    const locationId = config.square?.locationId || process.env.SQUARE_LOCATION_ID;
    if (!locationId) throw new Error('SQUARE_LOCATION_ID required for invoice sync');

    let cursor;
    let totalFetched = 0, created = 0, skipped = 0;
    const errors = [];

    // Build customer map
    const custRows = await db('customers').whereNotNull('square_customer_id').select('id', 'square_customer_id');
    const customerMap = {};
    for (const c of custRows) customerMap[c.square_customer_id] = c.id;

    do {
      let response;
      try {
        response = await invoicesApi.listInvoices(locationId, cursor, 100);
      } catch (err) {
        const detail = err.errors?.[0]?.detail || err.message;
        throw new Error(`Square Invoices API failed: ${detail}`);
      }

      const invoices = response.result?.invoices || [];
      cursor = response.result?.cursor;
      totalFetched += invoices.length;

      for (const inv of invoices) {
        try {
          const sqInvNumber = `SQ-${inv.invoiceNumber || inv.id.substring(0, 8)}`;

          // Check if already imported
          const existing = await db('invoices').where({ invoice_number: sqInvNumber }).first();
          if (existing) { skipped++; continue; }

          // Find customer from primary recipient
          const recipientId = inv.primaryRecipient?.customerId;
          const customerId = recipientId ? customerMap[recipientId] : null;
          if (!customerId) { skipped++; continue; }

          // Map status
          let status = 'draft';
          if (inv.status === 'SENT' || inv.status === 'SCHEDULED') status = 'sent';
          else if (inv.status === 'PAID') status = 'paid';
          else if (inv.status === 'PARTIALLY_PAID') status = 'sent';
          else if (inv.status === 'CANCELED' || inv.status === 'CANCELLED') status = 'void';
          else if (inv.status === 'UNPAID' && inv.dueDate && new Date(inv.dueDate) < new Date()) status = 'overdue';
          else if (inv.status === 'UNPAID') status = 'sent';

          // Build line items
          const lineItems = (inv.paymentRequests || []).flatMap(pr =>
            (pr.computedAmountMoney ? [{
              description: pr.requestType === 'BALANCE' ? 'Balance' : (pr.tipping?.title || 'Service'),
              quantity: 1,
              unit_price: Number(pr.computedAmountMoney.amount || 0) / 100,
              amount: Number(pr.computedAmountMoney.amount || 0) / 100,
            }] : [])
          );

          const total = inv.paymentRequests?.reduce((sum, pr) => {
            return sum + (Number(pr.computedAmountMoney?.amount || 0) / 100);
          }, 0) || 0;

          const token = crypto.randomBytes(32).toString('hex');

          await db('invoices').insert({
            token,
            invoice_number: sqInvNumber,
            customer_id: customerId,
            title: inv.title || `Square Invoice ${sqInvNumber}`,
            due_date: inv.paymentRequests?.[0]?.dueDate || null,
            line_items: JSON.stringify(lineItems),
            subtotal: total,
            total,
            status,
            sent_at: inv.status === 'SENT' || inv.status === 'PAID' ? inv.updatedAt || inv.createdAt : null,
            paid_at: inv.status === 'PAID' ? inv.updatedAt : null,
            notes: `Imported from Square invoice ${inv.id}`,
          });
          created++;
        } catch (err) {
          errors.push({ invoiceId: inv.id, error: err.message });
          skipped++;
        }
      }

      if (onProgress) {
        onProgress({ phase: 'invoices', status: 'running', totalFetched, created, skipped, errors: errors.length });
      }

      logger.info(`[bulk-import] Invoices page: ${invoices.length} (cursor: ${cursor ? 'yes' : 'done'})`);
    } while (cursor);

    logger.info(`[bulk-import] Phase 4 done: ${totalFetched} fetched, ${created} created, ${skipped} skipped`);
    if (onProgress) onProgress({ phase: 'invoices', status: 'done', totalFetched, created, skipped, errors: errors.length });
    return { totalFetched, created, skipped, errors: errors.slice(0, 50) };
  },

  // =========================================================================
  // Phase 5: Sync All Payments
  // =========================================================================
  async syncAllPayments({ startDate, onProgress } = {}) {
    logger.info('[bulk-import] Phase 5: syncAllPayments starting');
    if (!paymentsApi) throw new Error('Square Payments API not configured');

    const beginTime = startDate ? new Date(startDate).toISOString() : new Date(Date.now() - 365 * 86400000).toISOString();

    let cursor;
    let totalFetched = 0, created = 0, skipped = 0;
    const errors = [];

    // Build customer map
    const custRows = await db('customers').whereNotNull('square_customer_id').select('id', 'square_customer_id');
    const customerMap = {};
    for (const c of custRows) customerMap[c.square_customer_id] = c.id;

    do {
      let response;
      try {
        response = await paymentsApi.listPayments({
          beginTime,
          cursor,
          limit: 100,
        });
      } catch (err) {
        const detail = err.errors?.[0]?.detail || err.message;
        throw new Error(`Square Payments API failed: ${detail}`);
      }

      const payments = response.result?.payments || [];
      cursor = response.result?.cursor;
      totalFetched += payments.length;

      for (const pmt of payments) {
        try {
          // Must have a customer to link to
          const customerId = pmt.customerId ? customerMap[pmt.customerId] : null;
          if (!customerId) { skipped++; continue; }

          // Dedup by square_payment_id
          if (pmt.id) {
            const existing = await db('payments').where({ square_payment_id: pmt.id }).first();
            if (existing) { skipped++; continue; }
          }

          const amount = pmt.amountMoney?.amount ? Number(pmt.amountMoney.amount) / 100 : 0;
          if (amount <= 0) { skipped++; continue; }

          const paymentDate = pmt.createdAt ? new Date(pmt.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

          // Map status
          let status = 'processing';
          if (pmt.status === 'COMPLETED') status = 'paid';
          else if (pmt.status === 'FAILED') status = 'failed';
          else if (pmt.status === 'CANCELED' || pmt.status === 'CANCELLED') status = 'refunded';

          const description = pmt.note || pmt.receiptUrl ? `Square Payment` : 'Square Payment';

          await db('payments').insert({
            customer_id: customerId,
            square_payment_id: pmt.id,
            payment_date: paymentDate,
            amount,
            status,
            description: (pmt.note || 'Square Payment').substring(0, 200),
            metadata: JSON.stringify({
              square_receipt_url: pmt.receiptUrl || null,
              square_order_id: pmt.orderId || null,
              source_type: pmt.sourceType || null,
            }),
          });
          created++;
        } catch (err) {
          errors.push({ paymentId: pmt.id, error: err.message });
          skipped++;
        }
      }

      if (onProgress) {
        onProgress({ phase: 'payments', status: 'running', totalFetched, created, skipped, errors: errors.length });
      }

      logger.info(`[bulk-import] Payments page: ${payments.length} (cursor: ${cursor ? 'yes' : 'done'})`);
    } while (cursor);

    logger.info(`[bulk-import] Phase 5 done: ${totalFetched} fetched, ${created} created, ${skipped} skipped`);
    if (onProgress) onProgress({ phase: 'payments', status: 'done', totalFetched, created, skipped, errors: errors.length });
    return { totalFetched, created, skipped, errors: errors.slice(0, 50) };
  },

  // =========================================================================
  // Phase 6: Sync All Subscriptions
  // =========================================================================
  async syncAllSubscriptions({ onProgress } = {}) {
    logger.info('[bulk-import] Phase 6: syncAllSubscriptions starting');
    if (onProgress) onProgress({ phase: 'subscriptions', status: 'running', message: 'Verifying subscription records...' });

    let created = 0, updated = 0, alreadyValid = 0;
    const errors = [];

    try {
      // Get all customers with monthly_rate > 0 (recurring customers)
      const recurringCustomers = await db('customers')
        .where('monthly_rate', '>', 0)
        .whereNotNull('square_customer_id')
        .select('id', 'first_name', 'last_name', 'square_customer_id', 'monthly_rate', 'waveguard_tier', 'status');

      for (const cust of recurringCustomers) {
        try {
          // Check if they already have an active subscription record
          const existing = await db('customer_subscriptions')
            .where({ customer_id: cust.id, status: 'active' })
            .first();

          if (existing) {
            // Update monthly amount if it has changed
            if (Number(existing.monthly_amount) !== Number(cust.monthly_rate)) {
              await db('customer_subscriptions').where({ id: existing.id }).update({
                monthly_amount: cust.monthly_rate,
                service_type: cust.waveguard_tier || existing.service_type,
                updated_at: new Date(),
              });
              updated++;
            } else {
              alreadyValid++;
            }
            continue;
          }

          // Create a subscription record for this recurring customer
          await db('customer_subscriptions').insert({
            customer_id: cust.id,
            square_customer_id: cust.square_customer_id,
            service_type: cust.waveguard_tier || 'Pest Control',
            status: cust.status === 'active' ? 'active' : 'paused',
            start_date: new Date().toISOString().split('T')[0],
            monthly_amount: cust.monthly_rate,
            created_at: new Date(),
            updated_at: new Date(),
          });
          created++;
        } catch (err) {
          errors.push({ customerId: cust.id, name: `${cust.first_name} ${cust.last_name}`, error: err.message });
        }
      }

      // Calculate MRR from active subscriptions
      const [{ mrr }] = await db('customer_subscriptions')
        .where({ status: 'active' })
        .sum('monthly_amount as mrr');

      const [{ count: activeCount }] = await db('customer_subscriptions')
        .where({ status: 'active' })
        .count('id as count');

      const result = {
        totalRecurring: recurringCustomers.length,
        created,
        updated,
        alreadyValid,
        activeSubscriptions: parseInt(activeCount) || 0,
        mrr: Number(mrr) || 0,
        errors: errors.slice(0, 50),
      };

      logger.info(`[bulk-import] Phase 6 done: ${created} created, ${updated} updated, ${alreadyValid} valid, MRR=$${result.mrr}`);
      if (onProgress) onProgress({ phase: 'subscriptions', status: 'done', ...result });
      return result;
    } catch (err) {
      logger.error(`[bulk-import] Phase 6 failed: ${err.message}`);
      throw err;
    }
  },

  // =========================================================================
  // Phase 7: Sync Refunds — sweep payments for refund data + card details
  // =========================================================================
  async syncRefunds({ onProgress } = {}) {
    logger.info('[bulk-import] Phase 7: syncRefunds starting');
    if (!paymentsApi) throw new Error('Square Payments API not configured');
    if (onProgress) onProgress({ phase: 'refunds', status: 'running', message: 'Sweeping payments for refund data...' });

    // Get all payments with a square_payment_id that haven't been checked
    const payments = await db('payments')
      .whereNotNull('square_payment_id')
      .select('id', 'square_payment_id', 'status', 'receipt_url');

    let checked = 0, refundsFound = 0, cardDetailsAdded = 0;
    const errors = [];

    for (const pmt of payments) {
      try {
        const { result } = await paymentsApi.getPayment(pmt.square_payment_id);
        const sqPmt = result?.payment;
        if (!sqPmt) { checked++; continue; }

        const updates = {};

        // Capture receipt URL
        if (sqPmt.receiptUrl && !pmt.receipt_url) {
          updates.receipt_url = sqPmt.receiptUrl;
        }

        // Capture card details
        if (sqPmt.cardDetails) {
          if (sqPmt.cardDetails.card?.cardBrand) updates.card_brand = sqPmt.cardDetails.card.cardBrand;
          if (sqPmt.cardDetails.card?.last4) updates.card_last_four = sqPmt.cardDetails.card.last4;
          if (updates.card_brand || updates.card_last_four) cardDetailsAdded++;
        }

        // Capture order ID
        if (sqPmt.orderId) {
          updates.square_order_id = sqPmt.orderId;
        }

        // Check for refunds
        if (sqPmt.refundedMoney?.amount) {
          const refundAmount = Number(sqPmt.refundedMoney.amount) / 100;
          updates.refund_amount = refundAmount;
          updates.refunded_at = sqPmt.updatedAt ? new Date(sqPmt.updatedAt) : new Date();

          // Determine refund status
          const totalAmount = sqPmt.amountMoney?.amount ? Number(sqPmt.amountMoney.amount) / 100 : 0;
          if (refundAmount >= totalAmount) {
            updates.status = 'refunded';
            updates.refund_status = 'full';
          } else {
            updates.refund_status = 'partial';
          }
          refundsFound++;
        }

        if (Object.keys(updates).length > 0) {
          await db('payments').where({ id: pmt.id }).update(updates);
        }

        checked++;
        await delay(100); // Rate limit: 100ms between calls

        if (onProgress && checked % 50 === 0) {
          onProgress({ phase: 'refunds', status: 'running', checked, total: payments.length, refundsFound, cardDetailsAdded });
        }
      } catch (err) {
        errors.push({ paymentId: pmt.square_payment_id, error: err.message });
        checked++;
        await delay(100);
      }
    }

    const result = {
      totalChecked: checked,
      refundsFound,
      cardDetailsAdded,
      errors: errors.slice(0, 50),
    };

    logger.info(`[bulk-import] Phase 7 done: ${checked} checked, ${refundsFound} refunds found, ${cardDetailsAdded} card details added`);
    if (onProgress) onProgress({ phase: 'refunds', status: 'done', ...result });
    return result;
  },

  // =========================================================================
  // Subscription Report
  // =========================================================================
  async getSubscriptionReport() {
    const subs = await db('customer_subscriptions as cs')
      .join('customers as c', 'cs.customer_id', 'c.id')
      .where('cs.status', 'active')
      .select(
        'c.id as customer_id',
        'c.first_name',
        'c.last_name',
        'c.waveguard_tier',
        'cs.monthly_amount',
        'cs.start_date',
        'cs.service_type',
        'c.square_customer_id'
      )
      .orderBy('cs.monthly_amount', 'desc');

    // Check which customers have a Stripe card on file
    const customerIds = subs.map(s => s.customer_id);
    let cardMap = {};
    if (customerIds.length > 0) {
      const cards = await db('payment_methods')
        .whereIn('customer_id', customerIds)
        .select('customer_id');
      for (const c of cards) cardMap[c.customer_id] = true;
    }

    const subscribers = subs.map(s => ({
      customer_id: s.customer_id,
      name: `${s.first_name} ${s.last_name}`,
      tier: s.waveguard_tier || s.service_type || 'Standard',
      monthly_rate: Number(s.monthly_amount) || 0,
      start_date: s.start_date,
      has_card: !!cardMap[s.customer_id],
    }));

    const mrr = subscribers.reduce((sum, s) => sum + s.monthly_rate, 0);

    return {
      subscribers,
      count: subscribers.length,
      mrr,
      arr: mrr * 12,
    };
  },

  // =========================================================================
  // Master: Run Full Import
  // =========================================================================
  async runFullImport({ onProgress } = {}) {
    logger.info('[bulk-import] === FULL 8-PHASE IMPORT STARTING ===');
    const startTime = Date.now();
    const results = {};
    const allErrors = [];

    const totalPhases = 8;

    // Phase 1
    try {
      if (onProgress) onProgress({ phase: 'customers', status: 'starting', phaseNumber: 1, totalPhases });
      results.customers = await this.syncAllCustomers({ onProgress });
    } catch (err) {
      results.customers = { error: err.message };
      allErrors.push({ phase: 'customers', error: err.message });
      logger.error(`[bulk-import] Phase 1 failed: ${err.message}`);
    }

    // Phase 2
    try {
      if (onProgress) onProgress({ phase: 'history', status: 'starting', phaseNumber: 2, totalPhases });
      results.history = await this.syncAllHistory({ onProgress, batchSize: 10, delayBetweenBatches: 2000 });
    } catch (err) {
      results.history = { error: err.message };
      allErrors.push({ phase: 'history', error: err.message });
      logger.error(`[bulk-import] Phase 2 failed: ${err.message}`);
    }

    // Phase 3
    try {
      if (onProgress) onProgress({ phase: 'bookings', status: 'starting', phaseNumber: 3, totalPhases });
      results.bookings = await this.syncAllBookings({ onProgress });
    } catch (err) {
      results.bookings = { error: err.message };
      allErrors.push({ phase: 'bookings', error: err.message });
      logger.error(`[bulk-import] Phase 3 failed: ${err.message}`);
    }

    // Phase 4
    try {
      if (onProgress) onProgress({ phase: 'invoices', status: 'starting', phaseNumber: 4, totalPhases });
      results.invoices = await this.syncAllInvoices({ onProgress });
    } catch (err) {
      results.invoices = { error: err.message };
      allErrors.push({ phase: 'invoices', error: err.message });
      logger.error(`[bulk-import] Phase 4 failed: ${err.message}`);
    }

    // Phase 5
    try {
      if (onProgress) onProgress({ phase: 'payments', status: 'starting', phaseNumber: 5, totalPhases });
      results.payments = await this.syncAllPayments({ onProgress });
    } catch (err) {
      results.payments = { error: err.message };
      allErrors.push({ phase: 'payments', error: err.message });
      logger.error(`[bulk-import] Phase 5 failed: ${err.message}`);
    }

    // Phase 6
    try {
      if (onProgress) onProgress({ phase: 'subscriptions', status: 'starting', phaseNumber: 6, totalPhases });
      results.subscriptions = await this.syncAllSubscriptions({ onProgress });
    } catch (err) {
      results.subscriptions = { error: err.message };
      allErrors.push({ phase: 'subscriptions', error: err.message });
      logger.error(`[bulk-import] Phase 6 failed: ${err.message}`);
    }

    // Phase 7
    try {
      if (onProgress) onProgress({ phase: 'refunds', status: 'starting', phaseNumber: 7, totalPhases });
      results.refunds = await this.syncRefunds({ onProgress });
    } catch (err) {
      results.refunds = { error: err.message };
      allErrors.push({ phase: 'refunds', error: err.message });
      logger.error(`[bulk-import] Phase 7 failed: ${err.message}`);
    }

    // Phase 8: Recalculate customer totals
    try {
      if (onProgress) onProgress({ phase: 'totals', status: 'starting', phaseNumber: 8, totalPhases });
      await this._recalculateCustomerTotals();
      if (onProgress) onProgress({ phase: 'totals', status: 'done', message: 'Customer totals recalculated' });
    } catch (err) {
      allErrors.push({ phase: 'totals', error: err.message });
      logger.error(`[bulk-import] Phase 8 totals recalculation failed: ${err.message}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[bulk-import] === FULL IMPORT COMPLETE in ${elapsed}s ===`);

    return {
      success: allErrors.length === 0,
      elapsed: `${elapsed}s`,
      phases: results,
      errors: allErrors,
    };
  },

  // =========================================================================
  // Recalculate customer totals
  // =========================================================================
  async _recalculateCustomerTotals() {
    const customers = await db('customers').select('id');
    for (const cust of customers) {
      try {
        const [{ total }] = await db('payments')
          .where({ customer_id: cust.id, status: 'paid' })
          .sum('amount as total');

        const [{ count }] = await db('service_records')
          .where({ customer_id: cust.id })
          .count('id as count');

        await db('customers').where({ id: cust.id }).update({
          lifetime_revenue: total || 0,
          total_services: parseInt(count) || 0,
          updated_at: new Date(),
        });
      } catch { /* skip individual customer errors */ }
    }
    logger.info(`[bulk-import] Recalculated totals for ${customers.length} customers`);
  },

  // =========================================================================
  // Cleanup: dedup, fix descriptions, update totals
  // =========================================================================
  async cleanupImportedData() {
    logger.info('[bulk-import] Cleanup starting');
    let deduped = 0, descFixed = 0;

    // 1. Dedup service_records: same customer + date + type, keep the one with most data
    try {
      const dupes = await db('service_records')
        .select('customer_id', 'service_date', 'service_type')
        .groupBy('customer_id', 'service_date', 'service_type')
        .havingRaw('COUNT(*) > 1');

      for (const dup of dupes) {
        const records = await db('service_records')
          .where({
            customer_id: dup.customer_id,
            service_date: dup.service_date,
            service_type: dup.service_type,
          })
          .orderByRaw('(CASE WHEN technician_notes IS NOT NULL THEN 1 ELSE 0 END) DESC')
          .orderBy('created_at', 'desc');

        if (records.length > 1) {
          const idsToDelete = records.slice(1).map(r => r.id);
          await db('service_records').whereIn('id', idsToDelete).del();
          deduped += idsToDelete.length;
        }
      }
    } catch (err) {
      logger.error(`[bulk-import] Dedup service_records failed: ${err.message}`);
    }

    // 2. Fix generic descriptions like "Service" → better labels
    try {
      const generic = await db('service_records')
        .whereIn('service_type', ['Service', 'service', ''])
        .select('id', 'customer_id', 'service_date');

      for (const rec of generic) {
        // Try to match with a payment to get a better description
        const payment = await db('payments')
          .where({ customer_id: rec.customer_id, payment_date: rec.service_date })
          .whereNot('description', 'Square Payment')
          .first();

        if (payment?.description) {
          await db('service_records').where({ id: rec.id }).update({
            service_type: payment.description.replace(/^Square:\s*/, '').substring(0, 100),
          });
          descFixed++;
        } else {
          await db('service_records').where({ id: rec.id }).update({
            service_type: 'Pest Control Service',
          });
          descFixed++;
        }
      }
    } catch (err) {
      logger.error(`[bulk-import] Fix descriptions failed: ${err.message}`);
    }

    // 3. Recalculate customer totals
    await this._recalculateCustomerTotals();

    logger.info(`[bulk-import] Cleanup done: ${deduped} duplicates removed, ${descFixed} descriptions fixed`);
    return { deduped, descFixed };
  },
};

module.exports = SquareBulkImport;
