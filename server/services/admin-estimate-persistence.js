const crypto = require('crypto');
const db = require('../models/db');
const { validateEstimateDeliveryOptions } = require('./estimate-delivery-options');
const {
  attachLeadToEstimate,
  assertLeadCanAttachEstimate,
} = require('./lead-estimate-link');
const { clearEstimatePricingCache } = require('./estimate-pricing-cache');

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

function buildEstimatePersistenceFields(body) {
  return {
    customer_id: body.customerId || null,
    estimate_data: body.estimateData ? JSON.stringify(body.estimateData) : null,
    address: body.address,
    customer_name: body.customerName,
    customer_phone: body.customerPhone,
    customer_email: body.customerEmail,
    monthly_total: body.monthlyTotal,
    annual_total: body.annualTotal,
    onetime_total: body.onetimeTotal,
    waveguard_tier: body.waveguardTier,
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
    onetimeTotal,
    monthlyTotal,
    annualTotal,
  } = body;
  const linkedLeadId = normalizeLinkedLeadId(leadId);
  const deliveryError = validateEstimateDeliveryOptions({
    showOneTimeOption: !!showOneTimeOption,
    billByInvoice: !!billByInvoice,
    onetimeTotal,
    monthlyTotal,
    annualTotal,
  });
  if (deliveryError) throw errorWithStatus(deliveryError, 400);

  const expiresAt = estimateExpiresAt(now);
  const writeFields = buildEstimatePersistenceFields(body);

  return database.transaction(async (trx) => {
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
  estimateViewUrl,
};
