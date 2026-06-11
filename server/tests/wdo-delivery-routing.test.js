/**
 * WDO delivery routing: billing-contact copy + third-party report copies.
 *
 * The FDACS-13645 prints "Report Sent to Requestor and to:" as a delivery
 * claim, and the combined send's recipient resolution prefers the slot-1
 * service contact over a configured billing contact. These tests cover the
 * report_sent_to email parser and the send-with-invoice dry-run routing
 * preview (recipient / billing_copy / report_copies) the confirm dialog shows.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  mock.transaction = jest.fn();
  return mock;
});
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
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
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
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
  sendPrepGuide: jest.fn(async () => ({ ok: true, messageId: 'sg-prep' })),
  sendPortalInvite: jest.fn(async () => ({ ok: true, messageId: 'sg-invite' })),
  prepTemplateForProjectType: jest.fn(() => null),
  isPrepTemplateKey: jest.fn(() => false),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/filing.pdf'),
}));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(),
}));
jest.mock('sharp', () => jest.fn(() => ({
  stats: jest.fn().mockResolvedValue({ channels: [{ stdev: 25 }] }),
})));

const crypto = require('crypto');
const express = require('express');
const db = require('../models/db');
const projectsRouter = require('../routes/admin-projects');
const { wdoReportCopyEmails } = require('../services/wdo-report-copies');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    columnInfo: jest.fn().mockResolvedValue({ wdo_signature: {}, wdo_sent_filings: {} }),
    ...overrides,
  };
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

// Mirror of wdoContentHash in routes/admin-projects.js (see
// wdo-signature-binding.test.js for why it's deliberately duplicated).
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
  report_sent_to: 'ABC Title <closing@abctitle.com>; Jane Realtor jane@realty.com; cust@example.com',
};

function wdoProject(findings = FINDINGS) {
  return {
    id: 'project-1',
    project_type: 'wdo_inspection',
    customer_id: 'customer-1',
    status: 'draft',
    project_date: '2026-06-10',
    findings,
    wdo_signature: JSON.stringify({
      image: PNG_DATA_URL,
      signer_name: 'A',
      content_hash: expectedContentHash(findings, '2026-06-10'),
    }),
  };
}

const CUSTOMER = { id: 'customer-1', email: 'cust@example.com', first_name: 'Jane', phone: '9415550101' };

describe('wdoReportCopyEmails', () => {
  test('parses, lowercases, dedupes, and caps at 3', () => {
    const findings = {
      report_sent_to: 'A a@x.com B B@X.COM c c@x.com d d@x.com e e@x.com',
    };
    expect(wdoReportCopyEmails(findings)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  test('excludes the customer/billing recipients', () => {
    const findings = { report_sent_to: 'closing@abctitle.com, cust@example.com' };
    expect(wdoReportCopyEmails(findings, ['CUST@example.com'])).toEqual(['closing@abctitle.com']);
  });

  test('empty/no-email text parses to nothing', () => {
    expect(wdoReportCopyEmails({ report_sent_to: 'hand-delivered at closing' })).toEqual([]);
    expect(wdoReportCopyEmails({})).toEqual([]);
    expect(wdoReportCopyEmails(null)).toEqual([]);
  });
});

describe('send-with-invoice dry-run email routing preview', () => {
  function mockTables({ prefs = null } = {}) {
    const project = wdoProject();
    db.mockImplementation((table) => {
      if (table === 'projects') return chain({ first: jest.fn().mockResolvedValue(project) });
      if (table === 'customers') return chain({ first: jest.fn().mockResolvedValue(CUSTOMER) });
      if (table === 'notification_prefs') return chain({ first: jest.fn().mockResolvedValue(prefs) });
      throw new Error(`Unexpected table query: ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(db));
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('lists third-party report copies, excluding the customer recipient', async () => {
    mockTables();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.dry_run).toBe(true);
      expect(body.email_routing).toEqual({
        recipient: 'cust@example.com',
        billing_copy: null,
        report_copies: ['closing@abctitle.com', 'jane@realty.com'],
      });
    });
  });

  test('a distinct billing contact shows as billing_copy and is excluded from report copies', async () => {
    mockTables({ prefs: { billing_email: 'books@acme.com' } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.email_routing.billing_copy).toBe('books@acme.com');
      expect(body.email_routing.report_copies).toEqual(['closing@abctitle.com', 'jane@realty.com']);
    });
  });
});
