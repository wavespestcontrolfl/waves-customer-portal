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
  stripPortalUrlScheme: (value) => String(value).replace(/^https:\/\//, ''),
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
  for (const method of ['whereRaw', 'orWhere', 'orWhereRaw', 'forUpdate', 'orderBy', 'limit', 'transacting']) builder[method] = jest.fn(() => builder);
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
  jest.clearAllMocks();
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

describe('reviewed send attempt receipts', () => {
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
