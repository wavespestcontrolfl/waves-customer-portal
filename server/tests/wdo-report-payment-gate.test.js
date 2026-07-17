/**
 * WDO report payment hold — "pay before you get the report".
 *
 * Covers the three trust boundaries of the gate:
 *  1. The gated send (/send-with-invoice hold_report_until_paid): invoice +
 *     pay link go out, NO report artifact moves (no FDACS build, no filing
 *     archive, no report link in any channel), and the hold is stamped.
 *  2. The release (releaseHeldProjectReport): fires only on a settled
 *     invoice, re-runs the signature gates, delivers the report, archives
 *     the filing, and stamps released; failures revert to held with backoff.
 *  3. The public token routes: a held report serves 402 payment-required
 *     (with the pay link) instead of any report content.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();
const mockGates = { wdoReportPaymentHold: true };

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
  isEnabled: jest.fn((gate) => (gate in mockGates ? mockGates[gate] : true)),
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
const PayerService = require('../services/payer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { buildWdoReportPDFBuffer } = require('../services/pdf/wdo-report-pdf');
const logger = require('../services/logger');
const projectsRouter = require('../routes/admin-projects');
const reportsRouter = require('../routes/reports-public');
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

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/projects', projectsRouter);
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Mirror of wdoContentHash in routes/admin-projects.js (deliberately
// duplicated — see wdo-signature-binding.test.js).
function expectedContentHash(findings, projectDate) {
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
  const payload = JSON.stringify({ findings: stable(findings), project_date: projectDate });
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

const PRE_TREATMENT_FINDINGS = {
  treatment_address: '456 Palm Dr, Sarasota, FL 34236',
  treatment_method: 'Soil barrier (chemical)',
  product_name: 'Termidor SC',
  active_ingredient: 'fipronil',
  concentration_pct: '0.060',
  square_footage: '2200',
  gallons_applied: '220',
  applicator_name: 'Adam B',
  applicator_fdacs_id: 'JF111111',
  applicator_attestation: 'I certify this treatment record is true and complete.',
};

function wdoProject(overrides = {}) {
  const findings = overrides.findings || FINDINGS;
  return {
    id: 'project-1',
    project_type: 'wdo_inspection',
    customer_id: 'customer-1',
    status: 'review',
    project_date: '2026-06-10',
    report_token: '0123456789abcdef0123456789abcdef',
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

function preTreatmentProject(overrides = {}) {
  return wdoProject({
    project_type: 'pre_treatment_termite_certificate',
    wdo_signature: null,
    findings: PRE_TREATMENT_FINDINGS,
    ...overrides,
  });
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
  smsRows = [],
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
    if (table === 'notification_prefs') return chain({ first: jest.fn(async () => null) });
    if (table === 'sms_log') {
      const filters = { where: [], raw: [] };
      const c = chain();
      c.where = jest.fn((value) => { filters.where.push(value); return c; });
      c.whereRaw = jest.fn((sql, bindings) => { filters.raw.push({ sql, bindings }); return c; });
      c.first = jest.fn(async () => {
        const releaseKey = filters.raw.find((r) => r.sql.includes('report_hold_release_key'))?.bindings?.[0];
        if (releaseKey) {
          return smsRows.find((row) => {
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
            return meta.report_hold_release_key === releaseKey;
          }) || null;
        }
        const scheduledId = filters.raw.find((r) => r.sql.includes('scheduled_sms_log_id'))?.bindings?.[0];
        if (scheduledId) {
          return smsRows.find((row) => {
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
            return String(meta.scheduled_sms_log_id || '') === String(scheduledId)
              && ['queued', 'sent', 'delivered'].includes(row.status);
          }) || null;
        }
        return null;
      });
      c.insert = jest.fn(async (row) => { smsRows.push({ ...row }); return [1]; });
      c.update = jest.fn(async (payload) => {
        const id = filters.where.find((value) => value?.id)?.id;
        const row = smsRows.find((candidate) => candidate.id === id);
        if (row) Object.assign(row, payload);
        return row ? 1 : 0;
      });
      return c;
    }
    if (table === 'project_photos') return chain({ resolvesTo: [] });
    if (table === 'technicians') return chain({ first: jest.fn(async () => null) });
    if (table === 'activity_log') return chain({ insert: jest.fn(async (row) => { activityRows.push(row); return [1]; }) });
    if (table === 'service_records') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
  db.transaction.mockImplementation(async (cb) => cb(db));
  return { updates, smsRows, activityRows };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.fn.now.mockReturnValue('NOW');
  db.raw.mockImplementation((sql, bindings) => ({ sql, bindings }));
  mockGates.wdoReportPaymentHold = true;
});

describe('scheduled pre-treatment application prefill', () => {
  test('maps the appointment service defaults into editable product applications', async () => {
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        return chain({
          first: jest.fn(async () => ({
            id: 'sched-55',
            customer_id: 'customer-1',
            technician_id: 'tech-1',
            service_id: 'service-1',
            service_type: 'Termite Pretreatment Service',
          })),
        });
      }
      if (table === 'scheduled_service_addons') return chain({ resolvesTo: [] });
      if (table === 'services') {
        return chain({
          resolvesTo: [{
            id: 'service-1',
            name: 'Termite Pretreatment Service',
            default_products: ['Termidor SC', 'Bora-Care'],
          }],
        });
      }
      if (table === 'products_catalog') {
        return chain({
          resolvesTo: [
            { name: 'Termidor SC', epa_reg_number: '7969-210', active_ingredient: 'fipronil' },
            { name: 'Bora-Care', epa_reg_number: '64405-1', active_ingredient: 'borate' },
          ],
        });
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/scheduled-service/sched-55/application-prefill`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.applications).toEqual([
        expect.objectContaining({
          product_name: 'Termidor SC',
          treatment_method: 'Soil barrier (chemical)',
          epa_registration: '7969-210',
        }),
        expect.objectContaining({
          product_name: 'Bora-Care',
          treatment_method: 'Wood treatment (borate)',
          epa_registration: '64405-1',
        }),
      ]);
    });
  });
});

describe('send-with-invoice hold_report_until_paid', () => {
  test('prepare_invoice returns a durable draft for an explicit card-on-file charge without sending', async () => {
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepare_invoice: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        prepared: true,
        invoice: expect.objectContaining({ id: 'inv-1', status: 'draft', payer_billed: false }),
      }));
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(updates.projects || []).toHaveLength(0);
    });
  });

  test('self-pay hold: invoice-only delivery, hold stamped, no report artifacts', async () => {
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      expect(body.report_held).toBe(true);

      // Invoice-before-report email only — never the report templates.
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).toHaveBeenCalledTimes(1);
      const emailArgs = ProjectEmail.sendProjectInvoiceBeforeReport.mock.calls[0][0];
      expect(emailArgs.payUrl).toContain('/pay/invtok123');
      expect(emailArgs.attachments).toHaveLength(1); // invoice PDF only
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();

      // No report artifact moved: no FDACS build, no S3 filing archive.
      expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();

      // SMS carries the pay link, never the report link.
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const smsBody = sendCustomerMessage.mock.calls[0][0].body;
      expect(smsBody).toContain('/pay/invtok123');
      expect(smsBody).not.toContain('/report/project');

      // The invoice finalizes as delivered; the project does NOT become sent.
      expect(InvoiceService.markDeliverySent).toHaveBeenCalledWith('inv-1', expect.any(Object));
      const holdStamp = (updates.projects || []).find((u) => u.report_hold_status === 'held');
      expect(holdStamp).toBeTruthy();
      expect(holdStamp.status).toBeUndefined();
      expect(holdStamp.sent_at).toBeUndefined();
      expect(holdStamp.report_hold_attempts).toBe(0);
      // The public token stays dark in the portal while held.
      const tokenStamp = (updates.projects || []).find((u) => 'portal_visible' in u);
      expect(tokenStamp.portal_visible).toBe(false);
    });
  });

  test('hold is accepted for a pre-treatment certificate without a second signature', async () => {
    const { updates } = mockTables({ project: preTreatmentProject() });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      expect(body.report_held).toBe(true);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).toHaveBeenCalledTimes(1);
      expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
      expect((updates.projects || []).some((u) => u.report_hold_status === 'held')).toBe(true);
    });
  });

  test('phone-only certificate hold promises automatic release by text, not email', async () => {
    mockTables({
      project: preTreatmentProject(),
      customer: { ...CUSTOMER, email: '' },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      expect(body.report_held).toBe(true);
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      const smsBody = sendCustomerMessage.mock.calls[0][0].body;
      expect(smsBody).toMatch(/sent by text automatically/i);
      expect(smsBody).not.toMatch(/emailed automatically/i);
    });
  });

  test('pre-treatment preview builds its invoice from the appointment before a service record exists', async () => {
    const project = preTreatmentProject({
      invoice_id: null,
      scheduled_service_id: 'sched-55',
      service_record_id: null,
    });
    const createdInvoice = invoiceRow({ id: 'inv-new', total: 425, invoice_number: 'INV-2001' });
    mockTables({
      project,
      invoice: createdInvoice,
      // No reusable draft, no already-paid invoice, then the row created by
      // InvoiceService.create. This mirrors the first completion attempt.
      invoiceFirstResults: [null, null, createdInvoice],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, dry_run: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.dry_run).toBe(true);
      expect(body.invoice).toEqual(expect.objectContaining({ id: 'inv-new', total: 425 }));
      expect(InvoiceService.buildLineItemsForScheduledService).toHaveBeenCalledWith(
        'sched-55',
        expect.objectContaining({ fallbackDescription: expect.stringMatching(/Pre-Treatment/i) }),
      );
      expect(InvoiceService.create).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'customer-1',
        scheduledServiceId: 'sched-55',
        serviceRecordId: undefined,
      }));
    });
  });

  test('hold is rejected for ordinary non-compliance projects', async () => {
    mockTables({
      project: wdoProject({ project_type: 'pest_inspection', wdo_signature: null }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('hold_not_supported');
    });
  });

  test('hold is rejected once the report was already delivered', async () => {
    mockTables({ project: wdoProject({ status: 'sent', sent_at: '2026-07-01T00:00:00Z' }) });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('hold_after_send');
    });
  });

  test('hold is stamped BEFORE delivery and survives a failed invoice send', async () => {
    // The stamp rides the token update (pre-delivery): a pre-existing token
    // must 402 for the whole send window, and a crash/failure after the pay
    // link went out must leave the row held for the sweep (Codex P1).
    ProjectEmail.sendProjectInvoiceBeforeReport.mockResolvedValueOnce({ ok: false, reason: 'blocked' });
    const { updates } = mockTables();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(false);
      expect(body.report_held).toBe(false);
      const projectUpdates = updates.projects || [];
      // The hold stamp is the token update itself — before any email/SMS.
      const stamp = projectUpdates.find((u) => u.report_hold_status === 'held');
      expect(stamp).toBeTruthy();
      expect(stamp.report_token).toBeTruthy();
      // The failed send does NOT un-hold the report — it stays gated.
      expect(projectUpdates.some((u) => 'report_hold_status' in u && u.report_hold_status === null)).toBe(false);
      // The invoice 'sending' claim is returned so the send can be retried.
      expect((updates.invoices || []).some((u) => u.status === 'draft')).toBe(true);
    });
  });

  test('hold on a would-be statement-accrued invoice is rejected BEFORE creating it', async () => {
    // NET-terms payer + statements gate on: InvoiceService.create would stamp
    // payer_statement_id and roll the line onto the open monthly statement —
    // the guard must fire before any invoice exists (Codex P1).
    PayerService.resolveForInvoice.mockResolvedValueOnce({
      payerId: 'payer-1',
      paymentTerms: 'net30',
      snapshot: { company_name: 'ABC Title' },
    });
    mockTables({ project: wdoProject({ invoice_id: null }) });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('hold_statement_accrued');
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  test('hold is rejected while the feature gate is off', async () => {
    mockGates.wdoReportPaymentHold = false;
    mockTables();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold_report_until_paid: true, invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('hold_not_enabled');
    });
  });
});

describe('releaseHeldProjectReport', () => {
  test('delivers the held report once the invoice is paid', async () => {
    const project = wdoProject({ report_hold_status: 'held' });
    const { updates, activityRows } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(true);
    // Claim first, release last.
    const projectUpdates = updates.projects || [];
    expect(projectUpdates[0].report_hold_status).toBe('releasing');
    const releasedStamp = projectUpdates.find((u) => u.report_hold_status === 'released');
    expect(releasedStamp).toBeTruthy();
    expect(releasedStamp.status).toBe('sent');
    expect(releasedStamp.report_hold_release_source).toBe('payment_sweep');
    // The delivered filing is archived and appended atomically.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(releasedStamp.wdo_sent_filings).toEqual(expect.objectContaining({
      sql: expect.stringContaining("coalesce(wdo_sent_filings, '[]'::jsonb)"),
    }));
    // Report email carries the FDACS PDF; SMS carries the report link.
    expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalledTimes(2); // customer + report copy
    const releaseEmail = ProjectEmail.sendProjectReportReady.mock.calls[0][0];
    expect(releaseEmail.attachments).toHaveLength(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain('/report/project/');
    expect(sendCustomerMessage.mock.calls[0][0].metadata.scheduled_sms_log_id).toBeTruthy();
    const releaseActivity = activityRows.find((row) => row.action === 'project_report_released_after_payment');
    expect(releaseActivity.metadata.report_token).toBeUndefined();
    const releaseLog = logger.info.mock.calls.find(([message]) => String(message).includes('hold release delivered'))?.[0];
    expect(releaseLog).not.toContain(project.report_token);
  });

  test('does not send the release SMS twice when the project stamp retries', async () => {
    const project = wdoProject({ report_hold_status: 'held' });
    let releaseStampFailures = 1;
    mockTables({
      project,
      invoice: invoiceRow({ status: 'paid' }),
      projectUpdateResult: (payload) => {
        if (payload.report_hold_status === 'released' && releaseStampFailures > 0) {
          releaseStampFailures -= 1;
          throw new Error('release stamp unavailable');
        }
        return 1;
      },
    });

    const first = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });
    const second = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(first.released).toBe(false);
    expect(second.released).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(second.channels.sms).toEqual({ ok: true, deduplicated: true });
  });

  test('releases a paid pre-treatment certificate by report link without a WDO PDF', async () => {
    const project = preTreatmentProject({ report_hold_status: 'held', status: 'closed' });
    const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(true);
    expect(buildWdoReportPDFBuffer).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalledTimes(1);
    expect(ProjectEmail.sendProjectReportReady.mock.calls[0][0].attachments).toEqual([]);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const releasedStamp = (updates.projects || []).find((u) => u.report_hold_status === 'released');
    expect(releasedStamp).toBeTruthy();
    expect(releasedStamp.status).toBe('closed');
  });

  test('does not release a paid certificate whose required fields were cleared while held', async () => {
    const project = preTreatmentProject({
      report_hold_status: 'held',
      status: 'closed',
      findings: { ...PRE_TREATMENT_FINDINGS, treatment_address: '' },
    });
    const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(false);
    expect(result.reason).toMatch(/Missing required certificate details/i);
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
    expect(revert).toBeTruthy();
    expect(revert.report_hold_last_error).toMatch(/Treatment address/i);
  });

  test('does not release while the invoice is unsettled, without burning an attempt', async () => {
    const project = wdoProject({ report_hold_status: 'held' });
    const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'sent' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(false);
    expect(result.reason).toBe('invoice_not_settled');
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
    expect(revert).toBeTruthy();
    expect(revert.report_hold_attempts).toBe(0);
  });

  test('blocks the release when findings were edited after signing', async () => {
    const project = wdoProject({ report_hold_status: 'held' });
    project.wdo_signature = JSON.stringify({
      image: PNG_DATA_URL,
      signer_name: 'Adam B',
      content_hash: 'stale-hash-mismatch',
    });
    const { updates } = mockTables({ project, invoice: invoiceRow({ status: 'paid' }) });

    const result = await releaseHeldProjectReport('project-1', { source: 'payment_sweep' });

    expect(result.released).toBe(false);
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    const revert = (updates.projects || []).find((u) => u.report_hold_status === 'held');
    expect(revert).toBeTruthy();
    expect(revert.report_hold_attempts).toBe(1);
    expect(revert.report_hold_last_error).toMatch(/re-sign/i);
  });
});

describe('manual /send vs in-flight release (Codex P2)', () => {
  test('manual send on a HELD report takes the claim and releases it', async () => {
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      const projectUpdates = updates.projects || [];
      // Atomic claim first (same claim the sweep takes)…
      expect(projectUpdates[0].report_hold_status).toBe('releasing');
      // …then the delivered flip to released with the manual source.
      const released = projectUpdates.find((u) => u.report_hold_status === 'released');
      expect(released).toBeTruthy();
      expect(released.report_hold_release_source).toBe('manual_send');
      expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalled();
    });
  });

  test('un-held combined resend on a HELD row claims before delivering, then releases atomically', async () => {
    const { updates } = mockTables({ project: wdoProject({ report_hold_status: 'held' }) });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: 'inv-1' }), // hold NOT requested
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(true);
      const projectUpdates = updates.projects || [];
      const claimIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'releasing');
      const releasedIdx = projectUpdates.findIndex((u) => u.report_hold_status === 'released');
      // Claim taken BEFORE any delivery work; release rides the sent-stamp
      // update itself (atomic), not a separate follow-up write.
      expect(claimIdx).toBeGreaterThanOrEqual(0);
      expect(releasedIdx).toBeGreaterThan(claimIdx);
      expect(projectUpdates[releasedIdx].status).toBe('sent');
      expect(projectUpdates[releasedIdx].report_hold_release_source).toBe('manual_send');
      expect(ProjectEmail.sendProjectReportWithInvoice).toHaveBeenCalledTimes(1);
    });
  });

  test('un-held combined resend 409s while the sweep is mid-release', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'releasing' }),
      invoice: invoiceRow({ status: 'draft' }),
      // The sweep owns the claim: only the held→releasing claim UPDATE misses.
      projectUpdateResult: (payload) => (payload.report_hold_status === 'releasing' ? 0 : 1),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('release_in_progress');
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectInvoiceBeforeReport).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  test('manual send 409s while the sweep is mid-release, and delivers nothing', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'releasing' }),
      // The row is already claimed, so the manual claim UPDATE matches 0 rows.
      projectUpdateResult: (payload) => (payload.report_hold_status === 'releasing' ? 0 : 1),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('release_in_progress');
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });
});

describe('public report routes while held', () => {
  test('/project/:token/data serves 402 payment-required with the pay link', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'held' }),
      invoice: invoiceRow({ status: 'sent' }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(402);
      expect(body.code).toBe('report_payment_required');
      expect(body.payUrl).toContain('/pay/invtok123');
      expect(body.invoiceNumber).toBe('WPC-1001');
      // No report content leaks on the 402 payload.
      expect(body.findings).toBeUndefined();
      expect(body.photos).toBeUndefined();
    });
  });

  test('402 never exposes the payer AP pay link to report-token holders', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'held' }),
      invoice: invoiceRow({ status: 'sent', payer_id: 'payer-1' }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(402);
      expect(body.code).toBe('report_payment_required');
      // The pay link routes to the payer's AP inbox only — the homeowner (or
      // a forwarded third party) never receives it, and no billing metadata
      // rides the card.
      expect(body.payUrl).toBeNull();
      expect(body.payerBilled).toBe(true);
      expect(body.invoiceNumber).toBeNull();
    });
  });

  test('402 suppresses the pay CTA and flags processing during ACH clearing', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'held' }),
      invoice: invoiceRow({ status: 'processing' }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(402);
      expect(body.code).toBe('report_payment_required');
      // pay-v2 rejects 'processing' invoices — no dead-end pay button.
      expect(body.payUrl).toBeNull();
      expect(body.paymentProcessing).toBe(true);
    });
  });

  test('/project/:token/fdacs-pdf serves 402 while held', async () => {
    mockTables({
      project: wdoProject({ report_hold_status: 'held' }),
      invoice: invoiceRow({ status: 'sent' }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/fdacs-pdf`);
      const body = await res.json();
      expect(res.status).toBe(402);
      expect(body.code).toBe('report_payment_required');
    });
  });
});
