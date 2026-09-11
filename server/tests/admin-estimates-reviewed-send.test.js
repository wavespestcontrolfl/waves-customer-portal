/**
 * Reviewed estimate delivery: the confirmation, scheduled execution and retry
 * receipt must describe the same offer and provider attempt. All persistence,
 * transports, attachments and downstream notifications are isolated mocks.
 */
jest.mock('../models/db', () => {
  const database = jest.fn();
  database.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  database.fn = { now: () => new Date('2026-01-01T12:00:00.000Z') };
  database.transaction = jest.fn(async (callback) => callback(database));
  return database;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false),
}));
jest.mock('../services/email-fallback-gate', () => ({ smtpFallbackAllowed: jest.fn(() => false) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url, options) => `https://portal.wavespestcontrol.com/s/synthetic-${options.channel}`),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-synthetic-reviewed' })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (key, vars) => `Synthetic estimate: ${vars.estimate_url.replace(/^https:\/\//, '')}`),
}));
jest.mock('../services/email-template-library', () => {
  const template = { template_key: 'estimate.delivery' };
  const version = { id: 'synthetic-email-version' };
  const renderTemplate = jest.fn(({ payload }) => ({
    subject: 'Synthetic estimate message',
    text: `${payload.price_summary}\n${payload.estimate_url}`,
    html: '<p>Synthetic estimate message</p>',
  }));
  return {
    templateContentHash: jest.requireActual('../services/email-template-library').templateContentHash,
    loadTemplateByKey: jest.fn(async (key) => ({ template: { ...template, template_key: key }, activeVersion: version })),
    renderTemplate,
    renderVersion: jest.fn(async (id, payload) => renderTemplate({ template, version: { id }, payload })),
    sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'synthetic-email-accepted' } })),
  };
});
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => null) }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(), buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(), saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn(), stampFirstResponseByContact: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/estimate-learning', () => ({ recordSentLearningEvent: jest.fn(), recordPreSendRevision: jest.fn() }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/triage-auto-resolve', () => ({ deliveredEstimateScope: jest.fn(() => ({ lines: [] })) }));
jest.mock('../services/pdf/estimate-doc-pdf', () => ({
  buildEstimateProposalEmailAttachmentPreferred: jest.fn(async () => ({ filename: 'synthetic-proposal.pdf', content: 'c3ludGhldGlj', type: 'application/pdf' })),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(), bookingServiceFor: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({ services: [] })),
}));
jest.mock('../services/admin-estimate-persistence', () => ({
  ...jest.requireActual('../services/admin-estimate-persistence'),
  staleCallLinkageReason: jest.fn(async () => null),
}));

const db = require('../models/db');
const router = require('../routes/admin-estimates');
const persistence = require('../services/admin-estimate-persistence');
const email = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const { computeProposalTotals, normalizeProposal } = require('../services/estimate-proposal');
const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { GATED_SEND_AUTHORITY_SQL } = require('../services/pricing-authority-gate');
const { REPRICE_PENDING_ABSENT_SQL } = require('../utils/estimate-claim-sql');

let row;
let mutations;

function savedEstimate(overrides = {}) {
  return {
    id: 'synthetic-estimate', token: 'synthetic-estimate-token', status: 'sending',
    customer_id: null, customer_name: 'Synthetic Recipient',
    customer_phone: '+19415550123', customer_email: 'recipient@example.invalid',
    address: 'Synthetic service property', monthly_total: '100', annual_total: '1200', onetime_total: '0',
    pricing_authority: 'SERVER', estimate_data: {}, estimate_group_id: null,
    created_at: new Date('2026-01-01T12:00:00.000Z'), updated_at: new Date('2026-01-01T12:00:00.000Z'),
    ...overrides,
  };
}

function dataOf(estimate = row) {
  return typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;
}

// The send tests need one persisted row. Reads clone it, and whole-blob and
// JSONB-merge writes update it, so channel receipts survive subsequent reads.
function estimateDatabase(table) {
  const filters = [];
  const builder = {};
  const matches = () => table === 'estimates' && filters.every((filter) => filter(row));
  builder.where = jest.fn((key, value) => {
    if (typeof key === 'function') { key(builder); return builder; }
    for (const [field, expected] of Object.entries(typeof key === 'object' ? key : { [key]: value })) {
      filters.push((candidate) => candidate[field] === expected);
    }
    return builder;
  });
  builder.whereNot = jest.fn((fields) => {
    for (const [field, value] of Object.entries(fields)) filters.push((candidate) => candidate[field] !== value);
    return builder;
  });
  builder.whereNull = jest.fn((field) => { filters.push((candidate) => candidate[field] == null); return builder; });
  builder.whereNotNull = jest.fn((field) => { filters.push((candidate) => candidate[field] != null); return builder; });
  builder.whereIn = jest.fn((field, values) => { filters.push((candidate) => values.includes(candidate[field])); return builder; });
  builder.whereNotIn = jest.fn((field, values) => { filters.push((candidate) => !values.includes(candidate[field])); return builder; });
  for (const method of ['whereRaw', 'orWhereRaw', 'orWhereNotNull', 'forUpdate', 'orderBy', 'limit', 'transacting']) builder[method] = jest.fn(() => builder);
  builder.orWhere = jest.fn((key) => { if (typeof key === 'function') key(builder); return builder; });
  builder.modify = jest.fn((callback) => { callback(builder); return builder; });
  builder.first = jest.fn(async () => matches() ? structuredClone(row) : null);
  builder.select = jest.fn(async () => matches() ? [structuredClone(row)] : []);
  builder.update = jest.fn(async (patch) => {
    mutations.push({ table, patch });
    if (!matches()) return 0;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'estimate_data' && value?.sql) {
        if (value.bindings?.[0]) row.estimate_data = { ...dataOf(), ...JSON.parse(value.bindings[0]) };
      } else if (key === 'status' && value?.sql) row.status = row.viewed_at ? 'viewed' : 'sent';
      else row[key] = value;
    }
    return 1;
  });
  return builder;
}

async function invoke(path, method, body = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods[method]);
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.set = jest.fn(() => res);
  res.json = jest.fn((value) => { res.body = value; return res; });
  const next = jest.fn();
  await layer.route.stack.at(-1).handle({ params: { id: row.id }, body, query: {} }, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
}

function scheduledAttempt({ key = 'synthetic-scheduled-attempt', startedAt, result, channels = {} } = {}) {
  const scheduledAt = new Date(Date.now() + 86400000).toISOString();
  const body = { sendMethod: 'email', scheduledAt, idempotencyKey: key };
  const entry = {
    key, binding: JSON.stringify(['email', scheduledAt, null, null, null]), channels,
    scheduleResult: { success: true, scheduled: true, scheduledAt },
    scheduleReview: { scheduledAt },
    ...(startedAt ? { startedAt } : {}), ...(result ? { result } : {}),
  };
  return { entry, body, scheduledAt };
}

beforeEach(() => {
  isEnabled.mockImplementation(() => false);
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(false);
  row = savedEstimate();
  mutations = [];
  db.mockImplementation(estimateDatabase);
  sendgrid.isConfigured.mockReturnValue(true);
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-synthetic-reviewed' });
  email.sendTemplate.mockImplementation(async ({ onQueued }) => {
    await onQueued?.();
    return { sent: true, message: { provider_message_id: 'synthetic-email-accepted' } };
  });
  email.loadTemplateByKey.mockImplementation(async (key) => ({ template: { template_key: key }, activeVersion: { id: 'synthetic-email-version' } }));
});

describe('commercial bid authoring', () => {
  beforeEach(() => gateEnvValue.mockImplementation((key) => key === 'GATE_COMMERCIAL_BID_BUILDER'));
  const proposal = () => ({ enabled: true, validThrough: '2099-12-21', buildings: [{ name: 'Synthetic field', lineItems: [{ id: 'application', description: 'Synthetic application', quantity: 25.8, unit: 'acre', unitPrice: 100, frequency: 'one_time' }] }] });
  const costing = { revenueYears: 1, rows: [{ category: 'labor', phase: 'Phase A', description: 'PRIVATE CREW COST', quantity: 40, unit: 'hour', unitCost: 35, occurrences: 4 }] };
  test.each([['costing only', false], ['a changed line', true]])('re-saving a delivered proposal with %s keeps or drops the emailed-PDF marker (GH codex P2 on #4270)', async (name, changed) => {
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_data: { proposal: proposal(), proposalDelivery: { pdfEmailed: true } } });
    const incoming = proposal();
    if (changed) incoming.buildings[0].lineItems[0].unitPrice = 101;
    const res = await invoke('/:id/proposal', 'put', { expectedEditVersion: persistence.estimateEditVersion(row), proposal: incoming, projectCosting: costing });
    expect(res.statusCode).toBe(200);
    expect(dataOf().proposalCosting).toEqual(costing);
    if (changed) expect(dataOf().proposalDelivery).toBeUndefined();
    else expect(dataOf().proposalDelivery).toEqual({ pdfEmailed: true });
  });
  test('PUT stores fractional quote totals, fixed expiry and private costing atomically', async () => {
    row.status = 'draft';
    const res = await invoke('/:id/proposal', 'put', { expectedEditVersion: persistence.estimateEditVersion(row), proposal: proposal(), projectCosting: costing });
    expect(res.statusCode).toBe(200);
    // The response carries the version this write committed (pre-push codex P1 r3).
    expect(res.body.editVersion).toBe(persistence.estimateEditVersion(row));
    expect(row.onetime_total).toBe(2580);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    expect(dataOf().proposalCosting).toEqual(costing);
    expect(JSON.stringify(dataOf().proposal)).not.toContain('PRIVATE CREW COST');
    expect(dataOf().proposal.buildings[0].lineItems[0]).toMatchObject({ quantity: 25.8, unit: 'acre', amount: 2580 });
  });
  test('PUT rejects stale editing and invalid quantities without replacing saved prices', async () => {
    row.status = 'draft';
    const stale = await invoke('/:id/proposal', 'put', { expectedEditVersion: 'stale-version', proposal: proposal(), projectCosting: costing });
    expect(stale.statusCode).toBe(409);
    expect(mutations).toHaveLength(0);
    const invalid = proposal(); invalid.buildings[0].lineItems[0].quantity = 0.00001;
    const badQuantity = await invoke('/:id/proposal', 'put', { proposal: invalid });
    expect(badQuantity.statusCode).toBe(400);
    expect(mutations).toHaveLength(0);
  });
  // A pending send is judged at the first five-minute tick it can reach:
  // 04:55Z (23:55 ET) still fits a 2099-12-21 hold, 04:55:00.001Z first
  // runs at 05:00Z (pre-push codex P1 on #4309).
  test.each([['2099-12-22T04:55:00Z', 200], ['2099-12-22T04:55:00.001Z', 409], ['2099-12-22T04:59:59.999Z', 409], ['2099-12-22T05:00:00Z', 409]])('scheduled proposal edits respect the full Eastern day at %s', async (scheduledAt, status) => {
    Object.assign(row, { status: 'scheduled', scheduled_at: new Date(scheduledAt), estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-31' } } });
    const res = await invoke('/:id/proposal', 'put', { proposal: proposal() });
    expect(res.statusCode).toBe(status);
    if (status === 409) {
      expect(res.body.error).toMatch(/scheduled send date/);
      expect(mutations).toHaveLength(0);
      expect(dataOf().proposal.validThrough).toBe('2099-12-31');
    }
  });
  test.each(['draft', 'scheduled', 'send_failed', 'sent', 'viewed'].flatMap(status => [
    [status, '2099-12-22T04:55:00Z', 200], [status, '2099-12-22T04:55:00.001Z', 409], [status, '2099-12-22T04:59:59.999Z', 409], [status, '2099-12-22T05:00:00Z', 409],
  ]))('editing a %s sibling respects the group send at %s', async (status, sendAt, expected) => {
    Object.assign(row, { status, estimate_group_id: 'synthetic-group',
      estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-31' } } });
    const before = structuredClone(row);
    db.mockImplementation(table => {
      const builder = estimateDatabase(table);
      const originalWhere = builder.where;
      let pendingSchedule = false;
      builder.where = jest.fn((key, operator, value) => {
        if (key?.status === 'scheduled' && key.estimate_group_id === row.estimate_group_id) pendingSchedule = true;
        if (pendingSchedule && key === 'scheduled_at') {
          expect(operator).toBe('>');
          // The SQL bound is the last schedule whose tick fits the hold.
          expect(value.toISOString()).toBe('2099-12-22T04:55:00.000Z');
          builder.first = jest.fn(async () => new Date(sendAt) > value ? { id: 'scheduled-sibling' } : null);
          return builder;
        }
        return originalWhere(key, operator);
      });
      return builder;
    });
    const response = await invoke('/:id/proposal', 'put', { proposal: proposal() });
    expect(response.statusCode).toBe(expected);
    if (expected === 409) {
      expect(response.body.error).toMatch(/group’s scheduled send date/);
      expect(mutations).toHaveLength(0);
      expect(row).toEqual(before);
    }
  });
  test.each([[false], [true]])('saving a longer fixed hold pushes the group\'s published members forward so the entry link keeps assembling the group (pre-push codex P1 on #4309; send gate on: %s)', async (sendGateOn) => {
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_group_id: 'synthetic-group', estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-21' } } });
    isEnabled.mockImplementation((flag) => flag === 'sendRequiresServerPricing' && sendGateOn);
    const whereRawSql = [];
    db.mockImplementation((table) => { const b = estimateDatabase(table); const raw = b.whereRaw; b.whereRaw = jest.fn((sql) => { whereRawSql.push(String(sql)); return raw(sql); }); return b; });
    const res = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(whereRawSql.some((sql) => /expired_unsent/.test(sql))).toBe(true);
    // The revive never reaches a sibling that cannot render, and under the
    // send gate never one that fails the pricing-authority verdict
    // (pre-push codex P1 on #4270).
    expect(whereRawSql.some((sql) => /linkage_invalidated_at/.test(sql))).toBe(true);
    expect(whereRawSql.some((sql) => /invalidation_pending_at/.test(sql))).toBe(true);
    expect(whereRawSql).toContain(REPRICE_PENDING_ABSENT_SQL);
    expect(whereRawSql.includes(GATED_SEND_AUTHORITY_SQL)).toBe(sendGateOn);
    expect(res.statusCode).toBe(200);
    const siblingExtension = mutations.find(({ patch }) => !patch.estimate_data && patch.expires_at);
    expect(new Date(siblingExtension.patch.expires_at).toISOString()).toBe('2100-01-01T04:59:59.999Z');
    // A sweep-expired published anchor is revived by the same write, never an unsent expiry.
    expect(String(siblingExtension.patch.status?.sql ?? siblingExtension.patch.status)).toMatch(/WHEN status = 'expired' THEN \(CASE WHEN viewed_at IS NOT NULL THEN 'viewed' ELSE 'sent' END\)/);
    expect(String(siblingExtension.patch.disposition?.sql ?? siblingExtension.patch.disposition)).toMatch(/expired_unviewed/);
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
  });
  test('the push-forward revival carries the pricing-authority predicate while the rollout gate is on (GH codex P1 r5 on #4309)', async () => {
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_group_id: 'synthetic-group', estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-21' } } });
    isEnabled.mockImplementation((flag) => flag === 'sendRequiresServerPricing');
    const whereRawSql = [];
    db.mockImplementation((table) => { const b = estimateDatabase(table); const raw = b.whereRaw; b.whereRaw = jest.fn((sql) => { whereRawSql.push(String(sql)); return raw(sql); }); return b; });
    try {
      const res = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
      expect(res.statusCode).toBe(200);
      expect(whereRawSql).toContain(GATED_SEND_AUTHORITY_SQL);
    } finally {
      isEnabled.mockImplementation(() => false);
    }
  });
  test('shortening a fixed hold pulls members back off the obsolete widened expiry (GH codex P1 r4 on #4309)', async () => {
    const oldExpiry = new Date('2100-01-01T04:59:59.999Z');
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: oldExpiry, estimate_group_id: 'synthetic-group',
      estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-31' } } });
    // An ordinary sibling delivered on Jan 3 whose entry expiry this
    // anchor's old date had widened; its own standard window ended Jan 10.
    const sibling = savedEstimate({ id: 'synthetic-sibling', status: 'viewed', sent_at: new Date('2026-01-03T12:00:00.000Z'), viewed_at: new Date('2026-01-04T12:00:00.000Z'),
      expires_at: oldExpiry, estimate_group_id: 'synthetic-group', estimate_data: {} });
    const siblingUpdates = [];
    db.mockImplementation((table) => {
      const b = estimateDatabase(table);
      let groupQuery = false; let targetId = null;
      const originalWhere = b.where.getMockImplementation();
      b.where.mockImplementation((key, value) => { if (key?.estimate_group_id && !key.id) groupQuery = true; if (key?.id) targetId = key.id; return originalWhere(key, value); });
      const originalSelect = b.select.getMockImplementation();
      b.select.mockImplementation(async (...args) => (groupQuery ? [structuredClone(sibling)] : originalSelect(...args)));
      const originalUpdate = b.update.getMockImplementation();
      b.update.mockImplementation(async (patch) => { if (targetId === sibling.id) { siblingUpdates.push(patch); return 1; } return originalUpdate(patch); });
      return b;
    });
    const res = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-21' } });
    expect(res.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    expect(siblingUpdates).toHaveLength(1);
    expect(new Date(siblingUpdates[0].expires_at).toISOString()).toBe('2099-12-22T04:59:59.999Z');
  });
  test('an older editor omitting validity preserves the saved price hold', async () => {
    gateEnvValue.mockReturnValue(false);
    row.status = 'draft'; row.estimate_data = { proposal: proposal() };
    const incoming = proposal(); delete incoming.validThrough;
    const res = await invoke('/:id/proposal', 'put', { proposal: incoming });
    expect(res.statusCode).toBe(200);
    expect(dataOf().proposal.validThrough).toBe('2099-12-21');
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
  });
  test('a legacy editor cannot discard saved units by omitting line identifiers while the gate is off', async () => {
    gateEnvValue.mockReturnValue(false);
    row.status = 'draft'; row.estimate_data = { proposal: proposal(), proposalCosting: costing };
    const incoming = proposal();
    delete incoming.buildings[0].lineItems[0].id;
    delete incoming.buildings[0].lineItems[0].unit;
    const res = await invoke('/:id/proposal', 'put', { proposal: incoming });
    expect(res.statusCode).toBe(409);
    expect(mutations).toHaveLength(0);
    expect(dataOf().proposal.buildings[0].lineItems[0].unit).toBe('acre');
  });
  test.each([
    ['draft', null, null, null], ['expired', null, null, null],
    ['sent', '2099-01-01T12:00:00Z', null, '2099-01-08T12:00:00.000Z'],
    ['scheduled', null, '2099-01-10T12:00:00Z', '2099-01-17T12:00:00.000Z'],
    ['scheduled', '2020-01-01T12:00:00Z', '2099-01-10T12:00:00Z', '2099-01-17T12:00:00.000Z'],
  ])('clearing fixed validity restores the ordinary %s expiry from delivery, never the save time', async (status, sentAt, scheduledAt, expected) => {
    Object.assign(row, { status, sent_at: sentAt, scheduled_at: scheduledAt, expires_at: new Date('2026-01-09T04:59:59.999Z'),
      estimate_data: { proposal: { ...proposal(), validThrough: '2026-01-08' } } });
    const res = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: null } });
    expect(res.statusCode).toBe(200);
    expect(row.expires_at?.toISOString() ?? null).toBe(expected);
    if (!sentAt && !scheduledAt) expect(row.status).toBe('draft');
  });
  test.each(['validity', 'costing', 'unit'])('the disabled gate refuses new %s from a stale editor without changing the saved bid', async (field) => {
    row.status = 'draft'; row.estimate_data = { proposal: proposal(), proposalCosting: costing };
    const body = { proposal: proposal() };
    if (field === 'validity') body.proposal.validThrough = null;
    if (field === 'costing') body.projectCosting = { ...costing, rows: [] };
    if (field === 'unit') body.proposal.buildings[0].lineItems[0].unit = 'sqft';
    gateEnvValue.mockReturnValue(false);
    const res = await invoke('/:id/proposal', 'put', body);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/Bid authoring is currently disabled/);
    expect(mutations).toHaveLength(0);
    expect(dataOf()).toEqual({ proposal: proposal(), proposalCosting: costing });
  });
  test('the disabled gate rejects original-form uploads before parsing files or reading estimates', async () => {
    gateEnvValue.mockReturnValue(false);
    const layer = router.stack.find((entry) => entry.route?.path === '/:id/proposal/bid-form.pdf');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await layer.route.stack[0].handle({}, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
  test('an expired fixed bid can be explicitly revised and its expiry disposition is cleared', async () => {
    row.status = 'expired'; row.sent_at = new Date('2026-01-01T12:00:00Z');
    row.disposition = 'expired_unviewed';
    row.estimate_data = { proposal: { ...proposal(), validThrough: '2026-01-08' } };
    const res = await invoke('/:id/proposal', 'put', { proposal: proposal() });
    expect(res.statusCode).toBe(200);
    expect(row.status).toBe('sent'); expect(row.disposition).toBeNull();
  });
});

describe('reviewed send attempt receipts', () => {
  test('a repeat customer open between preview and scheduling preserves the reviewed version', async () => {
    row.status = 'viewed';
    row.view_count = 1;
    row.last_viewed_at = '2026-01-01T12:00:00Z';
    const preview = await invoke('/:id/send-preview', 'get');
    row.view_count = 2;
    row.last_viewed_at = '2026-01-02T12:00:00Z';
    const response = await invoke('/:id/send', 'post', {
      ...scheduledAttempt().body,
      expectedEditVersion: preview.body.editVersion,
      messageVersion: preview.body.messageVersion,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.scheduled).toBe(true);
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a terminal pre-dispatch schedule failure replays failure instead of the queued receipt', async () => {
    const { entry, body } = scheduledAttempt();
    row.status = 'send_failed';
    row.scheduled_at = null;
    row.last_send_error = 'The reviewed estimate changed before its scheduled send.';
    row.estimate_data = { manualSendAttempts: [entry] };
    const response = await invoke('/:id/send', 'post', body);
    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: 'SCHEDULED_SEND_FAILED', scheduled: false, sent: false,
      replayed: true, error: row.last_send_error });
    expect(mutations).toEqual([]);
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an active scheduled attempt still replays its queued receipt', async () => {
    const { entry, body, scheduledAt } = scheduledAttempt();
    row.status = 'scheduled';
    row.scheduled_at = scheduledAt;
    row.estimate_data = { manualSendAttempts: [entry] };
    const response = await invoke('/:id/send', 'post', body);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ...entry.scheduleResult, replayed: true });
    expect(mutations).toEqual([]);
  });

  test.each([
    ['sms', 'sms'], ['email', 'email'], ['both', 'sms'], ['both', 'email'],
  ])('scheduling %s rejects an unavailable %s message for reviewed and legacy callers', async (sendMethod, missing) => {
    row.status = 'draft';
    if (missing === 'sms') require('../routes/admin-sms-templates').getTemplate.mockResolvedValueOnce(null);
    else email.loadTemplateByKey.mockResolvedValueOnce(null);
    const preview = await invoke('/:id/send-preview', 'get');
    const { body } = scheduledAttempt();
    for (const reviewed of [true, false]) {
      if (missing === 'sms') require('../routes/admin-sms-templates').getTemplate.mockResolvedValueOnce(null);
      else email.loadTemplateByKey.mockResolvedValueOnce(null);
      const response = await invoke('/:id/send', 'post', { ...body, sendMethod,
        ...(reviewed ? { messageVersion: preview.body.messageVersion } : {}) });
      expect(response.statusCode).toBe(422);
      expect(response.body.code).toBe('ESTIMATE_MESSAGE_UNAVAILABLE');
      expect(response.body.error).toContain(missing);
      expect(row.status).toBe('draft');
    }
    expect(mutations).toEqual([]);
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a missing unselected message does not block scheduling the available channel', async () => {
    row.status = 'draft';
    require('../routes/admin-sms-templates').getTemplate.mockResolvedValueOnce(null);
    const { body } = scheduledAttempt();
    const response = await invoke('/:id/send', 'post', body);
    expect(response.statusCode).toBe(200);
    expect(response.body.scheduled).toBe(true);
    expect(row.status).toBe('scheduled');
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an interrupted scheduled attempt replays uncertainty instead of its old queued receipt', async () => {
    const { entry, body } = scheduledAttempt({ startedAt: new Date().toISOString(), channels: { email: { ok: true } } });
    row.estimate_data = { manualSendAttempts: [entry] };
    const response = await invoke('/:id/send', 'post', body);
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'SEND_OUTCOME_UNCERTAIN', channels: { email: { ok: true } } });
    expect(response.body.scheduled).toBeUndefined();
    expect(mutations).toEqual([]);
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a completed scheduled attempt replays its actual delivery result without another handoff', async () => {
    const result = { sent: true, channels: { email: { ok: true } }, sentChannels: ['email'], failedChannels: [] };
    const { entry, body } = scheduledAttempt({ startedAt: new Date().toISOString(), result });
    row.estimate_data = { manualSendAttempts: [entry] };
    const response = await invoke('/:id/send', 'post', body);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ...result, replayed: true });
    expect(mutations).toEqual([]);
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test('scheduled execution restores the confirmed email attempt key and completes that receipt', async () => {
    const { entry, scheduledAt } = scheduledAttempt();
    row.scheduled_at = scheduledAt;
    row.estimate_data = { manualSendAttempts: [entry] };
    const expectedKey = router._internals.estimateEmailIdempotencyKey(row, entry.key);
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(email.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expectedKey }));
    expect(dataOf().manualSendAttempts[0]).toMatchObject({ key: entry.key, result: { sent: true } });
  });

  test('a scheduled attempt cannot send after a different immediate attempt became uncertain', async () => {
    const { entry, scheduledAt } = scheduledAttempt();
    row.scheduled_at = scheduledAt;
    row.estimate_data = { manualSendAttempts: [entry, { key: 'synthetic-interrupted-immediate', startedAt: new Date().toISOString(), channels: { sms: { ok: true } } }] };
    await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true }))
      .rejects.toMatchObject({ code: 'SEND_OUTCOME_UNCERTAIN' });
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([true, false])('a scheduled deliberate resend honors acknowledged earlier uncertainty (request key: %s)', async (withKey) => {
    row.status = 'draft';
    const earlier = { key: 'synthetic-earlier-timeout', startedAt: new Date().toISOString() };
    row.estimate_data = { manualSendAttempts: [earlier] };
    const { body } = scheduledAttempt();
    if (!withKey) delete body.idempotencyKey;
    expect((await invoke('/:id/send', 'post', body)).statusCode).toBe(409);
    const scheduled = await invoke('/:id/send', 'post', { ...body, acknowledgeUncertainSend: true });
    expect(scheduled.body.scheduled).toBe(true);
    const receipt = dataOf().manualSendAttempts[1];
    expect(receipt.scheduleReview.acknowledgedUncertainAttemptKeys).toEqual([earlier.key]);
    row.status = 'sending'; // the existing cron's atomic claim
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(dataOf().manualSendAttempts.find((entry) => entry.key === receipt.key).result.sent).toBe(true);
    expect(dataOf().manualSendAttempts[0].result).toBeUndefined();
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('a scheduled acknowledgement does not authorize uncertainty from a later attempt', async () => {
    row.status = 'draft';
    row.estimate_data = { manualSendAttempts: [{ key: 'old-timeout', startedAt: new Date().toISOString() }] };
    const { body } = scheduledAttempt();
    expect((await invoke('/:id/send', 'post', { ...body, acknowledgeUncertainSend: true })).body.scheduled).toBe(true);
    row.estimate_data = { ...dataOf(), manualSendAttempts: [
      ...dataOf().manualSendAttempts, { key: 'later-timeout', startedAt: new Date().toISOString() },
    ] };
    row.status = 'sending';
    await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true }))
      .rejects.toMatchObject({ code: 'SEND_OUTCOME_UNCERTAIN' });
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test.each(['reviewed email content changed', 'template disabled', 'template version not found'])('pre-dispatch %s is a definite failed receipt', async (reason) => {
    const { entry, body } = scheduledAttempt();
    const reviewedMessages = { email: { versionId: 'synthetic-reviewed-version' } };
    email.sendTemplate.mockRejectedValueOnce(new Error(reason));
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { manualAttempt: entry, reviewedMessages });
    expect(result).toMatchObject({ sent: false, channels: { email: { ok: false, uncertain: false } } });
    expect(dataOf().manualSendAttempts[0].result.sent).toBe(false);
    expect((await invoke('/:id/send', 'post', body)).body).toMatchObject({ sent: false, replayed: true });
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('a provider timeout keeps its channel receipt unresolved and replay never dispatches again', async () => {
    const { entry, body, scheduledAt } = scheduledAttempt();
    row.scheduled_at = scheduledAt;
    row.estimate_data = { manualSendAttempts: [entry] };
    email.sendTemplate.mockImplementationOnce(async ({ onQueued }) => {
      await onQueued();
      throw Object.assign(new Error('Synthetic provider timeout'), { name: 'TimeoutError' });
    });

    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result).toMatchObject({ sent: false, uncertain: true, channels: { email: { ok: false, uncertain: true } } });
    expect(dataOf().manualSendAttempts[0]).toMatchObject({
      key: entry.key, startedAt: expect.any(String), channels: { email: { uncertain: true } },
    });
    expect(dataOf().manualSendAttempts[0].result).toBeUndefined();
    expect(dataOf().manualSendAttempts[0].completedAt).toBeUndefined();
    const preview = await invoke('/:id/send-preview', 'get');
    expect(preview.body.uncertainAttempt).toBe(true);

    const replay = await invoke('/:id/send', 'post', body);
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ code: 'SEND_OUTCOME_UNCERTAIN', channels: { email: { uncertain: true } } });
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['pre-provider consent read failed', undefined, false],
    ['provider outcome unknown', { sent: false, terminal: false }, true],
    ['provider definitely rejected', { sent: false, terminal: true }, false],
  ])('SMS %s records the corresponding uncertainty', async (reason, providerOutcome, uncertain) => {
    const manualAttempt = { key: 'synthetic-sms-failure', binding: 'synthetic-sms-binding' };
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error(reason), { providerOutcome }));
    const result = await router.sendEstimateNow(structuredClone(row), 'sms', { manualAttempt });
    expect(result).toMatchObject({ sent: false, channels: { sms: { ok: false, uncertain } } });
    const receipt = dataOf().manualSendAttempts[0];
    if (uncertain) expect(receipt.result).toBeUndefined();
    else expect(receipt.result).toMatchObject({ sent: false });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('an SMS audit failure carrying real provider acceptance completes the successful receipt', async () => {
    const manualAttempt = { key: 'synthetic-accepted-sms', binding: 'synthetic-sms-binding' };
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('Synthetic audit write failed'), {
      providerOutcome: { sent: true, providerMessageId: 'SM-synthetic-provider-accepted' },
    }));

    const result = await router.sendEstimateNow(structuredClone(row), 'sms', { manualAttempt });
    expect(result).toMatchObject({
      sent: true, channels: { sms: { ok: true, real: true, status: 'provider_accepted', warning: expect.any(String) } },
    });
    expect(result.uncertain).toBeUndefined();
    expect(dataOf().manualSendAttempts[0]).toMatchObject({
      key: manualAttempt.key, completedAt: expect.any(String), result: { sent: true, channels: { sms: { ok: true } } },
    });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('reviewed message parity', () => {
  test('loading the send preview never writes, shortens links, or invokes a transport', async () => {
    row.status = 'draft';
    const response = await invoke('/:id/send-preview', 'get');
    expect(response.statusCode).toBe(200);
    expect(response.body.messages.email.text).toContain('Priced per application');
    expect(require('../routes/admin-sms-templates').getTemplate).toHaveBeenCalledWith(
      'estimate_sent', expect.any(Object), {}, { noVariants: true, audit: false },
    );
    expect(mutations).toEqual([]);
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('email unavailable in the reviewed message cannot fall through to a newly active template', async () => {
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { reviewedMessages: { sms: null, email: null } });
    expect(result.sent).toBe(false);
    expect(result.channels.email.ok).toBe(false);
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['sendgrid', false],
    ['smtp', true],
  ])('a reviewed %s message never sends through a changed provider', async (provider, sendgridConfigured) => {
    sendgrid.isConfigured.mockReturnValue(sendgridConfigured);
    const result = await router.sendEstimateNow(structuredClone(row), 'email', {
      reviewedMessages: { sms: null, email: { provider, subject: 'Synthetic reviewed subject', text: 'Synthetic reviewed message' } },
    });
    expect(result).toMatchObject({ sent: false, channels: { email: { ok: false, error: expect.stringMatching(/reviewed email provider changed/i) } } });
    expect(result.channels.email.uncertain).not.toBe(true);
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(require('nodemailer').createTransport).not.toHaveBeenCalled();
  });

  test('commercial proposal preview and delivery use the same authoritative price summary', async () => {
    row.estimate_data = { proposal: {
      enabled: true,
      buildings: [{ name: 'Synthetic property', lineItems: [
        { id: 'synthetic-recurring-line', description: 'Synthetic recurring service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: false },
        { id: 'synthetic-setup-line', description: 'Synthetic setup', quantity: 1, unitPrice: 250, frequency: 'one_time', taxable: false },
      ] }],
    } };
    const preview = await invoke('/:id/send-preview', 'get');
    const firstYearTotal = computeProposalTotals(normalizeProposal(row)).firstYearTotal;
    expect(firstYearTotal).toBeGreaterThan(0);
    const result = await router.sendEstimateNow(structuredClone(row), 'email');
    expect(result.sent).toBe(true);
    const payload = email.sendTemplate.mock.calls[0][0].payload;
    expect(preview.body.messages.email.text.split('\n')[0]).toBe(payload.price_summary);
    expect(payload.price_summary).toContain(`first-year total $${firstYearTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  });
});

describe('reviewed multi-property offer revisions', () => {
  test.each(['showOneTimeOption', 'billByInvoice'])('%s cannot change on a sent sibling while another property is being sent', async (option) => {
    row.status = 'sent';
    row.estimate_group_id = 'synthetic-group';
    db.mockImplementation((table) => {
      const builder = estimateDatabase(table);
      const first = builder.first.getMockImplementation();
      builder.first.mockImplementation(async () => builder.where.mock.calls.some(([value]) => value?.estimate_group_id)
        && builder.whereNot.mock.calls.some(([value]) => value?.id === row.id)
        ? { id: 'synthetic-sending-anchor' } : first());
      return builder;
    });
    const response = await invoke('/:id', 'patch', { [option]: false });
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatch(/group is being sent/);
    expect(mutations).toEqual([]);
  });

  test('delivery options remain editable after the group handoff completes', async () => {
    row.status = 'sent';
    row.estimate_group_id = 'synthetic-group';
    row.bill_by_invoice = true;
    const response = await invoke('/:id', 'patch', { billByInvoice: false });
    expect(response.body).toEqual({ success: true });
    expect(row.bill_by_invoice).toBe(false);
    expect(db.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['estimate-group-send', 'synthetic-group'],
    );
  });

  test('a delivery-option update refuses membership that changed while waiting for its group lock', async () => {
    row.status = 'sent';
    row.estimate_group_id = 'synthetic-group';
    db.raw.mockImplementationOnce((sql, bindings) => {
      row.estimate_group_id = 'synthetic-different-group';
      return { sql, bindings };
    });
    const response = await invoke('/:id', 'patch', { billByInvoice: false });
    expect(response.statusCode).toBe(409);
    expect(mutations).toEqual([]);
  });

  test.each(['SERVER', 'CLIENT_FALLBACK'])('%s pricing cannot revise a published sibling while the group is sending', async (authority) => {
    const queriedGroups = [];
    const trx = jest.fn(() => {
      const builder = {};
      builder.where = jest.fn((value) => {
        if (typeof value === 'function') value(builder);
        else if (value.estimate_group_id) queriedGroups.push(value.estimate_group_id);
        return builder;
      });
      for (const method of ['whereNot', 'whereNull', 'orWhereRaw']) builder[method] = jest.fn(() => builder);
      builder.first = jest.fn(async () => ({ id: 'synthetic-sending-anchor' }));
      return builder;
    });
    await expect(persistence.assertNoRevisionDuringGroupSend(
      trx, { id: row.id, status: 'sent', estimate_group_id: 'synthetic-group' }, { pricing_authority: authority },
    )).rejects.toMatchObject({ statusCode: 409 });
    expect(queriedGroups).toEqual(['synthetic-group']);
  });

  test('verified revisions lock both their current and destination groups in consistent order', () => {
    expect(persistence.revisionGroupLockIds(
      { estimate_group_id: 'synthetic-group-z' }, { pricing_authority: 'SERVER', estimate_group_id: 'synthetic-group-a' },
    )).toEqual(['synthetic-group-a', 'synthetic-group-z']);
  });
});


describe('fixed bid deadline at the provider handoff (GH codex P2 r4 on #4309)', () => {
  const expiry = new Date('2099-12-22T04:59:59.999Z');
  const setBid = () => {
    row.estimate_data = { proposal: { enabled: true, validThrough: '2099-12-21',
      buildings: [{ name: 'Synthetic property', lineItems: [
        { id: 'application', description: 'Synthetic application', quantity: 1, unit: 'acre', unitPrice: 100, frequency: 'one_time' },
      ] }] } };
  };
  test.each(['sms', 'email'])('%s refuses a bid whose deadline passes during preparation, as a definite failure', async (channel) => {
    setBid();
    let at = new Date(expiry.getTime() - 5000);
    if (channel === 'sms') {
      shortenOrPassthrough.mockImplementationOnce(async (url) => { at = new Date(expiry.getTime() + 5000); return url; });
    } else {
      require('../services/pdf/estimate-doc-pdf').buildEstimateProposalEmailAttachmentPreferred.mockImplementationOnce(async () => {
        at = new Date(expiry.getTime() + 5000); return { filename: 'synthetic.pdf', content: 'c3ludGhldGlj', type: 'application/pdf' };
      });
    }
    const result = await router.sendEstimateNow(structuredClone(row), channel, { callerPreClaimed: true, now: () => at });
    expect(result.channels[channel]).toMatchObject({ ok: false, error: expect.stringMatching(/validity date has passed/) });
    expect(result.channels[channel].uncertain).not.toBe(true);
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
  test('a bid still inside its deadline at the handoff goes out', async () => {
    setBid();
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true, now: () => new Date(expiry.getTime() - 5000) });
    expect(result.channels.email.ok).toBe(true);
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
