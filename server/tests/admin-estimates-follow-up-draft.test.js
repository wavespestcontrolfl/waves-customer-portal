jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    return data?.result?.quoteRequired === true ||
      data?.quoteRequired === true ||
      data?.result?.specItems?.some((item) => item.quoteRequired === true);
  }),
  estimateDataHasUnresolvedManagerApproval: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    const inputsApproved = data?.inputs?.dethatchingManagerApproved === true &&
      data?.inputs?.dethatchingManagerApprovalTrusted === true &&
      String(data?.inputs?.dethatchingManagerApprovalReason || '').trim().length > 0;
    return !inputsApproved && data?.result?.oneTime?.items?.some((item) => (
      item.requiresManagerApproval === true &&
      item.managerApprovalReason === 'st_augustine_dethatching' &&
      item.managerApprovalSatisfied !== true
    ));
  }),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  bookingServiceFor: jest.fn(),
  isEstimateCustomerViewable: jest.fn(),
}));
jest.mock('../utils/estimate-claim-sql', () => ({
  ...jest.requireActual('../utils/estimate-claim-sql'),
  callSideBlockForEstimateData: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));

jest.mock('../services/pricing-authority-gate', () => ({
  ...jest.requireActual('../services/pricing-authority-gate'),
  estimateDeliverableUnderGate: jest.fn(),
}));
jest.mock('../utils/greeting-first-name', () => ({
  ...jest.requireActual('../utils/greeting-first-name'),
  estimateGreetingFirstName: jest.fn(),
}));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn() }));
jest.mock('../services/estimate-emailed-service-name', () => ({ emailedServiceName: jest.fn() }));
jest.mock('../services/estimate-followup-copy', () => ({
  ...jest.requireActual('../services/estimate-followup-copy'),
  followupEmailVars: jest.fn(),
}));

const router = require('../routes/admin-estimates');
const db = require('../models/db');
const { shortenOrPassthrough } = require('../services/short-url');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { estimateDeliverableUnderGate } = require('../services/pricing-authority-gate');
const { estimateGreetingFirstName } = require('../utils/greeting-first-name');
const { leadIdForEstimate } = require('../services/estimate-lead-linkage');
const { emailedServiceName } = require('../services/estimate-emailed-service-name');
const { followupEmailVars } = require('../services/estimate-followup-copy');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');

function routeHandler(path, method = 'post') {
  const layer = router.stack.find((entry) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const LONG = 'https://portal.wavespestcontrol.com/estimate/tok-fixture';
const SHORT = 'https://go.example.test/fx1';

function estimateRow(extra = {}) {
  return {
    id: 'estimate-fixture',
    token: 'tok-fixture',
    customer_name: 'Dana Fixture',
    customer_phone: '+15555550123',
    customer_id: 'customer-fixture',
    status: 'sent',
    monthly_total: 89,
    estimate_data: {},
    ...extra,
  };
}

function mockRow(row) {
  const update = jest.fn().mockResolvedValue(1);
  const query = { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row), update };
  db.mockReturnValue(query);
  return query;
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

async function draft(row) {
  mockRow(row);
  const res = makeRes();
  const next = jest.fn();
  await routeHandler('/:id/follow-up-draft', 'get')({ params: { id: 'estimate-fixture' } }, res, next);
  return { res, next };
}

async function send(row, body = {}) {
  const query = mockRow(row);
  const res = makeRes();
  const next = jest.fn();
  await routeHandler('/:id/follow-up')({ params: { id: 'estimate-fixture' }, body }, res, next);
  return { res, next, query };
}

const ENV_GATE = 'GATE_ESTIMATE_FOLLOWUP_SERVICE_NAME';

describe('GET /:id/follow-up-draft', () => {
  const savedGate = process.env[ENV_GATE];
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn = { now: jest.fn() };
    db.raw = jest.fn();
    estimateDeliverableUnderGate.mockResolvedValue(true);
    isEstimateCustomerViewable.mockReturnValue(true);
    callSideBlockForEstimateData.mockResolvedValue(null);
    estimateGreetingFirstName.mockResolvedValue('Dana');
    followupEmailVars.mockReturnValue({ service_label: 'home protection' });
    emailedServiceName.mockResolvedValue(null);
    process.env[ENV_GATE] = 'true';
  });
  afterAll(() => {
    if (savedGate === undefined) delete process.env[ENV_GATE];
    else process.env[ENV_GATE] = savedGate;
  });

  test('404 when the estimate does not exist', async () => {
    const { res } = await draft(undefined);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Estimate not found' });
  });

  test.each([
    ['no phone', { customer_phone: null }],
    ['a phone that cannot take texts', { customer_phone: '+11235550123' }],
    ['an accepted estimate', { status: 'accepted' }],
    ['no token', { token: null }],
    ['an expiry date that has passed (the sweep has not marked it yet)', { status: 'viewed', expires_at: new Date(Date.now() - 60000).toISOString() }],
    ['an unreadable expiry date', { expires_at: 'not-a-date' }],
    ['a declined estimate', { status: 'declined' }],
    ['an estimate the sweep marked expired', { status: 'expired' }],
    ['a draft that was never sent', { status: 'draft' }],
  ])('message is null for %s', async (_label, extra) => {
    const { res, next } = await draft(estimateRow(extra));
    expect(res.json).toHaveBeenCalledWith({ message: null });
    expect(next).not.toHaveBeenCalled();
  });

  test('message is null when the estimate is not sendable (manager approval open)', async () => {
    const { res } = await draft(estimateRow({
      estimate_data: {
        result: { oneTime: { items: [{ service: 'dethatching', requiresManagerApproval: true, managerApprovalReason: 'st_augustine_dethatching', managerApprovalSatisfied: false }] } },
      },
    }));
    expect(res.json).toHaveBeenCalledWith({ message: null });
  });

  test('message is null when the pricing-authority gate refuses the send', async () => {
    estimateDeliverableUnderGate.mockResolvedValue(false);
    const { res } = await draft(estimateRow());
    expect(res.json).toHaveBeenCalledWith({ message: null });
  });

  test.each(['pest control', 'lawn care', 'lawn care and pest control'])('names %s with the long link', async (name) => {
    emailedServiceName.mockResolvedValue(name);
    const { res } = await draft(estimateRow());
    expect(res.json).toHaveBeenCalledWith({
      message: `Hi Dana, it's Waves. Your ${name} estimate is here: ${LONG} Any questions? Just reply to this text.`,
    });
  });

  test('message is null when the public page would refuse the link', async () => {
    isEstimateCustomerViewable.mockReturnValue(false);
    const { res } = await draft(estimateRow());
    expect(res.json).toHaveBeenCalledWith({ message: null });
  });

  test('message is null when the call-side verdict blocks the link', async () => {
    callSideBlockForEstimateData.mockResolvedValue('call_linkage_stale');
    const { res } = await draft(estimateRow({ status: 'viewed' }));
    expect(res.json).toHaveBeenCalledWith({ message: null });
    expect(callSideBlockForEstimateData).toHaveBeenCalledWith(db, expect.anything(), { estimateStatus: 'viewed' });
  });

  test('a viewed estimate with an expiry date still ahead gets the ready text', async () => {
    const { res } = await draft(estimateRow({ status: 'viewed', expires_at: new Date(Date.now() + 86400000).toISOString() }));
    expect(res.json).toHaveBeenCalledWith({
      message: `Hi Dana, it's Waves. Your Waves estimate is here: ${LONG} Any questions? Just reply to this text.`,
    });
  });

  test('no proven name gives Your Waves estimate', async () => {
    const { res } = await draft(estimateRow());
    expect(res.json).toHaveBeenCalledWith({
      message: `Hi Dana, it's Waves. Your Waves estimate is here: ${LONG} Any questions? Just reply to this text.`,
    });
  });

  test('a throwing name read gives no name and does not fail the draft', async () => {
    emailedServiceName.mockRejectedValue(new Error('read failed'));
    const { res, next } = await draft(estimateRow());
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      message: expect.stringContaining('Your Waves estimate is here:'),
    });
  });

  test('a name outside the three allowed (a pack label) is dropped', async () => {
    emailedServiceName.mockResolvedValue('termite protection');
    const { res } = await draft(estimateRow());
    expect(res.json).toHaveBeenCalledWith({ message: expect.stringContaining('Your Waves estimate is here:') });
  });

  test('with the gate off the name read is skipped; a single-service pack label still names the service', async () => {
    process.env[ENV_GATE] = 'false';
    followupEmailVars.mockReturnValue({ service_label: 'lawn care' });
    const { res } = await draft(estimateRow());
    expect(emailedServiceName).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: expect.stringContaining('Your lawn care estimate is here:') });
  });

  test('reads only: no short link, no message, no row written', async () => {
    const query = mockRow(estimateRow());
    await routeHandler('/:id/follow-up-draft', 'get')({ params: { id: 'estimate-fixture' } }, makeRes(), jest.fn());
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(query.update).not.toHaveBeenCalled();
  });
});

describe('POST /:id/follow-up', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn = { now: jest.fn().mockReturnValue('now') };
    db.raw = jest.fn().mockReturnValue('raw');
    estimateDeliverableUnderGate.mockResolvedValue(true);
    isEstimateCustomerViewable.mockReturnValue(true);
    callSideBlockForEstimateData.mockResolvedValue(null);
    estimateGreetingFirstName.mockResolvedValue('Dana');
    leadIdForEstimate.mockResolvedValue(null);
    shortenOrPassthrough.mockResolvedValue(SHORT);
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  test('swaps every long link of this estimate for the short link', async () => {
    const { res } = await send(estimateRow(), { message: `Hi Dana ${LONG} again ${LONG} bye` });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: `Hi Dana ${SHORT} again ${SHORT} bye`,
      purpose: 'estimate_followup',
      estimateId: 'estimate-fixture',
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  test.each([
    ['the public page would refuse the link', () => isEstimateCustomerViewable.mockReturnValue(false)],
    ['the call-side verdict blocks the link', () => callSideBlockForEstimateData.mockResolvedValue('call_linkage_stale')],
  ])('a text that carries the link is refused (409) and nothing is sent when %s', async (_label, arrange) => {
    arrange();
    const { res, query } = await send(estimateRow(), { message: `Hi Dana, here it is: ${LONG} Any questions?` });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ESTIMATE_LINK_NOT_VIEWABLE' }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
    expect(query.update).not.toHaveBeenCalled();
  });

  test('a text without the link is not judged by the link check', async () => {
    isEstimateCustomerViewable.mockReturnValue(false);
    const { res } = await send(estimateRow(), { message: 'Hi Dana, any questions?' });
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a typed message without the link is sent as typed', async () => {
    await send(estimateRow(), { message: 'Hi Dana, any questions?' });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ body: 'Hi Dana, any questions?' }));
  });

  test('another estimate\'s link is not swapped', async () => {
    const other = 'https://portal.wavespestcontrol.com/estimate/tok-other';
    await send(estimateRow(), { message: `${other} ${LONG}` });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ body: `${other} ${SHORT}` }));
  });

  test('stamps the follow-up after a send', async () => {
    const { query } = await send(estimateRow(), { message: 'Hi' });
    expect(query.update).toHaveBeenCalledWith({ follow_up_count: 'raw', last_follow_up_at: 'now' });
  });

  test.each([
    ['no phone', { customer_phone: null }, 400, { error: 'No phone on file' }],
    ['an accepted estimate', { status: 'accepted' }, 400, { error: 'Already accepted' }],
  ])('keeps its refusal for %s', async (_label, extra, status, body) => {
    const { res } = await send(estimateRow(extra), { message: 'Hi' });
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(body);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('keeps the 409 when the pricing-authority gate refuses', async () => {
    estimateDeliverableUnderGate.mockResolvedValue(false);
    const { res } = await send(estimateRow(), { message: 'Hi' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRICING_AUTHORITY_NOT_SERVER' }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('keeps the 422 and skips the stamp when the send is blocked', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, reason: 'blocked' });
    const { res, query } = await send(estimateRow(), { message: 'Hi' });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: 'blocked' });
    expect(query.update).not.toHaveBeenCalled();
  });
});
