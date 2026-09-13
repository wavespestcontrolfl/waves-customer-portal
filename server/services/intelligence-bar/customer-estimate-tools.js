const db = require('../../models/db');
const persistence = require('../admin-estimate-persistence');
const { gateEnvValue } = require('../../config/feature-gates');
const { normalizeGrassType, resolveTrackKey, loadCustomerGrassContext } = require('../lawn-grass-context');
const { loadCurrentServiceSpendContext } = require('../estimate-membership-context');
const { agentEngineResultDigest } = require('../agent-estimate-preview');
const { previewFingerprint } = require('./authorization-contract');
const { storedManualDiscountForReplay } = require('../estimate-manual-discount-replay');
const { perApplicationChargeAmount } = require('../billing-cadence');
const { lineRequiresReview, lineHasHeuristicTurf } = require('../estimator-engine/draft-builder');
const { normalizePropertyType } = require('../pricing-engine/commercial-helpers');
const { activeRecurringServices, duplicateCurrentServices } = require('./estimate-tools');

const uuid = { type: 'string', format: 'uuid' };
const CUSTOMER_ESTIMATE_TOOLS = [
  {
    name: 'get_customer_estimate_context',
    description: 'Load an existing customer’s saved service properties, lawn measurements, grass type, current services and estimates from any admin page. Use these saved facts before asking for measurements. Property measurements belong to that property; a secondary property never inherits the primary lawn profile. This read does not create a lead, draft, appointment or message.',
    input_schema: { type: 'object', additionalProperties: false,
      properties: { customer_id: uuid, property_id: uuid }, required: ['customer_id'] },
  },
  {
    name: 'save_customer_estimate',
    _sideEffects: true,
    description: 'Prepare a lawn estimate for an existing customer using its saved property measurements and live membership/pricing rules. Currently supports residential lawn at 6, 9 or 12 applications per year. New drafts default to the portal’s 9-application program. Revisions preserve the saved cadence unless a change is requested. Requires the saved property ID; never create a duplicate lead. The first call previews the price, source facts and options for confirmation. With estimate_id, revises that property’s existing estimate in place under the usual editability rules. Saving never sends, schedules a send or books work.',
    input_schema: { type: 'object', additionalProperties: false,
      properties: { customer_id: uuid, property_id: uuid, estimate_id: uuid,
        lawn_applications: { type: 'integer', enum: [6, 9, 12] } },
      required: ['customer_id', 'property_id'] },
  },
];

function failure(message, code = 'missing_information', statusCode = 409) {
  const err = new Error(message);
  Object.assign(err, { code, statusCode });
  return err;
}

// PostgreSQL returns canonical lowercase UUIDs; a request may spell them in uppercase.
const sameId = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function address(property) {
  // A service address starts with a street; a row holding only its default state is not one.
  if (!String(property.address_line1 || '').trim()) return '';
  return [[property.address_line1, property.address_line2].filter(Boolean).join(' '), property.city,
    [property.state, property.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

async function loadContext(input, database = db, lock = false) {
  let customers = database('customers').where({ id: input.customer_id }).whereNull('deleted_at');
  if (lock) customers = customers.forUpdate();
  const customer = await customers.first();
  if (!customer) throw failure('Customer not found', 'target_not_found', 404);
  let query = database('customer_properties').where({ customer_id: customer.id, active: true }).orderBy('id');
  if (lock) query = query.forUpdate();
  const rows = await query;
  const selected = input.property_id ? rows.find(row => sameId(row.id, input.property_id)) : rows.find(row => row.is_primary);
  if (input.property_id && !selected) throw failure('The property does not belong to this customer', 'target_relationship_mismatch');
  let grass = null, profileLawnSqft = null;
  if (selected?.is_primary) {
    let profiles = database('customer_turf_profiles').where({ customer_id: customer.id, active: true }).orderBy('id');
    if (lock) profiles = profiles.forUpdate();
    const profileRows = await profiles;
    profileLawnSqft = profileRows[0]?.lawn_sqft ?? null;
    if (profileRows.length > 1) throw failure('More than one active lawn profile exists. Resolve the lawn profile before pricing.', 'ambiguous_measurements');
    grass = await loadCustomerGrassContext(customer.id, database, { strict: true });
  }
  const grassType = grass?.grassType ?? normalizeGrassType(selected?.lawn_type);
  const property = selected ? {
    id: selected.id, label: selected.label, address: address(selected), is_primary: selected.is_primary,
    occupancy_type: selected.occupancy_type, property_type: selected.property_type,
    treatable_lawn_sqft: profileLawnSqft ?? grass?.propertySqft ?? selected.property_sqft ?? null,
    grass_type: grassType,
    track: resolveTrackKey(grass?.trackKey, grassType),
    lot_sqft: selected.lot_sqft || null,
    measurement_source: profileLawnSqft !== null || grass?.propertySqft != null ? 'saved_primary_lawn_context' : 'saved_service_property',
  } : null;
  const spend = await loadCurrentServiceSpendContext(database, customer.id);
  const contact = { id: customer.id, name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    phone: customer.phone || null, email: customer.email || null };
  return { customer: contact, property,
    properties: rows.map(row => ({ id: row.id, label: row.label, address: address(row), is_primary: row.is_primary })),
    current_services: spend.currentServices, current_tier: spend.currentTierLabel,
    _version: previewFingerprint({ contact, property, currentServices: JSON.parse(JSON.stringify(spend)) }) };
}

async function readCustomerEstimateContext(input) {
  const context = await loadContext(input);
  const estimates = await db('estimates').where({ customer_id: input.customer_id }).whereNull('archived_at')
    .modify(q => { if (input.property_id) q.where({ property_id: input.property_id }); })
    .orderBy('created_at', 'desc').limit(20).select('id', 'property_id', 'address', 'status', 'updated_at');
  return { ...context, estimates: estimates.map(row => ({ ...row,
    href: `/admin/estimates?editEstimateId=${row.id}` })) };
}

function estimateBody(input, context) {
  const property = context.property;
  if (!property?.address || !(Number(property.treatable_lawn_sqft) > 0) || !property.track) {
    throw failure('A saved service address, treatable lawn area and identified grass type are required. Update the missing property facts before pricing.');
  }
  if (property.occupancy_type === 'commercial' || normalizePropertyType(property.property_type) === 'commercial') {
    throw failure('This property needs the commercial estimate workflow.', 'capability_unimplemented');
  }
  // Lawn service already active at this property is already priced: a second
  // lawn estimate could be sent and accepted as duplicate service.
  const duplicates = duplicateCurrentServices({ lawn: true }, activeRecurringServices(context.current_services), property.address);
  if (duplicates.length) throw failure(`This property already has active ${duplicates.join(', ')} service. Quote only requested additions.`, 'duplicate_service');
  const applications = input.lawn_applications ?? 9;
  if (![6, 9, 12].includes(applications)) throw failure('Choose 6, 9 or 12 lawn applications per year.', 'invalid_input', 400);
  const engineInputs = { measuredTurfSf: Number(property.treatable_lawn_sqft), turfSource: 'measured',
    ...(property.lot_sqft ? { lotSqFt: Number(property.lot_sqft) } : {}),
    propertyType: property.property_type || 'single_family',
    services: { lawn: { track: property.track, lawnFreq: applications } } };
  return { customerId: context.customer.id, propertyId: property.id, address: property.address,
    customerName: context.customer.name, customerPhone: context.customer.phone, customerEmail: context.customer.email,
    estimateData: { engineInputs, inputs: { customerId: context.customer.id, propertyId: property.id,
      address: property.address, svcLawn: true, lawnFreq: String(applications), grassType: property.track,
      measuredTurfSf: String(property.treatable_lawn_sqft), lotSqFt: String(property.lot_sqft || '') },
    propertyFacts: { treatable_lawn_sqft: { value: property.treatable_lawn_sqft, source: property.measurement_source,
      property_id: property.id }, grass_type: { value: property.grass_type, source: property.measurement_source, property_id: property.id } } } };
}

async function estimatePreview(input, database = db, context = null) {
  context = context || await loadContext(input, database);
  const body = estimateBody(input, context);
  let prior = null;
  if (input.estimate_id) {
    prior = await database('estimates').where({ id: input.estimate_id }).first();
    if (!prior || !sameId(prior.customer_id, input.customer_id) || !sameId(prior.property_id, input.property_id)) {
      throw failure('The estimate does not belong to this customer and service property', 'target_relationship_mismatch');
    }
    // The whole group is judged, not only this row: a scheduled anchor pins
    // every sibling's offer in its receipt. Under confirmation this reruns
    // after the group locks are held, so the verdict is authoritative there.
    const queued = await persistence.findQueuedGroupSend(database, prior);
    if (queued) {
      throw failure(queued.self
        ? 'This estimate has a queued send. Clear the scheduled send in the estimate editor before revising it.'
        : 'This estimate belongs to a multi-property group with a queued send. Clear that scheduled send in the estimate editor before revising it.',
      'estimate_send_scheduled');
    }
    body.expectedEditVersion = persistence.estimateEditVersion(prior);
    body.notes = prior.notes;
    body.showOneTimeOption = prior.show_one_time_option;
    body.billByInvoice = prior.bill_by_invoice;
    const savedData = typeof prior.estimate_data === 'string' ? JSON.parse(prior.estimate_data) : prior.estimate_data;
    const savedLines = savedData?.engineResult?.lineItems;
    if (savedLines?.length !== 1 || !/^lawn/.test(savedLines[0].service)) {
      throw failure('This tool currently revises lawn-only estimates. Other service mixes need the full estimate editor.', 'capability_unimplemented');
    }
    const request = savedData.engineRequest;
    const savedInputs = request?.profile
      ? require('../../routes/property-lookup-v2').translateV2CallToV1Input(request.profile, request.selectedServices, request.options)
      : savedData.engineInputs;
    if (!savedInputs?.services?.lawn) throw failure('The saved lawn configuration is unavailable. Reopen the estimate editor to restore its inputs.');
    body.estimateData.inputs = { ...savedData.inputs, ...body.estimateData.inputs };
    const freshInputs = body.estimateData.engineInputs;
    const applications = input.lawn_applications ?? Number(savedInputs.services.lawn.lawnFreq);
    if (![6, 9, 12].includes(applications)) throw failure('The saved lawn cadence needs review in the estimate editor.', 'capability_unimplemented');
    freshInputs.services.lawn.lawnFreq = applications;
    body.estimateData.inputs.lawnFreq = String(applications);
    body.estimateData.engineInputs = { ...savedInputs, ...freshInputs,
      services: { ...savedInputs.services, lawn: { ...savedInputs.services.lawn, ...freshInputs.services.lawn } } };
    // Reuse the persisted, approved discount inputs. The shared replay helper
    // refuses fixed allocations that cannot be reconstructed faithfully.
    const manualDiscount = savedData.engineInputs?.manualDiscount || savedData.engineRequest?.options?.manualDiscount
      || storedManualDiscountForReplay(savedData, { requireReplayable: true });
    if (manualDiscount) body.estimateData.engineInputs.manualDiscount = manualDiscount;
    if (savedData.operatorPriceAdjustment) body.estimateData.operatorPriceAdjustment = savedData.operatorPriceAdjustment;
    // The public pricing builder replays this naming audit after recompute.
    if (Array.isArray(savedData.presentationOverrides)) body.estimateData.presentationOverrides = savedData.presentationOverrides;
  }
  const params = { database, body, dryRun: true, requireLivePricing: true };
  const prepared = input.estimate_id
    ? await persistence.reviseAdminEstimate({ ...params, estimateId: input.estimate_id })
    : await persistence.createOrReuseAdminEstimate(params);
  if (prepared.estimate.pricing_authority !== 'SERVER') throw failure('Engine pricing is unavailable. No estimate was saved.', 'integration_unavailable', 503);
  const data = JSON.parse(prepared.estimate.estimate_data);
  // The editor normally submits its calculated tier. This adapter derives
  // that same field from the server result, including a downward reprice.
  body.waveguardTier = data.result?.recurring?.tier;
  if (!['Bronze', 'Silver', 'Gold', 'Platinum'].includes(body.waveguardTier)) {
    throw failure('The engine could not verify the estimate tier.', 'pricing_unavailable');
  }
  const engineDigest = agentEngineResultDigest(data.engineResult);
  const lines = data.engineResult?.lineItems || [];
  if (lines.length !== 1 || lines.some(line => lineRequiresReview(line) || line.requiresQuote
      || lineHasHeuristicTurf(line) || String(line.pricingConfidence || '').toUpperCase() === 'LOW')
      || !lines.some(line => Number(line.annualPrice ?? line.annual) > 0)) {
    throw failure('The engine could not produce a priced lawn estimate from the saved facts.', 'pricing_unavailable');
  }
  // Use the customer-facing projection, including discounts and hidden floor-
  // capped cadences. An unsaved revision must neither read nor populate the
  // saved estimate's pricing cache, so omit its cache identity.
  const pricing = await require('../../routes/estimate-public').buildPricingBundle({ ...prepared.estimate, id: null });
  const offeredCadences = (pricing.frequencies || []).map(frequency => ({
    key: frequency.key, applications: Number(frequency.visitsPerYear),
    per_application: Number(frequency.perTreatment),
    selected: Number(frequency.visitsPerYear) === body.estimateData.engineInputs.services.lawn.lawnFreq,
  }));
  if (!offeredCadences.length || offeredCadences.some(cadence => ![6, 9, 12].includes(cadence.applications)
      || !Number.isFinite(cadence.per_application) || cadence.per_application <= 0)) {
    throw failure('The customer-selectable lawn prices could not be verified.', 'pricing_unavailable');
  }
  return { preview: true, customer: context.customer, property: context.property,
    estimate_id: input.estimate_id || null, action: input.estimate_id ? 'revise_estimate' : 'create_estimate',
    applications_per_year: body.estimateData.engineInputs.services.lawn.lawnFreq,
    totals: { monthly: Number(prepared.estimate.monthly_total), annual: Number(prepared.estimate.annual_total),
      one_time: Number(prepared.estimate.onetime_total) },
    lines: lines.map(line => ({ service: line.name || line.service, applications: line.frequency,
      per_application: perApplicationChargeAmount({ annualRate: prepared.estimate.annual_total, visitsPerYear: line.frequency }),
      initial: line.initialFee || 0 })),
    offered_cadences: offeredCadences,
    engine_result_digest: engineDigest,
    current_services: context.current_services, quote_tier: body.waveguardTier,
    effect: prior && prior.status !== 'draft' ? 'Updates the saved estimate and its existing customer link. No message is sent.' : 'Saves a draft. No customer message, appointment or scheduled send.',
    _version: { facts: context._version, estimate: prior ? persistence.estimateEditVersion(prior) : null,
      pricing: engineDigest, cadences: agentEngineResultDigest(offeredCadences) },
    _body: body };
}

async function saveCustomerEstimate(input, actionContext) {
  if (!actionContext.confirmed) return estimatePreview(input);
  if (!actionContext.isAdmin || !input._verified_estimate_version || !actionContext.operationId) {
    throw failure('A fresh administrator confirmation is required.', 'approval_required');
  }
  return db.transaction(async trx => {
    // Lock order: customer (and its properties) FIRST, then the estimate.
    // updateCustomer locks the customers row and its fanout then touches the
    // open estimates rows, so taking the estimate lock before the customer
    // lock here would be an AB-BA deadlock against a concurrent profile edit.
    const context = await loadContext(input, trx, true);
    if (input.estimate_id) {
      const observed = await trx('estimates').where({ id: input.estimate_id }).first();
      if (!observed) throw failure('Estimate not found', 'target_not_found', 404);
      // A native editor may hold a group lock while waiting for acceptance
      // to release the estimate row. Never join that wait with customer held.
      await persistence.lockEstimateGroupAddressRevision(trx, observed.estimate_group_id, { noWait: true });
      await persistence.lockScheduledGroupGuardGroups(trx, observed, observed, { noWait: true });
      // Customer acceptance takes estimate -> customer. Do not wait on its
      // estimate lock while holding the customer needed by conversion.
      const locked = await trx('estimates').where({ id: observed.id }).forUpdate().noWait().first().catch(err => {
        if (err.code === '55P03') throw failure('This estimate is being updated. Ask again after that operation finishes.', 'estimate_busy');
        throw err;
      });
      // A draft deleted between the observed read and the row lock is a
      // deterministic refusal, never a TypeError that strands the action.
      if (!locked) throw failure('The estimate was deleted after the preview. Nothing was saved.', 'target_not_found', 404);
      if (locked.estimate_group_id !== observed.estimate_group_id) throw failure('Estimate group changed. Review again.', 'preview_changed');
    }
    const preview = await estimatePreview(input, trx, context);
    if (JSON.stringify(preview._version) !== JSON.stringify(input._verified_estimate_version)) {
      throw failure('The customer, property, estimate or pricing changed. Review a fresh preview.', 'preview_changed');
    }
    const actor = await trx('technicians').where({ id: actionContext.technicianId, active: true, role: 'admin' }).first();
    if (!actor) throw failure('Administrator access is required.', 'permission_denied', 403);
    const params = { database: trx, body: { ...preview._body, clientDraftId: actionContext.operationId },
      technicianId: actor.id, technician: actor, requireLivePricing: true, expectedEngineResultDigest: preview.engine_result_digest };
    const result = input.estimate_id
      ? await persistence.reviseAdminEstimate({ ...params, estimateId: input.estimate_id })
      : await persistence.createOrReuseAdminEstimate(params);
    const saved = await trx('estimates').where({ id: result.estimate.id }).first();
    if (!saved || !sameId(saved.customer_id, input.customer_id) || !sameId(saved.property_id, input.property_id)
        || agentEngineResultDigest(saved.estimate_data.engineResult) !== preview.engine_result_digest) {
      throw failure('The saved estimate did not match its approved price and property.', 'verification_failed');
    }
    const auditId = await require('../audit-log').recordAuditEvent({ actor_type: 'admin', actor_id: actor.id,
      action: input.estimate_id ? 'estimate_revised' : 'estimate_created', resource_type: 'estimate', resource_id: saved.id,
      metadata: { customer_id: input.customer_id, property_id: input.property_id, source: 'intelligence_bar' }, critical: true, trx });
    const receipt = { success: true, estimate_id: saved.id, customer_id: saved.customer_id, property_id: saved.property_id,
      status: saved.status, edit_version: persistence.estimateEditVersion(saved), audit_id: auditId,
      verification: { persisted: true, pricing_matches: true },
      receipt: { label: input.estimate_id ? 'Estimate revised' : 'Estimate draft saved',
        summary: 'Saved with engine-verified pricing. No message was sent.', href: `/admin/estimates?editEstimateId=${saved.id}` } };
    await require('./pending-actions').recordResult(actionContext.operationId, receipt, { database: trx, critical: true });
    return receipt;
  });
}

async function executeCustomerEstimateTool(name, input, actionContext = {}) {
  if (!gateEnvValue('GATE_IB_PLATFORM')) return { error: 'Customer estimate actions are disabled', code: 'integration_disabled' };
  try {
    const result = name === 'get_customer_estimate_context' ? await readCustomerEstimateContext(input)
      : name === 'save_customer_estimate' ? await saveCustomerEstimate(input, actionContext)
        : { error: 'Unknown customer estimate action', code: 'capability_unimplemented' };
    // The internal payload is used only inside the confirmed domain transaction.
    // Never expose it as model-authored inputs or as an operator receipt.
    if (result?._body) delete result._body;
    return result;
  } catch (err) {
    if (!err.statusCode) throw err;
    return { success: false, error: err.message, code: err.code || 'domain_validation', preview_changed: err.code === 'preview_changed' };
  }
}

module.exports = { CUSTOMER_ESTIMATE_TOOLS, executeCustomerEstimateTool };
