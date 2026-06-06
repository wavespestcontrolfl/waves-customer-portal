const db = require('../models/db');
const logger = require('./logger');
const AccountMembershipEmail = require('./account-membership-email');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { generateEstimate } = require('./pricing-engine');
const { mapV1ToLegacyShape } = require('./pricing-engine/v1-legacy-mapper');
const { triggerNotification } = require('./notification-triggers');
const { normalizePhone } = require('../utils/phone');

const OPEN_REQUEST_TERMINAL_STATUSES = ['resolved', 'closed', 'cancelled'];
const INACTIVE_ESTIMATE_STATUSES = ['accepted', 'declined', 'expired', 'send_failed'];
const SOURCE_PUBLIC_ESTIMATE = 'public_estimate';

const SERVICE_LABELS = {
  lawn_care: 'Lawn Care',
  pest_control: 'Pest Control',
  mosquito: 'Mosquito',
  tree_shrub: 'Tree & Shrub',
};

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function firstNameFrom(name, fallback = 'there') {
  return String(name || '').trim().split(/\s+/)[0] || fallback;
}

function splitName(name) {
  const parts = String(name || 'New Customer').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'New',
    last_name: parts.slice(1).join(' ') || 'Customer',
  };
}

function phoneLast10(value) {
  const normalized = normalizePhone(value) || value;
  const digits = String(normalized || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function phonesMatch(a, b) {
  const aLast10 = phoneLast10(a);
  const bLast10 = phoneLast10(b);
  return !!aLast10 && !!bLast10 && aLast10 === bLast10;
}

function addressKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function estimateStreetAddressLine(estimate = {}) {
  return cleanText(String(estimate.address || '').split(',')[0], 200);
}

function estimateStreetAddressKey(estimate = {}) {
  return addressKey(estimateStreetAddressLine(estimate));
}

function customerStreetAddressKey(customer = {}) {
  return addressKey(customer.address_line1 || customer.address || '');
}

function customerMatchesEstimateAddress(customer, estimate) {
  const estimateAddress = estimateStreetAddressKey(estimate);
  const customerAddress = customerStreetAddressKey(customer);
  if (!estimateAddress || !customerAddress) return false;
  return estimateAddress === customerAddress;
}

function chooseSafeCustomerCandidate(candidates = [], estimate = {}) {
  const liveCandidates = candidates.filter((customer) => customer && !customer.deleted_at);
  if (!liveCandidates.length) return null;

  if (estimateStreetAddressKey(estimate)) {
    const addressMatches = liveCandidates.filter((customer) => customerMatchesEstimateAddress(customer, estimate));
    return addressMatches.length === 1 ? addressMatches[0] : null;
  }

  return liveCandidates.length === 1 ? liveCandidates[0] : null;
}

function normalizeRequestedServiceKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(SERVICE_LABELS, raw)) return raw;
  if (raw.includes('lawn')) return 'lawn_care';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('pest')) return 'pest_control';
  if (raw.includes('tree') || raw.includes('shrub')) return 'tree_shrub';
  return null;
}

function requestedServiceLabel(serviceKey) {
  return SERVICE_LABELS[serviceKey] || cleanText(serviceKey, 80).replace(/_/g, ' ') || 'Service';
}

function extractEngineInputs(estData) {
  if (!estData || typeof estData !== 'object') return null;
  if (estData.engineInputs && typeof estData.engineInputs === 'object') return estData.engineInputs;
  if (estData.inputs && typeof estData.inputs === 'object') return estData.inputs;
  return null;
}

function removeSendSnapshotPricingBundle(estData = {}) {
  if (!estData || typeof estData !== 'object' || !estData.sendSnapshot?.pricingBundle) return estData;
  return {
    ...estData,
    sendSnapshot: {
      ...estData.sendSnapshot,
      pricingBundle: undefined,
      pricingBundleError: undefined,
    },
  };
}

function resolvePropertyNumber(updatedInputs, estData, key) {
  return Number(
    updatedInputs?.[key]
    || estData?.result?.property?.[key]
    || estData?.engineResult?.property?.[key]
    || 0
  );
}

function addRequestedServiceToInputs(engineInputs, estData, serviceKey) {
  const updatedInputs = JSON.parse(JSON.stringify(engineInputs || {}));
  updatedInputs.services = updatedInputs.services || {};

  if (serviceKey === 'lawn_care') {
    if (updatedInputs.services.lawn) return { added: false, updatedInputs, reason: 'already_included' };
    const lawnSqFt = resolvePropertyNumber(updatedInputs, estData, 'lawnSqFt');
    const lotSqFt = resolvePropertyNumber(updatedInputs, estData, 'lotSqFt');
    if (lawnSqFt > 0) updatedInputs.lawnSqFt = lawnSqFt;
    if (!updatedInputs.lotSqFt && lotSqFt > 0) updatedInputs.lotSqFt = lotSqFt;
    if (lawnSqFt <= 0 && lotSqFt <= 0) return { added: false, updatedInputs, reason: 'missing_lawn_or_lot_sqft' };
    updatedInputs.services.lawn = {
      track: 'st_augustine',
      tier: 'enhanced',
      shadeClassification: 'FULL_SUN',
    };
    return { added: true, updatedInputs };
  }

  if (serviceKey === 'pest_control') {
    if (updatedInputs.services.pest) return { added: false, updatedInputs, reason: 'already_included' };
    updatedInputs.services.pest = { frequency: 'quarterly', version: 'v1', roachType: 'none' };
    return { added: true, updatedInputs };
  }

  if (serviceKey === 'mosquito') {
    if (updatedInputs.services.mosquito) return { added: false, updatedInputs, reason: 'already_included' };
    updatedInputs.services.mosquito = { tier: 'monthly' };
    return { added: true, updatedInputs };
  }

  return { added: false, updatedInputs, reason: 'unsupported_service' };
}

function buildEstimateServiceRevisionDraft(estimate = {}, requestedService) {
  const serviceKey = normalizeRequestedServiceKey(requestedService);
  const serviceLabel = requestedServiceLabel(serviceKey);
  const estData = parseJson(estimate.estimate_data, {}) || {};
  const engineInputs = extractEngineInputs(estData);

  if (!serviceKey) {
    return {
      status: 'not_priced',
      serviceKey,
      serviceLabel,
      reason: 'missing_requested_service',
      generatedAt: new Date().toISOString(),
    };
  }

  if (!engineInputs) {
    return {
      status: 'not_priced',
      serviceKey,
      serviceLabel,
      reason: 'missing_engine_inputs',
      generatedAt: new Date().toISOString(),
    };
  }

  const { added, updatedInputs, reason } = addRequestedServiceToInputs(engineInputs, estData, serviceKey);
  if (!added) {
    return {
      status: 'not_priced',
      serviceKey,
      serviceLabel,
      reason: reason || 'service_not_added',
      generatedAt: new Date().toISOString(),
    };
  }

  try {
    const v1Result = generateEstimate(updatedInputs);
    const legacyResult = mapV1ToLegacyShape(v1Result);
    const newMonthly = Number(legacyResult?.recurring?.monthlyTotal || 0);
    const newAnnual = Number(legacyResult?.recurring?.annualAfterDiscount || newMonthly * 12);
    const newOneTime = Number(legacyResult?.oneTime?.total || estimate.onetime_total || 0);
    const newTier = String(legacyResult?.recurring?.tier || 'silver').replace(/^./, (c) => c.toUpperCase());
    const newBaseMonthly = Math.round((Number(legacyResult?.recurring?.annualBeforeDiscount || 0) / 12) * 100) / 100;
    const draftEstimateData = removeSendSnapshotPricingBundle({
      ...estData,
      inputs: updatedInputs,
      result: legacyResult,
      baseMonthly: newBaseMonthly > 0 ? newBaseMonthly : (estData?.baseMonthly || 0),
      onetimeTotalBase: newOneTime,
      addServiceDraft: {
        requestedService: serviceKey,
        requestedServiceLabel: serviceLabel,
        source: SOURCE_PUBLIC_ESTIMATE,
        previousMonthly: Number(estimate.monthly_total || 0),
        previousTier: estimate.waveguard_tier || 'Bronze',
        newMonthly,
        newBaseMonthly,
        newTier,
        generatedAt: new Date().toISOString(),
      },
    });

    return {
      status: 'priced',
      serviceKey,
      serviceLabel,
      confidence: 'draft',
      previous: {
        monthly: Number(estimate.monthly_total || 0),
        annual: Number(estimate.annual_total || 0),
        oneTime: Number(estimate.onetime_total || 0),
        tier: estimate.waveguard_tier || 'Bronze',
      },
      updated: {
        monthly: newMonthly,
        annual: newAnnual,
        oneTime: newOneTime,
        tier: newTier,
        baseMonthly: newBaseMonthly,
      },
      draftEstimateData,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'not_priced',
      serviceKey,
      serviceLabel,
      reason: 'pricing_engine_failed',
      error: err.message,
      generatedAt: new Date().toISOString(),
    };
  }
}

async function resolveEstimateCustomer(database, estimate = {}) {
  if (estimate.customer_id) {
    const customer = await database('customers')
      .where({ id: estimate.customer_id })
      .whereNull('deleted_at')
      .first();
    if (customer) return customer;
  }

  const customer = await findSafeExistingCustomerForEstimate(database, estimate);
  if (customer) {
    if (!estimate.customer_id) {
      await database('estimates').where({ id: estimate.id }).update({ customer_id: customer.id });
    }
    return customer;
  }

  if (!estimate.customer_phone) {
    const err = new Error('Estimate must have a customer or phone number to create a service request');
    err.status = 400;
    throw err;
  }

  const name = splitName(estimate.customer_name);
  const [created] = await database('customers').insert({
    ...name,
    phone: estimate.customer_phone,
    email: estimate.customer_email || null,
    address_line1: estimateStreetAddressLine(estimate),
    city: '',
    state: 'FL',
    zip: '',
    active: false,
    waveguard_tier: null,
    monthly_rate: null,
    member_since: null,
    stage: 'new_lead',
    lead_source: SOURCE_PUBLIC_ESTIMATE,
    lead_source_detail: 'estimate_add_service_request',
    lead_source_channel: 'public_estimate',
    pipeline_stage: 'new_lead',
    pipeline_stage_changed_at: new Date(),
    last_contact_date: new Date(),
    last_contact_type: 'estimate_add_service_request',
  }).onConflict().ignore().returning('*');

  if (!created) {
    const safeExisting = await findSafeExistingCustomerForEstimate(database, estimate);
    if (safeExisting) {
      await database('estimates').where({ id: estimate.id }).update({ customer_id: safeExisting.id });
      return safeExisting;
    }
    const conflict = new Error('Customer contact could not be safely matched');
    conflict.status = 409;
    throw conflict;
  }

  await database('estimates').where({ id: estimate.id }).update({ customer_id: created.id });
  await database('property_preferences').insert({ customer_id: created.id }).catch((err) => {
    logger.warn(`[estimate-add-service-request] property_preferences create skipped for ${created.id}: ${err.message}`);
  });
  await database('notification_prefs').insert({ customer_id: created.id }).catch((err) => {
    logger.warn(`[estimate-add-service-request] notification_prefs create skipped for ${created.id}: ${err.message}`);
  });

  return created;
}

async function findSafeExistingCustomerForEstimate(database, estimate = {}) {
  const last10 = phoneLast10(estimate.customer_phone);
  if (last10) {
    const phoneCandidates = await database('customers')
      .whereNull('deleted_at')
      .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
      .select('*');
    const phoneMatch = chooseSafeCustomerCandidate(phoneCandidates, estimate);
    if (phoneMatch) return phoneMatch;
  }

  const email = String(estimate.customer_email || '').trim().toLowerCase();
  if (email) {
    const emailCandidates = await database('customers')
      .whereNull('deleted_at')
      .whereRaw('LOWER(email) = ?', [email])
      .select('*');
    const emailMatch = chooseSafeCustomerCandidate(emailCandidates, estimate);
    if (emailMatch) return emailMatch;
  }

  return null;
}

function openRequestQuery(database, estimateId, requestedService) {
  return database('service_requests')
    .where({ estimate_id: estimateId, requested_service: requestedService })
    .whereNotIn('status', OPEN_REQUEST_TERMINAL_STATUSES);
}

async function runRequestTransaction(database, handler) {
  if (database && typeof database.transaction === 'function') {
    return database.transaction(handler);
  }
  return handler(database);
}

async function findEstimateByTokenForUpdate(database, estimateToken) {
  const query = database('estimates').where({ token: estimateToken });
  const lockableQuery = typeof query.forUpdate === 'function' ? query.forUpdate() : query;
  return lockableQuery.first();
}

function isEstimateAddServiceRequestable(estimate = {}, now = new Date()) {
  if (estimate.archived_at) return false;
  if (INACTIVE_ESTIMATE_STATUSES.includes(estimate.status)) return false;
  if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
  return true;
}

function publicEstimateUrl(token) {
  return token ? `/estimate/${encodeURIComponent(token)}` : null;
}

async function recordInternalEvents(database, { estimate, customer, request, serviceLabel, pricingRevision }) {
  const subject = `Customer requested ${serviceLabel} from estimate`;
  const body = `Public estimate request created. Follow up with a revised estimate option for ${serviceLabel}.`;
  const metadata = {
    service_request_id: request.id,
    estimate_id: estimate.id,
    requested_service: request.requested_service,
    source: SOURCE_PUBLIC_ESTIMATE,
    pricing_revision_status: pricingRevision?.status || null,
  };

  await database('customer_interactions').insert({
    customer_id: customer.id,
    interaction_type: 'service_request',
    subject,
    body,
    metadata: JSON.stringify(metadata),
  }).catch((err) => {
    logger.warn(`[estimate-add-service-request] customer_interactions insert failed for request ${request.id}: ${err.message}`);
  });

  await database('activity_log').insert({
    customer_id: customer.id,
    estimate_id: estimate.id,
    action: 'estimate_add_service_requested',
    description: `Customer requested ${serviceLabel} add-on from public estimate.`,
    metadata: JSON.stringify(metadata),
  }).catch((err) => {
    logger.warn(`[estimate-add-service-request] activity_log insert failed for request ${request.id}: ${err.message}`);
  });
}

async function notifyAdmin({ notificationTrigger, estimate, customer, request, serviceLabel, pricingRevision }) {
  const customerName = cleanText(
    estimate.customer_name || `${customer.first_name || ''} ${customer.last_name || ''}`,
    120
  ) || 'Customer';
  await notificationTrigger('bundle_quote_requested', {
    estimateId: estimate.id,
    customerId: customer.id,
    requestId: request.id,
    customerName,
    suggestedService: serviceLabel,
    bundled: false,
    previousTier: estimate.waveguard_tier || 'Bronze',
    previousMonthly: Number(estimate.monthly_total || 0),
    newTier: pricingRevision?.updated?.tier || null,
    newMonthly: pricingRevision?.updated?.monthly ?? null,
    requestedService: request.requested_service,
    source: SOURCE_PUBLIC_ESTIMATE,
    pricingRevisionStatus: pricingRevision?.status || null,
  });
}

async function sendCustomerConfirmations({
  customer,
  estimate,
  request,
  serviceLabel,
  sendMessage,
  accountMembershipEmail,
}) {
  const firstName = customer.first_name || firstNameFrom(estimate.customer_name);
  const phone = customer.phone && (!estimate.customer_phone || phonesMatch(estimate.customer_phone, customer.phone))
    ? customer.phone
    : null;
  if (phone) {
    const body = `Hi ${firstName}, we received your request to add ${serviceLabel.toLowerCase()} to your Waves estimate. Our team will review the property details and send the updated option shortly.`;
    try {
      const smsResult = await sendMessage({
        to: phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'support_resolution',
        customerId: customer.id,
        estimateId: estimate.id,
        identityTrustLevel: 'phone_matches_customer',
        entryPoint: 'public_estimate_add_service_request',
        metadata: {
          original_message_type: 'estimate_add_service_request_received',
          service_request_id: request.id,
          estimate_id: estimate.id,
          requested_service: request.requested_service,
          source: SOURCE_PUBLIC_ESTIMATE,
        },
      });
      if (!smsResult.sent) {
        logger.warn(`[estimate-add-service-request] confirmation SMS blocked/failed for request ${request.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      }
    } catch (err) {
      logger.error(`[estimate-add-service-request] confirmation SMS failed for request ${request.id}: ${err.message}`);
    }
  } else if (estimate.customer_phone && customer.phone) {
    logger.warn(`[estimate-add-service-request] confirmation SMS skipped for request ${request.id}: estimate phone does not match customer phone`);
  }

  if (customer.active === false) {
    return;
  }

  try {
    const emailResult = accountMembershipEmail?.sendRequestReceived?.({
      customerId: customer.id,
      request,
      responseTime: 'shortly',
      idempotencyKey: `estimate.add_service_request.email:${request.id}`,
    });
    if (emailResult && typeof emailResult.catch === 'function') {
      emailResult.catch((err) => {
        logger.warn(`[estimate-add-service-request] confirmation email failed for request ${request.id}: ${err.message}`);
      });
    }
  } catch (err) {
    logger.warn(`[estimate-add-service-request] confirmation email failed for request ${request.id}: ${err.message}`);
  }
}

function serializeRequest(row) {
  const pricingRevision = parseJson(row.pricing_revision, row.pricing_revision || {});
  return {
    id: row.id,
    customerId: row.customer_id,
    estimateId: row.estimate_id,
    requestedService: row.requested_service,
    source: row.source,
    category: row.category,
    subject: row.subject,
    status: row.status,
    createdAt: row.created_at,
    pricingRevision: serializePricingRevisionSummary(pricingRevision),
  };
}

function serializePricingRevisionSummary(revision = {}) {
  if (!revision || typeof revision !== 'object') return null;
  return {
    status: revision.status || null,
    serviceKey: revision.serviceKey || null,
    serviceLabel: revision.serviceLabel || null,
    confidence: revision.confidence || null,
    reason: revision.reason || null,
    generatedAt: revision.generatedAt || null,
  };
}

async function createEstimateAddServiceRequest({
  estimateToken,
  requestedService,
  database = db,
  notificationTrigger = triggerNotification,
  sendMessage = sendCustomerMessage,
  accountMembershipEmail = AccountMembershipEmail,
} = {}) {
  const serviceKey = normalizeRequestedServiceKey(requestedService);
  if (!serviceKey) {
    const err = new Error('Requested service is required');
    err.status = 400;
    throw err;
  }

  const serviceLabel = requestedServiceLabel(serviceKey);
  const confirmation = {
    message: `Got it. We're reviewing ${serviceLabel.toLowerCase()} for your property and will follow up shortly.`,
  };

  const transactionResult = await runRequestTransaction(database, async (trx) => {
    const estimate = await findEstimateByTokenForUpdate(trx, estimateToken);
    if (!estimate) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }
    if (!isEstimateAddServiceRequestable(estimate)) {
      const err = new Error('Estimate is no longer active');
      err.status = 409;
      throw err;
    }

    const existing = await openRequestQuery(trx, estimate.id, serviceKey).first();
    if (existing) {
      return {
        response: {
          success: true,
          deduped: true,
          request: serializeRequest(existing),
          confirmation,
        },
      };
    }

    const customer = await resolveEstimateCustomer(trx, estimate);
    const pricingRevision = buildEstimateServiceRevisionDraft(estimate, serviceKey);
    const estimateNumber = estimate.estimate_number || estimate.id;
    const subject = `Add ${serviceLabel} to estimate #${estimateNumber}`;
    const description = `Customer requested ${serviceLabel} from public estimate ${estimateNumber}. Review property details and send a revised estimate option.`;

    let request;
    try {
      [request] = await trx('service_requests').insert({
        customer_id: customer.id,
        estimate_id: estimate.id,
        requested_service: serviceKey,
        source: SOURCE_PUBLIC_ESTIMATE,
        category: 'add_service',
        subject,
        description,
        urgency: 'routine',
        status: 'new',
        pricing_revision: JSON.stringify({
          ...pricingRevision,
          estimateUrl: publicEstimateUrl(estimate.token || estimateToken),
        }),
      }).returning('*');
    } catch (err) {
      if (err.code === '23505') {
        const dupe = await openRequestQuery(trx, estimate.id, serviceKey).first();
        if (dupe) {
          return {
            response: {
              success: true,
              deduped: true,
              request: serializeRequest(dupe),
              confirmation,
            },
          };
        }
      }
      throw err;
    }

    return {
      estimate,
      customer,
      request,
      pricingRevision,
      response: {
        success: true,
        deduped: false,
        request: serializeRequest(request),
        revision: serializePricingRevisionSummary(pricingRevision),
        confirmation,
      },
    };
  });

  if (transactionResult.response?.deduped) {
    return transactionResult.response;
  }

  const {
    estimate,
    customer,
    request,
    pricingRevision,
    response,
  } = transactionResult;

  logger.info(`[estimate-add-service-request] Created ${serviceKey} request ${request.id} for estimate ${estimate.id}`);

  await recordInternalEvents(database, { estimate, customer, request, serviceLabel, pricingRevision });

  await notifyAdmin({
    notificationTrigger,
    estimate,
    customer,
    request,
    serviceLabel,
    pricingRevision,
  }).catch((err) => {
    logger.error(`[estimate-add-service-request] admin notification failed for request ${request.id}: ${err.message}`);
  });

  await sendCustomerConfirmations({
    customer,
    estimate,
    request,
    serviceLabel,
    sendMessage,
    accountMembershipEmail,
  });

  return response;
}

module.exports = {
  SOURCE_PUBLIC_ESTIMATE,
  OPEN_REQUEST_TERMINAL_STATUSES,
  INACTIVE_ESTIMATE_STATUSES,
  normalizeRequestedServiceKey,
  requestedServiceLabel,
  isEstimateAddServiceRequestable,
  serializePricingRevisionSummary,
  buildEstimateServiceRevisionDraft,
  createEstimateAddServiceRequest,
};
