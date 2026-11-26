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
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async (_key, vars) => `Hi ${vars.first_name}, your Waves ${vars.project_type} report is ready: ${vars.report_url}`),
}));
jest.mock('../services/project-email', () => ({
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
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async () => {}),
  payerRecipient: jest.fn(() => null),
  resolveForInvoice: jest.fn(async () => null),
  freezeApEmail: jest.fn(async () => {}),
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

function invoiceRow(overrides = {}) {
  return {
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

const holdBodyFor = (extra = {}) => ({ hold_report_until_paid: true, invoice_id: 'inv-1', ...extra });

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
      // the confirm's own invoice recipient is the real one too (the contact's email switch applied)
      expect(body.email_routing.recipient).toBe('holder@example.com');
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

    test('a would-be statement-accrued invoice is refused BEFORE it is created', async () => {
      mockGates.payerStatements = true;
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1', paymentTerms: 'net30', snapshot: { company_name: 'ABC Title' } });
      mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true });
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
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true });
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
      const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
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
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(db, ['wdo-report-hold-release:project-1'], 'wdo_report_released', expect.any(Object));
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
    const project = wdoProject({ report_hold_status: 'held', report_hold_attempts: 1 });
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
      const res = await post(baseUrl, '/admin/projects/project-1/send');
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

  test('/send on a HELD report of a CLOSED project releases it and keeps the closed status', async () => {
    const { updates } = mockTables({ project: wdoProject({ status: 'closed', report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/projects/project-1/send');
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
      const res = await post(baseUrl, '/admin/projects/project-1/send');
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

  test('send-with-invoice without the hold flag on a held project delivers and releases atomically', async () => {
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, SEND_WITH_INVOICE(), { invoice_id: 'inv-1' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      const released = (updates.projects || []).find((u) => u.report_hold_status === 'released');
      expect(released).toBeTruthy();
      expect(released.status.sql).toBe("CASE WHEN status = 'closed' THEN status ELSE 'sent' END");
      expect(released.report_hold_release_source).toBe('manual_send');
      expect(ProjectEmail.sendProjectReportWithInvoice).toHaveBeenCalledTimes(1);
    });
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
      const retarget = writes.find((w) => w.payload.invoice_id === 'inv-2');
      expect(retarget).toBeTruthy();
      expect(retarget.raws).toEqual([expect.objectContaining({
        sql: expect.stringContaining("report_hold_status, '') NOT IN ('held', 'releasing')"),
        bindings: ['inv-2'],
      })]);
      // a hold whose invoice is gone (NULL) is not adopted by another bill either
      expect(retarget.raws[0].sql).not.toContain('IS NULL');
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
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true });
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
      expect(first).toMatch(/:release:[0-9a-f]{8}$/);
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

    test('an unreadable balance counts as credit (fail closed), and the arming transaction reads it again under the locks', async () => {
      const { getBalance } = require('../services/customer-credit');
      mockTables();
      getBalance.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('db blip'));
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('hold_has_credit');
      });
      getBalance.mockReset(); getBalance.mockResolvedValue(0);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
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
      expect(projectUpdates.some((u) => 'delivery_channels' in u || 'last_delivery_at' in u)).toBe(false);
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

  describe('P1: the payer lookup fails closed', () => {
    test('a lookup error refuses the hold before any invoice is created, and asks the lookup to throw', async () => {
      PayerService.resolveForInvoice.mockRejectedValueOnce(new Error('db down'));
      mockTables({ project: wdoProject({ invoice_id: null }) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), { hold_report_until_paid: true });
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
      // the link stamp, the check right before the provider calls, and the courtesy text mark
      expect(renewals).toHaveLength(3);
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

  describe('round 4: the release uses the send-time recipient once', () => {
    test('a service contact that declines email falls back to the holder: the email, its key and the copy exclusion all use the holder', async () => {
      const findings = { ...FINDINGS, report_sent_to: 'Holder <holder@example.com>, ABC Title <closing@abctitle.com>' };
      mockTables({ project: wdoProject({ report_hold_status: 'held', findings }), invoice: invoiceRow({ status: 'paid' }) });
      ProjectEmail.resolveProjectEmailRecipientForSend.mockResolvedValueOnce({ email: 'holder@example.com', name: 'Holder', role: 'primary' });
      const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
      expect(result.released).toBe(true);
      const calls = ProjectEmail.sendProjectReportReady.mock.calls.map(([args]) => args);
      expect(calls[0].recipient.email).toBe('holder@example.com');
      const hashOf = (email) => require('crypto').createHash('sha1').update(email).digest('hex').slice(0, 12);
      expect(calls[0].idempotencyKey.endsWith(hashOf('holder@example.com'))).toBe(true);
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
    test('locks the project row, then the customer payment lock, then the invoice row, and writes once naming the invoice', async () => {
      mockTables();
      const { order, writes } = trackLocks();
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, SEND_WITH_INVOICE(), holdBodyFor());
        expect((await res.json()).report_held).toBe(true);
      });
      expect(order.slice(0, 3)).toEqual(['projects', 'customer', 'invoices']);
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
      expect(key).toMatch(/hold_release:inv-1:[0-9a-f]{8}:[0-9a-f]{12}$/);
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
      await withServer(async (baseUrl) => { await post(baseUrl, '/admin/projects/project-1/send'); });
      expect(closed()).toHaveLength(1);
    });

    test('a combined send on a held project', async () => {
      mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
      await withServer(async (baseUrl) => { await post(baseUrl, SEND_WITH_INVOICE(), { invoice_id: 'inv-1' }); });
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
