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
  // estimate-annual-guard.js (via estimate-offer-version.js) needs this —
  // every gate in this file defaults off, so this stays consistent with
  // gateEnvValue's own always-false mock above.
  termiteAnnualPlanSelectionEnabled: jest.fn(() => false),
  commercialProposalSignLive: () => false,
  commercialAutopayLive: jest.fn(() => false),
  buildingUseTaxLive: jest.fn(() => false),
  commercialFirstVisitLive: jest.fn(() => false),
  lawnSprayNoTaxLive: jest.fn(() => true),
  satellitePalmCountTypedLive: jest.fn(() => false),
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
    sendTemplate: jest.fn(async () => ({ sent: true, providerAttempted: true, providerAccepted: true, message: { provider_message_id: 'synthetic-email-accepted' } })),
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
  buildEstimateEmailPdfAttachment: jest.fn(async () => null),
  recordEmailedPdfDisclosure: jest.fn(async () => 'persisted'),
  ESTIMATE_EMAIL_PDF_NOTES: { delivery: 'Synthetic delivery PDF note.', followUp: 'Synthetic follow-up PDF note.' },
}));
jest.mock('../routes/estimate-public', () => ({
  reconcileFrozenMembershipSnapshot: jest.fn(async () => {}),
  composeEstimateDataPayload: jest.fn((...args) => require('./helpers/estimate-document-payload').documentPayloadFromRow(...args)),
  findLinkedUpcomingAppointment: jest.fn(async () => null), adoptionServiceModesForContract: jest.fn(() => []),
  acceptanceServiceLists: jest.fn(), bookingServiceFor: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({ services: [] })),
  estimateClosedOnline: jest.fn(() => false),
}));
jest.mock('../services/admin-estimate-persistence', () => ({
  ...jest.requireActual('../services/admin-estimate-persistence'),
  staleCallLinkageReason: jest.fn(async () => null),
}));

jest.mock('../services/pdf/proposal-bid-form', () => ({ buildProposalBidForm: jest.fn(async () => Buffer.from('%PDF-synthetic')) }));
const { buildProposalBidForm } = require('../services/pdf/proposal-bid-form');
const db = require('../models/db');
const router = require('../routes/admin-estimates');
const persistence = require('../services/admin-estimate-persistence');
const email = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const { computeProposalTotals, normalizeProposal } = require('../services/estimate-proposal');
const { gateEnvValue, commercialAutopayLive, buildingUseTaxLive } = require('../config/feature-gates');
const { refreshExpiredGroupNavigation } = require('../services/estimate-group-navigation');
const { buildPricingBundle } = require('../routes/estimate-public');
const { estimateOfferVersion } = require('../services/estimate-offer-version');
jest.mock('../services/pricing-authority-gate', () => {
  const actual = jest.requireActual('../services/pricing-authority-gate');
  return { ...actual, gatedSendAuthorityPredicateApplies: jest.fn(() => false) };
});

let row;
let groupRows;
let callRows;
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
  const matches = () => (table === 'estimates' ? [row, ...groupRows] : table === 'call_log' ? callRows : [])
    .filter((candidate) => filters.every((filter) => filter(candidate)));
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
  builder.first = jest.fn(async () => matches().length ? structuredClone(matches()[0]) : null);
  builder.select = jest.fn(async () => matches().map((candidate) => structuredClone(candidate)));
  builder.update = jest.fn(async (patch) => {
    mutations.push({ table, patch });
    const targets = matches();
    if (!targets.length) return 0;
    // Every matched row takes the patch and the affected count comes back,
    // as knex reports it (the grouped delivery claim stamps every
    // link-visible sibling in one UPDATE and checks the count — #4667).
    // Only the grouped delivery-claim stamp / release fans out to every
    // matched row (the fake's filters are looser than SQL elsewhere, so
    // other writes keep first-match semantics).
    const claimSql = patch.estimate_data?.sql?.includes("'{estimatorEngine}'") && patch.estimate_data.sql.includes('delivering_at');
    for (const target of (claimSql ? targets : [targets[0]])) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'estimate_data' && value?.sql) {
          if (value.sql.includes("'{estimatorEngine}'") && value.sql.includes("- 'delivering_at'")) {
            const data = dataOf(target);
            const eng = { ...(data.estimatorEngine || {}) };
            delete eng.delivering_at; delete eng.delivering_token;
            target.estimate_data = { ...data, estimatorEngine: eng };
          } else if (value.sql.includes("'{estimatorEngine}'") && value.sql.includes("'delivering_at'")) {
            const data = dataOf(target);
            target.estimate_data = { ...data, estimatorEngine: { ...(data.estimatorEngine || {}), delivering_at: value.bindings?.[0], delivering_token: value.bindings?.[1] } };
          } else if (value.bindings?.[0]) {
            target.estimate_data = { ...dataOf(target), ...JSON.parse(value.bindings[0]) };
          }
        } else if (key === 'status' && value?.sql) target.status = target.viewed_at ? 'viewed' : 'sent';
        else target[key] = value;
      }
    }
    return claimSql ? targets.length : 1;
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
  gateEnvValue.mockReturnValue(false);
  row = savedEstimate();
  groupRows = [];
  callRows = [];
  mutations = [];
  db.mockImplementation(estimateDatabase);
  sendgrid.isConfigured.mockReturnValue(true);
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-synthetic-reviewed' });
  email.sendTemplate.mockImplementation(async ({ onQueued }) => {
    await onQueued?.();
    return { sent: true, providerAttempted: true, providerAccepted: true, message: { provider_message_id: 'synthetic-email-accepted' } };
  });
  email.loadTemplateByKey.mockImplementation(async (key) => ({ template: { template_key: key }, activeVersion: { id: 'synthetic-email-version' } }));
  buildPricingBundle.mockResolvedValue({ services: [] });
});

describe('commercial bid authoring', () => {
  test('the disabled gate refuses uploaded forms before parsing or database access', async () => {
    gateEnvValue.mockReturnValue(false);
    const layer = router.stack.find((entry) => entry.route?.path === '/:id/proposal/bid-form.pdf');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await layer.route.stack[0].handle({}, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
  test('an export refuses a stale proposal before PDF generation', async () => {
    const res = await invoke('/:id/proposal/bid-form.pdf', 'post', { options: JSON.stringify({ expectedEditVersion: 'stale' }) });
    expect(res.statusCode).toBe(409);
    expect(buildProposalBidForm).not.toHaveBeenCalled();
    expect(mutations).toHaveLength(0);
  });
  test('an export refuses an edit made during PDF generation without writing data', async () => {
    const version = persistence.estimateEditVersion(row);
    buildProposalBidForm.mockImplementationOnce(async () => {
      row.estimate_data = { ...dataOf(), syntheticConcurrentEdit: true };
      return Buffer.from('%PDF-synthetic');
    });
    const res = await invoke('/:id/proposal/bid-form.pdf', 'post', { options: JSON.stringify({ expectedEditVersion: version }) });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/while preparing the form/);
    expect(mutations).toHaveLength(0);
  });
  beforeEach(() => gateEnvValue.mockImplementation((key) => key === 'GATE_COMMERCIAL_BID_BUILDER'));
  const proposal = () => ({ enabled: true, validThrough: '2099-12-21', buildings: [{ name: 'Synthetic field', lineItems: [{ id: 'application', description: 'Synthetic application', quantity: 25.8, unit: 'acre', unitPrice: 100, frequency: 'one_time' }] }] });
  const costing = { revenueYears: 1, rows: [{ category: 'labor', phase: 'Phase A', description: 'PRIVATE CREW COST', quantity: 40, unit: 'hour', unitCost: 35, occurrences: 4 }] };
  test('the admin proposal read returns private costs beside the normalized customer proposal', async () => {
    row.estimate_data = { proposal: proposal(), proposalCosting: costing };
    const res = await invoke('/:id/proposal', 'get');
    expect(res.statusCode).toBe(200);
    expect(res.body.projectCosting).toEqual(costing);
    expect(JSON.stringify(res.body.proposal)).not.toContain('PRIVATE CREW COST');
  });
  test.each([['costing only', false, false], ['a changed line', true, false], ['costing only, legacy lines given ids on load', false, true]])('re-saving a delivered proposal with %s keeps or drops the emailed-PDF marker (GH codex P2 on #4270)', async (name, changed, legacy) => {
    const savedProposal = proposal();
    // A legacy delivered proposal has no line ids; the editor mints them on
    // load and the next cost-only save sends them (GH codex P2 r12 on #4270).
    if (legacy) delete savedProposal.buildings[0].lineItems[0].id;
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_data: { proposal: savedProposal, proposalDelivery: { pdfEmailed: true } } });
    const incoming = proposal();
    if (legacy) incoming.buildings[0].lineItems[0].id = 'generated-on-load';
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
  test.each(['private costing', 'changed quote', 'already stale review'])('scheduled execution after %s preserves only the offer staff reviewed', async (change) => {
    row.status = 'draft';
    expect((await invoke('/:id/proposal', 'put', { proposal: proposal() })).statusCode).toBe(200);
    const { entry, scheduledAt } = scheduledAttempt();
    entry.scheduleReview.reviewedOffer = change === 'already stale review' ? 'stale-offer' : estimateOfferVersion(row);
    row.status = 'scheduled'; row.scheduled_at = scheduledAt;
    row.estimate_data = { ...dataOf(), manualSendAttempts: [entry] };
    const incoming = proposal();
    if (change === 'changed quote') incoming.buildings[0].lineItems[0].unitPrice = 101;
    const saved = await invoke('/:id/proposal', 'put', { proposal: incoming, projectCosting: costing });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.editVersion).toBe(persistence.estimateEditVersion(row));
    row.status = 'sending';
    if (change === 'private costing') {
      expect(dataOf().manualSendAttempts[0].scheduleReview.reviewedOffer).toBe(estimateOfferVersion(row));
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email.ok).toBe(true);
      expect(email.sendTemplate).toHaveBeenCalledTimes(1);
    } else {
      await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true }))
        .rejects.toMatchObject({ code: 'ESTIMATE_REVIEW_STALE' });
      expect(email.sendTemplate).not.toHaveBeenCalled();
    }
  });
  test('adding costs while enabling a synthesized proposal keeps the scheduled approval stale', async () => {
    Object.assign(row, { monthly_total: 100, annual_total: 1200, onetime_total: 0, estimate_data: {} });
    const incoming = normalizeProposal(row);
    expect(incoming).toMatchObject({ enabled: false, synthesized: true });
    const { entry, scheduledAt } = scheduledAttempt();
    const reviewedOffer = estimateOfferVersion(row);
    entry.scheduleReview.reviewedOffer = reviewedOffer;
    row.status = 'scheduled'; row.scheduled_at = scheduledAt;
    row.estimate_data = { manualSendAttempts: [entry] };
    const saved = await invoke('/:id/proposal', 'put', { proposal: { ...incoming, enabled: true, synthesized: false }, projectCosting: costing });
    expect(saved.statusCode).toBe(200);
    expect(dataOf().proposal.enabled).toBe(true);
    expect(dataOf().manualSendAttempts[0].scheduleReview.reviewedOffer).toBe(reviewedOffer);
    expect(estimateOfferVersion(row)).not.toBe(reviewedOffer);
    row.status = 'sending';
    await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true }))
      .rejects.toMatchObject({ code: 'ESTIMATE_REVIEW_STALE' });
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });
  test('a private-cost-only sibling save preserves matching pending group reviews without endorsing stale reviews', async () => {
    row.status = 'draft';
    expect((await invoke('/:id/proposal', 'put', { proposal: proposal() })).statusCode).toBe(200);
    row.estimate_group_id = 'synthetic-group';
    const priorVersion = estimateOfferVersion(row);
    const { entry, scheduledAt } = scheduledAttempt();
    entry.scheduleReview.reviewedGroupVersions = { [row.id]: priorVersion, other: 'other-offer' };
    const staleEntry = structuredClone(entry); staleEntry.key = 'stale-group-review';
    staleEntry.scheduleReview.reviewedGroupVersions[row.id] = 'stale-offer';
    const anchor = savedEstimate({ id: 'scheduled-anchor', status: 'scheduled', estimate_group_id: row.estimate_group_id,
      scheduled_at: scheduledAt, estimate_data: { manualSendAttempts: [entry, staleEntry] } });
    groupRows = [anchor];
    expect((await invoke('/:id/proposal', 'put', { proposal: proposal(), projectCosting: costing })).statusCode).toBe(200);
    expect(dataOf(anchor).manualSendAttempts[0].scheduleReview.reviewedGroupVersions)
      .toEqual({ [row.id]: estimateOfferVersion(row), other: 'other-offer' });
    expect(dataOf(anchor).manualSendAttempts[1].scheduleReview.reviewedGroupVersions[row.id]).toBe('stale-offer');
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
  // Owner 2026-10-28: the building use sets which rows the builder taxes, so it saves with the proposal and an
  // unknown value is refused, never silently dropped.
  test('PUT saves the building use and refuses an unknown one without saving', async () => {
    row.status = 'draft';
    const unknown = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), buildingUse: 'warehouse' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body.error).toBe('Building use must be residential or nonresidential.');
    expect(mutations).toHaveLength(0);
    const saved = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), buildingUse: 'residential' } });
    expect(saved.statusCode).toBe(200);
    expect(dataOf().proposal.buildingUse).toBe('residential');
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
  test('saving a longer anchor hold changes only its own offer deadline (owner ruling on #4309 r7)', async () => {
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_group_id: 'synthetic-group', estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-21' } } });
    const res = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(res.statusCode).toBe(200);
    // The anchor's own authored deadline — and nothing else — is its expiry.
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    // No sibling is widened and none is revived: a sibling's offer is its own,
    // so nothing about this save can change it. Group reachability is carried
    // by groupLinkViewableThrough on this row instead.
    const siblingExtension = mutations.find(({ patch }) => patch.status && patch.expires_at);
    expect(siblingExtension).toBeUndefined();
    const anchorData = row.estimate_data || {};
    expect(Object.prototype.hasOwnProperty.call(anchorData, 'groupWidenFloorExpiresAt')).toBe(false);
    expect(anchorData.groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
  });
  test('the longest published anchor records its own floor before its hold is shortened', async () => {
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group',
      estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-31' } } });
    const shorterSibling = savedEstimate({ id: 'shorter-sibling', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    groupRows.push(shorterSibling);
    const first = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(first.statusCode).toBe(200);
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(shorterSibling).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');

    const shorter = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-21' } });
    expect(shorter.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
  });
  test.each([
    ['newly authored', null],
    ['lengthened', '2099-12-21'],
  ])('a %s sibling hold extends the delivered anchor link while offers keep their own deadlines', async (_label, oldDate) => {
    const anchor = savedEstimate({
      id: 'published-anchor', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'),
      expires_at: new Date('2099-01-08T12:00:00.000Z'),
      estimate_data: { deliveryState: { lastDeliveredAt: '2026-01-02T12:00:00.000Z' } },
    });
    groupRows.push(anchor);
    Object.assign(row, {
      status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group',
      estimate_data: { groupPublishedByEstimateId: anchor.id, proposal: { ...proposal(), validThrough: oldDate } },
    });
    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(result.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(anchor.expires_at.toISOString()).toBe('2099-01-08T12:00:00.000Z');
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');

    // A later shortening closes only this property's offer. The already
    // delivered group link keeps its promised navigation lifetime.
    const shorter = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-21' } });
    expect(shorter.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(anchor.expires_at.toISOString()).toBe('2099-01-08T12:00:00.000Z');
  });
  test('saving a fixed sibling keeps the delivered link open through a longer published ordinary offer', async () => {
    const anchor = savedEstimate({ id: 'published-anchor', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    const ordinarySibling = savedEstimate({ id: 'ordinary-sibling', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2100-02-01T12:00:00.000Z') });
    groupRows.push(anchor, ordinarySibling);
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group',
      estimate_data: { groupPublishedByEstimateId: anchor.id, proposal: { ...proposal(), validThrough: '2099-12-11' } } });
    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-21' } });
    expect(result.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2100-02-01T12:00:00.000Z');
    expect(anchor.expires_at.toISOString()).toBe('2099-01-08T12:00:00.000Z');
    expect(ordinarySibling.expires_at.toISOString()).toBe('2100-02-01T12:00:00.000Z');
  });
  test('clearing a sibling fixed hold keeps the delivered link open through its restored ordinary expiry', async () => {
    const anchor = savedEstimate({ id: 'short-anchor', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2099-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-03T12:00:00.000Z'),
      estimate_data: { groupLinkViewableThrough: '2099-01-04T12:00:00.000Z' } });
    groupRows.push(anchor);
    Object.assign(row, { status: 'sent', sent_at: new Date('2099-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group',
      estimate_data: { groupPublishedByEstimateId: anchor.id, proposal: { ...proposal(), validThrough: '2099-01-04' } } });
    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '' } });
    expect(result.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2099-01-09T12:00:00.000Z');
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2099-01-09T12:00:00.000Z');
    expect(anchor.expires_at.toISOString()).toBe('2099-01-03T12:00:00.000Z');
  });
  test('a proposal save preserves its locked publication marker and longer promised link window', async () => {
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group',
      estimate_data: { proposal: proposal(), groupPublishedByEstimateId: row.id,
        groupLinkViewableThrough: '2100-02-01T12:00:00.000Z' } });
    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(result.statusCode).toBe(200);
    expect(dataOf().groupPublishedByEstimateId).toBe(row.id);
    expect(dataOf().groupLinkViewableThrough).toBe('2100-02-01T12:00:00.000Z');
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
  });
  test.each([
    ['missing', null],
    ['stale', 'former-anchor'],
    ['older same-group sender after a resend', 'current-anchor'],
  ])('a %s publication marker extends eligible delivered links in the current group only', async (_case, marker) => {
    const formerAnchor = savedEstimate({
      id: 'former-anchor', status: 'sent', estimate_group_id: 'former-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'),
      expires_at: new Date('2099-01-08T12:00:00.000Z'),
    });
    const currentAnchor = savedEstimate({ id: 'current-anchor', status: 'sent', estimate_group_id: 'current-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    const viewedOnlyAnchor = savedEstimate({ id: 'viewed-anchor', status: 'expired', estimate_group_id: 'current-group',
      viewed_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    const withheld = ['draft', 'send_failed'].map((status) => savedEstimate({ id: `${status}-member`, status,
      estimate_group_id: 'current-group', sent_at: new Date('2026-01-02T12:00:00.000Z') }));
    const expiredUnsent = savedEstimate({ id: 'expired-unsent-member', status: 'expired', disposition: 'expired_unsent',
      estimate_group_id: 'current-group', sent_at: new Date('2026-01-02T12:00:00.000Z') });
    const held = savedEstimate({ id: 'held-member', status: 'sent', estimate_group_id: 'current-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_data: { estimatorEngine: { reprice_pending_at: '2026-01-02T12:00:00.000Z' } } });
    const archived = savedEstimate({ id: 'archived-member', status: 'sent', estimate_group_id: 'current-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), archived_at: new Date('2026-01-03T12:00:00.000Z') });
    const invalidated = savedEstimate({ id: 'invalidated-member', status: 'sent', estimate_group_id: 'current-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_data: { estimatorEngine: { linkage_invalidated_at: '2026-01-02T12:00:00.000Z' } } });
    groupRows.push(formerAnchor, currentAnchor, viewedOnlyAnchor, ...withheld, expiredUnsent, held, archived, invalidated);
    Object.assign(row, {
      status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'current-group',
      estimate_data: { ...(marker ? { groupPublishedByEstimateId: marker } : {}), proposal: proposal() },
    });
    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(result.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(currentAnchor).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(viewedOnlyAnchor).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(formerAnchor).groupLinkViewableThrough).toBeUndefined();
    expect(formerAnchor.expires_at.toISOString()).toBe('2099-01-08T12:00:00.000Z');
    for (const candidate of [...withheld, expiredUnsent, held, archived, invalidated]) {
      expect(dataOf(candidate).groupLinkViewableThrough).toBeUndefined();
    }
  });
  test('saving an unpublished fixed sibling records only the anchor’s existing offer floor', async () => {
    const anchor = savedEstimate({ id: 'delivered-anchor', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    groupRows.push(anchor);
    Object.assign(row, { status: 'draft', estimate_group_id: 'synthetic-group',
      estimate_data: { groupPublishedByEstimateId: anchor.id } });
    const response = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(response.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2099-01-08T12:00:00.000Z');
  });
  test('saving a published property ignores a longer fixed hold still in draft', async () => {
    const anchor = savedEstimate({ id: 'delivered-anchor', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    const unpublished = savedEstimate({ id: 'draft-with-long-hold', status: 'draft',
      estimate_group_id: 'synthetic-group', estimate_data: { proposal: { enabled: true, validThrough: '2101-12-31' } } });
    groupRows.push(anchor, unpublished);
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group',
      estimate_data: { groupPublishedByEstimateId: anchor.id, proposal: proposal() } });
    const response = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(response.statusCode).toBe(200);
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(unpublished).groupLinkViewableThrough).toBeUndefined();
  });
  test('a durable call-side block cannot source or receive a group navigation grant', async () => {
    const blocked = savedEstimate({ id: 'call-blocked-sibling', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2101-01-01T12:00:00.000Z'),
      estimate_data: { estimatorEngine: { callLogId: 'blocked-call' } } });
    callRows.push({ id: 'blocked-call', metadata: { estimator_draft_block: { reason: 'linkage_changed' } } });
    groupRows.push(blocked);
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group', estimate_data: { proposal: proposal() } });

    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(result.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(blocked).groupLinkViewableThrough).toBeUndefined();
  });
  test('an authored save lifts an observed reprice hold and extends the delivered link atomically', async () => {
    const anchor = savedEstimate({ id: 'delivered-anchor', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    groupRows.push(anchor);
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'),
      estimate_group_id: 'synthetic-group', estimate_data: {
        groupPublishedByEstimateId: anchor.id,
        estimatorEngine: { reprice_pending_at: '2026-01-02T12:00:00.000Z', reprice_attempt: 'synthetic-attempt' },
        proposal: { ...proposal(), validThrough: '2099-01-04' },
      } });
    const result = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-31' } });
    expect(result.statusCode).toBe(200);
    expect(dataOf().estimatorEngine.reprice_pending_at).toBeUndefined();
    expect(anchor.expires_at.toISOString()).toBe('2099-01-08T12:00:00.000Z');
    expect(dataOf(anchor).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(result.body.editVersion).toBe(persistence.estimateEditVersion(row));
  });
  test('shortening a fixed hold rewrites only the anchor, because no sibling was ever widened (owner ruling on #4309 r7)', async () => {
    const sibling = { ...row, id: 'sibling-1', status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_group_id: 'synthetic-group' };
    Object.assign(row, { status: 'sent', sent_at: new Date('2026-01-02T12:00:00.000Z'), estimate_group_id: 'synthetic-group', estimate_data: { proposal: { ...proposal(), validThrough: '2099-12-31' } } });
    const siblingUpdates = [];
    db.mockImplementation((table) => {
      const b = estimateDatabase(table);
      let targetId = null;
      const originalWhere = b.where.getMockImplementation();
      b.where.mockImplementation((key, value) => { if (key?.id) targetId = key.id; return originalWhere(key, value); });
      const originalUpdate = b.update.getMockImplementation();
      b.update.mockImplementation(async (patch) => { if (targetId === sibling.id) { siblingUpdates.push(patch); return 1; } return originalUpdate(patch); });
      return b;
    });
    const res = await invoke('/:id/proposal', 'put', { proposal: { ...proposal(), validThrough: '2099-12-21' } });
    expect(res.statusCode).toBe(200);
    // The anchor follows its own new authored date.
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    // Nothing to pull back: a shrink cannot strand a sibling on an obsolete
    // widened value when no widening ever happened. This is the whole reason
    // the reconstruction pass and its saved floor could be deleted instead of
    // repaired — the round-7 P2 regression lived in that pass.
    expect(siblingUpdates).toHaveLength(0);
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
  test('an expired fixed bid can be explicitly revised and its expiry disposition is cleared', async () => {
    row.status = 'expired'; row.sent_at = new Date('2026-01-01T12:00:00Z');
    row.disposition = 'expired_unviewed';
    row.estimate_data = { proposal: { ...proposal(), validThrough: '2026-01-08' } };
    const res = await invoke('/:id/proposal', 'put', { proposal: proposal() });
    expect(res.statusCode).toBe(200);
    expect(row.status).toBe('sent'); expect(row.disposition).toBeNull();
  });
});

describe('group publication navigation', () => {
  function groupDatabase(table) {
    const builder = estimateDatabase(table);
    const originalWhere = builder.where.getMockImplementation();
    // This fake cannot evaluate Knex's nested OR predicates; real predicates
    // remain enforced by the status and id filters on each write.
    builder.where.mockImplementation((key, value) => {
      if (typeof key === 'function') {
        if (String(key).includes("status: 'sending'") && String(key).includes('DELIVERY_CLAIM_NOT_LIVE_SQL')) {
          builder.whereIn('status', ['sending']);
        }
        return builder;
      }
      if (key?.updated_at instanceof Date) {
        const { updated_at: _ignored, ...fields } = key;
        originalWhere(fields);
        // Claim reads clone the Date, whereas SQL compares its value.
        return builder;
      }
      return originalWhere(key, value);
    });
    builder.orWhere.mockImplementation(() => builder);
    builder.then = (resolve, reject) => builder.select().then(resolve, reject);
    const originalUpdate = builder.update.getMockImplementation();
    builder.update.mockImplementation((patch) => {
      if (patch.status === 'sending' && groupRows.some((candidate) => candidate.status === 'draft')) {
        groupRows.find((candidate) => candidate.status === 'draft').status = 'sending';
        return Promise.resolve(1);
      }
      if (patch.expires_at?.sql?.includes('GREATEST(COALESCE(expires_at')) {
        const ordinaryExpiry = patch.expires_at.bindings[0];
        const older = groupRows.find((candidate) => candidate.status === 'sent');
        return originalUpdate({ ...patch, expires_at: older?.expires_at > ordinaryExpiry ? older.expires_at : ordinaryExpiry });
      }
      return originalUpdate(patch);
    });
    return builder;
  }

  function fixedSibling() {
    return savedEstimate({ id: 'fixed-sibling', status: 'draft', estimate_group_id: 'synthetic-group',
      estimate_data: { proposal: { enabled: true, validThrough: '2099-12-31' } } });
  }

  function prepareGroup() {
    Object.assign(row, { status: 'sending', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'),
      expires_at: new Date('2099-01-08T12:00:00.000Z'),
      estimate_data: { groupPublishedByEstimateId: 'older-delivered-link' } });
    const older = savedEstimate({ id: 'older-delivered-link', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-01T12:00:00.000Z'), expires_at: new Date('2099-01-08T12:00:00.000Z') });
    const sibling = fixedSibling();
    groupRows.push(older, sibling);
    db.mockImplementation(groupDatabase);
    return { older, sibling };
  }

  test('a grouped sibling priced from the satellite needs its own typed palm count: the anchor\'s count never clears it', async () => {
    const gates = require('../config/feature-gates');
    const { sibling } = prepareGroup();
    sibling.estimate_data = { ...sibling.estimate_data, engineResult: { lineItems: [{ service: 'tree_shrub', palmCount: 9, palmCountFromLookup: true }] } };
    gates.satellitePalmCountTypedLive.mockReturnValue(true);
    try {
      await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true, confirmedPalmCount: 9 }))
        .rejects.toMatchObject({ code: 'PALM_COUNT_REQUIRED', message: expect.stringContaining('palm count from the satellite image') });
    } finally {
      gates.satellitePalmCountTypedLive.mockReturnValue(false);
    }
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sibling.status).toBe('draft');
  });

  test('a scheduled sibling is held to the palm count its own schedule recorded (pre-push audit P1)', async () => {
    const gates = require('../config/feature-gates');
    const { sibling } = prepareGroup();
    const scheduledAt = new Date('2099-01-03T15:00:00.000Z');
    Object.assign(sibling, {
      status: 'scheduled', scheduled_at: scheduledAt,
      estimate_data: {
        ...sibling.estimate_data,
        // Scheduled after its admin typed 14; a revision then re-priced it at 9.
        engineResult: { lineItems: [{ service: 'tree_shrub', palmCount: 9, palmCountFromLookup: true }] },
        manualSendAttempts: [{ key: 'sibling-schedule', binding: '[]', channels: {}, scheduleReview: { scheduledAt: scheduledAt.toISOString(), confirmedPalmCount: 14 } }],
      },
    });
    gates.satellitePalmCountTypedLive.mockReturnValue(true);
    try {
      await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true }))
        .rejects.toMatchObject({ code: 'PALM_COUNT_MISMATCH', message: expect.stringContaining('palm count from the satellite image') });
    } finally {
      gates.satellitePalmCountTypedLive.mockReturnValue(false);
    }
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(sibling.status).toBe('scheduled');
  });

  function failReconciliation() {
    db.mockImplementation((table) => {
      const builder = groupDatabase(table);
      const oldWhereNot = builder.whereNot.getMockImplementation();
      const oldWhereIn = builder.whereIn.getMockImplementation();
      const oldUpdate = builder.update.getMockImplementation();
      let excludesAnchor = false;
      let reconcilesLive = false;
      builder.whereNot.mockImplementation((fields) => {
        if (fields.id === row.id) excludesAnchor = true;
        return oldWhereNot(fields);
      });
      builder.whereIn.mockImplementation((field, statuses) => {
        if (field === 'status' && statuses.length === 2 && statuses.includes('sent') && statuses.includes('viewed')) reconcilesLive = true;
        return oldWhereIn(field, statuses);
      });
      builder.update.mockImplementation((patch) => {
        if (excludesAnchor && reconcilesLive && patch.followup_unviewed_sent) throw new Error('Synthetic reconciliation failure');
        return oldUpdate(patch);
      });
      return builder;
    });
  }

  test('an expired entry gains a durable floor only after a published sibling’s call settles cleanly', async () => {
    Object.assign(row, { status: 'expired', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-01T12:00:00.000Z'), expires_at: new Date('2026-01-08T12:00:00.000Z') });
    const sibling = savedEstimate({ id: 'published-long-sibling', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2100-01-01T12:00:00.000Z'),
      estimate_data: { estimatorEngine: { callLogId: 'reprocessing-call' } } });
    groupRows.push(sibling);
    const call = { id: 'reprocessing-call', processing_status: 'processing', processing_token: 'synthetic-live-token', metadata: {} };
    callRows.push(call);
    db.mockImplementation(groupDatabase);

    const blockedRead = await refreshExpiredGroupNavigation(db, structuredClone(row));
    expect(blockedRead.id).toBe(row.id);
    expect(dataOf().groupLinkViewableThrough).toBeUndefined();
    expect(dataOf(sibling).groupLinkViewableThrough).toBeUndefined();

    call.processing_status = 'processed';
    call.processing_token = null;
    const recovered = await refreshExpiredGroupNavigation(db, structuredClone(row));
    expect(dataOf(recovered).groupLinkViewableThrough).toBe('2100-01-01T12:00:00.000Z');
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T12:00:00.000Z');
    expect(dataOf(sibling).groupLinkViewableThrough).toBe('2100-01-01T12:00:00.000Z');

    // Later shortening changes only the sibling's offer; the recovered
    // delivered-link promise remains on the entry token.
    sibling.expires_at = new Date('2026-01-08T12:00:00.000Z');
    await refreshExpiredGroupNavigation(db, structuredClone(row));
    expect(dataOf().groupLinkViewableThrough).toBe('2100-01-01T12:00:00.000Z');
  });

  test('recovery refuses a moved token or an entry whose own call remains blocked', async () => {
    Object.assign(row, { status: 'expired', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-01T12:00:00.000Z'), expires_at: new Date('2026-01-08T12:00:00.000Z'),
      estimate_data: { estimatorEngine: { callLogId: 'blocked-anchor-call' } } });
    groupRows.push(savedEstimate({ id: 'published-long-sibling', status: 'sent', estimate_group_id: 'synthetic-group',
      sent_at: new Date('2026-01-02T12:00:00.000Z'), expires_at: new Date('2100-01-01T12:00:00.000Z') }));
    callRows.push({ id: 'blocked-anchor-call', processing_status: 'processing', processing_token: 'synthetic-live-token', metadata: {} });
    db.mockImplementation(groupDatabase);

    expect(await refreshExpiredGroupNavigation(db, structuredClone(row))).toBeNull();
    expect(dataOf().groupLinkViewableThrough).toBeUndefined();
    expect(await refreshExpiredGroupNavigation(db, { ...structuredClone(row), token: 'former-token' })).toBeNull();
    expect(dataOf().groupLinkViewableThrough).toBeUndefined();
  });

  test('A to B resend leaves both delivered links eligible after reconciliation fails', async () => {
    const { older, sibling } = prepareGroup();
    failReconciliation();
    buildPricingBundle.mockImplementation(async (estimate) => {
      if (estimate.id === sibling.id) throw new Error('Synthetic snapshot failure');
      return { services: [] };
    });
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(sibling.status).toBe('draft');
    expect(dataOf(row).groupLinkViewableThrough).toBe('2099-01-08T12:00:00.000Z');
    expect(dataOf(older).groupLinkViewableThrough).toBeUndefined();
    expect(buildPricingBundle.mock.calls.filter(([estimate]) => estimate.id === sibling.id)).toHaveLength(3);
    expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('live-sibling group reconciliation failed'));

    gateEnvValue.mockImplementation((key) => key === 'GATE_COMMERCIAL_BID_BUILDER');
    const saved = await invoke('/:id/proposal', 'put', { proposal: {
      enabled: true, validThrough: '2099-12-31', buildings: [{ name: 'Synthetic building',
        lineItems: [{ id: 'synthetic-line', quantity: 1, unitPrice: 100, frequency: 'one_time' }] }],
    } });
    expect(saved.statusCode).toBe(200);
    expect(dataOf(older).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(row).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(sibling).groupLinkViewableThrough).toBeUndefined();
  });

  test('the longest anchor keeps its own delivered floor when reconciliation fails and its hold is later shortened', async () => {
    const { older, sibling } = prepareGroup();
    const authoredProposal = { enabled: true, validThrough: '2099-12-31', buildings: [{ name: 'Synthetic building',
      lineItems: [{ id: 'synthetic-line', quantity: 1, unitPrice: 100, frequency: 'one_time' }] }] };
    row.estimate_data.proposal = authoredProposal;
    failReconciliation();
    buildPricingBundle.mockImplementation(async (estimate) => {
      if (estimate.id === sibling.id) throw new Error('Synthetic snapshot failure');
      return { services: [] };
    });

    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(sibling.status).toBe('draft');
    expect(row.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(row).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(older).groupLinkViewableThrough).toBeUndefined();
    expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('live-sibling group reconciliation failed'));

    gateEnvValue.mockImplementation((key) => key === 'GATE_COMMERCIAL_BID_BUILDER');
    const shortened = await invoke('/:id/proposal', 'put', { proposal: { ...authoredProposal, validThrough: '2099-12-21' } });
    expect(shortened.statusCode).toBe(200);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
    expect(dataOf(row).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
  });

  test('successful sibling publication extends both delivered links with its own offer expiry', async () => {
    const { older, sibling } = prepareGroup();
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(sibling.status).toBe('sent');
    expect(sibling.expires_at.toISOString()).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(older).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(dataOf(row).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
    expect(row.expires_at.getTime()).toBeLessThan(sibling.expires_at.getTime());
  });

  test('a prior longer promise stays on its own token without spreading to a new sender', async () => {
    const { older, sibling } = prepareGroup();
    older.estimate_data = { groupLinkViewableThrough: '2101-01-01T12:00:00.000Z' };
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(sibling.status).toBe('sent');
    expect(dataOf(older).groupLinkViewableThrough).toBe('2101-01-01T12:00:00.000Z');
    expect(dataOf(row).groupLinkViewableThrough).toBe('2100-01-01T04:59:59.999Z');
  });

  test('a navigation-write failure rolls back sibling publication on each retry', async () => {
    const { older, sibling } = prepareGroup();
    db.transaction.mockImplementation(async (callback) => {
      const before = [row, ...groupRows].map((candidate) => structuredClone(candidate));
      try { return await callback(db); } catch (error) {
        [row, ...groupRows].forEach((candidate, index) => {
          for (const key of Object.keys(candidate)) if (!Object.hasOwn(before[index], key)) delete candidate[key];
          Object.assign(candidate, before[index]);
        });
        throw error;
      }
    });
    db.mockImplementation((table) => {
      const builder = groupDatabase(table);
      const originalWhere = builder.where.getMockImplementation();
      const originalUpdate = builder.update.getMockImplementation();
      let anchor = false;
      builder.where.mockImplementation((fields, value) => {
        if (fields?.id === row.id) anchor = true;
        return originalWhere(fields, value);
      });
      builder.update.mockImplementation((patch) => {
        if (anchor && row.status === 'sent' && patch.estimate_data?.bindings?.[0]?.includes('groupLinkViewableThrough')) {
          throw new Error('Synthetic navigation write failure');
        }
        return originalUpdate(patch);
      });
      return builder;
    });
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(sibling.status).toBe('draft');
    expect(sibling.sent_at).toBeUndefined();
    expect(dataOf(sibling).sendSnapshot).toBeUndefined();
    expect(dataOf(row).groupLinkViewableThrough).toBe('2099-01-08T12:00:00.000Z');
    expect(dataOf(older).groupLinkViewableThrough).toBe('2099-01-08T12:00:00.000Z');
    expect(require('../services/logger').error).toHaveBeenCalledWith(expect.stringContaining('publication attempt 3 failed'));
  });
});

describe('annual provider delivery receipts', () => {
  const { annualPlanOfferFingerprint, annualPlanHasDeliveredOffer } = require('../services/estimate-offer-version');
  const annualData = (fee = 299) => ({ results: { tmBait: { plan: 'annual_protection', annualFee: fee } } });

  test.each(['email', 'sms'])('a real %s handoff records a root-shaped annual offer', async (method) => {
    row.estimate_data = annualData();
    const fingerprint = annualPlanOfferFingerprint(row);
    const result = await router.sendEstimateNow(structuredClone(row), method, { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(result.channels[method]).toMatchObject(method === 'email' ? { providerAttempted: true } : { real: true });
    expect(dataOf().deliveryState.annualPlanOfferFingerprint).toBe(fingerprint);
    expect(dataOf().deliveryState.deliveredAt).toEqual([dataOf().deliveryState.lastDeliveredAt]);
    expect(annualPlanHasDeliveredOffer(row)).toBe(true);
  });

  test('SMTP acceptance records an annual receipt after the transport resolves', async () => {
    const priorPassword = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.GOOGLE_SMTP_PASSWORD = 'synthetic-password';
    row.estimate_data = annualData();
    sendgrid.isConfigured.mockReturnValue(false);
    require('../services/email-fallback-gate').smtpFallbackAllowed.mockReturnValueOnce(true);
    // Pre-push audit P1: the SMTP fallback now runs the real annual-offer
    // guard too — a FRESH (never-delivered) annual estimate while the
    // selection gate is off is legitimately withheld, so this test (which
    // proves the delivery receipt gets recorded AFTER a real handoff, not
    // guard behavior) turns the gate on for its one send.
    require('../config/feature-gates').termiteAnnualPlanSelectionEnabled.mockReturnValueOnce(true);
    const sendMail = jest.fn(async () => {
      expect(dataOf().deliveryState).toBeUndefined();
    });
    require('nodemailer').createTransport.mockReturnValueOnce({ sendMail });
    try {
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ providerAttempted: true, providerAccepted: true, provider: 'smtp_fallback' });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(annualPlanHasDeliveredOffer(row)).toBe(true);
    } finally {
      if (priorPassword === undefined) delete process.env.GOOGLE_SMTP_PASSWORD;
      else process.env.GOOGLE_SMTP_PASSWORD = priorPassword;
    }
  });

  test('pre-push audit P1: the SMTP fallback withholds a withheld annual estimate — no transport call', async () => {
    const priorPassword = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.GOOGLE_SMTP_PASSWORD = 'synthetic-password';
    row.estimate_data = annualData(); // fresh, undelivered, gate off -> withheld
    sendgrid.isConfigured.mockReturnValue(false);
    require('../services/email-fallback-gate').smtpFallbackAllowed.mockReturnValueOnce(true);
    const sendMail = jest.fn();
    require('nodemailer').createTransport.mockReturnValueOnce({ sendMail });
    try {
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      // sendEstimateNowInner's channel mapping keeps only ok/error on its
      // not-ok branch (channels.email = result.ok ? {...} : { ok: false,
      // error: result.error || 'Email send failed' }) — sendEstimateEmail's
      // own richer shape (blocked/provider/providerAttempted) is what the
      // pre-push audit's fix contract describes at that inner layer;
      // confirmed directly against sendEstimateEmail below.
      expect(result.channels.email).toMatchObject({ ok: false, error: 'annual_offer_withheld' });
      expect(sendMail).not.toHaveBeenCalled();
      expect(dataOf().deliveryState).toBeUndefined();
      expect(annualPlanHasDeliveredOffer(row)).toBe(false);
    } finally {
      if (priorPassword === undefined) delete process.env.GOOGLE_SMTP_PASSWORD;
      else process.env.GOOGLE_SMTP_PASSWORD = priorPassword;
    }
  });

  test('pre-push audit P1: an SMTP-fallback guard infrastructure error is a definite failure — no transport call, never uncertain', async () => {
    const priorPassword = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.GOOGLE_SMTP_PASSWORD = 'synthetic-password';
    row.estimate_data = annualData();
    sendgrid.isConfigured.mockReturnValue(false);
    require('../services/email-fallback-gate').smtpFallbackAllowed.mockReturnValueOnce(true);
    // Surgical: spy on the real module's annualHandoffGuard just for this
    // call, rather than sabotaging the shared db mock (which the SMTP
    // fallback's own PRIOR estimates reads — claim, verdict re-read — also
    // depend on to reach this point at all).
    const annualGuardModule = require('../services/estimate-annual-guard');
    const guardSpy = jest.spyOn(annualGuardModule, 'annualHandoffGuard')
      .mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });
    const sendMail = jest.fn();
    require('nodemailer').createTransport.mockReturnValueOnce({ sendMail });
    try {
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ ok: false, error: 'estimates lookup unavailable' });
      expect(result.channels.email.uncertain).toBeUndefined();
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      guardSpy.mockRestore();
      if (priorPassword === undefined) delete process.env.GOOGLE_SMTP_PASSWORD;
      else process.env.GOOGLE_SMTP_PASSWORD = priorPassword;
    }
  });

  test.each(['quarterly', 'annual_protection'])('historical %s email dedupe cannot witness revised annual terms', async (plan) => {
    row.status = 'draft';
    row.estimate_data = { results: { tmBait: { plan, annualFee: 299 } } };
    expect((await invoke('/:id/send', 'post', { sendMethod: 'email' })).body.sent).toBe(true);
    const priorDelivery = structuredClone(dataOf().deliveryState);
    dataOf().results.tmBait = { plan: 'annual_protection', annualFee: 399 };
    row.annual_total = '399';
    row.status = 'draft';
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true,
      message: { status: 'sent', provider_message_id: 'synthetic-prior-email' } });
    const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
    expect(response.statusCode).toBe(200);
    expect(response.body.channels.email).toMatchObject({ ok: true, providerAttempted: false });
    expect(email.sendTemplate.mock.calls[1][0].idempotencyKey).toBe(email.sendTemplate.mock.calls[0][0].idempotencyKey);
    for (const key of ['firstDeliveredAt', 'lastDeliveredAt', 'deliveredAt', 'annualPlanOfferFingerprint']) {
      expect(dataOf().deliveryState[key]).toEqual(priorDelivery[key]);
    }
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
  });

  test.each([undefined, false])('historical exact-offer dedupe preserves a prior receipt (providerAttempted=%s)', async (providerAttempted) => {
    row.estimate_data = annualData();
    dataOf().deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', lastDeliveredAt: '2026-01-01T12:00:00Z',
      deliveredAt: ['2026-01-01T12:00:00Z'], annualPlanOfferFingerprint: annualPlanOfferFingerprint(row) };
    const priorDelivery = structuredClone(dataOf().deliveryState);
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true, providerAttempted });
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email.providerAttempted).toBe(false);
    expect(dataOf().deliveryState).toMatchObject(priorDelivery);
    expect(annualPlanHasDeliveredOffer(row)).toBe(true);
  });

  test('historical annual email dedupe preserves the frozen billing bundle after configuration changes', async () => {
    row.status = 'draft';
    row.estimate_data = annualData();
    buildPricingBundle.mockResolvedValue({ services: [], billingTerms: { cadence: 'annual', amount: 299 } });
    expect((await invoke('/:id/send', 'post', { sendMethod: 'email' })).body.sent).toBe(true);
    const priorSnapshot = structuredClone(dataOf().sendSnapshot);
    const priorDelivery = structuredClone(dataOf().deliveryState);
    buildPricingBundle.mockClear();
    buildPricingBundle.mockResolvedValue({ services: [], billingTerms: { cadence: 'monthly', amount: 999 } });
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
    const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
    expect(response.statusCode).toBe(200);
    expect(response.body.channels.email.providerAccepted).toBe(false);
    expect(buildPricingBundle).not.toHaveBeenCalled();
    expect(dataOf().sendSnapshot).toEqual(priorSnapshot);
    expect(dataOf().deliveryState).toMatchObject({ firstDeliveredAt: priorDelivery.firstDeliveredAt,
      lastDeliveredAt: priorDelivery.lastDeliveredAt, deliveredAt: priorDelivery.deliveredAt,
      annualPlanOfferFingerprint: priorDelivery.annualPlanOfferFingerprint });
    expect(annualPlanHasDeliveredOffer(row)).toBe(true);
  });

  test.each(['email', 'both'].flatMap(method => [false, true].map(issued => [method, issued])))('historical proposal %s dedupe preserves only unchanged PDF receipts (issued=%s)', async (method, issued) => {
    row.status = 'draft';
    row.estimate_data = { proposal: { enabled: true, buildings: [{ name: 'Synthetic building',
      lineItems: [{ id: 'application', description: 'Synthetic application', quantity: 1, unitPrice: 299, frequency: 'one_time' }] }] } };
    expect((await invoke('/:id/send', 'post', { sendMethod: 'email' })).body.sent).toBe(true);
    if (!issued) {
      const proposal = structuredClone(dataOf().proposal); proposal.buildings[0].lineItems[0].unitPrice = 399;
      expect((await invoke('/:id/proposal', 'put', { proposal })).statusCode).toBe(200);
      expect(dataOf().proposalDelivery).toBeUndefined();
    }
    const priorReceipt = structuredClone(dataOf().proposalDelivery);
    const priorSnapshot = structuredClone(dataOf().sendSnapshot);
    if (issued) expect(priorReceipt.pdfEmailed).toBe(true);
    buildPricingBundle.mockClear();
    buildPricingBundle.mockResolvedValue({ services: [], billingTerms: { amount: 999 } });
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
    const response = await invoke('/:id/send', 'post', { sendMethod: method });
    expect(response.statusCode).toBe(200);
    expect(response.body.channels.email.providerAccepted).toBe(false);
    if (method === 'email' || issued) expect(dataOf().proposalDelivery).toEqual(priorReceipt);
    else expect(dataOf().proposalDelivery.pdfEmailed).toBe(false);
    if (method === 'email') {
      expect(dataOf().sendSnapshot).toEqual(priorSnapshot); expect(buildPricingBundle).not.toHaveBeenCalled();
    } else {
      expect(response.body.channels.sms.real).toBe(true); expect(buildPricingBundle).toHaveBeenCalledTimes(1);
    }
  });

  test('dedupe after a real superseded provider attempt still witnesses the annual offer', async () => {
    row.estimate_data = annualData();
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true, superseded: true, providerAttempted: true, providerAccepted: true });
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email.providerAttempted).toBe(true);
    expect(annualPlanHasDeliveredOffer(row)).toBe(true);
  });

  test('a rejected superseded provider attempt cannot mint an annual receipt', async () => {
    row.estimate_data = annualData();
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true, superseded: true,
      providerAttempted: true, providerAccepted: false });
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email).toMatchObject({ ok: true, providerAttempted: true, providerAccepted: false });
    expect(dataOf().deliveryState.annualPlanOfferFingerprint).toBeUndefined();
    expect(dataOf().deliveryState.firstDeliveredAt).toBeUndefined();
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
  });

  test.each([
    ['email rejection', 'email', () => email.sendTemplate.mockRejectedValueOnce(new Error('Template disabled'))],
    ['suppressed SMS', 'sms', () => sendCustomerMessage.mockResolvedValueOnce({ sent: true, reason: 'SMS suppressed' })],
    // Delivery-guards slice (re-cut of #4569): the annual-offer guard at the
    // send chokepoint blocked this handoff — same "no receipt, not sent"
    // contract as any other blocked/rejected channel.
    ['annual offer withheld (email)', 'email', () => email.sendTemplate.mockResolvedValueOnce({
      sent: false, blocked: true, reason: 'annual_offer_withheld', providerAttempted: false,
    })],
    ['annual offer withheld (sms)', 'sms', () => sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, code: 'ANNUAL_OFFER_WITHHELD', reason: 'annual_offer_withheld',
    })],
  ])('%s cannot issue an annual receipt', async (_name, method, arrange) => {
    row.estimate_data = annualData();
    arrange();
    expect((await router.sendEstimateNow(structuredClone(row), method, { callerPreClaimed: true })).sent).toBe(false);
    expect(dataOf().deliveryState).toBeUndefined();
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
  });

  test.each([false, true])('terminal anchor receipt merge requires an actual handoff (actual=%s)', async (actual) => {
    row.estimate_data = annualData();
    email.sendTemplate.mockImplementationOnce(async () => {
      row.status = 'accepted';
      row.price_locked_at = new Date();
      row.annual_total = '777';
      return { sent: true, providerAttempted: actual, providerAccepted: actual };
    });
    const fingerprint = annualPlanOfferFingerprint(row);
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.superseded).toBe(true);
    expect(row.status).toBe('accepted');
    expect(row.annual_total).toBe('777');
    expect(dataOf().deliveryState?.annualPlanOfferFingerprint).toBe(actual ? fingerprint : undefined);
  });

  describe('group publication', () => {
    let sibling;
    beforeEach(() => {
      row.status = 'draft';
      row.estimate_group_id = 'synthetic-group';
      row.estimate_data = annualData(399);
      sibling = savedEstimate({ id: 'annual-sibling', status: 'draft', estimate_group_id: row.estimate_group_id,
        address: 'Synthetic second property', estimate_data: annualData() });
      groupRows.push(sibling);
      db.mockImplementation((table) => {
        const builder = estimateDatabase(table);
        const originalWhere = builder.where;
        builder.where = jest.fn((key, value) => {
          // Visibility OR branches have separate contract coverage.
          if (typeof key === 'function') return builder;
          if (key?.updated_at != null) {
            const { updated_at: _ignored, ...fields } = key;
            return originalWhere(fields);
          }
          return originalWhere(key, value);
        });
        builder.orWhere = jest.fn(() => builder);
        builder.orWhereIn = jest.fn(() => builder);
        builder.then = (resolve, reject) => builder.select().then(resolve, reject);
        const update = builder.update;
        builder.update = jest.fn(async (patch) => {
          const priorData = structuredClone(dataOf(sibling));
          const result = await update(patch);
          // Model the terminal sibling scope + receipt SQL merge as well.
          if (result && patch.estimate_data?.sql?.startsWith("jsonb_set(COALESCE(estimate_data, '{}'::jsonb),") && patch.estimate_data.bindings?.[1]
            // …not the delivery-claim stamp (#4667: its bindings are a timestamp and a token, not JSON).
            && !patch.estimate_data.sql.includes("'{estimatorEngine}'")) {
            sibling.estimate_data = { ...priorData,
              sendSnapshot: { ...priorData.sendSnapshot, ...JSON.parse(patch.estimate_data.bindings[0]) },
              ...JSON.parse(patch.estimate_data.bindings[1]) };
          }
          return result;
        });
        return builder;
      });
    });

    test.each(['quarterly', 'annual_protection'])('%s anchor publishes the sibling’s own fingerprint and bounded history', async (plan) => {
      dataOf().results.tmBait.plan = plan;
      dataOf(sibling).deliveryState = { firstDeliveredAt: '2025-01-01T12:00:00Z', deliveredAt: Array(25).fill('2025-01-01T12:00:00Z') };
      const fingerprint = annualPlanOfferFingerprint(sibling);
      const result = await invoke('/:id/send', 'post', { sendMethod: 'email' });
      expect(result.statusCode).toBe(200);
      expect(sibling.status).toBe('sent');
      expect(dataOf(sibling).deliveryState).toMatchObject({ firstDeliveredAt: '2025-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint });
      expect(dataOf(sibling).deliveryState.annualPlanOfferFingerprint).not.toBe(dataOf().deliveryState.annualPlanOfferFingerprint);
      expect(dataOf(sibling).deliveryState.deliveredAt).toHaveLength(25);
      expect(dataOf(sibling).deliveryState.deliveredAt.at(-1)).toBe(dataOf().deliveryState.lastDeliveredAt);
      expect(annualPlanHasDeliveredOffer(sibling)).toBe(true);
    });

    test('historical group dedupe preserves both frozen billing bundles after configuration changes', async () => {
      buildPricingBundle.mockImplementation(async (estimate) => ({ services: [], billingTerms: { cadence: 'annual', amount: estimate.id === sibling.id ? 299 : 399 } }));
      expect((await invoke('/:id/send', 'post', { sendMethod: 'email' })).body.sent).toBe(true);
      const priorSnapshots = [row, sibling].map((estimate) => structuredClone(dataOf(estimate).sendSnapshot));
      const priorSiblingDelivery = structuredClone(dataOf(sibling).deliveryState);
      // Exercise the claimed publication path while retaining the issued offer.
      row.status = sibling.status = 'draft';
      buildPricingBundle.mockClear();
      buildPricingBundle.mockResolvedValue({ services: [], billingTerms: { cadence: 'monthly', amount: 999 } });
      email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
      const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
      expect(response.statusCode).toBe(200);
      expect(response.body.channels.email.providerAccepted).toBe(false);
      expect(buildPricingBundle).not.toHaveBeenCalled();
      expect([row, sibling].map((estimate) => dataOf(estimate).sendSnapshot)).toEqual(priorSnapshots);
      expect(dataOf(sibling).deliveryState).toEqual(priorSiblingDelivery);
      expect(sibling.status).toBe('sent');
      expect(dataOf(sibling).groupPublishedByEstimateId).toBe(row.id);
      expect(sibling.expires_at).toBeTruthy();
      expect(annualPlanHasDeliveredOffer(sibling)).toBe(true);
    });

    test.each([false, true])('historical dedupe preserves sibling evidence (issued=%s)', async (issued) => {
      if (issued) dataOf(sibling).deliveryState = { firstDeliveredAt: '2025-01-01T12:00:00Z',
        annualPlanOfferFingerprint: annualPlanOfferFingerprint(sibling), deliveredAt: ['2025-01-01T12:00:00Z'] };
      const priorDelivery = structuredClone(dataOf(sibling).deliveryState);
      email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true });
      const result = await invoke('/:id/send', 'post', { sendMethod: 'email' });
      expect(result.statusCode).toBe(200);
      expect(dataOf(sibling).deliveryState).toEqual(priorDelivery);
      expect(annualPlanHasDeliveredOffer(sibling)).toBe(issued);
    });

    test.each([false, true])('terminal sibling receipt merge requires an actual handoff (actual=%s)', async (actual) => {
      const fingerprint = annualPlanOfferFingerprint(sibling);
      email.sendTemplate.mockImplementationOnce(async () => {
        sibling.status = 'accepted';
        sibling.price_locked_at = new Date();
        sibling.annual_total = '777';
        return { sent: true, providerAttempted: actual, providerAccepted: actual };
      });
      const result = await invoke('/:id/send', 'post', { sendMethod: 'email' });
      expect(result.statusCode).toBe(200);
      expect(sibling.status).toBe('accepted');
      expect(sibling.annual_total).toBe('777');
      expect(dataOf(sibling).deliveryState?.annualPlanOfferFingerprint).toBe(actual ? fingerprint : undefined);
    });

    test('annual-offer delivery guard (delivery-guards slice, re-cut of #4569): a withheld sibling aborts the whole group send', async () => {
      email.sendTemplate.mockResolvedValueOnce({
        sent: false, blocked: true, reason: 'annual_offer_withheld', providerAttempted: false,
      });
      const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
      expect(response.statusCode).toBe(422);
      expect(response.body.success).toBe(false);
      expect(response.body.channels.email).toMatchObject({ ok: false });
      // The whole claimed set — anchor + sibling — rode the ONE provider
      // call, so a withheld sibling aborts it rather than publishing the
      // group around it (the customer's link shows every property).
      expect(email.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
        estimateIds: expect.arrayContaining([row.id, sibling.id]),
      }));
      // The sibling was claimed ('sending') then released back to its
      // pre-claim status — never published alongside a blocked anchor.
      expect(sibling.status).toBe('draft');
      expect(dataOf(sibling).groupPublishedByEstimateId).toBeUndefined();
      expect(row.status).not.toBe('sent');
      expect(annualPlanHasDeliveredOffer(sibling)).toBe(false);
    });

    test('pre-push audit P1: a guard infrastructure error leaves channels.email ok:false and NOT uncertain, and releases the group claim', async () => {
      email.sendTemplate.mockResolvedValueOnce({
        sent: false, aborted: true, guardError: true, reason: 'annual_offer_guard_failed',
        providerAttempted: false, error: 'estimates lookup unavailable',
      });
      const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
      expect(response.statusCode).toBe(422);
      expect(response.body.success).toBe(false);
      expect(response.body.channels.email).toMatchObject({ ok: false });
      // Never uncertain: sendTemplate resolved (didn't throw), so the
      // admin-estimates catch block that COMPUTES `uncertain` from a
      // possible-but-unproven provider attempt is never reached — this is
      // the exact misclassification the pre-push audit flagged (a thrown
      // guard error, after onQueued had already fired, read as an uncertain
      // delivery even though SendGrid was never called).
      expect(response.body.channels.email.uncertain).toBeUndefined();
      // The sibling was claimed ('sending') then released back to its
      // pre-claim status — a guard infra failure never publishes.
      expect(sibling.status).toBe('draft');
      expect(row.status).not.toBe('sent');
    });
  });
});

describe('satellite palm count typed before the first send (GATE_SATELLITE_PALM_COUNT_TYPED)', () => {
  const gates = require('../config/feature-gates');
  const satelliteLine = (palmCount) => ({ engineResult: { lineItems: [{ service: 'tree_shrub', palmCount, palmCountFromLookup: true }] } });
  beforeEach(() => {
    gates.satellitePalmCountTypedLive.mockReturnValue(true);
    row.status = 'draft';
    row.estimate_data = satelliteLine(14);
  });
  afterEach(() => gates.satellitePalmCountTypedLive.mockReturnValue(false));

  test('the preview asks for the count without blocking; the send needs exactly the priced count', async () => {
    const preview = await invoke('/:id/send-preview', 'get');
    expect(preview.body.satellitePalmCount).toBe(14);
    expect(preview.body.blockReason).toBeUndefined();
    const { body } = scheduledAttempt();
    const missing = await invoke('/:id/send', 'post', body);
    expect(missing.statusCode).toBe(409);
    expect(missing.body.code).toBe('PALM_COUNT_REQUIRED');
    const wrong = await invoke('/:id/send', 'post', { ...body, confirmedPalmCount: 6 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'PALM_COUNT_MISMATCH', error: expect.stringContaining('this quote priced 14') });
    expect(mutations).toEqual([]);
    const typed = await invoke('/:id/send', 'post', { ...body, confirmedPalmCount: 14 });
    expect(typed.statusCode).toBe(200);
    expect(typed.body.scheduled).toBe(true);
    expect(row.status).toBe('scheduled');
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test('a row scheduled with no recorded count (before this check existed) sends as before', async () => {
    row.status = 'sending';
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
  });

  // Pre-push audit P1: the count is checked on the pre-read row, so every claim
  // must hold it to the row it actually claims or sends.
  const casClaims = () => db.mock.results.map((r) => r.value)
    .filter((qb) => qb?.whereRaw?.mock.calls.some(([sql]) => sql.startsWith("COALESCE(estimate_data, '{}'::jsonb) = ?::jsonb")));

  test('an immediate send without a reviewed edit version still pins the snapshot the count was checked on', async () => {
    const response = await invoke('/:id/send', 'post', { sendMethod: 'email', confirmedPalmCount: 14 });
    expect(response.statusCode).toBe(200);
    expect(response.body.sent).toBe(true);
    expect(casClaims()).toHaveLength(1);
    const [, bindings] = casClaims()[0].whereRaw.mock.calls.find(([sql]) => sql.startsWith('COALESCE(estimate_data'));
    expect(JSON.parse(bindings[0])).toEqual(satelliteLine(14));
  });

  test('with nothing to count, an unreviewed immediate send claims as before (no snapshot pin)', async () => {
    gates.satellitePalmCountTypedLive.mockReturnValue(false);
    const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
    expect(response.body.sent).toBe(true);
    expect(casClaims()).toHaveLength(0);
  });

  test('a schedule checks the typed count again on the row it locks', async () => {
    db.mockImplementation((table) => {
      const builder = estimateDatabase(table);
      // A revision lands between the pre-read and the schedule's row lock.
      builder.forUpdate.mockImplementation(() => { row.estimate_data = satelliteLine(9); return builder; });
      return builder;
    });
    const { body } = scheduledAttempt();
    const response = await invoke('/:id/send', 'post', { ...body, confirmedPalmCount: 14 });
    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('PALM_COUNT_MISMATCH');
    expect(row.status).toBe('draft');
  });

  test('a schedule records the typed count; the cron leg sends the unchanged row', async () => {
    const { scheduledAt } = scheduledAttempt();
    const response = await invoke('/:id/send', 'post', { sendMethod: 'email', scheduledAt, confirmedPalmCount: 14 });
    expect(response.body.scheduled).toBe(true);
    // A typed count always gets a receipt, so the cron leg can check it again.
    expect(dataOf().manualSendAttempts.at(-1).scheduleReview.confirmedPalmCount).toBe(14);
    row.status = 'sending';
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
  });

  test('the cron leg refuses a scheduled row whose priced count moved after the count was typed', async () => {
    const { body } = scheduledAttempt();
    expect((await invoke('/:id/send', 'post', { ...body, confirmedPalmCount: 14 })).body.scheduled).toBe(true);
    row.estimate_data = { ...dataOf(), engineResult: satelliteLine(9).engineResult };
    row.status = 'sending';
    await expect(router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true }))
      .rejects.toMatchObject({ code: 'PALM_COUNT_MISMATCH' });
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test('a row already sent and a row with no satellite count are never asked', async () => {
    row.sent_at = new Date('2026-01-01T12:00:00.000Z');
    expect((await invoke('/:id/send-preview', 'get')).body.satellitePalmCount).toBeUndefined();
    row.sent_at = null;
    row.estimate_data = {};
    expect((await invoke('/:id/send-preview', 'get')).body.satellitePalmCount).toBeUndefined();
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
    expect(payload.price_summary).not.toMatch(/tax/);
  });

  test('a taxed commercial proposal email price line states the tax amount and rate beside the first-year total', async () => {
    row.estimate_data = { proposal: {
      enabled: true,
      taxRate: 0.07,
      buildings: [{ name: 'Synthetic property', lineItems: [
        { id: 'synthetic-taxable-line', description: 'Synthetic taxable service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: true },
      ] }],
    } };
    const result = await router.sendEstimateNow(structuredClone(row), 'email');
    expect(result.sent).toBe(true);
    const { price_summary: priceSummary } = email.sendTemplate.mock.calls[0][0].payload;
    // 1,200.00 annual x 7% = 84.00 tax; first year 1,284.00
    expect(priceSummary).toContain('$84.00 tax (7.00%)');
    expect(priceSummary).toContain('first-year total $1,284.00');
    expect(priceSummary.indexOf('tax (7.00%)')).toBeLessThan(priceSummary.indexOf('first-year total'));
  });
});

describe('GET /:id/proposal suggestedTaxRate', () => {
  const TaxCalculator = require('../services/tax-calculator');
  afterEach(() => jest.restoreAllMocks());

  test('returns the canonical county rate for a customer', async () => {
    row.customer_id = 'synthetic-customer';
    const calculate = jest.spyOn(TaxCalculator, 'calculateTax')
      .mockResolvedValue({ rate: 0.07, amount: 0.07, taxable: true, county: 'Manatee' });
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.suggestedTaxRate).toBe(0.07);
    expect(res.body.suggestedTaxSource).toBe('Manatee County');
    expect(calculate).toHaveBeenCalledWith('synthetic-customer', 'nonresidential_pest_control', 1, expect.objectContaining({ isCommercial: true }));
  });

  test('names the Florida default when the county cannot be found from the ZIP', async () => {
    row.customer_id = 'synthetic-customer';
    jest.spyOn(TaxCalculator, 'calculateTax')
      .mockResolvedValue({ rate: 0.07, amount: 0.07, taxable: true, county: 'unknown', reason: 'Default FL rate (county could not be inferred from ZIP)' });
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.suggestedTaxRate).toBe(0.07);
    expect(res.body.suggestedTaxSource).toBe("Florida commercial rate (county not found from the customer's ZIP)");
  });

  test('returns 0 for a tax-exempt customer so nothing is filled', async () => {
    row.customer_id = 'synthetic-exempt-customer';
    jest.spyOn(TaxCalculator, 'calculateTax')
      .mockResolvedValue({ rate: 0, amount: 0, taxable: false, county: null, reason: 'Tax exempt — synthetic' });
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.suggestedTaxRate).toBe(0);
    expect(res.body.suggestedTaxSource).toBe('Tax exempt — synthetic');
  });

  test('returns the resolver default (FL commercial 7%) with no customer, without a customer lookup', async () => {
    row.customer_id = null;
    const calculate = jest.spyOn(TaxCalculator, 'calculateTax');
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.suggestedTaxRate).toBe(require('../services/estimate-converter').FL_COMMERCIAL_TAX_RATE);
    expect(res.body.suggestedTaxSource).toBe('Florida commercial rate (no customer linked yet)');
    expect(calculate).not.toHaveBeenCalled();
  });

  test('a failed customer / exemption / county lookup suggests nothing, never the unchecked 7% default', async () => {
    row.customer_id = 'synthetic-customer';
    jest.spyOn(TaxCalculator, 'calculateTax').mockRejectedValue(new Error('synthetic lookup failure'));
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.suggestedTaxRate).toBeNull();
    expect(res.body.suggestedTaxSource).toBeNull();
    expect(res.body.proposal).toBeTruthy();
  });

  test('the accept-path resolver keeps failing soft to the FL default', async () => {
    jest.spyOn(TaxCalculator, 'calculateTax').mockRejectedValue(new Error('synthetic lookup failure'));
    const { resolveCommercialPrepayBaseRate, FL_COMMERCIAL_TAX_RATE } = require('../services/estimate-converter');
    await expect(resolveCommercialPrepayBaseRate('synthetic-customer', {})).resolves.toBe(FL_COMMERCIAL_TAX_RATE);
    await expect(resolveCommercialPrepayBaseRate('synthetic-customer', { strict: true })).rejects.toThrow('synthetic lookup failure');
  });
});

// Owner 2026-10-24 "autopay default" (GATE_COMMERCIAL_AUTOPAY): Auto Pay is the payment term of a proposal that does
// not bill by invoice, and never sits beside Bill by invoice. Net terms still need Bill by invoice.
describe('building-use tax gate on the builder read', () => {
  test('GET /:id/proposal says whether GATE_BUILDING_USE_TAX is live (the Taxable-box warning for Residential follows it)', async () => {
    Object.assign(row, { status: 'draft', estimate_data: { proposal: { enabled: true, buildings: [] } } });
    buildingUseTaxLive.mockReturnValue(true);
    expect((await invoke('/:id/proposal', 'get')).body.buildingUseTaxLive).toBe(true);
    buildingUseTaxLive.mockReturnValue(false);
    expect((await invoke('/:id/proposal', 'get')).body.buildingUseTaxLive).toBe(false);
  });

  test('GET /:id/proposal says whether GATE_LAWN_SPRAY_NO_TAX is live (lawn and tree & shrub bill untaxed only then)', async () => {
    Object.assign(row, { status: 'draft', estimate_data: { proposal: { enabled: true, buildings: [] } } });
    const { lawnSprayNoTaxLive } = require('../config/feature-gates');
    expect((await invoke('/:id/proposal', 'get')).body.lawnSprayNoTaxLive).toBe(true);
    lawnSprayNoTaxLive.mockReturnValueOnce(false);
    expect((await invoke('/:id/proposal', 'get')).body.lawnSprayNoTaxLive).toBe(false);
  });
});

describe('GET /:id/proposal taxExemptVerified (the Taxable-box warning compares with the calculator\'s exemption check)', () => {
  const TaxCalculator = require('../services/tax-calculator');
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['an exempt customer', { id: 'exemption-1' }, true],
    ['a customer with no verified exemption', undefined, false],
  ])('%s', async (_label, exemption, expected) => {
    row.customer_id = 'synthetic-customer';
    const find = jest.spyOn(TaxCalculator, 'findVerifiedExemption').mockResolvedValue(exemption);
    expect((await invoke('/:id/proposal', 'get')).body.taxExemptVerified).toBe(expected);
    expect(find).toHaveBeenCalledWith('synthetic-customer');
  });

  test('no linked customer: false, without an exemption lookup', async () => {
    row.customer_id = null;
    const find = jest.spyOn(TaxCalculator, 'findVerifiedExemption');
    expect((await invoke('/:id/proposal', 'get')).body.taxExemptVerified).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  test('a failed exemption read is null (unknown), and the builder read still succeeds', async () => {
    row.customer_id = 'synthetic-customer';
    jest.spyOn(TaxCalculator, 'findVerifiedExemption').mockRejectedValue(new Error('synthetic lookup failure'));
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.taxExemptVerified).toBeNull();
    expect(res.body.proposal).toBeTruthy();
  });
});

describe('GET /:id/proposal billToTaxBasis (a payer-billed visit bill follows the payer\'s tax status)', () => {
  const payer = require('../services/payer');
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['no active Bill-To payer', { payerId: null, taxExempt: false }, 'self'],
    ['a tax-exempt payer', { payerId: 'synthetic-payer', taxExempt: true }, 'payer_exempt'],
    ['a taxed payer', { payerId: 'synthetic-payer', taxExempt: false }, 'payer_taxed'],
  ])('%s', async (_label, resolved, expected) => {
    row.customer_id = 'synthetic-customer';
    const resolve = jest.spyOn(payer, 'resolveForInvoice').mockResolvedValue(resolved);
    expect((await invoke('/:id/proposal', 'get')).body.billToTaxBasis).toBe(expected);
    expect(resolve).toHaveBeenCalledWith({ customerId: 'synthetic-customer', throwOnError: true });
  });

  test('no linked customer: self, without a payer lookup', async () => {
    row.customer_id = null;
    const resolve = jest.spyOn(payer, 'resolveForInvoice');
    expect((await invoke('/:id/proposal', 'get')).body.billToTaxBasis).toBe('self');
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a failed payer read is null (unknown), and the builder read still succeeds', async () => {
    row.customer_id = 'synthetic-customer';
    jest.spyOn(payer, 'resolveForInvoice').mockRejectedValue(new Error('synthetic lookup failure'));
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.billToTaxBasis).toBeNull();
    expect(res.body.proposal).toBeTruthy();
  });
});

describe('GET /:id/proposal accountCommercial (a residential account\'s bills carry no tax until a taxable win)', () => {
  // The default fake answers every table; only the customer row read changes here.
  const withCustomer = (customer, { fail = false } = {}) => (table) => {
    const builder = estimateDatabase(table);
    if (table === 'customers') {
      builder.first = jest.fn(async () => {
        if (fail) throw new Error('synthetic lookup failure');
        return customer && structuredClone(customer);
      });
    }
    return builder;
  };

  test.each([
    ['a commercial account', { property_type: 'commercial' }, true],
    ['a business account', { property_type: 'business' }, true],
    ['a residential account', { property_type: 'residential' }, false],
    ['an account with no type', { property_type: null }, false],
    ['no customer row', null, null],
  ])('%s', async (_label, customer, expected) => {
    row.customer_id = 'synthetic-customer';
    db.mockImplementation(withCustomer(customer));
    expect((await invoke('/:id/proposal', 'get')).body.accountCommercial).toBe(expected);
  });

  test('no linked customer: true (the win creates a new commercial customer)', async () => {
    row.customer_id = null;
    expect((await invoke('/:id/proposal', 'get')).body.accountCommercial).toBe(true);
  });

  test('a failed read is null (unknown), and the builder read still succeeds', async () => {
    row.customer_id = 'synthetic-customer';
    db.mockImplementation(withCustomer(null, { fail: true }));
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.accountCommercial).toBeNull();
    expect(res.body.proposal).toBeTruthy();
  });
});

describe('GET /:id/proposal firstVisit (the builder Readiness card)', () => {
  const firstVisitModule = require('../services/commercial-first-visit');
  const { commercialFirstVisitLive } = require('../config/feature-gates');
  afterEach(() => jest.restoreAllMocks());

  test('GATE_COMMERCIAL_FIRST_VISIT on: serves the readiness of this estimate', async () => {
    commercialFirstVisitLive.mockReturnValueOnce(true);
    const readiness = jest.spyOn(firstVisitModule, 'firstVisitReadiness').mockResolvedValue({ state: 'office', reason: 'itemization' });
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body.firstVisit).toEqual({ state: 'office', reason: 'itemization' });
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }), expect.objectContaining({ closed: false }));
  });

  test('gate off: no firstVisit key and no read', async () => {
    const readiness = jest.spyOn(firstVisitModule, 'firstVisitReadiness');
    const res = await invoke('/:id/proposal', 'get');
    expect(res.body).not.toHaveProperty('firstVisit');
    expect(readiness).not.toHaveBeenCalled();
  });
});

describe('commercial Auto Pay payment term', () => {
  const recurring = (commercialTerms) => ({
    enabled: true,
    buildings: [{ name: 'Synthetic office', lineItems: [{ id: 'monthly', description: 'Synthetic monthly service', quantity: 1, unitPrice: 100, frequency: 'monthly' }] }],
    ...(commercialTerms ? { commercialTerms } : {}),
  });
  const put = (commercialTerms) => invoke('/:id/proposal', 'put', { expectedEditVersion: persistence.estimateEditVersion(row), proposal: recurring(commercialTerms) });
  beforeEach(() => {
    commercialAutopayLive.mockReturnValue(true);
    Object.assign(row, { status: 'draft', bill_by_invoice: false, estimate_data: { proposal: recurring() } });
  });
  afterEach(() => commercialAutopayLive.mockReturnValue(false));

  test('the builder read says whether Auto Pay is offered', async () => {
    expect((await invoke('/:id/proposal', 'get')).body.commercialAutopayEnabled).toBe(true);
    commercialAutopayLive.mockReturnValue(false);
    expect((await invoke('/:id/proposal', 'get')).body.commercialAutopayEnabled).toBe(false);
  });

  test('Auto Pay saves on a proposal that does not bill by invoice', async () => {
    const res = await put({ paymentTerms: 'Auto Pay' });
    expect(res.statusCode).toBe(200);
    expect(dataOf().proposal.commercialTerms.paymentTerms).toBe('autopay');
  });

  test('Auto Pay is refused beside Bill by invoice, and nothing is written', async () => {
    row.bill_by_invoice = true;
    const res = await put({ paymentTerms: 'autopay' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Auto Pay cannot be combined with Bill by invoice. Pick Net-30 or Net-60 for an invoiced proposal, or turn off Bill by invoice.');
    expect(mutations).toEqual([]);
  });

  test('Net-60 saves on a Bill-by-invoice proposal, in its canonical spelling (owner 2026-10-29)', async () => {
    row.bill_by_invoice = true;
    const res = await put({ paymentTerms: 'Net 60' });
    expect(res.statusCode).toBe(200);
    expect(dataOf().proposal.commercialTerms.paymentTerms).toBe('net60');
  });

  test('Net-60 without Bill by invoice is refused like every invoice term, and nothing is written', async () => {
    const res = await put({ paymentTerms: 'net60' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Structured payment terms require Bill by invoice. Put payment language in Additional terms, or turn on invoice billing for this proposal.');
    expect(mutations).toEqual([]);
  });

  test('with the gate off a new Auto Pay term is refused, but a proposal already on Auto Pay can still be saved', async () => {
    commercialAutopayLive.mockReturnValue(false);
    const refused = await put({ paymentTerms: 'autopay' });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toBe('Payment terms must be one of: Due on receipt, Net-15, Net-30, Net-60.');
    row.estimate_data = { proposal: recurring({ paymentTerms: 'autopay' }) };
    expect((await put({ paymentTerms: 'autopay' })).statusCode).toBe(200);
  });

  test('a Net term still needs Bill by invoice', async () => {
    const res = await put({ paymentTerms: 'net30' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Structured payment terms require Bill by invoice/);
  });

  test('Bill by invoice cannot be turned on while the proposal is on Auto Pay', async () => {
    row.estimate_data = { proposal: recurring({ paymentTerms: 'autopay' }) };
    const res = await invoke('/:id', 'patch', { billByInvoice: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('This proposal is on Auto Pay, which cannot be combined with Bill by invoice. Set Payment terms to Not set in the proposal editor first.');
    expect(mutations).toEqual([]);
    expect(row.bill_by_invoice).toBe(false);
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

describe('grouped send claim uses the locked anchor offer', () => {
  beforeEach(() => {
    row.estimate_group_id = 'synthetic-group';
    row.estimate_data = { proposal: { enabled: true, validThrough: '2099-12-21', buildings: [] } };
    // Knex's unresolved query builder is awaited for sibling enumeration.
    db.mockImplementation((table) => {
      const builder = estimateDatabase(table);
      builder.orWhereIn = jest.fn(() => builder);
      builder.then = (resolve, reject) => builder.select().then(resolve, reject);
      return builder;
    });
  });

  test.each(['2099-12-31', '2099-12-11'])('a proposal save to %s before the group lock rejects a stale unversioned send', async (validThrough) => {
    const preSaveRead = structuredClone(row);
    db.transaction.mockImplementationOnce(async (callback) => {
      // The authoring write commits after the caller read and before the
      // group advisory lock. Legacy direct sends have no edit-version pin.
      dataOf().proposal.validThrough = validThrough;
      return callback(db);
    });
    await expect(router.sendEstimateNow(preSaveRead, 'email', { callerPreClaimed: true }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ESTIMATE_REVIEW_STALE' });
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(row.expires_at).toBeUndefined();
    expect(dataOf().proposal.validThrough).toBe(validThrough);
  });

  test('an unchanged unversioned grouped send still publishes its authored deadline', async () => {
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email.ok).toBe(true);
    expect(row.expires_at.toISOString()).toBe('2099-12-22T04:59:59.999Z');
  });
});

describe('impossible US phone is refused before any provider call', () => {
  // Synthetic: ten digits whose area code starts with 1 can never be texted.
  const BAD_PHONE = '+11035550123';

  test.each(['both', 'sms'])('POST send (%s) refuses the whole send with 400 before the claim, the email and the text', async (sendMethod) => {
    row.status = 'draft';
    row.customer_phone = BAD_PHONE;
    const response = await invoke('/:id/send', 'post', { sendMethod });
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('INVALID_SMS_PHONE');
    expect(response.body.error).toContain(BAD_PHONE);
    expect(response.body.error).toMatch(/Nothing was sent/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(email.sendTemplate).not.toHaveBeenCalled();
    expect(mutations).toHaveLength(0);
    expect(row.status).toBe('draft');
  });

  test('POST send (email only) is unaffected by a bad saved phone', async () => {
    row.status = 'draft';
    row.customer_phone = BAD_PHONE;
    const response = await invoke('/:id/send', 'post', { sendMethod: 'email' });
    expect(response.statusCode).toBe(200);
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the scheduled-send request is refused too', async () => {
    row.status = 'draft';
    row.customer_phone = BAD_PHONE;
    const response = await invoke('/:id/send', 'post', {
      sendMethod: 'both', scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('INVALID_SMS_PHONE');
    expect(mutations).toHaveLength(0);
  });

  test('a caller with nobody to refuse to (cron, auto-send) still never reaches the provider for the text leg', async () => {
    row.customer_phone = '1035550123';
    const result = await router.sendEstimateNow(structuredClone(row), 'both', { callerPreClaimed: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.channels.sms.ok).toBe(false);
    expect(result.channels.sms.error).toMatch(/not a valid US phone number/);
    expect(result.channels.email.ok).toBe(true);
  });

  test('a valid number still sends the text', async () => {
    row.customer_phone = '(203) 555-0123';
    const result = await router.sendEstimateNow(structuredClone(row), 'sms', { callerPreClaimed: true });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].to).toBe('+12035550123');
    expect(result.channels.sms.ok).toBe(true);
  });

  test('the send preview carries the refusal reason for the dialog', async () => {
    row.customer_phone = BAD_PHONE;
    const preview = await invoke('/:id/send-preview', 'get');
    expect(preview.body.smsBlockReason).toMatch(/not a valid US phone number/);
    row.customer_phone = '+12035550123';
    const ok = await invoke('/:id/send-preview', 'get');
    expect(ok.body.smsBlockReason).toBeNull();
  });
});


describe('estimate PDF copy on the delivery email (GATE_ESTIMATE_EMAIL_PDF)', () => {
  const featureGates = require('../config/feature-gates');
  const docPdf = require('../services/pdf/estimate-doc-pdf');
  const PDF = { filename: 'Waves-Estimate-EST-2026-0001.pdf', content: 'c3ludGhldGlj', type: 'application/pdf', disposition: 'attachment' };
  const setGates = (on) => featureGates.isEnabled.mockImplementation((name) => on && (name === 'estimateEmailPdf' || name === 'estimateDocPdf'));
  let originalRender;
  beforeEach(() => {
    originalRender = email.renderTemplate.getMockImplementation();
    // The preview text carries the note, like the real template does.
    email.renderTemplate.mockImplementation(({ payload }) => ({
      subject: 'Synthetic estimate message',
      text: `${payload.price_summary}\n${payload.estimate_url}${payload.estimate_pdf_note ? `\n${payload.estimate_pdf_note}` : ''}`,
      html: '<p>Synthetic estimate message</p>',
    }));
    docPdf.buildEstimateEmailPdfAttachment.mockReset();
    docPdf.buildEstimateEmailPdfAttachment.mockResolvedValue(PDF);
  });
  afterEach(() => {
    featureGates.isEnabled.mockImplementation(() => false);
    email.renderTemplate.mockImplementation(originalRender);
  });

  test('gate on: the email carries the PDF and the note, and the channel says so', async () => {
    setGates(true);
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email).toMatchObject({ ok: true, pdfAttached: true });
    expect(result.channels.email.warning).toBeUndefined();
    const sent = email.sendTemplate.mock.calls[0][0];
    expect(sent.templateKey).toBe('estimate.delivery');
    expect(sent.attachments).toEqual([PDF]);
    expect(sent.payload.estimate_pdf_note).toBe('Synthetic delivery PDF note.');
    // The document advertises the same valid-through date as the link.
    expect(docPdf.buildEstimateEmailPdfAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }), { validThrough: expect.any(Date) });
  });

  test('gate off: nothing is built, no note, no attachment, and the channel result is unchanged', async () => {
    setGates(false);
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(docPdf.buildEstimateEmailPdfAttachment).not.toHaveBeenCalled();
    const sent = email.sendTemplate.mock.calls[0][0];
    expect(sent.attachments).toEqual([]);
    expect(sent.payload).not.toHaveProperty('estimate_pdf_note');
    expect(result.channels.email).not.toHaveProperty('pdfAttached');
    expect(result.channels.email.warning).toBeUndefined();
  });

  test('the PDF gate alone is not enough: the browser document gate must be on too', async () => {
    featureGates.isEnabled.mockImplementation((name) => name === 'estimateEmailPdf');
    await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(docPdf.buildEstimateEmailPdfAttachment).not.toHaveBeenCalled();
    expect(email.sendTemplate.mock.calls[0][0].payload).not.toHaveProperty('estimate_pdf_note');
  });

  test.each([
    ['returns nothing', () => docPdf.buildEstimateEmailPdfAttachment.mockResolvedValue(null)],
    ['throws', () => docPdf.buildEstimateEmailPdfAttachment.mockRejectedValue(new Error('browser down'))],
  ])('a render that %s still sends the email as today, with a warning', async (_label, arrange) => {
    setGates(true);
    arrange();
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    expect(result.channels.email).toMatchObject({ ok: true, pdfAttached: false, warning: expect.stringMatching(/PDF copy could not be attached/) });
    const sent = email.sendTemplate.mock.calls[0][0];
    expect(sent.attachments).toEqual([]);
    expect(sent.payload).not.toHaveProperty('estimate_pdf_note');
  });

  test.each([
    ['persisted without a file', { has_attachments: false }, { pdfAttached: false, warning: expect.stringMatching(/PDF copy could not be attached/) }],
    ['persisted with a file', { has_attachments: true }, { pdfAttached: true }],
    ['not reported', { provider_message_id: 'earlier' }, null],
  ])('a deduped answer (the earlier message %s) never claims the new render went out and records no disclosure (codex #6343 r12)', async (_label, message, expected) => {
    setGates(true);
    docPdf.recordEmailedPdfDisclosure.mockClear();
    email.sendTemplate.mockResolvedValueOnce({ sent: true, deduped: true, message });
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email.ok).toBe(true);
    if (expected) expect(result.channels.email).toMatchObject(expected);
    else expect(result.channels.email).not.toHaveProperty('pdfAttached');
    expect(docPdf.recordEmailedPdfDisclosure).not.toHaveBeenCalled();
  });

  test('a fresh provider-accepted send records the disclosure once and says the file went out', async () => {
    setGates(true);
    docPdf.recordEmailedPdfDisclosure.mockClear();
    const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(result.channels.email).toMatchObject({ ok: true, pdfAttached: true });
    expect(docPdf.recordEmailedPdfDisclosure).toHaveBeenCalledTimes(1);
  });

  test('a commercial proposal keeps its own PDF path and never gets the estimate copy', async () => {
    setGates(true);
    row.estimate_data = { proposal: { enabled: true, validThrough: '2099-12-21',
      buildings: [{ name: 'Synthetic property', lineItems: [
        { id: 'application', description: 'Synthetic application', quantity: 1, unit: 'acre', unitPrice: 100, frequency: 'one_time' },
      ] }] } };
    await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
    expect(docPdf.buildEstimateProposalEmailAttachmentPreferred).toHaveBeenCalledTimes(1);
    expect(docPdf.buildEstimateEmailPdfAttachment).not.toHaveBeenCalled();
    expect(email.sendTemplate.mock.calls[0][0].payload).not.toHaveProperty('estimate_pdf_note');
  });

  test('reviewed send: the preview shows the note, the same review sends, and the reviewed template hash is untouched', async () => {
    setGates(true);
    row.status = 'draft';
    const preview = await invoke('/:id/send-preview', 'get');
    expect(preview.body.messages.email.text).toContain('Synthetic delivery PDF note.');
    const response = await invoke('/:id/send', 'post', {
      sendMethod: 'email', expectedEditVersion: preview.body.editVersion, messageVersion: preview.body.messageVersion,
    });
    expect(response.statusCode).toBe(200);
    const sent = email.sendTemplate.mock.calls[0][0];
    expect(sent.attachments).toEqual([PDF]);
    expect(sent.expectedContentHash).toBe(preview.body.messages.email.contentHash);
  });

  test('reviewed send: the review of a message with no PDF line goes stale when the gate comes on', async () => {
    setGates(false);
    row.status = 'draft';
    const preview = await invoke('/:id/send-preview', 'get');
    expect(preview.body.messages.email.text).not.toContain('Synthetic delivery PDF note.');
    setGates(true);
    const response = await invoke('/:id/send', 'post', {
      sendMethod: 'email', expectedEditVersion: preview.body.editVersion, messageVersion: preview.body.messageVersion,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('ESTIMATE_REVIEW_STALE');
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test('reviewed send: a PDF that fails to render still sends the reviewed email without the file', async () => {
    setGates(true);
    row.status = 'draft';
    const preview = await invoke('/:id/send-preview', 'get');
    docPdf.buildEstimateEmailPdfAttachment.mockResolvedValue(null);
    const response = await invoke('/:id/send', 'post', {
      sendMethod: 'email', expectedEditVersion: preview.body.editVersion, messageVersion: preview.body.messageVersion,
    });
    expect(response.statusCode).toBe(200);
    expect(email.sendTemplate.mock.calls[0][0].attachments).toEqual([]);
    expect(email.sendTemplate.mock.calls[0][0].expectedContentHash).toBe(preview.body.messages.email.contentHash);
  });

  // codex #6343 r6 P1/P2: the reviewed PDF decision travels with the review and
  // the schedule; a grouped estimate carries no PDF; the delivery fence also
  // requires the claimed 'sending' state.
  describe('reviewed PDF decision, groups and the claimed state', () => {
    const emailPdf = require('../services/estimate-email-pdf');
    afterEach(() => jest.restoreAllMocks());

    test('the review records the decision (only when true) and a schedule built from it keeps it', async () => {
      setGates(true);
      row.status = 'draft';
      const preview = await invoke('/:id/send-preview', 'get');
      expect(preview.body.messages.email.pdfCopy).toBe(true);
      const scheduled = await invoke('/:id/send', 'post', {
        sendMethod: 'email', scheduledAt: new Date(Date.now() + 86400000).toISOString(), idempotencyKey: 'synthetic-pdf-schedule',
        expectedEditVersion: preview.body.editVersion, messageVersion: preview.body.messageVersion,
      });
      expect(scheduled.statusCode).toBe(200);
      // The schedule receipt carries the reviewed messages, decision included.
      const stored = dataOf().manualSendAttempts.at(-1).scheduleReview.reviewedMessages.email;
      expect(stored.pdfCopy).toBe(true);
      // Gate off: the review is exactly as before (no key at all).
      setGates(false);
      expect((await invoke('/:id/send-preview', 'get')).body.messages.email).not.toHaveProperty('pdfCopy');
    });

    test('a scheduled send reviewed WITH the PDF is stale when the decision is now no, and nothing is sent', async () => {
      setGates(false);
      await expect(router.sendEstimateNow(structuredClone(row), 'email', {
        callerPreClaimed: false, reviewedMessages: { sms: null, email: { provider: 'sendgrid', pdfCopy: true } },
      })).rejects.toMatchObject({ code: 'ESTIMATE_REVIEW_STALE' });
      expect(email.sendTemplate).not.toHaveBeenCalled();
    });

    test('a review made WITHOUT a stored decision (an old schedule) sends with no PDF and no note, never stale', async () => {
      setGates(true);
      const result = await router.sendEstimateNow(structuredClone(row), 'email', {
        reviewedMessages: { sms: null, email: { provider: 'sendgrid' } },
      });
      expect(result.channels.email.ok).toBe(true);
      expect(docPdf.buildEstimateEmailPdfAttachment).not.toHaveBeenCalled();
      const sent = email.sendTemplate.mock.calls[0][0];
      expect(sent.attachments).toEqual([]);
      expect(sent.payload).not.toHaveProperty('estimate_pdf_note');
    });

    test('a reviewed yes that is still yes sends the file; an estimate that joined a group since the review is stale', async () => {
      setGates(true);
      const reviewed = { sms: null, email: { provider: 'sendgrid', pdfCopy: true } };
      const ok = await router.sendEstimateNow(structuredClone(row), 'email', { reviewedMessages: reviewed });
      expect(ok.channels.email).toMatchObject({ ok: true, pdfAttached: true });
      email.sendTemplate.mockClear();
      jest.spyOn(emailPdf, 'estimateInMultiPropertyGroup').mockResolvedValue(true);
      await expect(router.sendEstimateNow(structuredClone(row), 'email', { reviewedMessages: reviewed }))
        .rejects.toMatchObject({ code: 'ESTIMATE_REVIEW_STALE' });
      expect(email.sendTemplate).not.toHaveBeenCalled();
    });

    describe('SMTP fallback previews record the same decision (codex #6343 r9)', () => {
      const gate = () => require('../services/email-fallback-gate').smtpFallbackAllowed;
      let priorPassword;
      beforeEach(() => {
        priorPassword = process.env.GOOGLE_SMTP_PASSWORD;
        process.env.GOOGLE_SMTP_PASSWORD = 'synthetic-password';
        sendgrid.isConfigured.mockReturnValue(false);
        gate().mockReturnValue(true);
        row.status = 'draft';
      });
      afterEach(() => {
        gate().mockReturnValue(false);
        sendgrid.isConfigured.mockReturnValue(true);
        if (priorPassword === undefined) delete process.env.GOOGLE_SMTP_PASSWORD;
        else process.env.GOOGLE_SMTP_PASSWORD = priorPassword;
      });

      test('the SMTP preview carries pdfCopy only when true, and its content hash is the same either way', async () => {
        setGates(true);
        const on = (await invoke('/:id/send-preview', 'get')).body.messages.email;
        setGates(false);
        const off = (await invoke('/:id/send-preview', 'get')).body.messages.email;
        expect(on).toMatchObject({ provider: 'smtp', pdfCopy: true });
        expect(off.provider).toBe('smtp');
        expect(off).not.toHaveProperty('pdfCopy');
        expect(on.contentHash).toBe(off.contentHash);
        expect(on.text).toBe(off.text);
      });

      test('a reviewed SMTP send attaches the file it was reviewed with; one reviewed without the decision does not', async () => {
        setGates(true);
        const reviewed = (await invoke('/:id/send-preview', 'get')).body.messages;
        row.status = 'sending';
        const sendMail = jest.fn(async () => ({}));
        require('nodemailer').createTransport.mockReturnValueOnce({ sendMail });
        const result = await router.sendEstimateNow(structuredClone(row), 'email', { reviewedMessages: reviewed });
        expect(result.channels.email).toMatchObject({ ok: true, provider: 'smtp_fallback', pdfAttached: true });
        expect(sendMail.mock.calls[0][0].attachments).toEqual([expect.objectContaining({ filename: PDF.filename, contentType: 'application/pdf' })]);

        row.status = 'sending';
        const sendMail2 = jest.fn(async () => ({}));
        require('nodemailer').createTransport.mockReturnValueOnce({ sendMail: sendMail2 });
        const { pdfCopy: _dropped, ...withoutDecision } = reviewed.email;
        const legacy = await router.sendEstimateNow(structuredClone(row), 'email', { reviewedMessages: { ...reviewed, email: withoutDecision } });
        expect(legacy.channels.email.ok).toBe(true);
        expect(sendMail2.mock.calls[0][0].attachments).toBeUndefined();
      });
    });

    test('a sms-only send is not held up by an email PDF decision', async () => {
      setGates(false);
      const result = await router.sendEstimateNow(structuredClone(row), 'sms', {
        reviewedMessages: { sms: 'Synthetic text', email: { provider: 'sendgrid', pdfCopy: true } },
      });
      expect(email.sendTemplate).not.toHaveBeenCalled();
      expect(result.channels.sms).toBeDefined();
    });

    test('a grouped estimate: no PDF built, no note, no fence, and the review shows no note', async () => {
      setGates(true);
      jest.spyOn(emailPdf, 'estimateInMultiPropertyGroup').mockResolvedValue(true);
      row.status = 'draft';
      const preview = await invoke('/:id/send-preview', 'get');
      expect(preview.body.messages.email).not.toHaveProperty('pdfCopy');
      expect(preview.body.messages.email.text).not.toContain('Synthetic delivery PDF note.');
      row.status = 'sending';
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(docPdf.buildEstimateEmailPdfAttachment).not.toHaveBeenCalled();
      const sent = email.sendTemplate.mock.calls[0][0];
      expect(sent.attachments).toEqual([]);
      expect(sent.payload).not.toHaveProperty('estimate_pdf_note');
      expect(sent).not.toHaveProperty('withProviderHandoff');
      expect(result.channels.email.ok).toBe(true);
    });

    test('a decline landing during the render vetoes the send at the handoff', async () => {
      setGates(true);
      email.sendTemplate.mockImplementation(async ({ onQueued, withProviderHandoff }) => {
        await onQueued?.();
        try {
          await withProviderHandoff(async (_database, boundaryCheck) => { await boundaryCheck({}); });
        } catch (err) {
          return { sent: false, aborted: true, providerAttempted: false, boundaryBlocked: !!err.providerBoundaryBlocked };
        }
        return { sent: true, providerAttempted: true, providerAccepted: true, message: { provider_message_id: 'x' } };
      });
      docPdf.buildEstimateEmailPdfAttachment.mockImplementation(async () => { row.status = 'declined'; return PDF; });
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ ok: false, error: expect.stringMatching(/email was not sent/) });
    });
  });

  // codex #6343 r4 P1: the PDF is rendered from the fresh row but mailed to
  // estimate.customer_email; the handoff fence ties the two together.
  describe('recipient and content fence on the delivery PDF', () => {
    // Stand-in for sendTemplate's provider handoff: runs the caller's fence the
    // way sendOne does, and reports a veto the way sendTemplate does.
    const runFenceLikeSendTemplate = () => email.sendTemplate.mockImplementation(async ({ onQueued, withProviderHandoff }) => {
      await onQueued?.();
      if (withProviderHandoff) {
        try {
          await withProviderHandoff(async (_database, boundaryCheck) => { await boundaryCheck({}); });
        } catch (err) {
          return { sent: false, aborted: true, providerAttempted: false, boundaryBlocked: !!err.providerBoundaryBlocked, boundaryCheckFailed: !!err.providerBoundaryCheckFailed };
        }
      }
      return { sent: true, providerAttempted: true, providerAccepted: true, message: { provider_message_id: 'synthetic-email-accepted' } };
    });
    beforeEach(() => { setGates(true); runFenceLikeSendTemplate(); });

    test('nothing changed: the fence passes and the PDF goes out', async () => {
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ ok: true, pdfAttached: true });
      expect(email.sendTemplate.mock.calls[0][0].withProviderHandoff).toEqual(expect.any(Function));
    });

    test('an address corrected before the render: no PDF is built, no note, and the no-document fence stops the send to the old address', async () => {
      const stale = structuredClone(row);
      row.customer_email = 'corrected@example.invalid';
      const result = await router.sendEstimateNow(stale, 'email', { callerPreClaimed: true });
      expect(docPdf.buildEstimateEmailPdfAttachment).not.toHaveBeenCalled();
      const sent = email.sendTemplate.mock.calls[0][0];
      expect(sent.attachments).toEqual([]);
      expect(sent.payload).not.toHaveProperty('estimate_pdf_note');
      expect(sent.withProviderHandoff).toEqual(expect.any(Function));
      expect(result.channels.email).toMatchObject({ ok: false, error: expect.stringMatching(/email was not sent/) });
    });

    test('the same address in another case or with spaces still gets the PDF', async () => {
      const stale = structuredClone(row);
      stale.customer_email = ' Recipient@Example.Invalid ';
      const result = await router.sendEstimateNow(stale, 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ ok: true, pdfAttached: true });
    });

    test('an address corrected while the PDF renders vetoes the email: the channel fails with a clear error', async () => {
      docPdf.buildEstimateEmailPdfAttachment.mockImplementation(async () => { row.customer_email = 'corrected@example.invalid'; return PDF; });
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email.ok).toBe(false);
      expect(result.channels.email.error).toMatch(/changed .* while the PDF copy was being prepared; the email was not sent/);
      expect(result.channels.email.uncertain).toBeFalsy();
      expect(result.sent).toBe(false);
    });

    test('a price edit while the PDF renders vetoes the email too', async () => {
      docPdf.buildEstimateEmailPdfAttachment.mockImplementation(async () => { row.monthly_total = '150'; return PDF; });
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ ok: false, error: expect.stringMatching(/email was not sent/) });
    });

    test('a fence that cannot read fails the channel and says to try again', async () => {
      const failing = jest.fn(async ({ onQueued }) => {
        await onQueued?.();
        return { sent: false, aborted: true, providerAttempted: false, boundaryCheckFailed: true };
      });
      email.sendTemplate.mockImplementation(failing);
      const result = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(result.channels.email).toMatchObject({ ok: false, error: expect.stringMatching(/could not be re-checked .* Try sending again/) });
    });

    test('a render that returns nothing still carries a no-document fence: untouched by a content edit, stopped by a decline', async () => {
      docPdf.buildEstimateEmailPdfAttachment.mockImplementation(async () => { row.monthly_total = '150'; return null; });
      const edited = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      const sent = email.sendTemplate.mock.calls[0][0];
      expect(sent.attachments).toEqual([]);
      expect(sent.withProviderHandoff).toEqual(expect.any(Function));
      expect(edited.channels.email).toMatchObject({ ok: true, pdfAttached: false });
      row.status = 'sending';
      docPdf.buildEstimateEmailPdfAttachment.mockImplementation(async () => { row.status = 'declined'; return null; });
      const declined = await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(declined.channels.email).toMatchObject({ ok: false, error: expect.stringMatching(/email was not sent/) });
    });
  });
});

describe('delivery email monthly average (GATE_ESTIMATE_MONTHLY_AVERAGE)', () => {
  const averageService = require('../services/estimate-monthly-average');
  afterEach(() => { jest.restoreAllMocks(); });

  test('the send resolves the average from the row read just before sending, not the stale row it was handed', async () => {
    const spy = jest.spyOn(averageService, 'emailAverageParts').mockImplementation(async (estimate) => ({
      priceLine: `$94.00 per application · $${Number(estimate.monthly_total).toFixed(2)} a month`,
      note: 'Averaged over the year. You pay after each application.',
    }));
    const stale = structuredClone(row);
    stale.monthly_total = '100';
    row.monthly_total = '31.33'; // a price edit landed after the caller read the row
    await router.sendEstimateNow(stale, 'email', { callerPreClaimed: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].monthly_total).toBe('31.33');
    const sent = email.sendTemplate.mock.calls[email.sendTemplate.mock.calls.length - 1][0];
    expect(sent.payload.price_summary).toBe('$94.00 per application · $31.33 a month');
    expect(sent.payload.next_step_summary).toMatch(/^Averaged over the year\. You pay after each application\. When you are ready/);
  });
  describe('reviewed and scheduled sends keep the reviewed average copy', () => {
    const featureGates = require('../config/feature-gates');
    const PARTS = { priceLine: '$94.00 per application · $31.33 a month', note: 'Averaged over the year. You pay after each application.' };
    const TEXT = `${PARTS.priceLine}\n${PARTS.note}`;
    let current;
    let gateOn;
    beforeEach(() => {
      gateOn = true;
      current = PARTS;
      featureGates.isEnabled.mockImplementation((name) => gateOn && name === 'estimateMonthlyAverage');
      jest.spyOn(averageService, 'emailAverageParts').mockImplementation(async () => (gateOn ? current : null));
    });
    afterEach(() => { featureGates.isEnabled.mockImplementation(() => false); });

    test('the review records the exact copy, a schedule keeps it, and gate off leaves no key', async () => {
      const preview = await invoke('/:id/send-preview', 'get');
      expect(preview.body.messages.email.monthlyAverage).toBe(TEXT);
      gateOn = false;
      expect((await invoke('/:id/send-preview', 'get')).body.messages.email).not.toHaveProperty('monthlyAverage');
    });

    test('a reviewed average that is still the current one sends', async () => {
      const result = await router.sendEstimateNow(structuredClone(row), 'email', {
        reviewedMessages: { sms: null, email: { provider: 'sendgrid', monthlyAverage: TEXT } },
      });
      expect(result.channels.email.ok).toBe(true);
      expect(email.sendTemplate.mock.calls.at(-1)[0].payload.price_summary).toBe(PARTS.priceLine);
    });

    test('a price edit since the review changes the copy: stale, nothing sent', async () => {
      current = { ...PARTS, priceLine: '$94.00 per application · $35.00 a month' };
      await expect(router.sendEstimateNow(structuredClone(row), 'email', {
        callerPreClaimed: false, reviewedMessages: { sms: null, email: { provider: 'sendgrid', monthlyAverage: TEXT } },
      })).rejects.toMatchObject({ statusCode: 409, code: 'ESTIMATE_REVIEW_STALE' });
      expect(email.sendTemplate).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('an edit that lands between the early check and the email build fails the email channel stale; nothing reaches the provider', async () => {
      const edited = { ...PARTS, priceLine: '$94.00 per application · $35.00 a month' };
      // Call 1 is the early (pre-claim) check, call 2 the email build: the price changes in between.
      averageService.emailAverageParts.mockReset();
      averageService.emailAverageParts.mockResolvedValueOnce(PARTS).mockResolvedValue(edited);
      let result;
      let thrown;
      try {
        result = await router.sendEstimateNow(structuredClone(row), 'email', {
          callerPreClaimed: false, reviewedMessages: { sms: null, email: { provider: 'sendgrid', monthlyAverage: TEXT } },
        });
      } catch (err) { thrown = err; }
      expect(averageService.emailAverageParts).toHaveBeenCalledTimes(2);
      expect(email.sendTemplate).not.toHaveBeenCalled();
      const channel = result?.channels?.email || thrown?.channels?.email || thrown?.result?.channels?.email;
      expect(channel).toMatchObject({ ok: false, error: expect.stringContaining('monthly average changed before delivery') });
      expect(channel.uncertain).toBeFalsy();
    });

    test('an old review with no recorded average means "none": a send that would now add one is stale', async () => {
      await expect(router.sendEstimateNow(structuredClone(row), 'both', {
        callerPreClaimed: false, reviewedMessages: { sms: 'x', email: { provider: 'sendgrid' } },
      })).rejects.toMatchObject({ code: 'ESTIMATE_REVIEW_STALE' });
      expect(email.sendTemplate).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('a recorded average with the gate now off is stale (never silently dropped)', async () => {
      gateOn = false;
      await expect(router.sendEstimateNow(structuredClone(row), 'email', {
        callerPreClaimed: false, reviewedMessages: { sms: null, email: { provider: 'sendgrid', monthlyAverage: TEXT } },
      })).rejects.toMatchObject({ code: 'ESTIMATE_REVIEW_STALE' });
      expect(email.sendTemplate).not.toHaveBeenCalled();
    });

    test('an old review with no record and no average now sends as before; an unreviewed send uses the current value', async () => {
      gateOn = false;
      const old = await router.sendEstimateNow(structuredClone(row), 'email', {
        reviewedMessages: { sms: null, email: { provider: 'sendgrid' } },
      });
      expect(old.channels.email.ok).toBe(true);
      expect(email.sendTemplate.mock.calls.at(-1)[0].payload.next_step_summary).not.toContain('Averaged over the year');
      gateOn = true;
      await router.sendEstimateNow(structuredClone(row), 'email', { callerPreClaimed: true });
      expect(email.sendTemplate.mock.calls.at(-1)[0].payload.price_summary).toBe(PARTS.priceLine);
    });

    test('a text-only send and an SMTP review are never stale on this account', async () => {
      const textOnly = await router.sendEstimateNow(structuredClone(row), 'sms', { reviewedMessages: { sms: 'x', email: null } });
      expect(textOnly.channels.sms.ok).toBe(true);
      const smtp = await router.sendEstimateNow(structuredClone(row), 'email', { reviewedMessages: { sms: null, email: { provider: 'smtp' } } }).catch((e) => e);
      expect(smtp?.code).not.toBe('ESTIMATE_REVIEW_STALE');
    });
  });
});
