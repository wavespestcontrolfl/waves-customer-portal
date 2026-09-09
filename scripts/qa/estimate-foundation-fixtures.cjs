'use strict';
const assert = require('node:assert/strict');
const result = {
  recurring: { tier: 'Bronze', serviceCount: 1, monthlyTotal: 50, grandTotal: 50, annualAfterDiscount: 600,
    services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }] },
  oneTime: { total: 99, items: [{ service: 'pest_initial', name: 'Initial service', price: 99 }] },
  results: {}, totals: { year2mo: 50, year1: 699, year2: 600 },
};
const source = {
  id: 'estimate-example-a', status: 'draft', editable: true, editVersion: 'version-a',
  customerId: 'customer-example-a', customerName: 'Avery Example', customerPhone: '+19415550100',
  customerEmail: 'avery@example.invalid', address: '100 Example Court, Example City, FL 34201',
  notes: 'Notes for Avery only.', propertyId: 'property-example-a',
  inputs: { svcPest: true, homeSqFt: '2000', lotSqFt: '6000',
    manualDiscountPreset: '__custom__', manualDiscountType: 'FIXED', manualDiscountValue: '25',
    manualDiscountLabel: 'Customer-specific credit', manualDiscountInternalReason: 'First customer only',
    serviceSpecificDiscountKeys: ['first-customer-credit'] },
  engineRequest: { profile: { homeSqFt: 2000, lotSqFt: 6000 }, selectedServices: ['PEST'], options: { pestTier: 'quarterly' } },
  result, token: 'synthetic-example-token', updatedAt: '2026-09-08T15:00:00Z',
};

function createFixtures({ baseUrl, pendingCreate, pendingCalculation }) {
  const records = new Map([[source.id, structuredClone(source)]]);
  const state = { failCreate: true, conflictRevision: false };
  const handlers = new Map();
  const reply = (body, status = 200) => ({ body, status });
  const staticReads = {
    '/api/admin/auth/me': { id: 'fixture-user', role: 'admin', name: 'Fixture operator' },
    '/api/admin/feature-flags': { flags: {} },
    '/api/admin/communications/unread-count': { count: 0, conversations: 0 },
    '/api/admin/notifications/unread-count': { count: 0, conversations: 0 },
    '/api/admin/discounts': [],
    '/api/admin/triage': { items: [] },
    '/api/admin/leads/lead-example-a': { lead: { id: 'lead-example-a', extracted_data: {} } },
    [`/api/admin/customers/${source.customerId}/properties`]: { properties: [] },
    [`/api/admin/estimates/customer-spend/${source.customerId}`]: { services: [] },
  };
  for (const key of ['lawn_pricing_v2', 'onetime_flea', 'rodent_bait_brackets', 'rodent_setup_fee', 'rodent_waveguard', 'termite_rental']) {
    staticReads[`/api/admin/pricing-config/${key}`] = { data: null, featureAvailable: false, subFeaturesAvailable: {} };
  }
  for (const [endpoint, body] of Object.entries(staticReads)) handlers.set(`GET ${endpoint}`, () => reply(structuredClone(body)));
  for (const id of [source.id, 'estimate-example-created']) {
    handlers.set(`GET /api/admin/estimates/${id}/edit-source`, () => {
      assert.ok(records.has(id), 'Cannot reopen an unsaved fixture');
      return reply(structuredClone(records.get(id)));
    });
    handlers.set(`GET /api/admin/estimates/${id}/group`, () => reply({ estimates: [] }));
  }
  handlers.set('GET /api/admin/estimates/estimate-example-created/send-preview', () => {
    const record = records.get('estimate-example-created');
    assert.ok(record, 'Cannot review an unsaved fixture');
    return reply({ ...structuredClone(record), previewPath: '/preview-estimate.html?scenario=pest',
      customerUrl: `${baseUrl}/preview-estimate.html?scenario=pest`, messageVersion: 'message-example-v1', groupVersions: [],
      messages: { sms: 'A fictional estimate preview for the selected recipient.', email: { subject: 'Example estimate', text: 'A fictional estimate email preview.' } } });
  });
  handlers.set('POST /api/admin/estimator/turf-preview', () => reply({ turfSf: 4000 }));
  handlers.set('POST /api/admin/estimator/calculate-estimate', async () => {
    await pendingCalculation;
    return reply(structuredClone(result));
  });
  handlers.set('POST /api/admin/estimates', async (body) => {
    if (state.failCreate) {
      await pendingCreate;
      state.failCreate = false;
      return reply({ error: 'Example save failed. Please retry.' }, 503);
    }
    const record = { ...body, id: 'estimate-example-created', status: 'draft', editable: true,
      editVersion: 'created-v1', token: 'synthetic-created-token', updatedAt: source.updatedAt,
      inputs: body.estimateData.inputs, result: body.estimateData.result, engineRequest: body.estimateData.engineRequest };
    records.set(record.id, structuredClone(record));
    return reply(record);
  });
  handlers.set('PUT /api/admin/estimates/estimate-example-created', (body) => {
    if (state.conflictRevision) return reply({ error: 'This example changed in another editor. Reopen the saved estimate.' }, 409);
    const id = 'estimate-example-created', prior = records.get(id);
    assert.ok(prior, 'Cannot revise an unsaved fixture');
    assert.equal(body.expectedEditVersion, prior.editVersion, 'The current revision must be sent');
    const record = { ...prior, ...body, editVersion: `${prior.editVersion}-next`,
      inputs: body.estimateData.inputs, result: body.estimateData.result, engineRequest: body.estimateData.engineRequest };
    if (!body.dryRun) records.set(id, structuredClone(record));
    return reply(structuredClone(record));
  });
  async function dispatch(method, endpoint, body) {
    const handler = handlers.get(`${method} ${endpoint}`);
    assert.ok(handler, `Unexpected fixture request: ${method} ${endpoint}`);
    return handler(body);
  }
  return { records, state, dispatch };
}
module.exports = { source, createFixtures };
