const crypto = require('crypto');
const db = require('../models/db');
const {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  normalizeEstimateDethatchingManagerApproval,
  validateEstimateDeliveryOptions,
} = require('./estimate-delivery-options');
const {
  attachLeadToEstimate,
  assertLeadCanAttachEstimate,
} = require('./lead-estimate-link');
const { clearEstimatePricingCache } = require('./estimate-pricing-cache');
const { inferEstimateServiceInterest } = require('./estimate-service-lines');

function errorWithStatus(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeLinkedLeadId(leadId) {
  return typeof leadId === 'string' ? leadId.trim() : leadId;
}

function estimateViewUrl(token) {
  return `https://portal.wavespestcontrol.com/estimate/${token}`;
}

function estimateExpiresAt(now = () => new Date()) {
  const expiresAt = new Date(now().getTime());
  expiresAt.setDate(expiresAt.getDate() + 7);
  return expiresAt;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function positiveMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : null;
}

function moneyValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundMoney(n) : null;
}

function nonNegativeMoney(value) {
  const amount = moneyValue(value);
  return amount !== null && amount >= 0 ? amount : null;
}

function fallbackMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? roundMoney(n) : 0;
}

function estimateResultRoot(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return {};
  return estimateData.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
}

function sumPositiveAmounts(rows = [], fields = ['price']) {
  return roundMoney((rows || []).reduce((sum, row) => {
    if (!row || typeof row !== 'object') return sum;
    for (const field of fields) {
      const amount = positiveMoney(row[field]);
      if (amount !== null) return sum + amount;
    }
    return sum;
  }, 0));
}

function sumSignedAmounts(rows = [], fields = ['price']) {
  return roundMoney((rows || []).reduce((sum, row) => {
    if (!row || typeof row !== 'object') return sum;
    for (const field of fields) {
      const amount = moneyValue(row[field]);
      if (amount !== null) return sum + amount;
    }
    return sum;
  }, 0));
}

function isApprovedDethatchingManagerRow(row = {}) {
  if (!row || typeof row !== 'object') return false;
  const service = String(row.service || row.key || '').toLowerCase();
  const label = String(row.name || row.label || row.displayName || '').toLowerCase();
  return (service.includes('dethatch') || label.includes('dethatch')) &&
    row.managerApproved === true &&
    row.managerApprovalSatisfied === true &&
    !!row.managerApprovalOverrideReason &&
    moneyValue(row.price) !== null;
}

function deriveTotalsFromEstimateData(estimateData) {
  const result = estimateResultRoot(estimateData);
  const recurring = result.recurring && typeof result.recurring === 'object'
    ? result.recurring
    : {};
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  const recurringRows = [
    ...(Array.isArray(recurring.services) ? recurring.services : []),
    ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
  ];
  const recurringRowsMonthly = sumPositiveAmounts(recurringRows, ['mo', 'monthly']);
  const monthlyTotal = positiveMoney(recurring.grandTotal) ??
    positiveMoney(recurring.monthlyTotal) ??
    positiveMoney(recurring.monthly) ??
    positiveMoney(nestedRecurring.grandTotal) ??
    positiveMoney(nestedRecurring.monthlyTotal) ??
    positiveMoney(result.totals?.year2mo) ??
    positiveMoney(recurringRowsMonthly);

  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const oneTimeRows = [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
  ];
  const oneTimeMembershipFee = positiveMoney(oneTime.membershipFee) ?? 0;
  const oneTimeRowsTotal = roundMoney(
    sumSignedAmounts(oneTimeRows, ['price', 'estimatedPrice', 'baseEstimatePrice']) +
    oneTimeMembershipFee
  );
  const topLevelSpecRows = Array.isArray(result.specItems)
    ? result.specItems.filter((row) => row?.onProg !== true && row?.includedOnProgram !== true)
    : [];
  const topLevelSpecRowsTotal = sumSignedAmounts(
    topLevelSpecRows,
    ['price', 'estimatedPrice', 'baseEstimatePrice']
  );
  const explicitOneTimeTotal = nonNegativeMoney(oneTime.total);
  const hasOneTimeDerivedSource = oneTimeRows.length > 0 || oneTimeMembershipFee > 0;
  const derivedOneTimeTotal = (
    hasOneTimeDerivedSource ? nonNegativeMoney(oneTimeRowsTotal) : null
  ) ?? (
    topLevelSpecRows.length > 0
      ? nonNegativeMoney(topLevelSpecRowsTotal)
      : null
  );
  const hasApprovedDethatchingManagerRow = oneTimeRows.some((row) => isApprovedDethatchingManagerRow(row));
  const oneTimeTotal = explicitOneTimeTotal !== null
    ? (
        hasApprovedDethatchingManagerRow && derivedOneTimeTotal !== null && derivedOneTimeTotal > explicitOneTimeTotal
          ? derivedOneTimeTotal
          : explicitOneTimeTotal
      )
    : derivedOneTimeTotal;

  const annualTotal = positiveMoney(result.totals?.year2) ??
    positiveMoney(recurring.annualTotal) ??
    positiveMoney(nestedRecurring.annualTotal) ??
    (monthlyTotal !== null ? roundMoney(monthlyTotal * 12) : null) ??
    positiveMoney(recurring.annualAfterDiscount) ??
    positiveMoney(nestedRecurring.annualAfterDiscount);

  return {
    monthlyTotal,
    annualTotal,
    onetimeTotal: oneTimeTotal,
  };
}

function resolveBillableTotals(body, estimateData, quoteRequired) {
  if (quoteRequired) {
    return { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 0 };
  }
  const derived = deriveTotalsFromEstimateData(estimateData);
  const monthlyTotal = derived.monthlyTotal ?? fallbackMoney(body.monthlyTotal);
  const onetimeTotal = derived.onetimeTotal ?? fallbackMoney(body.onetimeTotal);
  const annualTotal = derived.annualTotal ??
    (monthlyTotal > 0 ? roundMoney(monthlyTotal * 12) : fallbackMoney(body.annualTotal));
  return { monthlyTotal, annualTotal, onetimeTotal };
}

function applyResolvedTotalsToEstimateData(estimateData, totals, quoteRequired) {
  if (!estimateData || typeof estimateData !== 'object' || quoteRequired) return;
  const result = estimateResultRoot(estimateData);
  if (!result || typeof result !== 'object') return;

  if (result.oneTime && typeof result.oneTime === 'object' && totals.onetimeTotal > 0) {
    result.oneTime.total = totals.onetimeTotal;
    if (Object.prototype.hasOwnProperty.call(result.oneTime, 'otSubtotal')) {
      result.oneTime.otSubtotal = roundMoney(totals.onetimeTotal - fallbackMoney(result.oneTime.tmInstall));
    }
  }

  if (result.recurring && typeof result.recurring === 'object' && totals.monthlyTotal > 0) {
    result.recurring.grandTotal = totals.monthlyTotal;
    result.recurring.monthlyTotal = totals.monthlyTotal;
    if (totals.annualTotal > 0 && Object.prototype.hasOwnProperty.call(result.recurring, 'annualTotal')) {
      result.recurring.annualTotal = totals.annualTotal;
    }
  }

  if (result.totals && typeof result.totals === 'object') {
    if (totals.monthlyTotal > 0) result.totals.year2mo = totals.monthlyTotal;
    if (totals.annualTotal > 0) result.totals.year2 = totals.annualTotal;
    const year1 = roundMoney(fallbackMoney(totals.annualTotal) + fallbackMoney(totals.onetimeTotal));
    if (year1 > 0) result.totals.year1 = year1;
  }
}

function buildEstimatePersistenceFields(body, context = {}) {
  const estimateData = normalizeEstimateDethatchingManagerApproval(body.estimateData, context);
  const quoteRequired = estimateDataHasQuoteRequirement(estimateData) ||
    estimateDataHasUnresolvedManagerApproval(estimateData);
  const totals = resolveBillableTotals(body, estimateData, quoteRequired);
  applyResolvedTotalsToEstimateData(estimateData, totals, quoteRequired);
  const serviceInterest = inferEstimateServiceInterest({
    serviceInterest: body.serviceInterest,
    estimateData,
    monthlyTotal: totals.monthlyTotal,
    onetimeTotal: totals.onetimeTotal,
    notes: body.notes,
  });

  return {
    customer_id: body.customerId || null,
    estimate_data: estimateData ? JSON.stringify(estimateData) : null,
    address: body.address,
    customer_name: body.customerName,
    customer_phone: body.customerPhone,
    customer_email: body.customerEmail,
    monthly_total: totals.monthlyTotal,
    annual_total: totals.annualTotal,
    onetime_total: totals.onetimeTotal,
    waveguard_tier: body.waveguardTier,
    service_interest: serviceInterest,
    notes: body.notes,
    satellite_url: body.satelliteUrl,
    show_one_time_option: !!body.showOneTimeOption,
    bill_by_invoice: !!body.billByInvoice,
  };
}

async function firstForUpdate(query) {
  const lockableQuery = typeof query.forUpdate === 'function' ? query.forUpdate() : query;
  return lockableQuery.first();
}

async function createOrReuseAdminEstimate({
  database = db,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
}) {
  const {
    leadId,
    showOneTimeOption,
    billByInvoice,
    estimateData,
  } = body;
  const trustedEstimateData = normalizeEstimateDethatchingManagerApproval(estimateData, {
    technician,
    technicianId,
    now,
  });
  const quoteRequired = estimateDataHasQuoteRequirement(trustedEstimateData) ||
    estimateDataHasUnresolvedManagerApproval(trustedEstimateData);
  const totals = resolveBillableTotals(body, trustedEstimateData, quoteRequired);
  applyResolvedTotalsToEstimateData(trustedEstimateData, totals, quoteRequired);
  const linkedLeadId = normalizeLinkedLeadId(leadId);
  const deliveryError = validateEstimateDeliveryOptions({
    showOneTimeOption: !!showOneTimeOption,
    billByInvoice: !!billByInvoice,
    onetimeTotal: totals.onetimeTotal,
    monthlyTotal: totals.monthlyTotal,
    annualTotal: totals.annualTotal,
    estimateData: trustedEstimateData,
  });
  if (deliveryError) throw errorWithStatus(deliveryError, 400);

  const expiresAt = estimateExpiresAt(now);
  const writeFields = buildEstimatePersistenceFields(
    { ...body, estimateData: trustedEstimateData },
    { technician, technicianId, now },
  );

  return database.transaction(async (trx) => {
    let canReplaceLinkedEstimate = false;

    if (linkedLeadId) {
      const lead = await firstForUpdate(trx('leads').where({ id: linkedLeadId }));
      if (!lead) throw errorWithStatus('Lead not found', 404);

      if (lead.estimate_id) {
        const existingEstimate = await firstForUpdate(trx('estimates').where({ id: lead.estimate_id }));
        if (existingEstimate?.status === 'draft') {
          const nextEstimate = { ...existingEstimate, ...writeFields, expires_at: expiresAt };
          assertLeadCanAttachEstimate({
            lead,
            estimate: nextEstimate,
            estimateId: existingEstimate.id,
          });
          const [updated] = await trx('estimates')
            .where({ id: existingEstimate.id, status: 'draft' })
            .update({
              ...writeFields,
              expires_at: expiresAt,
              updated_at: now(),
            })
            .returning('*');
          if (!updated) {
            throw errorWithStatus('Estimate draft changed; refresh and try again.', 409);
          }
          clearEstimatePricingCache(existingEstimate.id);
          return {
            estimate: updated,
            reused: true,
          };
        }

        if (existingEstimate && !existingEstimate.archived_at) {
          throw errorWithStatus(
            'Lead is already linked to an active estimate. Archive or delete the existing estimate before creating a new one.',
            409,
          );
        }

        canReplaceLinkedEstimate = true;
      }
    }

    const token = randomBytes(16).toString('hex');
    const [created] = await trx('estimates').insert({
      ...writeFields,
      created_by_technician_id: technicianId,
      token,
      expires_at: expiresAt,
    }).returning('*');

    if (linkedLeadId) {
      await attachLeadToEstimate({
        database: trx,
        leadId: linkedLeadId,
        estimateId: created.id,
        estimate: created,
        technician,
        allowReplacingEstimateId: canReplaceLinkedEstimate,
      });
    }

    return {
      estimate: created,
      reused: false,
    };
  });
}

module.exports = {
  buildEstimatePersistenceFields,
  createOrReuseAdminEstimate,
  estimateExpiresAt,
  estimateViewUrl,
};
