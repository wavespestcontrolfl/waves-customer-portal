/**
 * WDO report hold (GATE_WDO_REPORT_HOLD): "your report is sent once payment is received".
 * Owner 2026-11-24, a smaller return of the hold removed in #6928.
 *
 *  1. The gate: off = today's send-with-invoice, exactly.
 *  2. The hold send (/send-with-invoice hold_report_until_paid): the invoice and pay link go out, no report
 *     artifact or link moves, the hold is stamped, and refusals (after first send, payer/statement billed, $0).
 *  3. The release (releaseHeldProjectReport): fires only on a paid or prepaid invoice, re-runs the signature
 *     checks, sends the report through the /send steps, and a failure bells once.
 *  4. Manual send is an early release and shares the delivery claim with the sweep.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();
const mockGates = { hold: true, payerStatements: false };

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  mock.transaction = jest.fn(async (cb) => cb(mock));
  return mock;
});
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'payerStatements' ? mockGates.payerStatements : true)),
  wdoReportHoldLive: jest.fn(() => mockGates.hold),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'bell-1' })),
}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/pay-combined', () => ({
  lockCombinedCustomerStable: jest.fn(async () => {}),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));
jest.mock('../services/admin-alert-episodes', () => ({
  closeAdminAlertKeys: jest.fn(async () => 1),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  isStaffAccessToken: () => false,
  staffTokenVersionMatches: () => false,
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
  classifyDeliveryCertainty: (o) => (o?.deliveryOutcome === 'not_sent' || o?.blocked === true ? 'not_sent' : (o?.deliveryOutcome === 'accepted' ? 'sent' : 'unknown')),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async (_key, vars) => `Hi ${vars.first_name}, your Waves ${vars.project_type} report is ready: ${vars.report_url}`),
}));
jest.mock('../services/project-email', () => ({
  dispatchBoundaryCheck: jest.fn(async () => true),
  reportEmailSuppressed: jest.fn(async () => false),
  PREP_TEMPLATE_BY_PROJECT_TYPE: {},
  resolveProjectEmailRecipient: jest.fn((customer = {}) => ({
    email: customer.email || '',
    name: customer.first_name || '',
    role: 'primary',
  })),
  resolveProjectEmailRecipientForSend: jest.fn(async (customer = {}) => ({
    email: customer.email || '',
    name: customer.first_name || '',
    role: 'primary',
  })),
  resolvePortalInviteRecipient: jest.fn((customer = {}) => ({
    email: customer.email || '',
    name: customer.first_name || '',
    role: 'primary',
  })),
  sendProjectReportReady: jest.fn(async () => ({ ok: true, messageId: 'sg-report' })),
  sendProjectReportWithInvoice: jest.fn(async () => ({ ok: true, messageId: 'sg-combined' })),
  sendProjectInvoiceBeforeReport: jest.fn(async () => ({ ok: true, messageId: 'sg-invoice-hold' })),
  sendPrepGuide: jest.fn(async () => ({ ok: true })),
  sendPortalInvite: jest.fn(async () => ({ ok: true })),
  prepTemplateForProjectType: jest.fn(() => null),
  isPrepTemplateKey: jest.fn(() => false),
}));
jest.mock('../services/invoice', () => ({
  markDeliverySent: jest.fn(async () => ({})),
  previewInvoiceTotals: jest.fn(async () => ({ total: 175 })),
  buildLineItemsForScheduledService: jest.fn(async () => ({
    lineItems: [{ description: 'Pre-treatment termite service', quantity: 1, unit_price: 425, amount: 425 }],
    discountIds: [],
  })),
  update: jest.fn(async () => null),
  create: jest.fn(async () => ({ id: 'inv-new' })),
}));
jest.mock('../services/customer-credit', () => ({
  getBalance: jest.fn(async () => 0),
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
  reverseAppliedCredit: jest.fn(async () => ({ reversed: 0 })),
  postCreditMovement: jest.fn(async () => {}),
  runPostFullCoverageSideEffects: jest.fn(async () => {}),
  round2: (n) => Math.round(Number(n || 0) * 100) / 100,
}));
jest.mock('../services/billing-channel-email-authority', () => ({
  ...jest.requireActual('../services/billing-channel-email-authority'),
  dispatchUnderBillingEmailAuthority: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/collections/collection-hold', () => ({
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
  holdExemptionApplies: jest.fn((exempt) => exempt === 'operator' || exempt === 'customer'),
}));
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async () => {}),
  payerRecipient: jest.fn(() => null),
  resolveForInvoice: jest.fn(async () => null),
  freezeApEmail: jest.fn(async () => {}),
  isNetPaymentTerm: jest.fn((t) => ['net15', 'net30', 'net60'].includes(t)),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('invoice-pdf')),
}));
jest.mock('../services/pdf/wdo-report-pdf', () => ({
  buildWdoReportPDFBuffer: jest.fn(async () => Buffer.from('wdo-pdf')),
}));
jest.mock('../services/pdf/addendum-photo', () => ({
  normalizeAddendumPhoto: jest.fn(async () => null),
}));
jest.mock('../services/project-completion', () => ({
  buildProjectCloseoutPreview: jest.fn(async () => null),
  completeProjectBackedService: jest.fn(async () => ({})),
  completionTechnicianNotes: jest.requireActual('../services/project-completion').completionTechnicianNotes,
  resolveProjectPortalAttachment: jest.fn(async () => ({
    portalAttached: false,
    portalAttachReason: 'policy_not_met',
    completionProfile: null,
  })),
}));
jest.mock('../services/project-report-links', () => ({
  FULL_TOKEN_RE: /^[a-f0-9]{32}$/i,
  extractProjectReportTokenLookup: (segment) => {
    const value = String(segment || '').toLowerCase();
    return /^[a-f0-9]{32}$/.test(value) ? { type: 'full', value } : null;
  },
  projectReportPathForProject: jest.fn(async (_db, project) => `/report/project/${project.report_token || 'tok'}`),
}));
jest.mock('../services/report-followup-appointment', () => ({
  findReportFollowupAppointment: jest.fn(async () => null),
}));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ __put: input })),
  GetObjectCommand: jest.fn((input) => ({ __get: input })),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/object'),
}));
jest.mock('sharp', () => jest.fn(() => ({
  stats: jest.fn().mockResolvedValue({ channels: [{ stdev: 25 }] }),
})));

const crypto = require('crypto');
const express = require('express');
const db = require('../models/db');
const ProjectEmail = require('../services/project-email');
const InvoiceService = require('../services/invoice');
const NotificationService = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const PayerService = require('../services/payer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { buildWdoReportPDFBuffer } = require('../services/pdf/wdo-report-pdf');
const logger = require('../services/logger');
const projectsRouter = require('../routes/admin-projects');
const { releaseHeldProjectReport } = projectsRouter;

const HOLD_COLUMNS = {
  wdo_signature: {},
  wdo_sent_filings: {},
  portal_visible: {},
  portal_visibility: {},
  portal_attach_policy: {},
  completion_profile_snapshot: {},
  report_hold_status: {},
  report_hold_at: {},
  report_hold_released_at: {},
  report_hold_release_source: {},
  report_hold_attempts: {},
  report_hold_next_attempt_at: {},
  report_hold_locked_at: {},
  report_hold_last_error: {},
};

function chain(overrides = {}) {
  const resolvesTo = 'resolvesTo' in overrides ? overrides.resolvesTo : [];
  const c = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    join: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    forShare: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
    returning: jest.fn().mockResolvedValue([]),
    columnInfo: jest.fn().mockResolvedValue(HOLD_COLUMNS),
    // Some call sites `await` or `.catch()` the builder itself (photo loads);
    // make the chain thenable so those resolve to a configurable value.
    then: (onFulfilled, onRejected) => Promise.resolve(resolvesTo).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(resolvesTo).catch(onRejected),
  };
  delete overrides.resolvesTo;
  return Object.assign(c, overrides);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/projects', projectsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

// Binds the loopback address the test fetches. A wildcard listen(0) can be handed a port that another process
// (a dev server, another jest run) already holds on 127.0.0.1; the fetch then reaches THAT server and the
// test fails with a foreign "not found" body. Waits for 'listening' before reading the port.
async function withServer(fn) {
  const server = await new Promise((resolve, reject) => {
    const listening = buildApp().listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Mirror of wdoContentHash in routes/admin-projects.js (deliberately
// duplicated — see wdo-signature-binding.test.js). The hash covers the
// CUSTOMER-SAFE findings (internal-key strip + fee-cue scrub) — the same
// representation the FDACS PDF renders (codex #2817).
function expectedContentHash(findings, projectDate) {
  const { stripInternalFindingKeys } = require('../services/project-types');
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = stable(value[key]);
        return acc;
      }, {});
    }
    return value;
  };
  const { projectRecordedFeeValues } = require('../services/project-types');
  const payload = JSON.stringify({ findings: stable(stripInternalFindingKeys(findings, { redactValues: true, feeValues: projectRecordedFeeValues({ findings }), freeTextKeys: require('../services/project-types').projectTypeFreeTextKeys('wdo_inspection') }) || {}), project_date: projectDate });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const PNG_DATA_URL = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]).toString('base64')}`;

const FINDINGS = {
  wdo_finding: 'Visible evidence of WDO observed',
  wdo_evidence: 'Frass at garage door frame',
  property_address: '456 Palm Dr, Sarasota, FL 34236',
  inspection_scope: 'Interior, attic access, exterior perimeter',
  inspection_fee: '175',
  applicator_name: 'Adam B',
  applicator_fdacs_id: 'JF111111',
  report_sent_to: 'ABC Title <closing@abctitle.com>',
};

function wdoProject(overrides = {}) {
  const findings = overrides.findings || FINDINGS;
  return {
    id: 'project-1',
    project_type: 'wdo_inspection',
    customer_id: 'customer-1',
    status: 'review',
    project_date: '2026-06-10',
    // an open project has no report token: only a send or a closeout mints one
    report_token: null,
    portal_visible: false,
    invoice_id: 'inv-1',
    findings,
    wdo_signature: JSON.stringify({
      image: PNG_DATA_URL,
      signer_name: 'Adam B',
      content_hash: expectedContentHash(findings, '2026-06-10'),
    }),
    report_hold_attempts: 0,
    ...overrides,
  };
}

const CUSTOMER = {
  id: 'customer-1',
  email: 'cust@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '9415550101',
};

// The held send's invoice claim token (crypto.randomUUID is pinned to it below): a row read at a handoff carries this
// send's claim unless a test says otherwise.
const INVOICE_CLAIM = '00000000-0000-4000-8000-00000000c1a1';
function invoiceRow(overrides = {}) {
  return {
    send_claim_token: INVOICE_CLAIM,
    id: 'inv-1',
    customer_id: 'customer-1',
    invoice_number: 'WPC-1001',
    status: 'draft',
    total: 175,
    token: 'invtok123',
    title: 'WDO inspection — manual',
    line_items: [{ description: 'WDO inspection', quantity: 1, unit_price: 175, amount: 175 }],
    ...overrides,
  };
}

function mockTables({
  project = wdoProject(),
  invoice = invoiceRow(),
  customer = CUSTOMER,
  invoiceFirstResults = null,
  updates = {},
  projectUpdateResult = null,
  paymentStarted = null,
} = {}) {
  const activityRows = [];
  const recordUpdate = (table) => jest.fn(async (payload) => {
    (updates[table] = updates[table] || []).push(payload);
    if (table === 'projects' && projectUpdateResult) return projectUpdateResult(payload);
    return 1;
  });
  const projectUpdate = recordUpdate('projects');
  const invoiceUpdate = recordUpdate('invoices');
  const queuedInvoiceFirstResults = Array.isArray(invoiceFirstResults)
    ? [...invoiceFirstResults]
    : null;
  db.mockImplementation((table) => {
    if (table === 'projects' || table === 'projects as p') {
      return chain({ first: jest.fn(async () => project), update: projectUpdate });
    }
    if (table === 'invoices') {
      return chain({
        first: jest.fn(async () => (
          queuedInvoiceFirstResults?.length ? queuedInvoiceFirstResults.shift() : invoice
        )),
        update: invoiceUpdate,
      });
    }
    if (table === 'customers') return chain({ first: jest.fn(async () => customer) });
    // arming reads the invoice's payment rows and charge attempts (any one refuses the hold)
    if (table === 'payments') return chain({ first: jest.fn(async () => (paymentStarted === 'payment' ? { id: 'pay-1' } : null)) });
    if (table === 'stripe_invoice_charge_attempts') return chain({ first: jest.fn(async () => (paymentStarted === 'attempt' ? { id: 'att-1' } : null)) });
    if (table === 'notification_prefs') return chain({ first: jest.fn(async () => null) });
    if (table === 'project_photos') return chain({ resolvesTo: [] });
    if (table === 'technicians') return chain({ first: jest.fn(async () => null) });
    if (table === 'activity_log') return chain({ insert: jest.fn(async (row) => { activityRows.push(row); return [1]; }) });
    if (table === 'service_records') return chain();
    // The non-WDO mint locks the visit row before building lines
    // (mint-serialization, codex #3344 r2); chain() carries forUpdate and a
    // truthy first() row for the lock read.
    if (table === 'scheduled_services') {
      return chain({ first: jest.fn(async () => ({ id: 'sched-55' })) });
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  db.transaction.mockImplementation(async (cb) => cb(db));
  return { updates, activityRows };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(require('crypto'), 'randomUUID').mockReturnValue(INVOICE_CLAIM);
  db.fn.now.mockReturnValue('NOW');
  db.raw.mockImplementation((sql, bindings) => ({ sql, bindings }));
  mockGates.hold = true;
  mockGates.payerStatements = false;
  // clearAllMocks keeps implementations: put the default send-time recipient back after a test replaced it
  ProjectEmail.resolveProjectEmailRecipientForSend.mockImplementation(async (customer = {}) => ({ email: customer.email || '', name: customer.first_name || '', role: 'primary' }));
});


const SEND_WITH_INVOICE = (id = 'project-1') => `/admin/projects/${id}/send-with-invoice`;

function post(baseUrl, path, body = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A held send carries the fingerprint of the invoice the operator confirmed (the default invoice row's, unless a test
// passes its own).
const holdBodyFor = (extra = {}) => ({
  hold_report_until_paid: true, invoice_id: 'inv-1',
  expected_billing_fingerprint: projectsRouter._private.billingFingerprintHash(invoiceRow()), ...extra,
});
// A resend of a report already held: the preview's fingerprint says the report was held when the operator saw it.
const heldResendBodyFor = (extra = {}) => holdBodyFor({
  expected_billing_fingerprint: projectsRouter._private.billingFingerprintHash(invoiceRow(), true), ...extra,
});

describe('gate off: today\'s behavior exactly', () => {
  beforeEach(() => { mockGates.hold = false; });

  test('a hold request is refused and nothing is sent or written', async () => {
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('hold_not_enabled');
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(updates.projects || []).toHaveLength(0);
    });
  });

  test('send-with-invoice without the flag is the normal combined send: no hold column is written', async () => {
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { invoice_id: 'inv-1' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      expect(body).not.toHaveProperty('report_held');
      expect(ProjectEmail.sendProjectReportWithInvoice).toHaveBeenCalledTimes(1);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      const touched = (updates.projects || []).filter((u) => Object.keys(u).some((k) => k.startsWith('report_hold_')));
      expect(touched).toEqual([]);
      expect((updates.projects || []).every((u) => u.report_token !== null)).toBe(true);
    });
  });

  test('the dry run carries no hold keys', async () => {
    mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, invoice_id: 'inv-1' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).not.toHaveProperty('report_hold');
      expect(body).not.toHaveProperty('report_hold_available');
    });
  });
});

describe('send-with-invoice hold_report_until_paid', () => {
  test('prepare_invoice never arms a hold', async () => {
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { prepare_invoice: true, hold_report_until_paid: true, invoice_id: 'inv-1' });
      expect(res.status).toBe(200);
      expect(updates.projects || []).toHaveLength(0);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });
  });

  test('self-pay hold: invoice-only delivery, hold stamped, no report link or artifact', async () => {
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      expect(body.report_held).toBe(true);
      expect(body.report_url).toBeNull();

      // Invoice-before-report email only, never the report templates.
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).toHaveBeenCalledTimes(1);
      const emailArgs = ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0];
      expect(emailArgs.payUrl).toContain('/pay/invtok123');
      expect(emailArgs.attachments).toHaveLength(1); // invoice PDF only
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();

      // No report artifact moved: no FDACS build, no S3 filing archive, no realtor copy.
      expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();

      // The text carries the pay link and the promise, never the report link.
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const sms = sendCustomerMessage.mock.calls[0][0];
      expect(sms.entryPoint).toBe('admin_project_report_with_invoice');
      expect(sms.body).toContain('/pay/invtok123');
      expect(sms.body).toContain('emailed automatically as soon as it\'s paid');
      expect(sms.body).not.toContain('/report/project');

      expect(InvoiceService.markDeliverySent).toHaveBeenCalledWith('inv-1', expect.any(Object));
      const projectUpdates = updates.projects || [];
      const holdStamp = projectUpdates.find((u) => u.report_hold_status === 'held');
      expect(holdStamp).toBeTruthy();
      // No report link is minted or written: the project had none (a hold refuses one that exists).
      expect(holdStamp).not.toHaveProperty('report_token');
      expect(holdStamp.invoice_id).toBe('inv-1');
      expect(holdStamp.report_hold_attempts).toBe(0);
      // Not sent: no sent stamp, no portal visibility, no link anywhere in any write.
      expect(projectUpdates.some((u) => u.sent_at || 'status' in u)).toBe(false);
      expect(projectUpdates.some((u) => 'portal_visible' in u)).toBe(false);
      expect(projectUpdates.some((u) => typeof u.report_token === 'string')).toBe(false);
    });
  });

  test('the hold dry run lists who the paid report will go to (the release recipient, then the named requestors, same exclusion rule)', async () => {
    const findings = { ...FINDINGS, report_sent_to: 'Holder <holder@example.com>, ABC Title <closing@abctitle.com>' };
    mockTables({ project: wdoProject({ findings }) });
    ProjectEmail.resolveProjectEmailRecipientForSend.mockResolvedValue({ email: 'holder@example.com', name: 'Holder', role: 'primary' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true, invoice_id: 'inv-1' });
      const body = await res.json();
      expect(body.report_hold_release).toEqual({ recipient: 'holder@example.com', copies: ['closing@abctitle.com'] });
      // the confirm's own invoice recipient is the one the held invoice email really uses: the billing recipient, no copy
      expect(body.email_routing.recipient).toBe(CUSTOMER.email);
      expect(body.email_routing.billing_copy).toBeNull();
    });
  });

  test('the dry run reports whether a hold is available', async () => {
    mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true, invoice_id: 'inv-1' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.report_hold).toBe(true);
      expect(body.report_hold_available).toBe(true);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });
    mockTables({ invoice: invoiceRow({ payer_id: 'payer-1' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, invoice_id: 'inv-1' });
      const body = await res.json();
      expect(body.report_hold_available).toBe(false);
    });
  });

  describe('refusals', () => {
    async function expectRefusal({ project, invoice, body = holdBodyFor(), status = 422, code }) {
      const { updates } = mockTables({ project, invoice });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), body);
        const json = await res.json();
        expect(res.status).toBe(status);
        expect(json.code).toBe(code);
        expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
        expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
        expect(sendCustomerMessage).not.toHaveBeenCalled();
        expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
      });
    }

    test('an ordinary (non-WDO) project', () => expectRefusal({
      project: wdoProject({ project_type: 'pest_inspection', wdo_signature: null }),
      code: 'hold_not_supported',
    }));

    test('a report already sent (hold_after_send)', () => expectRefusal({
      project: wdoProject({ status: 'sent', sent_at: '2026-07-01T00:00:00Z' }),
      code: 'hold_after_send',
    }));

    test('a release already running', () => expectRefusal({
      project: wdoProject({ report_hold_status: 'releasing' }),
      status: 409,
      code: 'release_in_progress',
    }));

    test('a third-party (payer-billed) invoice', () => expectRefusal({
      invoice: invoiceRow({ payer_id: 'payer-1' }),
      code: 'hold_payer_billed',
    }));

    test('a statement-accrued invoice', () => expectRefusal({
      invoice: invoiceRow({ payer_statement_id: 'stmt-1' }),
      code: 'hold_statement_accrued',
    }));

    test('an invoice with nothing to pay ($0 total)', () => expectRefusal({
      invoice: invoiceRow({ total: 0 }),
      code: 'hold_no_charge',
    }));

    test('a recorded $0 inspection fee (no-charge WDO)', () => expectRefusal({
      project: wdoProject({ findings: { ...FINDINGS, inspection_fee: '0' } }),
      status: 409,
      code: 'wdo_no_charge',
    }));

    test.each(['net30', 'net60'])('a would-be statement-accrued invoice (%s) is refused BEFORE it is created', async (terms) => {
      mockGates.payerStatements = true;
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1', paymentTerms: terms, snapshot: { company_name: 'ABC Title' } });
      mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true });
        const body = await res.json();
        expect(res.status).toBe(422);
        expect(body.code).toBe('hold_statement_accrued');
        expect(InvoiceService.create).not.toHaveBeenCalled();
      });
    });

    test('a would-be third-party invoice is refused BEFORE it is created', async () => {
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1', paymentTerms: 'due_on_receipt', snapshot: { company_name: 'ABC Title' } });
      mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true });
        const body = await res.json();
        expect(res.status).toBe(422);
        expect(body.code).toBe('hold_payer_billed');
        expect(InvoiceService.create).not.toHaveBeenCalled();
      });
    });
  });

  test('a failed invoice email takes the hold it armed back (the report was never promised)', async () => {
    ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, reason: 'blocked' });
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(false);
      expect(body.report_held).toBe(false);
      const projectUpdates = updates.projects || [];
      // The hold is stamped BEFORE any message (a crash after the email still leaves a held report) ...
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      const revertIdx = projectUpdates.findIndex((u) => 'report_hold_status' in u && u.report_hold_status === null);
      expect(stampIdx).toBeGreaterThanOrEqual(0);
      // ... and taken back when the invoice never went out.
      expect(revertIdx).toBeGreaterThan(stampIdx);
      expect((updates.invoices || []).some((u) => u.status === 'draft')).toBe(true);
    });
  });

  test('re-sending the invoice of an already-held report keeps the hold (no re-stamp)', async () => {
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_hold_attempts: 2 }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), heldResendBodyFor());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.report_held).toBe(true);
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
      expect((updates.projects || []).some((u) => 'report_hold_status' in u && u.report_hold_status === null)).toBe(false);
    });
  });
});

describe('releaseHeldProjectReport', () => {
  test.each([['paid'], ['prepaid']])('delivers the held report once the invoice is %s', async (status) => {
    const project = wdoProject({ report_hold_status: 'held' });
    const { updates, activityRows } = mockTables({ project, invoice: invoiceRow({ status }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(true);
    const projectUpdates = updates.projects || [];
    // The release takes the SHARED delivery claim with the hold claim, in one update, before anything is sent.
    expect(projectUpdates[0]).toEqual(expect.objectContaining({
      report_hold_status: 'releasing',
      delivery_status: 'sending',
      delivery_claim_token: expect.any(String),
    }));
    const releasedStamp = projectUpdates.find((u) => u.report_hold_status === 'released');
    expect(releasedStamp).toBeTruthy();
    // sent unless a closeout committed during delivery: decided in the write itself
    expect(releasedStamp.status.sql).toBe("CASE WHEN status = 'closed' THEN status ELSE 'sent' END");
    expect(releasedStamp.sent_at).toBeTruthy();
    expect(releasedStamp.report_hold_release_source).toBe('payment_sweep');
    expect(releasedStamp.delivery_claim_token).toBeNull();
    // A link is minted at the release (a held send minted none).
    expect(projectUpdates.some((u) => typeof u.report_token === 'string')).toBe(true);
    // The filing is archived and appended atomically; the email carries the FDACS PDF.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(releasedStamp.wdo_sent_filings).toEqual(expect.objectContaining({
      sql: expect.stringContaining("coalesce(wdo_sent_filings, '[]'::jsonb)"),
    }));
    expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalledTimes(2); // customer + realtor copy
    expect(ProjectEmail.sendProjectReportReady.mock.calls[0][0].attachments).toHaveLength(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain('/report/project/');
    // No bell for a good release; any earlier failure bell is closed.
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // ...and the uncertain-invoice-email bell too: once the report is out nobody needs to check the invoice email
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(db, ['wdo-report-hold-release:project-1', 'wdo-report-hold-invoice-email:project-1'], 'wdo_report_released', expect.any(Object));
    const activity = activityRows.find((row) => row.action === 'project_report_released_after_payment');
    expect(activity.metadata.report_token).toBeUndefined();
  });

  test.each([['processing'], ['sent'], ['viewed'], ['overdue'], ['draft']])(
    'does not release while the invoice is %s (ACH in flight or unpaid), and burns no attempt',
    async (status) => {
      const project = wdoProject({ report_hold_status: 'held' });
      const { updates } = mockTables({ project, invoice: invoiceRow({ status, amount_paid: status === 'sent' ? 50 : 0 }) });

      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

      expect(result).toEqual({ released: false, reason: 'invoice_not_settled' });
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).toBeTruthy();
      expect(revert.report_hold_attempts).toBe(0);
      expect(revert.delivery_claim_token).toBeNull();
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    },
  );

  test('does nothing when the claim is lost (not held any more, or a send holds the delivery claim)', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'held' }),
      invoice: invoiceRow({ status: 'paid' }),
      projectUpdateResult: (payload) => (payload.report_hold_status === 'releasing' ? 0 : 1),
    });
    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
    expect(result).toEqual({ released: false, reason: 'not_held_or_busy' });
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed release (findings edited after signing) goes back to held and rings ONE bell', async () => {
    const project = wdoProject({ report_hold_status: 'held' });
    project.wdo_signature = JSON.stringify({ image: PNG_DATA_URL, signer_name: 'Adam B', content_hash: 'stale-hash-mismatch' });
    const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(false);
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
    expect(revert.report_hold_attempts).toBe(1);
    expect(revert.report_hold_last_error).toMatch(/re-sign/i);
    expect(revert.report_hold_next_attempt_at).toBeInstanceOf(Date);
    expect(revert.delivery_claim_token).toBeNull();
    // One bell, through the admin alert rules (area, subject, done-when), with the project link and a per-project key.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('wdo_report_hold');
    expect(headline).toMatch(/^Customers — send Jane Doe the (paid )?(WDO )?report/);
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(why).toBe('The invoice is paid but the held report did not send.');
    expect(opts).toEqual(expect.objectContaining({
      bell: true,
      dedupeKey: 'wdo-report-hold-release:project-1',
      link: '/admin/projects?projectId=project-1',
    }));
    expect(opts.detail).toMatch(/re-sign/i);
    expect(opts.metadata).toEqual(expect.objectContaining({ doneWhen: 'report_sent', who: 'person', area: 'Customers', severity: 'needs-you' }));
  });

  test('later failed attempts of the same hold do not ring again', async () => {
    // the first failure's bell was recorded (the marker on the row): later failures stay quiet
    const project = wdoProject({ report_hold_status: 'held', report_hold_attempts: 1, delivery_channels: { release_bell: true } });
    project.wdo_signature = JSON.stringify({ image: PNG_DATA_URL, signer_name: 'Adam B', content_hash: 'stale-hash-mismatch' });
    const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(false);
    expect((updates.projects || []).find((u) => u.report_hold_status === 'held').report_hold_attempts).toBe(2);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed report email reverts to held and rings one bell, with no text and no copies', async () => {
    ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, reason: 'blocked' });
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(false);
    expect(result.reason).toMatch(/Report email failed/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalledTimes(1);
    expect((updates.projects || []).find((u) => u.report_hold_status === 'held').report_hold_attempts).toBe(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a customer with no email keeps the paid report held (the FDACS PDF is email only)', async () => {
    const { updates } = mockTables({
      project: wdoProject({ report_hold_status: 'held' }),
      invoice: invoiceRow({ status: 'paid' }),
      customer: { ...CUSTOMER, email: '' },
    });
    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
    expect(result.released).toBe(false);
    expect(result.reason).toMatch(/No email/);
    expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(true);
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
  });
});

describe('manual send releases a held report early, and never races the sweep', () => {
  test('/send on a HELD report clears the hold in the same write as the sent stamp', async () => {
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      const projectUpdates = updates.projects || [];
      // The shared delivery claim is the only claim: a sweep release cannot start while it is held.
      expect(projectUpdates[0].delivery_status).toBe('sending');
      const released = projectUpdates.find((u) => u.report_hold_status === 'released');
      expect(released).toBeTruthy();
      // sent unless a closeout committed meanwhile: decided in the write itself
      expect(released.status.sql).toBe("CASE WHEN status = 'closed' THEN status ELSE 'sent' END");
      expect(released.report_hold_release_source).toBe('manual_send');
      expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalled();
    });
  });

  test('/send on a HELD report that delivers nothing unpublishes the link it minted (still held, unpaid, no live link)', async () => {
    ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'rejected by provider' });
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: null, invoice_id: 'inv-1' }) });
    await withServer(async (baseUrl) => { await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' }); });
    const projectUpdates = updates.projects || [];
    const minted = projectUpdates.find((u) => typeof u.report_token === 'string');
    expect(minted?.portal_visible).toBe(false);
    const finalize = projectUpdates.find((u) => u.delivery_claim_token === null && 'delivery_status' in u && u.delivery_status !== 'sending');
    expect(finalize).toEqual(expect.objectContaining({ report_token: null }));
  });

  test('/send on a HELD report of a CLOSED project releases it and keeps the closed status', async () => {
    const { updates } = mockTables({ project: wdoProject({ status: 'closed', report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' });
      expect(res.status).toBe(200);
      const released = (updates.projects || []).find((u) => u.report_hold_status === 'released');
      expect(released).toBeTruthy();
      expect(released.status.sql).toBe("CASE WHEN status = 'closed' THEN status ELSE 'sent' END");
    });
  });

  test('/send on a held report that is NOT held writes no hold columns', async () => {
    const { updates } = mockTables({ project: wdoProject() });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/send');
      expect(res.status).toBe(200);
      expect((updates.projects || []).some((u) => Object.keys(u).some((k) => k.startsWith('report_hold_')))).toBe(false);
    });
  });

  test('/send 409s while the sweep holds the delivery claim, and delivers nothing', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'releasing', delivery_status: 'sending' }),
      projectUpdateResult: (payload) => (payload.delivery_status === 'sending' ? 0 : 1),
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('send_in_progress');
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  test('/send dry run says it releases a held report', async () => {
    mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/send', { dry_run: true });
      const body = await res.json();
      expect(body.releases_payment_hold).toBe(true);
    });
  });

  test('send-with-invoice without the hold flag on a held project refuses: a held report goes out only through the release', async () => {
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { invoice_id: 'inv-1' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('hold_use_send_report');
    });
    expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
    expect((updates.projects || []).some((u) => u.report_hold_status === 'released')).toBe(false);
  });

  test('a plain send (Send report, or report + invoice without the hold) claims no report that became held after its read', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
    expect(source).toContain("if ('report_hold_status' in project) sendClaimQuery.whereRaw(\"coalesce(report_hold_status, '') NOT IN ('held', 'releasing')\");");
    expect(source).toContain(`false: "coalesce(report_hold_status, '') NOT IN ('held', 'releasing')",`);
  });

  test('GET /:id offers the hold only while the gate is on, for an unsent WDO', async () => {
    const offer = async (patch = {}) => {
      mockTables({ project: wdoProject(patch) });
      const out = await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/projects/project-1`, { headers: { Authorization: 'Bearer admin' } });
        return res.json();
      });
      return out.project?.report_payment_hold_available;
    };
    mockGates.hold = true;
    expect(await offer()).toBe(true);
    // the drawer reads the same shared-link predicate as arming: a viewed or shown report is not offered
    expect(await offer({ report_viewed_at: '2026-06-11T10:00:00Z' })).toBe(false);
    expect(await offer({ portal_visible: true })).toBe(false);
    mockGates.hold = false;
    expect(await offer()).toBeUndefined();
  });
});

describe('Sent another way on a held report', () => {
  test('clears the hold (the report must not be sent again when it is paid)', async () => {
    mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    const base = db.getMockImplementation();
    const writes = [];
    let projectCalls = 0;
    db.mockImplementation((table) => {
      if (table !== 'projects') return base(table);
      projectCalls += 1;
      if (projectCalls === 1) return base(table);
      const write = chain({
        update: jest.fn((payload) => { writes.push(payload); return write; }),
        returning: jest.fn(async () => [{ sent_outside_portal_at: 'NOW', sent_outside_portal_by: 'admin-1', sent_outside_portal_note: null }]),
      });
      return write;
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/mark-sent-outside', { note: 'Emailed by hand' });
      expect(res.status).toBe(200);
      // Decided per row inside the UPDATE (not from the read): only a row that is held right then is released.
      expect(writes[0].sent_outside_portal_at).toBe('NOW');
      expect(writes[0].report_hold_status).toEqual({ sql: "CASE WHEN report_hold_status = 'held' THEN 'released' ELSE report_hold_status END", bindings: [] });
      expect(writes[0].report_hold_release_source).toEqual({ sql: "CASE WHEN report_hold_status = 'held' THEN ? ELSE report_hold_release_source END", bindings: ['sent_outside'] });
    });
  });

  test('refuses while the sweep is releasing it', async () => {
    mockTables({ project: wdoProject({ report_hold_status: 'releasing' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/mark-sent-outside', {});
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('release_in_progress');
    });
  });
});


// Pre-push audit (Codex, 2 P0 + 5 P1): each case below fails on the code before its fix.
describe('audit fixes', () => {
  const PayCombined = require('../services/pay-combined');

  // Wraps the mocked db so every projects write also records the whereRaw guards it was sent with.
  function trackProjectWrites() {
    const base = db.getMockImplementation();
    const writes = [];
    db.mockImplementation((table) => {
      const c = base(table);
      if (table === 'projects') {
        const raws = [];
        const originalUpdate = c.update;
        c.whereRaw = jest.fn((sql, bindings) => { raws.push({ sql, bindings }); return c; });
        c.update = jest.fn(async (payload) => { writes.push({ payload, raws: [...raws] }); return originalUpdate(payload); });
      }
      return c;
    });
    return writes;
  }

  describe('P0: a live hold stays bound to the invoice the customer received', () => {
    test('a refused request that resolved another invoice does not retarget the hold (the link write is guarded in the update itself)', async () => {
      mockTables({
        project: wdoProject({ report_hold_status: 'held' }),
        invoice: invoiceRow({ id: 'inv-2', status: 'paid' }),
      });
      const writes = trackProjectWrites();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, invoice_id: 'inv-2' });
        expect(res.status).toBe(409);
      });
      // a plain request on a held report is refused before any invoice is resolved: nothing is retargeted
      expect(writes.find((w) => w.payload.invoice_id === 'inv-2')).toBeUndefined();
    });

    test('a hold request on a held project with another invoice is refused', async () => {
      mockTables({
        project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }),
        invoice: invoiceRow({ id: 'inv-2', status: 'draft' }),
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ invoice_id: 'inv-2' }));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.code).toBe('hold_invoice_locked');
        expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      });
    });
  });

  describe('P0: a hold never clears a report link that already went out', () => {
    test.each([
      ['a migrated legacy_sent report', { delivery_status: 'legacy_sent', status: 'closed' }],
      ['a report marked sent another way', { sent_outside_portal_at: '2026-10-01T00:00:00Z' }],
    ])('%s is refused (hold_after_send) and its link is kept', async (_name, overrides) => {
      const { updates } = mockTables({ project: wdoProject(overrides) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_after_send');
      });
      expect((updates.projects || []).some((u) => u.report_token === null)).toBe(false);
    });

    test('the hold stamp itself requires an unsent report, so a send that finished after the preflight is protected', async () => {
      mockTables();
      const writes = trackProjectWrites();
      await withServer(async (baseUrl) => {
        await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
      });
      const stamp = writes.find((w) => w.payload.report_hold_status === 'held');
      expect(stamp.raws.map((r) => r.sql).join(' ')).toMatch(/sent_at IS NULL AND sent_outside_portal_at IS NULL/);
    });

    test('a lost stamp (the report was sent in between) sends nothing and keeps the link', async () => {
      const { updates } = mockTables({ projectUpdateResult: (payload) => (payload.report_hold_status === 'held' ? 0 : 1) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((updates.projects || []).every((u) => u.report_token !== undefined ? u.report_hold_status === 'held' : true)).toBe(true);
    });
  });

  describe('P1: a report whose link was already viewed is never held', () => {
    test('refused at the preflight (hold_after_send), and its link is kept', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_viewed_at: '2026-11-20T10:00:00Z' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).code).toBe('hold_after_send');
      });
      expect((updates.projects || []).some((u) => u.report_token === null)).toBe(false);
    });

    test('and again under the arming lock, and in the stamp itself', async () => {
      mockTables({ project: wdoProject() });
      // viewed between the preflight read and the lock
      const base = db.getMockImplementation();
      const raws = [];
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects') {
          const originalFirst = c.first;
          let locked = false;
          c.forUpdate = jest.fn(() => { locked = true; return c; });
          c.whereRaw = jest.fn((sql) => { raws.push(sql); return c; });
          c.first = jest.fn(async (...args) => (locked ? wdoProject({ report_viewed_at: '2026-11-24T08:00:00Z' }) : originalFirst(...args)));
        }
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).code).toBe('hold_after_send');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      // (the stamp's own condition is asserted in the unsent-report test above)
    });

    test('the stamp requires an unviewed report in the update itself', async () => {
      mockTables();
      const writes = trackProjectWrites();
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      const stamp = writes.find((w) => w.payload.report_hold_status === 'held');
      expect(stamp.raws.map((r) => r.sql).join(' ')).toContain('report_viewed_at IS NULL');
    });
  });

  describe('round 4: arming refuses once ANY payment has started on the invoice (fail closed, nothing to cancel)', () => {
    const refused = async (tables) => {
      const { updates } = mockTables(tables);
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_payment_started');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    };

    test('an invoice with a PaymentIntent (bank or card, any status) refuses the hold', async () => {
      await refused({ invoice: invoiceRow({ stripe_payment_intent_id: 'pi_any' }) });
    });
    test('an invoice with a payment row refuses the hold', async () => {
      await refused({ paymentStarted: 'payment' });
    });
    test('an invoice with a charge attempt refuses the hold', async () => {
      await refused({ paymentStarted: 'attempt' });
    });
    test('a fresh invoice (no payment of any kind) arms the hold, and Stripe is never called', async () => {
      mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).report_held).toBe(true);
      });
    });
  });

  describe('round 4: every hold refusal runs before a draft invoice is created', () => {
    test.each([
      ['a voided linked invoice', wdoProject({ invoice_id: 'inv-1' })],
      ['a live hold whose invoice was voided', wdoProject({ invoice_id: 'inv-1', report_hold_status: 'held' })],
    ])('%s refuses the hold and mints nothing', async (_label, project) => {
      // the linked invoice reads as voided; no other invoice matches the visit
      const { updates } = mockTables({ project, invoice: null, invoiceFirstResults: [invoiceRow({ status: 'void' }), null, null] });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_unusable');
      });
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.invoice_id)).toBe(false);
    });
  });

  describe('round 5: arming and the invoice PDF fail closed', () => {
    test('an invoice that now belongs to another customer (a merge) refuses the hold and sends nothing', async () => {
      const { updates } = mockTables({ invoice: invoiceRow({ customer_id: 'customer-2' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_customer_changed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('a failed invoice PDF refuses the held send before anything is sent, and takes the hold back', async () => {
      require('../services/pdf/invoice-pdf').buildInvoicePDFBuffer.mockRejectedValueOnce(new Error('pdf down'));
      const { updates } = mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(500);
        expect((await res.json()).error).toMatch(/invoice PDF/);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      const projectUpdates = updates.projects || [];
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      expect(projectUpdates.findIndex((u, i) => i > stampIdx && u.report_hold_status === null)).toBeGreaterThan(stampIdx);
    });
  });

  describe('round 6: the automatic release never needs an override', () => {
    test('a missing detail /send would need a reason for (not only a statutory one) keeps the report held and rings the bell', async () => {
      const findings = { ...FINDINGS, inspection_scope: '' };
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', findings }), invoice: invoiceRow({ status: 'paid' }) });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_last_error && /give a reason/.test(u.report_hold_last_error))).toBe(true);
    });
  });

  describe('round 5: a retried release repeats nothing', () => {
    const releaseOnce = async (project) => {
      const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      return { updates, result };
    };
    const findings = { ...FINDINGS, report_sent_to: 'ABC Title <closing@abctitle.com>' };

    test('the requestor copy key carries the filing revision (a re-signed filing is a new key)', async () => {
      await releaseOnce(wdoProject({ report_hold_status: 'held', findings }));
      const keyOf = () => ProjectEmail.sendProjectReportReady.mock.calls.map(([a]) => a).find((a) => a.recipient.email === 'closing@abctitle.com').idempotencyKey;
      const first = keyOf();
      expect(first).toMatch(/:release:[0-9a-f]{8}:[0-9a-f]{8}$/);
      ProjectEmail.sendProjectReportReady.mockClear();
      await releaseOnce(wdoProject({ report_hold_status: 'held', findings: { ...findings, wdo_evidence: 'Frass at the garage door and the lanai' } }));
      expect(keyOf()).not.toBe(first);
    });

    test('the courtesy text is claimed on the row BEFORE it is dispatched, and a lost claim sends nothing', async () => {
      const order = [];
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', findings }), invoice: invoiceRow({ status: 'paid' }) });
      sendCustomerMessage.mockImplementationOnce(async () => {
        order.push(`dispatch after ${(updates.projects || []).filter((u) => u.delivery_channels?.bindings?.[0]?.includes('release_sms')).length} mark`);
        return { sent: true };
      });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(order).toEqual(['dispatch after 1 mark']);
      sendCustomerMessage.mockClear();
      mockTables({ project: wdoProject({ report_hold_status: 'held', findings }), invoice: invoiceRow({ status: 'paid' }), projectUpdateResult: (payload) => (payload.delivery_channels?.bindings?.[0]?.includes('release_sms') ? 0 : 1) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('the courtesy text is marked per invoice and filing, and a retry does not text again', async () => {
      const first = await releaseOnce(wdoProject({ report_hold_status: 'held', findings }));
      expect(first.result.released).toBe(true);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const marked = first.updates.projects.find((u) => u.delivery_channels?.bindings?.[0]?.includes('release_sms'));
      const mark = JSON.parse(marked.delivery_channels.bindings[0]).release_sms;
      sendCustomerMessage.mockClear();
      const retry = await releaseOnce(wdoProject({ report_hold_status: 'held', findings, delivery_channels: { release_sms: mark } }));
      expect(retry.result.released).toBe(true);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(retry.result.channels.sms).toEqual({ ok: true, deduped: true });
    });
  });

  describe('round 8: any report link refuses the hold, and nothing is ever cleared', () => {
    test.each([
      ['a report token (a closeout or an earlier send minted it)', { report_token: 'a'.repeat(32) }],
      ['sent through the portal', { sent_at: '2026-06-11T10:00:00Z' }],
      ['marked sent outside the portal', { sent_outside_portal_at: '2026-06-11T10:00:00Z' }],
      ['viewed by the customer', { report_viewed_at: '2026-06-11T10:00:00Z' }],
      ['shown on the customer portal', { portal_visible: true }],
      ['a migrated delivery', { delivery_status: 'legacy_sent' }],
      ['status sent', { status: 'sent' }],
    ])('a report with %s refuses the hold and sends nothing', async (_label, patch) => {
      const { updates } = mockTables({ project: wdoProject(patch) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_after_send');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('the arming write carries every link signal in its own condition and never writes report_token', async () => {
      mockTables();
      const writes = trackProjectWrites();
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      const stamp = writes.find((w) => w.payload.report_hold_status === 'held');
      const sql = stamp.raws.map((r) => r.sql).join(' ');
      ['report_token IS NULL', 'sent_at IS NULL', 'sent_outside_portal_at IS NULL', 'report_viewed_at IS NULL', 'portal_visible IS NOT TRUE', "delivery_status IS DISTINCT FROM 'legacy_sent'"]
        .forEach((clause) => expect(sql).toContain(clause));
      expect(stamp.payload).not.toHaveProperty('report_token');
    });

  });

  describe('round 7: an exception after arming and before any message takes the hold back', () => {
    const { shortenOrPassthrough } = require('../services/short-url');
    const reverted = (updates, stampIdx) => (updates.projects || []).findIndex((u, i) => i > stampIdx && u.report_hold_status === null);

    test('a failure between the stamp and the first customer message unwinds the hold and sends nothing', async () => {
      shortenOrPassthrough.mockRejectedValueOnce(new Error('shortener down'));
      const { updates } = mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(500);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      const stampIdx = (updates.projects || []).findIndex((u) => u.report_hold_status === 'held');
      expect(stampIdx).toBeGreaterThanOrEqual(0);
      expect(reverted(updates, stampIdx)).toBeGreaterThan(stampIdx);
    });

    test('a failure AFTER the invoice email went out keeps the hold (the customer was told)', async () => {
      InvoiceService.markDeliverySent.mockRejectedValueOnce(new Error('db blip after delivery'));
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).toHaveBeenCalledTimes(1);
      const stampIdx = (updates.projects || []).findIndex((u) => u.report_hold_status === 'held');
      expect(stampIdx).toBeGreaterThanOrEqual(0);
      expect(reverted(updates, stampIdx)).toBe(-1);
    });
  });

  describe('round 9: fail closed on credit, deleted invoices and readiness', () => {
    test('a customer with ANY account credit balance is refused before any credit is applied or any invoice is created', async () => {
      const { getBalance, autoApplyAccountCreditIfEnabled } = require('../services/customer-credit');
      getBalance.mockResolvedValue(0.01);
      const { updates } = mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_has_credit');
      });
      getBalance.mockResolvedValue(0);
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(autoApplyAccountCreditIfEnabled).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('credit issued before a RESEND of an existing hold refuses the resend and keeps the hold', async () => {
      const { updates } = mockTables({
        project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }),
        customer: { ...CUSTOMER, account_credits: 12.5 },
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), heldResendBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_has_credit');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      // the earlier hold is not taken back
      expect((updates.projects || []).some((u) => u.report_hold_status === null)).toBe(false);
    });

    test('an inspection fee changed to $0 after the send read the project refuses on the locked row', async () => {
      const { updates } = mockTables();
      const base = db.getMockImplementation();
      let projectReads = 0;
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects') {
          const original = c.first;
          c.forUpdate = jest.fn(() => {
            c.first = jest.fn(async () => wdoProject({ findings: { ...FINDINGS, inspection_fee: '0' } }));
            return c;
          });
          c.first = jest.fn(async (...a) => { projectReads += 1; return original(...a); });
        }
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).code).toBe('wdo_no_charge');
      });
      expect(projectReads).toBeGreaterThan(0);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('preparing the draft with the hold intent runs the hold preflight first (a refused hold makes no draft)', async () => {
      mockTables({ project: wdoProject({ report_token: 'already-shared' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { prepare_invoice: true, hold_report_until_paid: true });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_after_send');
      });
      const InvoiceService = require('../services/invoice');
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });

    test('an unreadable balance counts as credit (fail closed) in the preflight', async () => {
      const { getBalance } = require('../services/customer-credit');
      mockTables();
      getBalance.mockRejectedValueOnce(new Error('db blip'));
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_has_credit');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('credit issued after the preflight read is caught under the customers row lock the credit writer takes', async () => {
      // the preflight read saw 0 (getBalance), but the locked customers row read inside the arming transaction has credit
      const { updates } = mockTables({ customer: { ...CUSTOMER, account_credits: 12.5 } });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_has_credit');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('a held send never applies credit', async () => {
      const { autoApplyAccountCreditIfEnabled } = require('../services/customer-credit');
      mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      expect(autoApplyAccountCreditIfEnabled).not.toHaveBeenCalled();
    });

    test('a report the release would refuse is refused BEFORE a draft invoice is created', async () => {
      mockTables({ project: wdoProject({ invoice_id: null, findings: { ...FINDINGS, inspection_scope: '' } }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true, override_reason: 'x' });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_not_releasable');
      });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });

    test.each([
      ['a PaymentIntent', { stripe_payment_intent_id: 'pi_1' }],
      ['paid_at', { paid_at: '2026-06-11T10:00:00Z' }],
      ['payment_recorded_at', { payment_recorded_at: '2026-06-11T10:00:00Z' }],
      ['amount_paid', { amount_paid: 20 }],
      ['credit already applied', { credit_applied: 20 }],
      ['a partial status', { status: 'partial' }],
    ])('payment evidence on the invoice (%s) refuses the hold', async (_label, patch) => {
      mockTables({ invoice: invoiceRow(patch) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect([409, 422]).toContain(res.status);
        expect(['hold_payment_started']).toContain((await res.json()).code);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a payments row that names the invoice under waves_invoice_id or dispute_invoice_id counts', async () => {
      const holdService = require('../services/project-report-hold');
      const seen = [];
      const database = jest.fn((table) => chain({ first: jest.fn(async () => { seen.push(table); return table === 'payments' ? { id: 'pay-9' } : null; }) }));
      const sqlSeen = [];
      database.mockImplementation((table) => {
        const c = chain({ first: jest.fn(async () => (table === 'payments' ? { id: 'pay-9' } : null)) });
        c.whereRaw = jest.fn((sql, bindings) => { sqlSeen.push({ sql, bindings }); return c; });
        return c;
      });
      await expect(holdService.assertNoPaymentStarted({ id: 'inv-1', status: 'overdue' }, database)).rejects.toMatchObject({ holdRefusal: { code: 'hold_payment_started' } });
      expect(sqlSeen[0].sql).toContain("metadata->>'waves_invoice_id'");
      expect(sqlSeen[0].sql).toContain("metadata->>'dispute_invoice_id'");
      expect(sqlSeen[0].bindings).toEqual(['inv-1', 'inv-1', 'inv-1']);
    });

    test('a held report whose invoice link is gone refuses a hold on another invoice (it stays for staff)', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_locked');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('a report that needs an override reason (or is otherwise not releasable) is not held', async () => {
      const findings = { ...FINDINGS, inspection_scope: '' };
      const { updates } = mockTables({ project: wdoProject({ findings }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ override_reason: 'office says ok' }));
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_not_releasable');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('a hold is refused when the address the paid report would go to does not accept email (the contact declined, no fallback)', async () => {
      const { updates } = mockTables();
      ProjectEmail.resolveProjectEmailRecipientForSend.mockResolvedValueOnce({ email: null });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_not_releasable');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('the dry run refuses a hold for a report the release would refuse (the drawer shows why before anyone confirms)', async () => {
      mockTables({ project: wdoProject({ findings: { ...FINDINGS, inspection_scope: '' } }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true, invoice_id: 'inv-1', override_reason: 'x' });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_not_releasable');
      });
    });

    test('the release validates and archives the signed PDF BEFORE it publishes the report link (a PDF failure leaves no token)', async () => {
      buildWdoReportPDFBuffer.mockRejectedValueOnce(new Error('photo set changed'));
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      expect((updates.projects || []).some((u) => typeof u.report_token === 'string' || 'portal_visible' in u)).toBe(false);
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });
  });

  describe('round 11: recipient, blocked email, delivery evidence', () => {
    test('a held send emails, and compares the billing copy with, the address the invoice email really uses', async () => {
      ProjectEmail.resolveProjectEmailRecipientForSend.mockResolvedValue({ email: 'holder@example.com', name: 'Holder', role: 'primary' });
      mockTables();
      const base = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'notification_prefs'
        ? chain({ first: jest.fn(async () => ({ billing_email: 'holder@example.com' })) })
        : base(table)));
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      // one invoice email, to the holder: the billing contact IS the holder, so no second copy
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).toHaveBeenCalledTimes(1);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0].recipient.email).toBe('holder@example.com');
    });

    test('a held send records no report delivery on the project (the invoice email is not the report)', async () => {
      const { updates } = mockTables({ project: wdoProject({ delivery_status: null }) });
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const projectUpdates = updates.projects || [];
      // (the only channel write is the held invoice send count, not a delivery record)
      const deliveryRecord = (u) => ('delivery_channels' in u && !String(u.delivery_channels?.sql || '').includes("'held_invoice_sends'")) || 'last_delivery_at' in u;
      expect(projectUpdates.some(deliveryRecord)).toBe(false);
      expect(projectUpdates.some((u) => u.delivery_status === 'sent' || u.delivery_status === 'partial')).toBe(false);
      // the claim is given back with the status it had
      expect(projectUpdates.some((u) => u.delivery_claim_token === null && u.delivery_status === null)).toBe(true);
    });

    test('a release blocked by email suppression counts the block, and the next attempt uses a new key (so a cleared suppression sends)', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'suppressed' });
      const first = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(first.released).toBe(false);
      expect((updates.projects || []).some((u) => u.delivery_channels?.sql?.includes('release_email_blocks'))).toBe(true);
      const firstKey = ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey;
      expect(firstKey).not.toMatch(/:b\d+$/);

      ProjectEmail.sendProjectReportReady.mockClear();
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_channels: { release_email_blocks: 1 } }), invoice: invoiceRow({ status: 'paid' }) });
      const retry = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(retry.released).toBe(true);
      expect(ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey).toBe(`${firstKey}:b1`);
    });

    test('an accepted or uncertain send keeps its key: a retry without a counted block repeats the same key', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const key = ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey;
      ProjectEmail.sendProjectReportReady.mockClear();
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey).toBe(key);
    });
  });

  describe('round 12: one amount, unknown email outcome, deposits, drawer', () => {
    test.each([
      ['the total', { total: 250 }],
      ['a line item', { line_items: [{ description: 'WDO inspection', quantity: 1, unit_price: 250, amount: 250 }] }],
      ['the tax', { tax_amount: 17.5 }],
    ])('an invoice that changed (%s) between the send reading it and the arming lock refuses and sends nothing', async (_label, patch) => {
      const { updates } = mockTables();
      const base = db.getMockImplementation();
      // the locked read inside the arming transaction is the changed row; every earlier read is the original
      let invoiceReads = 0;
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'invoices') {
          const original = c.first;
          c.first = jest.fn(async (...a) => { invoiceReads += 1; return c.__locked ? invoiceRow(patch) : original(...a); });
          c.forUpdate = jest.fn(() => { c.__locked = true; return c; });
        }
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_changed');
      });
      expect(invoiceReads).toBeGreaterThan(0);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('an invoice email that ends in an error (outcome unknown) keeps the hold, parks the invoice for review and rings the one bell', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'provider timeout', deliveryOutcome: 'uncertain' });
      const { updates } = mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.report_held).toBe(true);
      });
      const projectUpdates = updates.projects || [];
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      expect(stampIdx).toBeGreaterThanOrEqual(0);
      expect(projectUpdates.findIndex((u, i) => i > stampIdx && u.report_hold_status === null)).toBe(-1);
      // parked for review (still payable), never marked sent
      expect(InvoiceService.markDeliverySent).not.toHaveBeenCalled();
      expect((updates.invoices || []).some((u) => u.status === 'scheduled' && u.scheduled_send_at === null)).toBe(true);
      expect(require('../services/logger').error.mock.calls).toEqual([]);
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(NotificationService.notifyAdmin.mock.calls[0][3]).toEqual(expect.objectContaining({ dedupeKey: 'wdo-report-hold-invoice-email:project-1' }));
    });

    test('a definite failure (the library says blocked) takes the hold back and rings no bell', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'suppressed' });
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const projectUpdates = updates.projects || [];
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      expect(projectUpdates.findIndex((u, i) => i > stampIdx && u.report_hold_status === null)).toBeGreaterThan(stampIdx);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    test('an estimate deposit applied to the invoice counts as a prior payment', async () => {
      mockTables({ invoice: invoiceRow({ line_items: [
        { description: 'WDO inspection', quantity: 1, unit_price: 250, amount: 250 },
        { description: 'Estimate deposit', category: 'deposit_credit', amount: -50 },
      ] }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_payment_started');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a settlement deferral (the invoice is not paid yet) stores no error, so the drawer cannot read it as a paid failure', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'sent' }) });
      const base = db.getMockImplementation();
      // the sweep scan said paid; the lock-time read finds it open again
      db.mockImplementation((table) => base(table));
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).toBeTruthy();
      expect(revert).not.toHaveProperty('report_hold_last_error');
    });

    test('the project detail carries the held invoice status for the drawer', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'processing' }) });
      const out = await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/projects/project-1`, { headers: { Authorization: 'Bearer admin' } });
        return res.json();
      });
      expect(out.project.report_hold_invoice_status).toBe('processing');
    });
  });

  describe('round 13: one invoice handoff path, definite vs uncertain, confirmed amount, bell retry', () => {
    // The held invoice email's provider handoff: the billing email authority's options, and the claim token the send took.
    const handoffOf = async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const args = ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0];
      expect(typeof args.withProviderHandoff).toBe('function');
      const authority = require('../services/billing-channel-email-authority');
      const dispatch = jest.fn();
      await args.withProviderHandoff(dispatch);
      const opts = authority.dispatchUnderBillingEmailAuthority.mock.calls.at(-1)[0];
      expect(opts.dispatch).toBe(dispatch);
      const token = (updates.projects || []).find((u) => u.delivery_claim_token)?.delivery_claim_token;
      expect(token).toBeTruthy();
      return { opts, token, args };
    };
    // The pre-send check on the world as the locked handle reads it at the handoff.
    const checkOn = (opts, token, { project = {}, invoice = {} } = {}) => {
      mockTables({
        project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token, report_token: null, ...project }),
        invoice: invoiceRow({ status: 'sending', ...invoice }),
      });
      return opts.preSendCheck({ database: db });
    };

    test('the held invoice email goes through the billing email authority, and its fence passes when nothing changed', async () => {
      const { opts, token, args } = await handoffOf();
      expect(opts).toMatchObject({
        input: { customerId: 'customer-1', invoiceId: expect.anything(), channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
        templateKey: 'project.invoice_before_report',
        holdExempt: 'operator',
        state: args.handoffState,
      });
      expect(opts.recipientEmail).toBe(args.recipient.email);
      expect(await checkOn(opts, token)).toEqual({ ok: true });
    });

    test.each([
      ['the invoice was paid', { invoice: { status: 'paid' } }, 'HELD_INVOICE_NOT_SENDABLE'],
      ['the invoice was voided', { invoice: { status: 'void' } }, 'HELD_INVOICE_NOT_SENDABLE'],
      ['a part payment landed', { invoice: { amount_paid: 50 } }, 'HELD_INVOICE_CHANGED'],
      ['the amount changed', { invoice: { total: 250 } }, 'HELD_INVOICE_CHANGED'],
      ['the title changed', { invoice: { title: 'Termite treatment' } }, 'HELD_INVOICE_CHANGED'],
      ['the due date changed', { invoice: { due_date: '2026-12-31' } }, 'HELD_INVOICE_CHANGED'],
      ['it became a payer bill', { invoice: { payer_id: 'payer-1' } }, 'INVOICE_PAYER_BILLED'],
      ['the invoice moved to another customer (a merge)', { invoice: { customer_id: 'customer-2' } }, 'INVOICE_CUSTOMER_MISMATCH'],
      ['the project moved to another customer', { project: { customer_id: 'customer-2' } }, 'INVOICE_CUSTOMER_MISMATCH'],
      ['another request took the delivery claim', { project: { delivery_claim_token: 'someone-else' } }, 'HELD_SEND_SUPERSEDED'],
      ['the report link was minted', { project: { report_token: 'tok' } }, 'HELD_SEND_SUPERSEDED'],
      ['the hold was taken back', { project: { report_hold_status: null } }, 'HELD_SEND_SUPERSEDED'],
      ['the report was recorded as sent another way', { project: { sent_outside_portal_at: '2026-11-26T09:00:00Z' } }, 'HELD_SEND_SUPERSEDED'],
      ['the fee was changed to $0', { project: { findings: { ...FINDINGS, inspection_fee: '0' } } }, 'WDO_NO_CHARGE'],
      ['a card payment was started on the pay page', { invoice: { stripe_payment_intent_id: 'pi_1' } }, 'HOLD_PAYMENT_STARTED'],
    ])('the fence refuses when %s', async (_label, world, code) => {
      const { opts, token } = await handoffOf();
      expect(await checkOn(opts, token, world)).toMatchObject({ ok: false, code });
    });

    test('the fence refuses when the customer now has account credit, the report can no longer release, or the switch is off', async () => {
      const { opts, token } = await handoffOf();
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token, report_token: null }), invoice: invoiceRow({ status: 'sending' }), customer: { ...CUSTOMER, account_credits: 10 } });
      expect(await opts.preSendCheck({ database: db })).toMatchObject({ ok: false, code: 'HOLD_HAS_CREDIT' });
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token, report_token: null }), invoice: invoiceRow({ status: 'sending' }), customer: { ...CUSTOMER, email: '' } });
      expect(await opts.preSendCheck({ database: db })).toMatchObject({ ok: false, code: 'HOLD_NOT_RELEASABLE' });
      require('../config/feature-gates').wdoReportHoldLive.mockReturnValueOnce(false);
      expect(await checkOn(opts, token)).toMatchObject({ ok: false, code: 'HOLD_SWITCHED_OFF' });
    });

    test('the fence asks the collections hold on the locked handle: a fallback hold or an unreadable hold refuses, a plain dispute is exempt', async () => {
      const collectionHold = require('../services/collections/collection-hold');
      const { opts, token } = await handoffOf();
      collectionHold.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: true, reason: 'hold' });
      expect(await checkOn(opts, token)).toMatchObject({ ok: false, code: 'COLLECTION_HOLD' });
      expect(collectionHold.messagingHeldByCollectionHold).toHaveBeenLastCalledWith('customer-1', db, { ignoreDisputeHold: true });
      collectionHold.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: true, reason: 'lookup_failed' });
      expect(await checkOn(opts, token)).toMatchObject({ ok: false, code: 'COLLECTION_HOLD' });
      expect(await checkOn(opts, token)).toEqual({ ok: true });
    });

    test('a held send emails the invoice once, to the billing recipient: no second billing-contact copy', async () => {
      mockTables();
      const base = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'notification_prefs'
        ? chain({ first: jest.fn(async () => ({ billing_email: 'billing@example.com' })) })
        : base(table)));
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      const calls = ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls.map(([a]) => a);
      expect(calls.length).toBe(1);
      expect(calls[0].recipient.email).toBe('billing@example.com');
      expect(typeof calls[0].withProviderHandoff).toBe('function');
    });

    test('a handoff refused at the boundary (blocked) is a definite failure: the hold is taken back, no bell', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'handoff_refused' });
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const projectUpdates = updates.projects || [];
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      expect(projectUpdates.findIndex((u, i) => i > stampIdx && u.report_hold_status === null)).toBeGreaterThan(stampIdx);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    test('an error before the provider handoff (deliveryOutcome not_sent) is a definite failure: the hold is taken back', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'template render failed', deliveryOutcome: 'not_sent' });
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const projectUpdates = updates.projects || [];
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      expect(projectUpdates.findIndex((u, i) => i > stampIdx && u.report_hold_status === null)).toBeGreaterThan(stampIdx);
      expect(InvoiceService.markDeliverySent).not.toHaveBeenCalled();
    });

    test('only an error after the provider handoff (deliveryOutcome uncertain) keeps the hold', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'timeout', deliveryOutcome: 'uncertain' });
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const projectUpdates = updates.projects || [];
      const stampIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'held');
      expect(projectUpdates.findIndex((u, i) => i > stampIdx && u.report_hold_status === null)).toBe(-1);
    });

    test('an invoice email of unknown outcome parks the invoice for review: payable, never stamped sent', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'timeout', deliveryOutcome: 'uncertain' });
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      expect(InvoiceService.markDeliverySent).not.toHaveBeenCalled();
      const park = (updates.invoices || []).find((u) => u.status === 'scheduled');
      expect(park).toEqual(expect.objectContaining({ scheduled_send_at: null, send_claim_token: null }));
      expect(park.scheduled_send_error).toMatch(/delivery unverified/);
    });

    test('a held resend whose email is accepted closes the earlier unknown-outcome invoice bell', async () => {
      const holdService = require('../services/project-report-hold');
      const close = jest.spyOn(holdService, 'closeInvoiceEmailBell').mockResolvedValue();
      mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }) });
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), heldResendBodyFor())).status).toBe(200); });
      expect(close).toHaveBeenCalledWith('project-1');
      close.mockRestore();
    });

    test('the pay-link text of a held send holds the phone, the customer and the claim through the provider request', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
      expect(sms.metadata.report_hold).toBe(true);
      expect(typeof sms.withSmsHandoff).toBe('function');
      const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
      const dispatch = jest.fn(async () => ({ ok: true, sid: 'SM1' }));
      // nothing changed: dispatched once, under the lock
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token }) });
      expect(await sms.withSmsHandoff(dispatch)).toEqual({ ok: true, sid: 'SM1' });
      dispatch.mockClear();
      // the phone on the customer row now differs: refused, nothing dispatched
      mockTables({ customer: { ...CUSTOMER, phone: '9415550177' }, project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token }) });
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      // the project moved to another customer (a merge): refused
      mockTables({ project: wdoProject({ report_hold_status: 'held', customer_id: 'customer-2', delivery_claim_token: token }) });
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      // another request owns the claim: refused
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: 'someone-else' }) });
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('arming judges release readiness on the customer read inside the arming transaction', async () => {
      // the preflight customer has an email; the row read under the arming locks has none
      mockTables();
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'customers') {
          const originalForShare = c.forShare;
          c.forShare = jest.fn(() => {
            c.first = jest.fn(async () => ({ ...CUSTOMER, email: '' }));
            return originalForShare ? originalForShare.call(c) : c;
          });
        }
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBeGreaterThanOrEqual(400);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('the dry run hands back a fingerprint of the invoice the operator confirms, and the send refuses a changed bill', async () => {
      mockTables();
      const fingerprint = await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true, invoice_id: 'inv-1' });
        return (await res.json()).invoice.billing_fingerprint;
      });
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      // the same bill goes through
      mockTables();
      await withServer(async (baseUrl) => {
        expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ expected_billing_fingerprint: fingerprint }))).status).toBe(200);
      });
      // the bill changed while the dialog was open: both reads see the new amount, the confirmed fingerprint does not match
      ProjectEmail.sendProjectInvoiceBeforeReport.mockClear();
      mockTables({ invoice: invoiceRow({ total: 250, line_items: [{ description: 'WDO inspection', quantity: 1, unit_price: 250, amount: 250 }] }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ expected_billing_fingerprint: fingerprint }));
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_changed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a release-failure alert that could not be recorded is tried again on the next failure, and a recorded one is not repeated', async () => {
      const failing = () => ({ project: wdoProject({ report_hold_status: 'held', report_hold_attempts: 1 }), invoice: invoiceRow({ status: 'paid' }) });
      const stale = (project) => { project.wdo_signature = JSON.stringify({ image: PNG_DATA_URL, signer_name: 'Adam B', content_hash: 'stale-hash-mismatch' }); return project; };
      // the insert did not record (muted): no marker, so the next failure tries again
      NotificationService.notifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
      const first = failing(); stale(first.project);
      const { updates } = mockTables(first);
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect((updates.projects || []).some((u) => u.delivery_channels?.sql?.includes('release_bell'))).toBe(false);
      // the next failure rings and records
      NotificationService.notifyAdmin.mockClear();
      const second = failing(); stale(second.project);
      const next = mockTables(second);
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect((next.updates.projects || []).some((u) => u.delivery_channels?.sql?.includes('release_bell'))).toBe(true);
      // with the marker on the row, a later failure stays quiet
      NotificationService.notifyAdmin.mockClear();
      const third = failing(); stale(third.project); third.project.delivery_channels = { release_bell: true };
      mockTables(third);
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });
  });

  describe('round 14: the held send never creates the invoice; the handoff re-reads who it goes to', () => {
    test('a held send without the confirmed invoice id is refused before anything is created', async () => {
      mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('hold_invoice_required');
      });
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('the prepared invoice (no hold, nothing sent) hands back the fingerprint the confirm is bound to', async () => {
      mockTables();
      const out = await withServer(async (baseUrl) => (await post(baseUrl, SEND_WITH_INVOICE(), { prepare_invoice: true })).json());
      expect(out.prepared).toBe(true);
      expect(out.invoice.billing_fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a failure alert is not raised when a manual release finished meanwhile (the hold is no longer held)', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, reason: 'blocked' });
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      const base = db.getMockImplementation();
      let projectReads = 0;
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects') {
          const original = c.first;
          // the re-read after the revert finds the report released by a manual send
          c.first = jest.fn(async (...args) => { projectReads += 1; return args[0] === 'report_hold_status' ? { report_hold_status: 'released' } : original(...args); });
        }
        return c;
      });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      expect(projectReads).toBeGreaterThan(0);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });
  });

  describe('P1: the payer lookup fails closed', () => {
    test('a lookup error refuses the hold before any invoice is created, and asks the lookup to throw', async () => {
      PayerService.resolveForInvoice.mockRejectedValueOnce(new Error('db down'));
      mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true, hold_report_until_paid: true });
        expect(res.status).toBe(500);
      });
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ throwOnError: true }));
    });
  });

  describe('P1: the release renews the lease the stale-claim recovery checks', () => {
    test('every renewal under the ownership fence moves report_hold_locked_at with updated_at', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const renewals = (updates.projects || []).filter((u) => u.updated_at && u.report_hold_locked_at && !('report_hold_status' in u));
      // the link stamp, the check right before the provider calls, the one requestor copy, and the courtesy text mark
      expect(renewals).toHaveLength(4);
    });
  });

  describe('P1: the release sends the report to a named requestor who only got the invoice', () => {
    test('the billing contact is not excluded from the FDACS copies', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'Billing Desk <billing@example.com>, ABC Title <closing@abctitle.com>' };
      mockTables({
        project: wdoProject({ report_hold_status: 'held', findings }),
        invoice: invoiceRow({ status: 'paid' }),
      });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'notification_prefs'
        ? chain({ first: jest.fn(async () => ({ billing_email: 'billing@example.com' })) })
        : base(table)));
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      const recipients = ProjectEmail.sendProjectReportReady.mock.calls.map(([args]) => args.recipient.email);
      expect(recipients).toEqual(expect.arrayContaining([CUSTOMER.email, 'billing@example.com', 'closing@abctitle.com']));
    });
  });

  describe('round 18: account lookup, settlement at publish, confirmed amount, visit history', () => {
    test('a secondary property whose account-holder lookup fails stays held (never emailed to the on-site contact)', async () => {
      const secondary = { ...CUSTOMER, account_id: 'acct-1', is_primary_profile: false };
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }), customer: secondary });
      const base = db.getMockImplementation();
      let customerReads = 0;
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'customers') {
          c.first = jest.fn(async () => { customerReads += 1; if (customerReads > 1) throw new Error('db down'); return secondary; });
        }
        return c;
      });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(true);
    });

    test('an invoice that reopened during the PDF work keeps the report held: no link, no email, no attempt burned', async () => {
      const { updates } = mockTables({
        project: wdoProject({ report_hold_status: 'held' }),
        // the first read (before the PDF) says paid; the locked read at publish says it reopened
        invoiceFirstResults: [invoiceRow({ status: 'paid' }), invoiceRow({ status: 'sent' })],
      });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result).toMatchObject({ released: false, reason: 'invoice_not_settled' });
      expect((updates.projects || []).some((u) => u.report_token)).toBe(false);
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).not.toHaveProperty('report_hold_last_error');
    });

    test('a held send without the confirmed fingerprint is refused, and nothing is sent', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ expected_billing_fingerprint: undefined }));
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_changed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(false);
    });

    test('publishing a held report that was closed out gives the visit record its report link back', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held', service_record_id: 'sr-1', report_token: 'tok-1' }), invoice: invoiceRow({ status: 'paid' }) });
      const base = db.getMockImplementation();
      const srWrites = [];
      db.mockImplementation((table) => (table === 'service_records'
        ? chain({ update: jest.fn(async (payload) => { srWrites.push(payload); return 1; }) })
        : base(table)));
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      expect(srWrites).toHaveLength(1);
      // the release-time portal decision, not the closeout's "not attached" (the report was unsent then)
      expect(srWrites[0].structured_notes.sql).toMatch(/'portalAttached', \?::boolean, 'projectReport', jsonb_build_object/);
      // ...and the paid report's recommendations join the note the held completion wrote without them
      expect(srWrites[0].technician_notes.sql).toBe('CASE WHEN technician_notes IS NOT DISTINCT FROM ? OR technician_notes IS NOT DISTINCT FROM ? THEN ? ELSE technician_notes END');
      const [attached, token, url, tokenOnly] = srWrites[0].structured_notes.bindings;
      expect(token).toBe('tok-1');
      expect(tokenOnly).toBe(!attached);
      expect(url === null).toBe(!attached);
    });
  });

  describe('advisor redesign phase 1: one locked pre-send check for every release leg', () => {
    async function releaseArgs(findings) {
      mockTables({ project: wdoProject({ report_hold_status: 'held', ...(findings ? { findings } : {}) }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      return ProjectEmail.sendProjectReportReady.mock.calls;
    }

    test('the report email refuses when the invoice reopened after the link was published', async () => {
      const [[args]] = await releaseArgs();
      const dispatch = jest.fn();
      mockTables({ project: wdoProject({ report_hold_status: 'releasing' }), invoice: invoiceRow({ status: 'sent' }) });
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(args.handoffState.boundaryBlock).toEqual({ code: 'HELD_INVOICE_UNSETTLED' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('the check locks customers, then the invoice, then the project (an account merge locks in that order)', async () => {
      const [[args]] = await releaseArgs();
      const base = db.getMockImplementation();
      const order = [];
      db.mockImplementation((table) => {
        const c = base(table);
        c.forShare = jest.fn(() => { order.push(table); return c; });
        return c;
      });
      expect(await args.withProviderHandoff(jest.fn())).toEqual({ ok: true });
      const firstOf = (t) => order.indexOf(t);
      expect(firstOf('customers')).toBeGreaterThanOrEqual(0);
      expect(firstOf('customers')).toBeLessThan(firstOf('invoices'));
      expect(firstOf('invoices')).toBeLessThan(firstOf('projects'));
    });

    test('the project recorded as sent another way refuses every leg', async () => {
      const [[args]] = await releaseArgs();
      mockTables({ project: wdoProject({ report_hold_status: 'releasing', sent_outside_portal_at: '2026-11-26T10:00:00Z' }), invoice: invoiceRow({ status: 'paid' }) });
      expect(await args.withProviderHandoff(jest.fn())).toEqual({ ok: false });
      expect(args.handoffState.boundaryBlock).toEqual({ code: 'REPORT_OWNER_CHANGED' });
    });

    test('a failed read inside the check blocks the send', async () => {
      const [[args]] = await releaseArgs();
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'invoices') c.first = jest.fn(async () => { throw new Error('db blip'); });
        return c;
      });
      const dispatch = jest.fn();
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('each requestor copy runs the check, and a copy removed from the form is not sent', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'ABC Title <closing@abctitle.com>' };
      const calls = await releaseArgs(findings);
      const copy = calls.map(([a]) => a).find((a) => a.recipient?.role === 'report_copy');
      expect(typeof copy.withProviderHandoff).toBe('function');
      const dispatch = jest.fn();
      expect(await copy.withProviderHandoff(dispatch)).toEqual({ ok: true });
      mockTables({ project: wdoProject({ report_hold_status: 'releasing', findings: { ...FINDINGS, report_sent_to: '' } }), invoice: invoiceRow({ status: 'paid' }) });
      expect(await copy.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(copy.handoffState.boundaryBlock).toEqual({ code: 'REPORT_COPY_REMOVED' });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('the text refuses when the invoice reopened, and a text that definitely did not go gives its mark back', async () => {
      sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'RECIPIENT_CHANGED' });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect((updates.projects || []).some((u) => u.delivery_channels?.sql === "delivery_channels - 'release_sms'")).toBe(true);
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'project_report_hold_release')[0];
      mockTables({ project: wdoProject({ report_hold_status: 'releasing' }), invoice: invoiceRow({ status: 'refunded' }) });
      const dispatch = jest.fn();
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('advisor redesign phase 5: the held invoice is the one staff confirmed', () => {
    test('an invoice email that throws before the provider handoff takes the hold back; one that throws after keeps it', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockImplementationOnce(async () => { throw new Error('pdf render failed'); });
      let { updates } = mockTables();
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      expect((updates.projects || []).some((u) => u.report_hold_status === null)).toBe(true);
      ProjectEmail.sendProjectInvoiceBeforeReport.mockImplementationOnce(async ({ handoffState }) => {
        handoffState.handoffStarted = true;
        throw new Error('socket hang up');
      });
      ({ updates } = mockTables());
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      expect((updates.projects || []).some((u) => u.report_hold_status === null)).toBe(false);
    });

    test('an invoice lookup for a project that moved to another customer since the read refuses (no old-customer invoice reused)', async () => {
      mockTables({ project: wdoProject() });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects' && c.forUpdate) {
          const fu = c.forUpdate;
          c.forUpdate = jest.fn((...a) => { const r = fu.apply(c, a); const first = r.first; r.first = jest.fn(async (...b) => { const row = await first.apply(r, b); return row ? { ...row, customer_id: 'customer-2' } : row; }); return r; });
        }
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { dry_run: true });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('project_customer_changed');
      });
    });

    test('an unknown-outcome invoice bell raised after the release already ran is closed at once', async () => {
      const holdService = require('../services/project-report-hold');
      const raise = jest.spyOn(holdService, 'raiseInvoiceEmailUncertainBell').mockImplementation(async () => {
        // the customer paid and the release committed (and closed its bells) while this bell was being raised
        mockTables({ project: wdoProject({ report_hold_status: 'released' }) });
      });
      const close = jest.spyOn(holdService, 'closeInvoiceEmailBell').mockResolvedValue();
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'timeout', deliveryOutcome: 'uncertain' });
      mockTables();
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      expect(raise).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith('project-1');
      // a release still in flight (it may fail back to held) leaves the bell open: its own finalize closes it
      raise.mockImplementation(async () => { mockTables({ project: wdoProject({ report_hold_status: 'releasing' }) }); });
      close.mockClear();
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'timeout', deliveryOutcome: 'uncertain' });
      mockTables();
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor()); });
      expect(close).not.toHaveBeenCalled();
      raise.mockRestore();
      close.mockRestore();
    });

    test('a held send never reprices the confirmed draft, even when the fee changed since the preview', async () => {
      // the untouched auto-created draft, at $175, while the project fee now reads $250
      const draft = invoiceRow({ title: 'WDO Inspection', line_items: [{ description: 'WDO Inspection (FDACS-13645)', quantity: 1, unit_price: 175, amount: 175 }] });
      mockTables({ project: wdoProject({ findings: { ...FINDINGS, inspection_fee: '250' } }), invoice: draft });
      await withServer(async (baseUrl) => {
        await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ expected_billing_fingerprint: projectsRouter._private.billingFingerprintHash(draft) }));
      });
      expect(InvoiceService.update).not.toHaveBeenCalled();
    });
  });

  describe('audit round 24', () => {
    const releaseArgs = async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      return ProjectEmail.sendProjectReportReady.mock.calls[0][0];
    };

    test('P0: a paid invoice that belongs to another customer never releases the report', async () => {
      // the invoice is another customer's from the start: every read of it agrees, and still nothing releases
      const world = () => mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid', customer_id: 'customer-2' }) });
      world();
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      // ...and the handoff check refuses it too
      const args = await releaseArgs();
      const dispatch = jest.fn();
      world();
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(args.handoffState.boundaryBlock).toEqual({ code: 'HELD_INVOICE_UNSETTLED' });
      // ...nor one the project is no longer held on
      mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-9' }), invoice: invoiceRow({ status: 'paid' }) });
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('the first report email of unknown outcome keeps the link and records the unknown outcome', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'socket timeout', deliveryOutcome: 'uncertain' });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: null }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const writes = updates.projects || [];
      expect(writes.some((u) => String(u.delivery_channels?.sql || '').includes('release_email_unknown'))).toBe(true);
      expect(writes.some((u) => 'report_token' in u && u.report_token === null)).toBe(false);
      // the key stays: no block counted
      expect(writes.some((u) => String(u.delivery_channels?.sql || '').includes('release_email_blocks'))).toBe(false);
    });

    test('a refusal at the handoff because the invoice was refunded is "not due yet": no attempt, no block, no bell', async () => {
      const holdService = require('../services/project-report-hold');
      const raise = jest.spyOn(holdService, 'raiseReleaseFailedBell');
      ProjectEmail.sendProjectReportReady.mockImplementationOnce(async ({ handoffState }) => {
        handoffState.boundaryBlock = { code: 'HELD_INVOICE_UNSETTLED' };
        return { ok: false, blocked: true, reason: 'handoff_refused' };
      });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_hold_attempts: 0 }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const writes = updates.projects || [];
      const revert = writes.find((u) => u.report_hold_status === 'held');
      expect(revert.report_hold_attempts).toBe(0);
      expect(revert).not.toHaveProperty('report_hold_last_error');
      expect(writes.some((u) => String(u.delivery_channels?.sql || '').includes('release_email_blocks'))).toBe(false);
      expect(raise).not.toHaveBeenCalled();
      raise.mockRestore();
    });

    test('a confirmed early release finds the report already released by payment: nothing is sent again', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'released', status: 'sent', sent_at: '2026-11-26T10:00:00Z' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_already_released');
      });
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });

    test('a held report whose invoice was deleted previews the release recipients', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: null, findings: { ...FINDINGS, report_sent_to: 'agent@example.com' } }) });
      const body = await withServer(async (baseUrl) => (await post(baseUrl, '/admin/projects/project-1/send', { dry_run: true })).json());
      expect(body.releases_payment_hold).toBe(true);
      expect(body.email_routing.recipient).toBeTruthy();
    });

    test('a held send-with-invoice never takes a release claim', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      expect(source).toContain(`true: "coalesce(report_hold_status, '') <> 'releasing'",`);
    });
  });

  describe('audit round 25', () => {
    test('P0: a collections hold that lands before the pay-link text stops it', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
      const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token }) });
      const collectionHold = require('../services/collections/collection-hold');
      collectionHold.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: true, reason: 'wrong_number' });
      const dispatch = jest.fn();
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'COLLECTION_HOLD' }));
      expect(dispatch).not.toHaveBeenCalled();
      expect(collectionHold.messagingHeldByCollectionHold).toHaveBeenLastCalledWith('customer-1', expect.anything(), { ignoreDisputeHold: true });
    });

    test('an unknown-outcome resend of an invoice already sent keeps its status (it stays an open bill)', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, error: 'timeout', deliveryOutcome: 'uncertain' });
      const sent = invoiceRow({ status: 'sent' });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }), invoice: sent });
      await withServer(async (baseUrl) => {
        await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ expected_billing_fingerprint: projectsRouter._private.billingFingerprintHash(sent, true) }));
      });
      // the resend really ran (the email was tried), and its unknown outcome restored the sent status
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).toHaveBeenCalledTimes(1);
      const writes = updates.invoices || [];
      expect(writes.some((u) => u.status === 'scheduled')).toBe(false);
      expect(writes.some((u) => u.status === 'sent')).toBe(true);
      expect(InvoiceService.markDeliverySent).not.toHaveBeenCalled();
    });

    test('a plain Send report confirmed before another admin held the report asks again', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'none' });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_changed');
      });
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });

    test('a paid invoice owned by another customer hands the report back to held at once, with a counted attempt', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid', customer_id: 'customer-2' }) });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      expect(result.reason).not.toBe('claim_superseded');
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert.report_hold_attempts).toBe(1);
      expect(revert.report_hold_last_error).toMatch(/another customer/);
    });
  });

  describe('audit round 26', () => {
    test('P0: a third-party payer assigned after arming stops the homeowner pay-link email and text', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
      await ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0].withProviderHandoff(jest.fn());
      const opts = require('../services/billing-channel-email-authority').dispatchUnderBillingEmailAuthority.mock.calls.at(-1)[0];
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
      const world = () => mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token, report_token: null }), invoice: invoiceRow({ status: 'sending' }) });
      world();
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1', paymentTerms: 'due_on_receipt' });
      expect(await opts.preSendCheck({ database: db })).toMatchObject({ ok: false, code: 'INVOICE_PAYER_BILLED' });
      world();
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1', paymentTerms: 'due_on_receipt' });
      const dispatch = jest.fn();
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('P0: an invoice riding another visit, billed to a payer since, is refused at arming and at both handoffs', async () => {
      const payerOnOtherVisit = async ({ scheduledServiceId }) => (scheduledServiceId === 'ss-other' ? { payerId: 'payer-1', paymentTerms: 'due_on_receipt' } : null);
      // arming: the confirmed invoice names another visit, whose payer came after the invoice was made
      mockTables({ invoice: invoiceRow({ scheduled_service_id: 'ss-other' }) });
      PayerService.resolveForInvoice.mockImplementation(payerOnOtherVisit);
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
          expect(res.status).toBe(422);
          expect((await res.json()).code).toBe('hold_payer_billed');
        });
        expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      } finally {
        PayerService.resolveForInvoice.mockImplementation(async () => null);
      }
      // the handoffs: armed on a self-pay invoice, then the invoice's own visit gains a payer before the email and text
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
      await ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0].withProviderHandoff(jest.fn());
      const opts = require('../services/billing-channel-email-authority').dispatchUnderBillingEmailAuthority.mock.calls.at(-1)[0];
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token, report_token: null }), invoice: invoiceRow({ status: 'sending', scheduled_service_id: 'ss-other' }) });
      PayerService.resolveForInvoice.mockImplementation(payerOnOtherVisit);
      try {
        expect(await opts.preSendCheck({ database: db })).toMatchObject({ ok: false, code: 'INVOICE_PAYER_BILLED' });
        const dispatch = jest.fn();
        expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        PayerService.resolveForInvoice.mockImplementation(async () => null);
      }
    });

    test('a held report whose release has not finished shows nothing on its public link', () => {
      const { heldReportUnreleased, servedWdoFiling } = require('../routes/reports-public');
      expect(heldReportUnreleased({ report_hold_status: 'held' })).toBe(true);
      expect(heldReportUnreleased({ report_hold_status: 'releasing' })).toBe(true);
      expect(heldReportUnreleased({ report_hold_status: 'released' })).toBe(false);
      expect(heldReportUnreleased({ report_hold_status: null })).toBe(false);
      // only a filing recorded as emailed is ever served
      expect(servedWdoFiling({ wdo_sent_filings: [], delivery_channels: { release_filing: { s3_key: 'x' } } })).toBeNull();
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/reports-public.js'), 'utf8');
      expect(source).toContain("if (!project || heldReportUnreleased(project)) return res.status(404).json({ error: 'Report not found' });");
      expect(source).toContain("if (!project || project.project_type !== 'wdo_inspection' || heldReportUnreleased(project)) {");
    });

    test('P0: a held link is bound to its filing and recipient before the email, and never carries a changed one', async () => {
      const K = 'k'.repeat(32);
      const linkPart = require('crypto').createHash('sha1').update(K).digest('hex').slice(0, 8);
      const releaseEmails = () => ProjectEmail.sendProjectReportReady.mock.calls.filter(([a]) => String(a.idempotencyKey || '').includes(':hold_release:'));
      // the binding is written under the claim BEFORE the email is handed to the provider (a crash after the
      // provider accepts it still leaves the binding)
      let { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: K }), invoice: invoiceRow({ status: 'paid' }) });
      let boundAtDispatch = null;
      ProjectEmail.sendProjectReportReady.mockImplementationOnce(async () => {
        const w = (updates.projects || []).find((u) => String(u.delivery_channels?.sql || '').includes('release_link_binding'));
        boundAtDispatch = w ? w.delivery_channels.bindings[0] : null;
        return { ok: false, error: 'email send held by provider_retry_ambiguous' };
      });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(boundAtDispatch).toMatch(new RegExp(`^${linkPart}:[0-9a-f]{8}:[0-9a-f]{12}$`));
      // the same link, filing and address: the retry goes out on the same link
      ProjectEmail.sendProjectReportReady.mockClear();
      mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: K, delivery_channels: { release_email_unknown: true, release_link_binding: boundAtDispatch } }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(releaseEmails()).toHaveLength(1);
      // staff corrected the address (or re-signed an edit): nothing goes out on that link, which is taken back
      ProjectEmail.sendProjectReportReady.mockClear();
      ({ updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: K, delivery_channels: { release_link_binding: `${linkPart}:deadbeef:000000000000` } }), invoice: invoiceRow({ status: 'paid' }) }));
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(releaseEmails()).toHaveLength(0);
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).toEqual(expect.objectContaining({ report_token: null }));
      expect(revert).not.toHaveProperty('report_hold_last_error');
      // a binding left from a link already taken back binds nothing: the new link is bound and sent
      ProjectEmail.sendProjectReportReady.mockClear();
      mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: K, delivery_channels: { release_link_binding: 'ffffffff:deadbeef:000000000000' } }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(releaseEmails()).toHaveLength(1);
    });

    test('a new link reaches the requestor copies and the text again (their keys name the link)', async () => {
      const releaseWith = async (token) => {
        ProjectEmail.sendProjectReportReady.mockClear();
        const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: token, findings: { ...FINDINGS, report_sent_to: 'closing@abctitle.com' } }), invoice: invoiceRow({ status: 'paid' }) });
        await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
        const copy = ProjectEmail.sendProjectReportReady.mock.calls.map(([x]) => x).find((x) => x.recipient.email === 'closing@abctitle.com');
        const smsMark = (updates.projects || []).map((u) => String(u.delivery_channels?.bindings?.[0] || '')).find((b) => b.includes('release_sms'));
        return { copyKey: copy?.idempotencyKey, smsMark };
      };
      const a = await releaseWith('a'.repeat(32));
      const b = await releaseWith('b'.repeat(32));
      expect(a.copyKey).toBeTruthy();
      expect(a.smsMark).toBeTruthy();
      expect(b.copyKey).not.toBe(a.copyKey);
      expect(b.smsMark).not.toBe(a.smsMark);
    });

    test('a held send claims only the invoice status it read, and gives a first delivery its send-day due date', async () => {
      const helpers = jest.requireActual('../services/invoice-helpers');
      // a draft past its due day goes out due on the send day; a delivered bill or a future due date keeps its day
      expect(helpers.firstDeliveryDueDateOf({ status: 'draft', due_date: '2026-11-01' }, '2026-11-26')).toBe('2026-11-26');
      expect(helpers.firstDeliveryDueDateOf({ status: 'sent', sent_at: 'x', due_date: '2026-11-01' }, '2026-11-26')).toBe('2026-11-01');
      expect(helpers.firstDeliveryDueDateOf({ status: 'draft', due_date: '2026-12-10' }, '2026-11-26')).toBe('2026-12-10');
      expect(helpers.firstDeliveryDueDateOf({ status: 'draft', due_date: null }, '2026-11-26')).toBeNull();
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const claim = (updates.invoices || []).find((u) => u.status === 'sending');
      expect(String(claim.due_date?.sql || '')).toContain('AND due_date < ?::date THEN ?::date ELSE due_date END');
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      expect(source).toContain('.where((q) => { if (hold.active) q.where({ status: previousInvoiceStatus }); })');
      // the fingerprint confirms the due date the first delivery carries
      expect(source).toContain("require('../services/invoice-helpers').firstDeliveryDueDateOf(inv, etDateString()),");
    });

    test('Send report on a held report with no early-release confirmation (the technician completion screen) asks first', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, '/admin/projects/project-1/send', {});
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_changed');
      });
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });

    test('a first held send replayed after it succeeded (a lost response) sends no second invoice', async () => {
      // the report is now held from the first send; the replay carries the first preview's fingerprint
      mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_changed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a hold is refused when the report email handoff would stop the recipient (another contact slot declined the address)', async () => {
      ProjectEmail.dispatchBoundaryCheck.mockResolvedValueOnce(false);
      mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(await res.json())).toMatch(/No email on file that accepts email/);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(ProjectEmail.dispatchBoundaryCheck).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'customer-1' }));
    });

    test('the report email handoff applies the address-wide email rule under its locks', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const args = ProjectEmail.sendProjectReportReady.mock.calls[0][0];
      ProjectEmail.dispatchBoundaryCheck.mockResolvedValueOnce(false);
      const dispatch = jest.fn();
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(dispatch).not.toHaveBeenCalled();
      expect(args.handoffState.boundaryBlock).toEqual({ code: 'REPORT_RECIPIENT_DECLINED' });
    });

    test('a held draft is priced from the locked project: a fee changed to $0 since the preflight creates no draft', async () => {
      const zeroFee = wdoProject({ invoice_id: null, findings: { ...FINDINGS, inspection_fee: '0' } });
      mockTables({ project: wdoProject({ invoice_id: null }), invoice: null });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects') c.forUpdate = jest.fn(() => ({ ...c, first: jest.fn(async () => zeroFee) }));
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true, prepare_invoice: true });
        expect((await res.json()).code).toBe('wdo_no_charge');
      });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });

    test('a hold is refused when the photos changed after signing (the paid release would refuse)', async () => {
      const project = wdoProject();
      const sig = typeof project.wdo_signature === 'string' ? JSON.parse(project.wdo_signature) : project.wdo_signature;
      const signed = wdoProject({ wdo_signature: { ...sig, photo_set_hash: 'signed-over-other-photos' } });
      // the hold request is refused before any invoice goes out
      mockTables({ project: signed });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(await res.json())).toMatch(/Photos changed after signing/);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('one confirmation sends a held invoice once: a replayed resend after it succeeded refuses', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }) });
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), heldResendBodyFor())).status).toBe(200); });
      expect((updates.projects || []).some((u) => String(u.delivery_channels?.sql || '').includes("'held_invoice_sends'"))).toBe(true);
      // the replay finds the count moved since the confirmation
      ProjectEmail.sendProjectInvoiceBeforeReport.mockClear();
      mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1', delivery_channels: { held_invoice_sends: 1 } }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), heldResendBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_invoice_changed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('the release publishes only while the project keeps the customer and invoice its email verified', async () => {
      const { updates } = mockTables({
        project: wdoProject({ report_hold_status: 'held' }),
        invoice: invoiceRow({ status: 'paid' }),
        // an account merge moved the project after the email: the fenced finalize writes nothing
        projectUpdateResult: (u) => (u.report_hold_status === 'released' ? 0 : 1),
      });
      const base = db.getMockImplementation();
      const finalizeWheres = [];
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects') {
          const where = c.where;
          c.where = jest.fn((arg) => { finalizeWheres.push(arg); return where.call(c, arg); });
        }
        return c;
      });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).not.toBe(true);
      expect(finalizeWheres).toContainEqual({ customer_id: 'customer-1', invoice_id: 'inv-1' });
      // still held, and the emailed link is taken back
      const reverted = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(reverted).toBeTruthy();
      expect(reverted.report_token).toBeNull();
    });

    test('a plain combined send claims the invoice with its own token, and gives back only that claim', async () => {
      const { updates } = mockTables({ project: wdoProject({ invoice_id: 'inv-1' }) });
      ProjectEmail.sendProjectReportWithInvoice.mockResolvedValueOnce({ ok: false, deliveryOutcome: 'not_sent', error: 'down' });
      sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, error: 'down' });
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), {}); });
      expect(ProjectEmail.sendProjectReportWithInvoice).toHaveBeenCalled();
      const invoiceUpdates = updates.invoices || [];
      expect(invoiceUpdates[0]).toEqual(expect.objectContaining({ status: 'sending', send_claim_token: INVOICE_CLAIM }));
      expect(invoiceUpdates.some((u) => u.status !== 'sending' && u.send_claim_token === null)).toBe(true);
    });

    test('a held completion keeps the recommendations out of the visit note until the paid release', () => {
      const { completionTechnicianNotes } = jest.requireActual('../services/project-completion');
      const project = wdoProject({ title: 'WDO inspection', recommendations: 'Treat the garage door frame.' });
      expect(completionTechnicianNotes(project, { reportHeld: true })).not.toMatch(/garage door frame/);
      expect(completionTechnicianNotes(project)).toMatch(/Treat the garage door frame/);
    });

    test('a hold is refused when the report address is on the email suppression list', async () => {
      ProjectEmail.reportEmailSuppressed.mockResolvedValueOnce(true);
      mockTables();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(await res.json())).toMatch(/accepts email/);
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a held report sent another way takes back its link in the same write', () => {
      const fields = projectsRouter._private.heldReleaseFieldsInSql
        ? projectsRouter._private.heldReleaseFieldsInSql('sent_outside')
        : null;
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      expect(source).toContain("report_token: whenHeld('report_token', 'NULL'),");
      if (fields) expect(fields.report_token.sql).toBe("CASE WHEN report_hold_status = 'held' THEN NULL ELSE report_token END");
    });

    test('both invoice handoffs refuse once this send no longer owns the invoice claim', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
      await ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0].withProviderHandoff(jest.fn());
      const opts = require('../services/billing-channel-email-authority').dispatchUnderBillingEmailAuthority.mock.calls.at(-1)[0];
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
      const world = () => mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token, report_token: null }), invoice: invoiceRow({ status: 'sending', send_claim_token: '00000000-0000-4000-8000-0000000000ff' }) });
      world();
      expect(await opts.preSendCheck({ database: db })).toMatchObject({ ok: false, code: 'HELD_SEND_SUPERSEDED' });
      world();
      const dispatch = jest.fn();
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false }));
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('a plain Send report confirmed as a first send refuses a report sent meanwhile', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'released', status: 'sent', sent_at: '2026-11-26T10:00:00Z' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'none', expected_sent: false });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('report_already_sent');
      });
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      expect(source).toContain("if (confirmedFirstSend) sendClaimQuery.whereNull('sent_at').whereRaw(\"status IS DISTINCT FROM 'sent'\");");
      const client = require('fs').readFileSync(require('path').join(__dirname, '../../client/src/pages/admin/ProjectsPage.jsx'), 'utf8');
      expect(client).toContain('expected_sent: project.status === "sent",');
    });

    test('a held send claims the invoice with its own token, and settles or finalizes only that claim', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const claim = (updates.invoices || []).find((u) => u.status === 'sending');
      expect(claim.send_claim_token).toBe(INVOICE_CLAIM);
      expect(InvoiceService.markDeliverySent).toHaveBeenCalledWith('inv-1', expect.objectContaining({ claimToken: claim.send_claim_token }));
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      expect(source).toContain("await db('invoices').where(invoiceClaimWhere(invoice.id, claimToken)).update({ ...update, updated_at: db.fn.now() })");
      expect(source).not.toMatch(/db\('invoices'\)\.where\(\{ id: invoice\.id, status: 'sending' \}\)/);
    });

    test('the filing is saved before the report email goes out', async () => {
      const order = [];
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: null }), invoice: invoiceRow({ status: 'paid' }) });
      const realUpdate = updates;
      ProjectEmail.sendProjectReportReady.mockImplementationOnce(async () => {
        order.push(['email', (realUpdate.projects || []).some((u) => String(JSON.stringify(u.delivery_channels?.bindings || '')).includes('release_filing'))]);
        return { ok: true, messageId: 'm1' };
      });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(order).toEqual([['email', true]]);
    });

    test('a link taken back and minted again gets a new report email key', async () => {
      const keyFor = async (token) => {
        ProjectEmail.sendProjectReportReady.mockClear();
        mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: token }), invoice: invoiceRow({ status: 'paid' }) });
        await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
        return ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey;
      };
      const a = await keyFor('a'.repeat(32));
      expect(await keyFor('a'.repeat(32))).toBe(a);
      expect(await keyFor('c'.repeat(32))).not.toBe(a);
    });

    test('the draft payer lookup runs on the open transaction', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      expect(source).toContain('await assertHoldMintable(project, holdRequested, { database: trx, linkedInvoiceId, locked });');
    });

    test('the key moves only when the email ledger shows this key ended in a bounce or drop', async () => {
      const counted = (u) => String(u.delivery_channels?.sql || '').includes('release_email_blocks');
      // the ledger answers the key with its terminal failed row: a fresh copy may go next time
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, deduped: true, reason: 'bounced' });
      let { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect((updates.projects || []).some(counted)).toBe(true);
      // a plain error (a template or database read failed): the key stays, an accepted earlier copy is found next time
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'template lookup failed', deliveryOutcome: 'not_sent' });
      ({ updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) }));
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect((updates.projects || []).some(counted)).toBe(false);
    });

    test('a refused held send never relinks the project to the invoice it named', async () => {
      const relinks = [];
      mockTables({ project: wdoProject({ invoice_id: 'inv-1' }), invoice: invoiceRow({ id: 'inv-2' }) });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'projects') {
          const u = c.update;
          c.update = jest.fn(async (payload) => { if (payload && payload.invoice_id === 'inv-2') relinks.push(payload); return u(payload); });
        }
        return c;
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor({ invoice_id: 'inv-2', expected_billing_fingerprint: 'stale' }));
        expect(res.status).toBe(409);
      });
      expect(relinks).toEqual([]);
    });

    test('an address-only correction on the invoice changes the confirmed-bill fingerprint', () => {
      const { billingFingerprintHash } = projectsRouter._private;
      expect(billingFingerprintHash(invoiceRow({ customer_address_snapshot: { line1: '1 Old St' } })))
        .not.toBe(billingFingerprintHash(invoiceRow({ customer_address_snapshot: { line1: '2 New St' } })));
    });

    test('a staff release judges missing details on the claimed row: no override reason, no send', async () => {
      // the inspection date was cleared after the screen read (and the report re-signed)
      const undatedSigned = () => wdoProject({
        report_hold_status: 'held', project_date: null,
        wdo_signature: JSON.stringify({ image: PNG_DATA_URL, signer_name: 'Adam B', content_hash: expectedContentHash(FINDINGS, null) }),
      });
      mockTables({ project: undatedSigned(), invoice: invoiceRow({ status: 'paid' }) });
      const result = await releaseHeldProjectReport('project-1', { source: 'manual_send', readinessOverride: false });
      expect(result.released).toBe(false);
      expect(result.reason).toMatch(/Missing details/);
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      // with a reason given, the same row sends
      mockTables({ project: undatedSigned(), invoice: invoiceRow({ status: 'paid' }) });
      expect((await releaseHeldProjectReport('project-1', { source: 'manual_send', readinessOverride: true })).released).toBe(true);
    });

    test('the release and the visit history link commit together: a failed visit write records no release', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held', service_record_id: 'sr-1', report_token: 'tok-1' }), invoice: invoiceRow({ status: 'paid' }) });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'service_records'
        ? chain({ update: jest.fn(async () => { throw new Error('connection reset'); }) })
        : base(table)));
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
    });
  });

  describe('audit round 27', () => {
    test('a crash after the email handoff began (queued, in progress) keeps the key: no second FDACS email', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'email send held by provider_retry_in_progress' });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const writes = updates.projects || [];
      expect(writes.some((u) => String(u.delivery_channels?.sql || '').includes('release_email_blocks'))).toBe(false);
      expect(writes.some((u) => String(u.delivery_channels?.sql || '').includes('release_email_unknown'))).toBe(true);
    });

    test.each([['paid', {}], ['voided', { status: 'void' }], ['fully credited', { credit_applied: 175 }]])(
      'an invoice %s from the email before the text skips the pay-link text',
      async (_label, patch) => {
        const { updates } = mockTables();
        await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
        const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
        const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
        mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token }), invoice: invoiceRow({ status: 'paid', ...patch }) });
        const dispatch = jest.fn();
        expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false }));
        expect(dispatch).not.toHaveBeenCalled();
      },
    );

    test('the pay-link text still goes when the invoice is open', async () => {
      const { updates } = mockTables();
      await withServer(async (baseUrl) => { expect((await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor())).status).toBe(200); });
      const token = (updates.projects || []).find((u) => u.delivery_status === 'sending').delivery_claim_token;
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'admin_project_report_with_invoice')[0];
      mockTables({ project: wdoProject({ report_hold_status: 'held', delivery_claim_token: token }), invoice: invoiceRow({ status: 'sent' }) });
      const dispatch = jest.fn(async () => ({ ok: true }));
      expect(await sms.withSmsHandoff(dispatch)).toEqual({ ok: true });
    });
  });

  describe('advisor redesign phase 4: a crashed release is handed back wherever its claim is cleared', () => {
    test('an edit that clears a crashed claim also gives a releasing report back to held', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-projects.js'), 'utf8');
      const fn = source.slice(source.indexOf('async function lockProjectForPhotoMutation('), source.indexOf('async function flagWdoSignatureStaleForPhotos('));
      expect(fn).toContain("report_hold_status: db.raw(\"CASE WHEN report_hold_status = 'releasing' THEN 'held' ELSE report_hold_status END\")");
      expect(fn).toContain("report_hold_locked_at: db.raw(\"CASE WHEN report_hold_status = 'releasing' THEN NULL ELSE report_hold_locked_at END\")");
    });
  });

  describe('advisor redesign phase 2: the link goes live only once the email is accepted', () => {
    const { resolveProjectPortalAttachment } = require('../services/project-completion');

    test('the publish step keeps the report hidden; the delivered write shows it; the visit link follows delivery', async () => {
      resolveProjectPortalAttachment.mockResolvedValueOnce({ portalAttached: true, portalAttachReason: 'ok', completionProfile: null });
      const order = [];
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', service_record_id: 'sr-1', report_token: 'c'.repeat(32) }), invoice: invoiceRow({ status: 'paid' }) });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'service_records') c.update = jest.fn(async () => { order.push('visit_link'); return 1; });
        if (table === 'projects') {
          const up = c.update;
          c.update = jest.fn(async (payload) => { if (payload.report_hold_status === 'released') order.push('released'); return up(payload); });
        }
        return c;
      });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      const projectUpdates = updates.projects || [];
      const stamp = projectUpdates.find((u) => typeof u.report_token === 'string' && 'portal_visible' in u);
      expect(stamp.portal_visible).toBe(false);
      const released = projectUpdates.find((u) => u.report_hold_status === 'released');
      expect(released.portal_visible).toBe(true);
      expect(order).toEqual(['released', 'visit_link']);
    });

    test('a report email that definitely failed takes back the link this attempt minted', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'rejected', blocked: true });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: null }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).toEqual(expect.objectContaining({ report_token: null }));
    });

    test('a report email of unknown outcome keeps the link (the customer may hold it)', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'email send held by provider_retry_ambiguous' });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: null }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).not.toHaveProperty('report_token');
    });

    test('a failed email never touches a link that existed before this attempt', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'rejected', blocked: true });
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', report_token: 'b'.repeat(32) }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).not.toHaveProperty('report_token');
    });
  });

  describe('round 19: report recipient at handoff, notes in the fingerprint, failed resend', () => {
    test('the release email re-reads its recipient under the customer lock: a corrected address refuses the old one', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const args = ProjectEmail.sendProjectReportReady.mock.calls[0][0];
      expect(typeof args.withProviderHandoff).toBe('function');
      const dispatch = jest.fn();
      const base = db.getMockImplementation();
      const shared = [];
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'customers') c.forShare = jest.fn(() => { shared.push(table); return c; });
        return c;
      });
      // unchanged: it dispatches, with the customer row held FOR SHARE through the dispatch
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: true });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(shared.length).toBeGreaterThan(0);
      // staff corrected the email during the PDF work: refused, nothing dispatched
      ProjectEmail.resolveProjectEmailRecipientForSend.mockResolvedValueOnce({ email: 'corrected@example.com', name: '', role: 'primary' });
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(args.handoffState.boundaryBlock).toEqual({ code: 'REPORT_RECIPIENT_CHANGED' });
    });

    test('an earlier report email of unknown outcome: the sweep keeps its key, a staff Send report approves a fresh copy', async () => {
      const held = 'email send held by provider_retry_ambiguous';
      // the sweep: no counter move, the key stays held
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: held });
      const sweep = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const counted = (u) => String(u.delivery_channels?.sql || '').includes('release_email_blocks');
      expect((sweep.updates.projects || []).some(counted)).toBe(false);
      // ...and the outcome is recorded, so a later staff press knows a new copy is wanted
      const flagged = (u) => String(u.delivery_channels?.sql || '').includes('release_email_unknown');
      expect((sweep.updates.projects || []).some(flagged)).toBe(true);
      // a staff Send report with that record: the counter moves first, so this send mints a new key
      ProjectEmail.sendProjectReportReady.mockClear();
      const manual = mockTables({ project: { ...wdoProject({ report_hold_status: 'held', delivery_channels: { release_email_unknown: true } }), invoice_id: 'inv-1' }, invoice: invoiceRow() });
      await withServer(async (baseUrl) => (await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' })).json());
      expect((manual.updates.projects || []).some(counted)).toBe(true);
      expect(ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey).toMatch(/:b1$/);
    });

    test('a staff Send report whose email outcome is unknown does not move the key: the automatic retry cannot send a second copy', async () => {
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, error: 'email send held by provider_retry_ambiguous' });
      const manual = mockTables({ project: { ...wdoProject({ report_hold_status: 'held' }), invoice_id: 'inv-1' }, invoice: invoiceRow() });
      const body = await withServer(async (baseUrl) => (await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' })).json());
      expect((manual.updates.projects || []).some((u) => String(u.delivery_channels?.sql || '').includes('release_email_blocks'))).toBe(false);
      expect(body.sent).toBe(false);
      expect(body.channels.email.error).toMatch(/press Send report again/);
    });

    test('the report handoff refuses when the project moved to another customer or this attempt lost its claim', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const args = ProjectEmail.sendProjectReportReady.mock.calls[0][0];
      const dispatch = jest.fn();
      mockTables({ project: wdoProject({ customer_id: 'customer-2' }) });
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      mockTables({ project: null });
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      mockTables({ customer: { ...CUSTOMER, deleted_at: '2026-11-25T00:00:00Z' } });
      expect(await args.withProviderHandoff(dispatch)).toEqual({ ok: false });
      expect(dispatch).not.toHaveBeenCalled();
      expect(args.handoffState.boundaryBlock).toEqual({ code: 'REPORT_OWNER_CHANGED' });
    });

    test('the release text holds the number on the customer row through the provider request (a corrected phone vetoes)', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'project_report_hold_release')[0];
      expect(typeof sms.withSmsHandoff).toBe('function');
      const dispatch = jest.fn(async () => ({ ok: true, sid: 'SM1' }));
      expect(await sms.withSmsHandoff(dispatch)).toEqual({ ok: true, sid: 'SM1' });
      mockTables({ customer: { ...CUSTOMER, phone: '9415550199' } });
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      mockTables({ project: wdoProject({ customer_id: 'customer-2' }) });
      expect(await sms.withSmsHandoff(dispatch)).toEqual(expect.objectContaining({ ok: false, code: 'RECIPIENT_CHANGED' }));
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('the release text goes to the phone as it is after the PDF and email work', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      const base = db.getMockImplementation();
      let customerReads = 0;
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'customers') {
          const original = c.first;
          c.first = jest.fn(async (...a) => {
            customerReads += 1;
            const row = await original(...a);
            return customerReads > 1 && row ? { ...row, phone: '9415550177' } : row;
          });
        }
        return c;
      });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const sms = sendCustomerMessage.mock.calls.find(([a]) => a.entryPoint === 'project_report_hold_release')?.[0];
      expect(sms?.to).toMatch(/9415550177$/);
    });

    test('both hold texts are allowed their locked handoff by the sender, and only as hold texts', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../services/messaging/send-customer-message.js'), 'utf8');
      expect(source).toContain("{ purpose: 'support_resolution', entryPoint: 'project_report_hold_release', messageType: 'project_report', heldMark: false },");
      expect(source).toContain("{ purpose: 'payment_link', entryPoint: 'admin_project_report_with_invoice', messageType: 'invoice', heldMark: true },");
      expect(source).toContain('|| reportHoldSmsHandoffAllowed(input);');
    });

    test('a failure bell raised just after a release finished is closed again', async () => {
      const holdService = require('../services/project-report-hold');
      const raise = jest.spyOn(holdService, 'raiseReleaseFailedBell').mockResolvedValue(true);
      const close = jest.spyOn(holdService, 'closeReleaseFailedBell').mockResolvedValue();
      // the release fails (no PDF) and the revert finds the row held; the marker write then finds it released
      mockTables({
        project: wdoProject({ report_hold_status: 'held' }),
        invoice: invoiceRow({ status: 'paid' }),
        projectUpdateResult: (payload) => (payload.delivery_channels?.sql?.includes('release_bell') ? 0 : 1),
      });
      buildWdoReportPDFBuffer.mockRejectedValueOnce(new Error('render failed'));
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(raise).toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith('project-1');
      raise.mockRestore();
      close.mockRestore();
    });

    test('a release that crashed counts as a failed attempt with a reason', async () => {
      const holdService = require('../services/project-report-hold');
      const updates = [];
      db.mockImplementation(() => chain({ update: jest.fn(async (payload) => { updates.push(payload); return 1; }) }));
      await holdService._internals.recoverStaleReleasingClaims();
      expect(updates[0].report_hold_attempts).toBeTruthy();
      expect(updates[0].report_hold_last_error).toMatch(/did not finish/);
    });

    test('a requestor copy that fails makes the release partial', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'ABC Title <closing@abctitle.com>' };
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held', findings }), invoice: invoiceRow({ status: 'paid' }) });
      ProjectEmail.sendProjectReportReady
        .mockImplementationOnce(async () => ({ ok: true }))
        .mockImplementationOnce(async () => ({ ok: false, error: 'bounced' }));
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const released = (updates.projects || []).find((u) => u.report_hold_status === 'released');
      expect(released?.delivery_status).toBe('partial');
    });

    test('the manual Send report preview of a held report lists the release routing (a named billing contact gets its copy)', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'Billing Desk <billing@example.com>, ABC Title <closing@abctitle.com>' };
      mockTables({ project: { ...wdoProject({ report_hold_status: 'held', findings }), invoice_id: 'inv-1' } });
      const base = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'notification_prefs'
        ? chain({ first: jest.fn(async () => ({ billing_email: 'billing@example.com' })) })
        : base(table)));
      const body = await withServer(async (baseUrl) => (await post(baseUrl, '/admin/projects/project-1/send', { dry_run: true })).json());
      expect(body.email_routing.recipient).toBe(CUSTOMER.email);
      expect(body.email_routing.report_copies).toEqual(expect.arrayContaining(['billing@example.com', 'closing@abctitle.com']));
    });

    test('the confirmed fingerprint covers the notes the invoice PDF prints', () => {
      const { billingFingerprintHash } = projectsRouter._private;
      expect(billingFingerprintHash(invoiceRow({ notes: 'Thanks!' }))).not.toBe(billingFingerprintHash(invoiceRow({ notes: 'Pay by Friday' })));
    });

    test('a failed resend on a report that was already held says the report is still held', async () => {
      ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'handoff_refused' });
      const { activityRows } = mockTables({ project: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-1' }) });
      const body = await withServer(async (baseUrl) => (await post(baseUrl, SEND_WITH_INVOICE(), heldResendBodyFor())).json());
      expect(body.report_held).toBe(true);
      expect(activityRows.map((r) => r.action)).toContain('project_invoice_report_hold_resend_failed');
    });
  });

  describe('round 4: the release uses the send-time recipient once', () => {
    test('a service contact that declines email falls back to the holder: the email, its key and the copy exclusion all use the holder', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'Holder <holder@example.com>, ABC Title <closing@abctitle.com>' };
      mockTables({ project: wdoProject({ report_hold_status: 'held', findings }), invoice: invoiceRow({ status: 'paid' }) });
      // asked twice: the release blocker (is there an address that accepts email?) and the email itself
      const holder = { email: 'holder@example.com', name: 'Holder', role: 'primary' };
      ProjectEmail.resolveProjectEmailRecipientForSend.mockResolvedValueOnce(holder).mockResolvedValueOnce(holder);
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      const calls = ProjectEmail.sendProjectReportReady.mock.calls.map(([args]) => args);
      expect(calls[0].recipient.email).toBe('holder@example.com');
      const hashOf = (email) => require('crypto').createHash('sha1').update(email).digest('hex').slice(0, 12);
      expect(calls[0].idempotencyKey).toContain(`:${hashOf('holder@example.com')}:`);
      // the holder is named on the filing and already has the report: no second copy to them
      expect(calls.slice(1).map((c) => c.recipient.email)).toEqual(['closing@abctitle.com']);
    });
  });
});


// Pre-push audit round 2: arming is one transaction, and the release/delivery edges.
describe('audit fixes, round 2', () => {
  const holdService = require('../services/project-report-hold');
  const PayCombined = require('../services/pay-combined');

  // Records which table each FOR UPDATE read took, in order, and every conditional write's whereRaw guards.
  function trackLocks({ lockedProject = null } = {}) {
    const base = db.getMockImplementation();
    const order = [];
    const writes = [];
    db.mockImplementation((table) => {
      const c = base(table);
      if (table === 'customers') {
        c.forUpdate = jest.fn(() => { order.push('customers row'); return c; });
      }
      if (table === 'projects' || table === 'invoices') {
        const raws = [];
        const originalFirst = c.first;
        let locked = false;
        c.forUpdate = jest.fn(() => { locked = true; order.push(table); return c; });
        c.whereRaw = jest.fn((sql, bindings) => { raws.push({ sql, bindings }); return c; });
        c.first = jest.fn(async (...args) => (locked && table === 'projects' && lockedProject ? lockedProject : originalFirst(...args)));
        if (table === 'projects') {
          const originalUpdate = c.update;
          c.update = jest.fn(async (payload) => { writes.push({ payload, raws: [...raws] }); return originalUpdate(payload); });
        }
      }
      return c;
    });
    PayCombined.lockCombinedCustomerStable.mockImplementation(async () => { order.push('customer'); });
    return { order, writes };
  }

  async function markWith(project) {
    mockTables({ project });
    const base = db.getMockImplementation();
    const writes = [];
    let projectCalls = 0;
    db.mockImplementation((table) => {
      if (table !== 'projects') return base(table);
      projectCalls += 1;
      if (projectCalls === 1) return base(table);
      const write = chain({
        update: jest.fn((payload) => { writes.push(payload); return write; }),
        returning: jest.fn(async () => [{ sent_outside_portal_at: 'NOW', sent_outside_portal_by: 'admin-1', sent_outside_portal_note: null }]),
      });
      return write;
    });
    await withServer(async (baseUrl) => { await post(baseUrl, '/admin/projects/project-1/mark-sent-outside', {}); });
    return writes[0];
  }


  describe('P0: arming is ONE transaction that binds the hold to its invoice', () => {
    test('locks as a merge does (payment lock, customer, invoice, project last), and writes once naming the invoice', async () => {
      mockTables();
      const { order, writes } = trackLocks();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).report_held).toBe(true);
      });
      // the account merge's order: the customer's payment lock, the customers row (the credit writer's lock), the
      // invoice, and the project last
      expect(order.slice(0, 4)).toEqual(['customer', 'customers row', 'invoices', 'projects']);
      const stamp = writes.find((w) => w.payload.report_hold_status === 'held');
      expect(stamp.raws).toEqual(expect.arrayContaining([expect.objectContaining({
        sql: expect.stringContaining('invoice_id IS NOT DISTINCT FROM ?'),
        bindings: ['inv-1'],
      })]));
      expect(db.transaction).toHaveBeenCalled();
    });

    test('a request that read the project unheld but finds it held on ANOTHER invoice under the lock refuses and keeps the hold', async () => {
      mockTables({ project: wdoProject() });
      const { writes } = trackLocks({ lockedProject: wdoProject({ report_hold_status: 'held', invoice_id: 'inv-other' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.code).toBe('hold_invoice_locked');
      });
      expect(writes.some((w) => w.payload.report_hold_status === 'held' || w.payload.invoice_id === 'inv-1')).toBe(false);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });

    test('a report sent between the preflight and the arming (seen under the lock) is not held', async () => {
      mockTables();
      trackLocks({ lockedProject: wdoProject({ sent_at: '2026-11-24T00:00:00Z', status: 'sent' }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).code).toBe('hold_after_send');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });
  });

  describe('P1: live payer ownership is re-read under the locks, for a reused invoice too', () => {
    test('an explicit invoice for a visit that now resolves to a payer is refused before anything is promised', async () => {
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1', paymentTerms: 'due_on_receipt', snapshot: {} });
      mockTables();
      trackLocks();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).code).toBe('hold_payer_billed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('an invoice withdrawn from the homeowner (payer-billed packet) is refused', async () => {
      mockTables({ invoice: invoiceRow({ scheduled_send_error: 'payer_billed: moved to the payer' }) });
      trackLocks();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).code).toBe('hold_payer_billed');
      });
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
    });
  });

  describe('P1: the filing recorded is the one actually emailed, across a release retry', () => {
    const { Readable } = require('stream');
    const archived = (project) => ({
      s3_key: 'wdo-filings/project-1/111-FDACS-13645.pdf',
      sha256: 'abc',
      invoice_id: 'inv-1',
      content_hash: expectedContentHash(project.findings, project.project_date),
      signed_at: null,
      photo_set_hash: null,
      sent_at: '2026-11-24T10:00:00Z',
    });

    test('the archived filing reference is persisted in the same fenced update that renews the lease, before the email', async () => {
      const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }), invoice: invoiceRow({ status: 'paid' }) });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      const persisted = (updates.projects || []).find((u) => u.delivery_channels?.bindings?.[0]?.includes('release_filing'));
      expect(persisted).toBeTruthy();
      expect(persisted.report_hold_locked_at).toBe('NOW');
      expect(JSON.parse(persisted.delivery_channels.bindings[0]).release_filing.invoice_id).toBe('inv-1');
      expect((updates.projects || []).indexOf(persisted)).toBeLessThan((updates.projects || []).findIndex((u) => u.report_hold_status === 'released'));
    });

    test('a manual Send report takes over an interrupted release: the stored filing and the release email key, no second email', async () => {
      const base = wdoProject({ report_hold_status: 'releasing', delivery_status: 'sending', updated_at: '2026-11-24T09:00:00Z' });
      mockTables({ project: { ...base, invoice_id: 'inv-1', delivery_channels: { release_filing: archived(base) } }, invoice: invoiceRow({ status: 'paid' }) });
      mockS3Send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('archived-bytes')]) });
      await withServer(async (baseUrl) => { expect((await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' })).status).toBe(200); });
      expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
      const email = ProjectEmail.sendProjectReportReady.mock.calls[0][0];
      expect(Buffer.from(email.attachments[0].content, 'base64').toString()).toBe('archived-bytes');
      // the sweep's own key for this invoice, filing and recipient: the provider dedupes the sweep's earlier email
      expect(email.idempotencyKey).toMatch(/^project\.report_ready:project-1:hold_release:inv-1:[0-9a-f]{8}:[0-9a-f]{12}:[0-9a-f]{8}$/);
    });

    test('a manual Send report of a held report texts through the release marker: a takeover after the sweep texted sends no second text', async () => {
      const base = wdoProject({ report_hold_status: 'held' });
      const filing = archived(base);
      const sha = (v) => require('crypto').createHash('sha1').update(v).digest('hex').slice(0, 8);
      // per invoice, filing and link (this row's link as the release reads it)
      const mark = `inv-1:${sha([filing.content_hash, filing.signed_at, filing.photo_set_hash].map((v) => String(v ?? '')).join('|'))}:${sha(String(base.report_token || ''))}`;
      mockTables({ project: { ...base, invoice_id: 'inv-1', delivery_channels: { release_filing: filing, release_sms: mark } }, invoice: invoiceRow({ status: 'paid' }) });
      mockS3Send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('archived-bytes')]) });
      await withServer(async (baseUrl) => { expect((await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' })).status).toBe(200); });
      expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('a failed manual Send report of a held report hands it back to held, keeps its stored release state, and rings no bell', async () => {
      const holdService = require('../services/project-report-hold');
      const raise = jest.spyOn(holdService, 'raiseReleaseFailedBell');
      ProjectEmail.sendProjectReportReady.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'suppressed' });
      const { updates } = mockTables({ project: { ...wdoProject({ report_hold_status: 'held' }), invoice_id: 'inv-1' }, invoice: invoiceRow() });
      const body = await withServer(async (baseUrl) => (await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' })).json());
      expect(body.sent).toBe(false);
      const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(revert).toBeTruthy();
      // the stored release state (filing, keys, text mark) is never overwritten by a failed attempt
      expect(revert).not.toHaveProperty('delivery_channels');
      expect(revert.report_hold_attempts).toBe(0);
      expect(raise).not.toHaveBeenCalled();
      raise.mockRestore();
    });

    test('a manual Send report of a held report sends the named billing contact its copy (only the recipient is left out)', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'Billing Desk <billing@example.com>, ABC Title <closing@abctitle.com>' };
      mockTables({ project: { ...wdoProject({ report_hold_status: 'held', findings }), invoice_id: 'inv-1' }, invoice: invoiceRow() });
      const baseImpl = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'notification_prefs'
        ? chain({ first: jest.fn(async () => ({ billing_email: 'billing@example.com' })) })
        : baseImpl(table)));
      await withServer(async (baseUrl) => { expect((await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' })).status).toBe(200); });
      const recipients = ProjectEmail.sendProjectReportReady.mock.calls.map(([args]) => args.recipient?.email);
      expect(recipients).toEqual(expect.arrayContaining([CUSTOMER.email, 'billing@example.com', 'closing@abctitle.com']));
    });

    test('a retry reuses the stored filing: same bytes emailed, nothing rebuilt or re-archived, that filing recorded', async () => {
      const base = wdoProject({ report_hold_status: 'held' });
      const filing = archived(base);
      const { updates } = mockTables({ project: { ...base, delivery_channels: { release_filing: filing } }, invoice: invoiceRow({ status: 'paid' }) });
      mockS3Send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('archived-bytes')]) });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
      expect(mockS3Send).toHaveBeenCalledTimes(1); // the read of the archived object, no new put
      const email = ProjectEmail.sendProjectReportReady.mock.calls[0][0];
      expect(Buffer.from(email.attachments[0].content, 'base64').toString()).toBe('archived-bytes');
      const released = updates.projects.find((u) => u.report_hold_status === 'released');
      expect(released.wdo_sent_filings.bindings[0]).toContain('111-FDACS-13645.pdf');
    });

    test('after an edit and re-sign the stored filing is not reused: a new one is archived and the email key changes', async () => {
      const base = wdoProject({ report_hold_status: 'held' });
      const stale = { ...archived(base), content_hash: 'older-findings-hash' };
      mockTables({ project: { ...base, delivery_channels: { release_filing: stale } }, invoice: invoiceRow({ status: 'paid' }) });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      expect(buildWdoReportPDFBuffer).toHaveBeenCalledTimes(1);
      expect(mockS3Send).toHaveBeenCalledTimes(1); // the new put
      const key = ProjectEmail.sendProjectReportReady.mock.calls[0][0].idempotencyKey;
      expect(key).toMatch(/hold_release:inv-1:[0-9a-f]{8}:[0-9a-f]{12}:[0-9a-f]{8}$/);
    });

    test.each([
      ['a re-signed report (new signature revision)', { sigPatch: { signed_at: '2026-11-25T09:00:00Z' } }],
    ])('%s is not served the old signed PDF: a new filing is archived', async (_name, { sigPatch }) => {
      const base = wdoProject({ report_hold_status: 'held' });
      const stored = archived(base); // signed_at null, photo_set_hash null
      const signature = { ...JSON.parse(base.wdo_signature), ...sigPatch };
      mockTables({
        project: { ...base, wdo_signature: JSON.stringify(signature), delivery_channels: { release_filing: stored } },
        invoice: invoiceRow({ status: 'paid' }),
      });
      await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      // the stored filing no longer matches the signature: nothing is read back from S3, a new one is built and put
      expect(mockS3Send.mock.calls.some(([command]) => command.__get)).toBe(false);
      expect(buildWdoReportPDFBuffer).toHaveBeenCalledTimes(1);
    });

    test('a stored filing is reused only for the same signature revision AND photo set (checked before anything is read from S3)', async () => {
      const { resumableReleaseFiling } = require('../routes/admin-projects')._private;
      const base = wdoProject({ report_hold_status: 'held' });
      const stored = { ...archived(base), photo_set_hash: 'photos-v1' };
      const sign = (patch) => JSON.stringify({ ...JSON.parse(base.wdo_signature), photo_set_hash: 'photos-v1', ...patch });
      const withStored = (signature) => ({ ...base, wdo_signature: signature, delivery_channels: { release_filing: stored } });
      mockS3Send.mockClear();
      await expect(resumableReleaseFiling(withStored(sign({ photo_set_hash: 'photos-v2' })), { id: 'inv-1' })).resolves.toBeNull();
      await expect(resumableReleaseFiling(withStored(sign({ signed_at: '2026-11-25T09:00:00Z' })), { id: 'inv-1' })).resolves.toBeNull();
      await expect(resumableReleaseFiling(withStored(sign({})), { id: 'inv-2' })).resolves.toBeNull();
      expect(mockS3Send).not.toHaveBeenCalled();
      mockS3Send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('bytes')]) });
      await expect(resumableReleaseFiling(withStored(sign({})), { id: 'inv-1' })).resolves.toMatchObject({ filing: stored });
    });

    test('the email key names the filing: a different signature revision or photo set is a different key', () => {
      const { filingKeyPart } = require('../routes/admin-projects')._private;
      const a = filingKeyPart({ content_hash: 'h', signed_at: 't1', photo_set_hash: 'p1' });
      expect(filingKeyPart({ content_hash: 'h', signed_at: 't1', photo_set_hash: 'p1' })).toBe(a);
      expect(filingKeyPart({ content_hash: 'h', signed_at: 't2', photo_set_hash: 'p1' })).not.toBe(a);
      expect(filingKeyPart({ content_hash: 'h', signed_at: 't1', photo_set_hash: 'p2' })).not.toBe(a);
    });

    test('a read failure on a MATCHING stored filing keeps the release held: nothing is rebuilt, re-archived or emailed', async () => {
      const base = wdoProject({ report_hold_status: 'held' });
      const { updates } = mockTables({ project: { ...base, delivery_channels: { release_filing: archived(base) } }, invoice: invoiceRow({ status: 'paid' }) });
      mockS3Send.mockRejectedValueOnce(new Error('s3 timeout'));
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(false);
      expect(result.reason).toMatch(/s3 timeout/);
      expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
      expect(mockS3Send).toHaveBeenCalledTimes(1); // the failed read, no put
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held' && u.report_hold_attempts === 1)).toBe(true);
    });
  });

  describe('P1: Sent another way releases from the row as the update sees it', () => {
    test('a project read as NOT held still carries the per-row release (a hold armed after the read is released)', async () => {
      const write = await markWith(wdoProject({ report_hold_status: null }));
      expect(write.report_hold_status.sql).toContain("CASE WHEN report_hold_status = 'held'");
    });

    test('a database without the hold columns writes none', async () => {
      const project = wdoProject();
      const { report_hold_status: _a, report_hold_attempts: _b, ...legacy } = project;
      const write = await markWith(legacy);
      expect(Object.keys(write).some((k) => k.startsWith('report_hold_'))).toBe(false);
    });
  });

  describe('P1: a manual delivery closes the release-failure alert', () => {
    const closed = () => episodes.closeAdminAlertKeys.mock.calls.filter(([, keys]) => keys[0] === 'wdo-report-hold-release:project-1');

    test('Send report on a held project', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
      await withServer(async (baseUrl) => { await post(baseUrl, '/admin/projects/project-1/send', { expected_hold: 'held' }); });
      expect(closed()).toHaveLength(1);
    });


    test('Sent another way on a held project', async () => {
      await markWith(wdoProject({ report_hold_status: 'held' }));
      expect(closed()).toHaveLength(1);
    });

    test('a project that was never held closes nothing', async () => {
      mockTables({ project: wdoProject() });
      await withServer(async (baseUrl) => { await post(baseUrl, '/admin/projects/project-1/send'); });
      expect(closed()).toHaveLength(0);
    });
  });

});

describe('release sweep', () => {
  const holdService = require('../services/project-report-hold');

  test('only an invoice that is paid or prepaid and due is picked up', async () => {
    const asked = [];
    db.mockImplementation((table) => {
      const c = chain({ resolvesTo: [{ id: 'project-9' }] });
      c.whereIn = jest.fn((...args) => { asked.push({ table, args }); return c; });
      return c;
    });
    const ids = await holdService._internals.findDueHeldProjectIds(5);
    expect(ids).toEqual(['project-9']);
    expect(asked).toEqual([{ table: 'projects as p', args: ['i.status', ['paid', 'prepaid']] }]);
  });

  test('a stale releasing claim goes back to held and gives the shared delivery claim back', async () => {
    const updates = [];
    db.mockImplementation(() => chain({ update: jest.fn(async (payload) => { updates.push(payload); return 1; }) }));
    await holdService._internals.recoverStaleReleasingClaims();
    expect(updates[0]).toEqual(expect.objectContaining({ report_hold_status: 'held', delivery_claim_token: null }));
  });

  test('recovery also requires the shared delivery lease (updated_at) to be stale, so a manual send that took the release over keeps its claim', async () => {
    const wheres = [];
    db.mockImplementation(() => {
      const c = chain({ update: jest.fn(async () => 1) });
      c.where = jest.fn((...args) => { wheres.push(args); return c; });
      return c;
    });
    await holdService._internals.recoverStaleReleasingClaims();
    expect(wheres.filter(([column]) => column === 'report_hold_locked_at' || column === 'updated_at').map(([column, op]) => `${column} ${op}`).sort())
      .toEqual(['report_hold_locked_at <', 'updated_at <']);
  });

  test('the sweep hands each due project to the release', async () => {
    const projectsRouterModule = require('../routes/admin-projects');
    const spy = jest.spyOn(projectsRouterModule, 'releaseHeldProjectReport').mockResolvedValue({ released: true });
    db.mockImplementation((table) => chain({ resolvesTo: table === 'projects as p' ? [{ id: 'a' }, { id: 'b' }] : [] }));
    const result = await holdService.sweepHeldReportReleases({ limit: 5 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(result.released).toBe(2);
    spy.mockRestore();
  });

  test('backoff doubles from 5 minutes and caps at 6 hours', () => {
    expect([1, 2, 3, 4].map(holdService.reportHoldBackoffMinutes)).toEqual([5, 10, 20, 40]);
    expect(holdService.reportHoldBackoffMinutes(20)).toBe(360);
  });
});
