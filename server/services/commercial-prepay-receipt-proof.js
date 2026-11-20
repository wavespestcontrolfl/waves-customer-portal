'use strict';

// Read-only proof for the original invoice behind an unbooked commercial
// prepay. This module deliberately does not activate coverage, move a setup
// claim, or write a payment projection: it only classifies the live money
// ledger as collected, returned, or insufficiently attributable.
const {
  invoiceDepositCreditCents,
  invoicePrincipalCents,
  refundedPaymentOwnsInvoice,
} = require('./invoice-helpers');

const cents = (value) => Math.round((Number(value) || 0) * 100);
const millis = (value) => (value ? new Date(value).getTime() : null);

function metadata(value) {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function metadataInvoiceId(payment) {
  const value = metadata(payment?.metadata);
  return value.invoice_id || value.invoiceId || value.waves_invoice_id || null;
}

function providerKey(payment) {
  if (payment.stripe_charge_id) return `charge:${payment.stripe_charge_id}`;
  if (payment.stripe_payment_intent_id) {
    return `intent:${String(payment.stripe_payment_intent_id).split(':')[0]}`;
  }
  return `payment:${payment.id}`;
}

function billToMatches(invoice, payment) {
  const value = metadata(payment.metadata);
  if (invoice.payer_id) {
    const payerIds = [payment.payer_id, value.payer_id].filter(Boolean);
    return payerIds.length > 0 && payerIds.every((id) => String(id) === String(invoice.payer_id));
  }
  return String(payment.customer_id || '') === String(invoice.customer_id)
    && !payment.payer_id && !value.payer_id;
}

function requiredInvoicePrincipalCents(invoice) {
  const totalCents = Math.max(0, cents(invoice.total));
  const principalCents = invoice.subtotal != null ? invoicePrincipalCents(invoice) : totalCents;
  return principalCents > 0 ? principalCents : totalCents;
}

function newestRowsBy(rows, keyFor) {
  const latest = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const prior = latest.get(key);
    const at = millis(row.updated_at) ?? millis(row.created_at) ?? 0;
    const priorAt = millis(prior?.updated_at) ?? millis(prior?.created_at) ?? 0;
    if (!prior || at >= priorAt) latest.set(key, row);
  }
  return [...latest.values()];
}

async function providerInvoiceLinkIsUnique(conn, invoice) {
  const rows = await conn('invoices')
    .where(function providerIdentity() {
      if (invoice.stripe_charge_id) this.where('stripe_charge_id', invoice.stripe_charge_id);
      else this.where('stripe_payment_intent_id', invoice.stripe_payment_intent_id);
    })
    .select('id')
    .limit(2);
  return rows.length === 1 && String(rows[0].id) === String(invoice.id);
}

async function manualPaymentChain(conn, invoice, { partialOnly = false } = {}) {
  const { MANUAL_PAYMENT_RECORDED_ACTION } = require('./invoice-manual-payment');
  const recordedAt = millis(invoice.payment_recorded_at);
  if (recordedAt == null) return [];
  const markers = await conn('audit_log')
    .where({
      action: MANUAL_PAYMENT_RECORDED_ACTION,
      resource_type: 'invoices',
      resource_id: invoice.id,
    })
    .orderBy('created_at', 'desc')
    .select('created_at', 'metadata');
  const byTime = new Map(markers.map((marker) => [millis(marker.created_at), marker]));
  const paymentIds = [];
  const seenTimes = new Set();
  let markerAt = recordedAt;
  while (markerAt != null && !seenTimes.has(markerAt)) {
    seenTimes.add(markerAt);
    const marker = byTime.get(markerAt);
    const value = metadata(marker?.metadata);
    if (!marker || !value.paymentId) break;
    if (!partialOnly || value.partial === true) paymentIds.push(value.paymentId);
    markerAt = millis(value.previous?.payment_recorded_at);
  }
  if (!paymentIds.length) return [];
  const rows = await conn('payments').whereIn('id', paymentIds);
  const markerTimes = new Map(markers.map((marker) => [
    String(metadata(marker.metadata).paymentId || ''), millis(marker.created_at),
  ]));
  return rows.filter((row) => String(row.customer_id) === String(invoice.customer_id)
    && millis(row.created_at) === markerTimes.get(String(row.id)));
}

function customer360ShapeMatches(invoice, row, value, requiredCents) {
  const hasPrincipal = Object.hasOwn(value, 'principal_cents');
  const hasPayer = Object.hasOwn(value, 'payer_id');
  if (hasPrincipal !== hasPayer) return false;
  if (hasPrincipal) {
    return Number(value.principal_cents) === requiredCents
      && String(value.payer_id || '') === String(invoice.payer_id || '')
      && String(row.payer_id || '') === String(invoice.payer_id || '');
  }
  // Before payer/principal snapshots, this writer was self-pay only and the
  // payment row shared the invoice recording transaction timestamp.
  return !invoice.payer_id && !row.payer_id && !!invoice.payment_recorded_at
    && millis(row.created_at) === millis(invoice.payment_recorded_at);
}

async function customer360Receipt(conn, invoice) {
  const rows = await conn('payments')
    .where({ customer_id: invoice.customer_id })
    .whereNull('stripe_charge_id')
    .whereNull('stripe_payment_intent_id')
    .whereRaw("metadata->>'invoice_id' = ?", [String(invoice.id)])
    .whereRaw("metadata->>'source' = 'customer360_annual_prepay'");
  if (!rows.length) return null;
  if (rows.length !== 1) return [];
  const term = await conn('annual_prepay_terms')
    .where({ customer_id: invoice.customer_id, prepay_invoice_id: invoice.id })
    .first('id');
  if (!term) return [];
  const requiredCents = requiredInvoicePrincipalCents(invoice);
  const verified = rows.filter((row) => {
    const value = metadata(row.metadata);
    return String(value.annual_prepay_term_id || '') === String(term.id)
      && !!invoice.payment_method
      && value.method === invoice.payment_method
      && customer360ShapeMatches(invoice, row, value, requiredCents)
      && billToMatches(invoice, row)
      && cents(row.amount) === requiredCents;
  });
  return verified.length === 1 ? verified : [];
}

async function sourcePayments(conn, invoice) {
  if (invoice.stripe_charge_id || invoice.stripe_payment_intent_id) {
    const rows = await conn('payments').where(function providerIdentity() {
      if (invoice.stripe_charge_id) this.orWhere('stripe_charge_id', invoice.stripe_charge_id);
      if (invoice.stripe_payment_intent_id) {
        this.orWhere('stripe_payment_intent_id', invoice.stripe_payment_intent_id)
          .orWhere('stripe_payment_intent_id', `${invoice.stripe_payment_intent_id}:${invoice.id}`);
      }
    });
    const suffixedIntent = invoice.stripe_payment_intent_id
      ? `${invoice.stripe_payment_intent_id}:${invoice.id}` : null;
    const owned = rows.filter((row) => {
      if (!billToMatches(invoice, row)) return false;
      if (invoice.stripe_charge_id) {
        return String(row.stripe_charge_id || '') === String(invoice.stripe_charge_id);
      }
      return String(row.stripe_payment_intent_id || '') === String(suffixedIntent || '')
        || refundedPaymentOwnsInvoice(invoice, {
          chargeId: row.stripe_charge_id,
          paymentIntentId: row.stripe_payment_intent_id,
        });
    });
    const tagged = owned.filter((row) => String(metadataInvoiceId(row) || '') === String(invoice.id));
    const untagged = owned.filter((row) => !metadataInvoiceId(row));
    const singleUntagged = owned.length === 1 && untagged.length === 1
      && await providerInvoiceLinkIsUnique(conn, invoice);
    const allocation = tagged.length ? tagged : singleUntagged ? untagged : [];
    const providerRows = newestRowsBy(allocation, providerKey);
    const manualParts = await manualPaymentChain(conn, invoice, { partialOnly: true });
    return [...providerRows, ...manualParts.filter((part) =>
      !providerRows.some((row) => String(row.id) === String(part.id)))];
  }

  const manual = await manualPaymentChain(conn, invoice);
  if (manual.length) return manual;
  if (String(invoice.status || '').toLowerCase() === 'prepaid'
    && (cents(invoice.credit_applied) > 0 || invoiceDepositCreditCents(invoice) > 0)) return [];

  const recorded = await customer360Receipt(conn, invoice);
  if (recorded != null) return recorded;

  const scheduledRows = await conn('payments')
    .where({ customer_id: invoice.customer_id })
    .whereNull('stripe_charge_id')
    .whereNull('stripe_payment_intent_id')
    .whereRaw("metadata->>'invoice_id' = ?", [String(invoice.id)])
    .whereRaw("metadata->>'source' = 'scheduled_service_prepaid'");
  const scheduled = newestRowsBy(scheduledRows,
    (row) => String(metadata(row.metadata).scheduled_service_id || row.id));
  const lostDisputes = await conn('payments')
    .where({ status: 'disputed' })
    .whereRaw("metadata->>'dispute_invoice_id' = ?", [String(invoice.id)])
    .whereRaw("metadata->>'dispute_final' = 'lost'")
    .orderByRaw('COALESCE(updated_at, created_at) DESC');
  const latestLost = lostDisputes.find((row) => billToMatches(invoice, row));
  if (!latestLost) return scheduled;
  const latestScheduledAt = scheduled.reduce((latest, row) => Math.max(latest,
    millis(row.updated_at) ?? millis(row.created_at) ?? 0), 0);
  const lostAt = millis(latestLost.updated_at) ?? millis(latestLost.created_at) ?? 0;
  return latestScheduledAt > lostAt ? scheduled : [latestLost];
}

function fullRefund(payment) {
  const value = metadata(payment.metadata);
  const fullLostDispute = payment.status === 'disputed'
    && value.dispute_final === 'lost'
    && value.dispute_full_payment === true
    && !!value.dispute_invoice_id;
  return payment.status === 'refunded' || payment.refund_status === 'full' || fullLostDispute;
}

async function hasUnresolvedCombinedPartialRefund(conn, invoice, payments) {
  if (!invoice.stripe_charge_id
    || !payments.some((payment) => metadata(payment.metadata).combined_payment === true)) return false;
  const row = await conn('stripe_orphan_charges')
    .where({
      stripe_charge_id: invoice.stripe_charge_id,
      source: 'combined_pay_webhook',
      resolved: false,
    })
    .where('stripe_payment_intent_id', 'like', '%:partial-refund:%')
    .first('id');
  return !!row;
}

function recordedCents(column, dollars) {
  if (column != null) return Number(column);
  return dollars == null ? null : Math.round(Number(dollars) * 100);
}

function withinAmount(value, limit) {
  return Number.isInteger(value) && value >= 0 && value <= limit;
}

function paymentAmounts(payment) {
  const value = metadata(payment.metadata);
  const gross = cents(payment.amount);
  const explicitBase = recordedCents(payment.base_amount_cents, value.base_amount);
  const explicitSurcharge = recordedCents(payment.surcharge_amount_cents, value.card_surcharge);
  if (payment.processor === 'stripe' && explicitBase == null && explicitSurcharge == null) return null;
  const surcharge = explicitSurcharge ?? 0;
  const baseCents = explicitBase ?? gross - surcharge;
  if (!withinAmount(baseCents, gross) || !withinAmount(surcharge, gross)) return null;
  if (Math.abs(baseCents + surcharge - gross) > 1) return null;
  const refund = cents(payment.refund_amount);
  if (fullRefund(payment)) {
    if (payment.status !== 'disputed' && refund !== gross) return null;
    return { baseCents, netBaseCents: 0 };
  }
  const refundedSurcharge = Number(payment.refunded_surcharge_cents ?? 0);
  const recordedRefundBase = Number(payment.refunded_base_cents ?? 0);
  const refundBase = recordedRefundBase || refund - refundedSurcharge;
  if (!withinAmount(refund, gross) || !withinAmount(refundedSurcharge, surcharge)
    || !withinAmount(refundBase, baseCents)) return null;
  if (Math.abs(refundBase + refundedSurcharge - refund) > 1) return null;
  return { baseCents, netBaseCents: baseCents - refundBase };
}

function creditMovementKind(invoice, row) {
  const note = String(row.note || '');
  const label = invoice.invoice_number || invoice.id;
  if (row.source === 'adjustment'
    && (note === `Prepaid reversal for ${label}` || note.startsWith(`Prepaid reversal for ${label} — `))) {
    return 'prepaid_reversal';
  }
  if (row.source === 'adjustment'
    && note === `Account credit returned — invoice ${label} fully refunded`) return 'refund_return';
  if (row.source === 'adjustment') {
    const projectReturn = note.match(/^Project send failed — returned \$([0-9]+(?:\.[0-9]{1,2})?) applied credit$/);
    const canonicalUnwind = note === `Auto-applied credit reversed — invoice ${label} not delivered`
      || note === `Account credit returned — invoice ${label} voided`
      || note === 'Account credit returned — invoice re-routed to third-party payer'
      || /^Bill-To moved to payer .+ — homeowner credit returned$/.test(note)
      || (projectReturn && cents(projectReturn[1]) === cents(row.delta));
    if (canonicalUnwind) return 'application_unwind';
  }
  if (['invoice_application', 'invoice_prepaid'].includes(row.source)) return 'application';
  return null;
}

function creditMovementEvidence(invoice, rows) {
  const movements = rows.map((row) => ({
    delta: cents(row.delta),
    kind: creditMovementKind(invoice, row),
    at: millis(row.created_at),
  })).filter(({ delta }) => delta !== 0);
  const groups = [];
  let invalidTimestamp = false;
  for (const movement of movements.filter(({ kind }) => kind)) {
    if (movement.at == null) invalidTimestamp = true;
    const previous = groups[groups.length - 1];
    if (previous?.at === movement.at) previous.movements.push(movement);
    else groups.push({ at: movement.at, movements: [movement] });
  }
  return {
    groups,
    invalidTimestamp,
    hasApplication: movements.some(({ kind }) => kind === 'application'),
    hasUnknown: movements.some(({ kind }) => !kind),
  };
}

function creditGroupTotals(group) {
  const applications = group.movements.filter(({ kind }) => kind === 'application');
  const returns = group.movements.filter(({ kind }) => kind !== 'application');
  return {
    invalidSign: applications.some(({ delta }) => delta >= 0)
      || returns.some(({ delta }) => delta <= 0),
    appliedCents: applications.reduce((sum, movement) => sum - movement.delta, 0),
    returnedCents: returns.reduce((sum, movement) => sum + movement.delta, 0),
    returnKinds: new Set(returns.map(({ kind }) => kind)),
  };
}

function detachedRefundBeforeApplication({ sawApplication, appliedCents, returnKinds }) {
  return !sawApplication && appliedCents === 0
    && returnKinds.size === 1 && returnKinds.has('refund_return');
}

async function committedCreditEvidence(conn, invoice, requiredCents) {
  const recorded = Math.max(0, cents(invoice.credit_applied));
  const rows = await conn('customer_credit_ledger')
    .where({ invoice_id: invoice.id, customer_id: invoice.customer_id })
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'delta', 'source', 'note', 'created_at');
  const evidence = creditMovementEvidence(invoice, rows);
  if (evidence.invalidTimestamp || (evidence.hasUnknown && (evidence.hasApplication || recorded > 0))) return null;

  let consumed = 0;
  let lastFullReturn = null;
  let sawApplication = false;
  let latestApplicationAt = null;
  const refundEpisodes = [];
  for (const group of evidence.groups) {
    const { invalidSign, appliedCents, returnedCents, returnKinds } = creditGroupTotals(group);
    if (invalidSign) return null;
    const beforeReturns = consumed + appliedCents;
    if (beforeReturns > requiredCents) return null;
    if (appliedCents > 0) {
      sawApplication = true;
      latestApplicationAt = group.at;
      lastFullReturn = null;
    }
    if (!returnedCents) {
      consumed = beforeReturns;
      continue;
    }
    if (returnedCents > beforeReturns) {
      if (detachedRefundBeforeApplication({ sawApplication, appliedCents, returnKinds })) continue;
      return null;
    }
    if (returnKinds.size !== 1 || returnedCents !== beforeReturns) return null;
    const [returnKind] = returnKinds;
    if (returnKind === 'refund_return') {
      refundEpisodes.push({
        appliedAt: latestApplicationAt,
        returnedAt: group.at,
        cents: returnedCents,
      });
    }
    consumed = 0;
    lastFullReturn = beforeReturns === requiredCents ? returnKind : null;
    latestApplicationAt = null;
  }
  if (consumed !== recorded) return null;
  return {
    committedCents: recorded,
    prepaidReversed: recorded === 0 && sawApplication && lastFullReturn === 'prepaid_reversal',
    refundEpisodes,
  };
}

async function readReceiptState(conn, invoice) {
  if (!invoice || invoice.payer_statement_id) return null;
  const payments = (await sourcePayments(conn, invoice)).filter((row) =>
    billToMatches(invoice, row) && (row.status !== 'disputed'
      || String(metadata(row.metadata).dispute_invoice_id || '') === String(invoice.id)));
  if (await hasUnresolvedCombinedPartialRefund(conn, invoice, payments)) return 'unconfirmed';
  const money = payments.filter((payment) => payment.status === 'paid' || fullRefund(payment));
  const valued = money.map((payment) => ({ payment, amounts: paymentAmounts(payment) }));
  const depositCents = invoiceDepositCreditCents(invoice);
  const deposits = require('./estimate-deposits');
  const depositBacked = depositCents > 0
    ? await deposits.invoiceDepositCreditIsBacked(invoice, conn, { exactSourceBinding: true })
    : true;
  const depositReturn = depositCents > 0
    ? await deposits.readInvoiceDepositCreditReturn(invoice, conn)
    : null;
  // A live receipt needs the exact current allocation. A refunded receipt may
  // instead use the immutable before-image written by the same transaction
  // that made the deposit reusable; an unbound partial allocation supplies
  // neither and stays unknown.
  if (depositCents > 0 && !depositBacked && !depositReturn) return 'unconfirmed';
  const requiredCents = requiredInvoicePrincipalCents(invoice) + depositCents;
  const credit = await committedCreditEvidence(conn, invoice, requiredCents);
  if (valued.some(({ amounts }) => amounts == null) || credit == null) return 'unconfirmed';
  const paid = valued.filter(({ payment }) => payment.status === 'paid' && !fullRefund(payment));
  const paidCents = paid.reduce((sum, row) => sum + row.amounts.netBaseCents, 0);
  const collected = require('./annual-prepay-renewals')._private.invoiceTermStatus(invoice) === 'active';
  if (collected && requiredCents > 0
    && depositBacked
    && paidCents + credit.committedCents + depositCents === requiredCents) return 'active';
  if (depositCents === 0 && !paid.length && credit.prepaidReversed) return 'cancelled';
  const refundedBaseCents = valued.filter(({ payment }) => fullRefund(payment))
    .reduce((sum, row) => sum + row.amounts.baseCents, 0);
  if (!refundedBaseCents || paid.length) return 'unconfirmed';
  const missing = requiredCents - refundedBaseCents;
  if (missing < 0) return 'unconfirmed';
  if (depositCents === 0 && missing === 0) return 'cancelled';
  if (invoice.status === 'refunded') {
    const providerTimes = money.filter(fullRefund).map((row) => millis(row.created_at));
    if (providerTimes.every((at) => at != null)) {
      const providerStartedAt = Math.min(...providerTimes);
      const providerCompletedAt = Math.max(...providerTimes);
      // payments.updated_at is the refund ledger timestamp written by every
      // full-refund path; created_at is the original collection time. The
      // immutable deposit return must belong to this refund episode, not just
      // post-date the charge it may have been released against previously.
      const refundTimes = money.filter(fullRefund)
        .map((row) => millis(row.updated_at) ?? millis(row.created_at));
      if (refundTimes.some((at) => at == null)) return 'unconfirmed';
      const refundCompletedAt = Math.max(...refundTimes);
      // The deposit return must cover this invoice's whole deposit share and
      // occur no earlier than this provider-refund episode. An older release
      // (or one attached to another invoice) cannot complete a later refund.
      const returnedDepositCents = depositReturn?.returnedCents || 0;
      if (depositCents > 0 && (depositBacked || returnedDepositCents !== depositCents
        || depositReturn.returnedAt < refundCompletedAt)) return 'unconfirmed';
      const creditMissing = missing - returnedDepositCents;
      if (creditMissing === 0) return 'cancelled';
      if (creditMissing < 0) return 'unconfirmed';
      const matching = credit.refundEpisodes.filter((episode) => episode.cents === creditMissing
        && episode.appliedAt <= providerStartedAt && episode.returnedAt >= providerCompletedAt);
      if (matching.length === 1) return 'cancelled';
    }
  }
  return 'unconfirmed';
}

module.exports = { readReceiptState };
