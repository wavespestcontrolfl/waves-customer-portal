/**
 * Pre-treatment certificate prefill and the combined report + invoice send
 * (/send-with-invoice): prepare_invoice, the post-claim re-judge of the
 * pre-treat staff-send checks, and the dry-run invoice preview.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();
const mockGates = {};

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
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const projectsRouter = require('../routes/admin-projects');

const PROJECT_COLUMNS = {
  wdo_signature: {},
  wdo_sent_filings: {},
  portal_visible: {},
  portal_visibility: {},
  portal_attach_policy: {},
  completion_profile_snapshot: {},
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
    columnInfo: jest.fn().mockResolvedValue(PROJECT_COLUMNS),
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

const PRE_TREATMENT_FINDINGS = {
  treatment_address: '456 Palm Dr, Sarasota, FL 34236',
  treatment_time: '08:40',
  warranty_type: 'Renewable 5-year retreatment bond',
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

describe('send-with-invoice', () => {
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
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(updates.projects || []).toHaveLength(0);
    });
  });

  test('an edit that lands before the delivery claim is re-judged after it (pre-treat staff-send checks)', async () => {
    const project = preTreatmentProject();
    const { updates } = mockTables({
      project,
      // The claim takes the row; an edit committed just before it cleared the time.
      projectUpdateResult: (payload) => {
        if (payload.delivery_status === 'sending') project.findings = { ...project.findings, treatment_time: '' };
        return 1;
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.error).toContain('Time of treatment');
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
      // The catch released the delivery claim.
      expect((updates.projects || []).some((u) => u.delivery_status !== undefined && u.delivery_status !== 'sending')).toBe(true);
      expect((updates.projects || []).some((u) => u.report_token)).toBe(false);
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
      // No reusable draft, no already-paid invoice (pre-lock pass), the
      // same two misses again for the in-lock re-check (codex r5 round —
      // the advisory/visit locks repeat both checks before creating), then
      // the row created by InvoiceService.create. Mirrors the first
      // completion attempt.
      invoiceFirstResults: [null, null, null, null, createdInvoice],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.dry_run).toBe(true);
      // ADMIN-BUG-R49 fix: a non-WDO dry-run preview no longer surfaces the
      // minted draft's real id/invoice_number — it's built inside a
      // savepoint that is always rolled back, so nothing is persisted or
      // linked to the project. Only the computed total carries through.
      expect(body.invoice).toEqual(expect.objectContaining({ id: null, invoice_number: null, status: 'preview', total: 425 }));
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
});
