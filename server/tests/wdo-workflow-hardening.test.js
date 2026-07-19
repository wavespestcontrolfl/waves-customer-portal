/**
 * WDO workflow hardening (July 2026 audit fixes):
 *  - /send dry_run returns the email-routing preview without sending;
 *  - /send takes an atomic 'sending' claim (concurrent second POST 409s);
 *  - photo mutations on a signed WDO flag the signature stale in the same
 *    transaction (the FDACS photo addendum sits outside the content hash);
 *  - a future project_date on a WDO/pre-treat legal document 422s;
 *  - an undecodable signature image fails CLOSED (400), not open.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();
const mockSharpStats = jest.fn();

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
jest.mock('sharp', () => jest.fn(() => ({ stats: mockSharpStats })));

const crypto = require('crypto');
const express = require('express');
const db = require('../models/db');
const ProjectEmail = require('../services/project-email');
const projectsRouter = require('../routes/admin-projects');
const { etDateString } = require('../utils/datetime-et');

// Mirror of wdoContentHash in routes/admin-projects.js (deliberately
// duplicated — see wdo-signature-binding.test.js).
function expectedContentHash(findings, projectDate) {
  const {
    stripInternalFindingKeys,
    projectRecordedFeeValues,
    projectTypeFreeTextKeys,
  } = require('../services/project-types');
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
  const payload = JSON.stringify({
    findings: stable(stripInternalFindingKeys(findings, {
      redactValues: true,
      feeValues: projectRecordedFeeValues({ findings }),
      freeTextKeys: projectTypeFreeTextKeys('wdo_inspection'),
    }) || {}),
    project_date: projectDate,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

const FINDINGS = {
  wdo_finding: 'Visible evidence of WDO observed',
  wdo_evidence: 'Frass at garage door frame',
  property_address: '456 Palm Dr, Sarasota, FL 34236',
  inspection_scope: 'Interior, attic access, exterior perimeter',
  inspection_fee: '175',
  report_sent_to: 'Jane Realtor jane@realty.com',
};

function wdoProject(overrides = {}) {
  return {
    id: 'project-1',
    project_type: 'wdo_inspection',
    customer_id: 'customer-1',
    status: 'draft',
    project_date: '2026-06-10',
    findings: FINDINGS,
    wdo_signature: JSON.stringify({
      image: PNG_DATA_URL,
      signer_name: 'A. Licensee',
      content_hash: expectedContentHash(FINDINGS, '2026-06-10'),
    }),
    ...overrides,
  };
}

const CUSTOMER = { id: 'customer-1', email: 'cust@example.com', first_name: 'Jane', phone: '9415550101' };

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    join: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(1),
    returning: jest.fn().mockResolvedValue([{ id: 'photo-1', category: null, visit: 'primary' }]),
    columnInfo: jest.fn().mockResolvedValue({
      wdo_signature: {},
      wdo_sent_filings: {},
      portal_visible: {},
      report_hold_status: {},
      report_hold_attempts: {},
    }),
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
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function mockTables(tables) {
  db.mockImplementation((table) => tables[table] || chain());
  db.transaction.mockImplementation(async (cb) => cb(db));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSharpStats.mockResolvedValue({ channels: [{ stdev: 25 }] });
});

describe('POST /:id/send dry_run', () => {
  test('returns routing preview (recipient + report copies) without sending', async () => {
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    mockTables({
      projects,
      customers: chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }),
      notification_prefs: chain({ first: jest.fn().mockResolvedValue(null) }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.dry_run).toBe(true);
      expect(body.email_routing).toEqual({
        recipient: 'cust@example.com',
        report_copies: ['jane@realty.com'],
      });
      expect(body.releases_payment_hold).toBe(false);
      // Preview must be side-effect free: no claim, no token mint, no email.
      expect(projects.update).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });
  });

  test('a held report previews releases_payment_hold: true', async () => {
    mockTables({
      projects: chain({ first: jest.fn().mockResolvedValue(wdoProject({ report_hold_status: 'held' })) }),
      customers: chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }),
      notification_prefs: chain({ first: jest.fn().mockResolvedValue(null) }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      });
      const body = await res.json();
      const cols = await chain().columnInfo();
      expect(cols.wdo_signature).toBeDefined(); // scaffolding sanity
      expect(res.status).toBe(200);
      expect(body.releases_payment_hold).toBe(true);
    });
  });
});

describe('POST /:id/send concurrency claim', () => {
  test('second overlapping send 409s while the claim is live', async () => {
    const projects = chain({
      first: jest.fn().mockResolvedValue(wdoProject({ delivery_status: 'sending' })),
      // The claim UPDATE matches no row (already 'sending', updated recently).
      update: jest.fn().mockResolvedValue(0),
    });
    mockTables({
      projects,
      customers: chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }),
      notification_prefs: chain({ first: jest.fn().mockResolvedValue(null) }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('send_in_progress');
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });
  });

  test('send-with-invoice shares the claim: losing it 409s and returns the invoice claim', async () => {
    const projects = chain({
      first: jest.fn().mockResolvedValue(wdoProject({ delivery_status: 'sending' })),
      // The shared delivery claim matches no row — a report-only /send owns it.
      update: jest.fn().mockResolvedValue(0),
    });
    const invoices = chain({
      first: jest.fn().mockResolvedValue({
        id: 'inv-1', customer_id: 'customer-1', status: 'draft',
        total: 175, line_items: [], token: 'invtok123', invoice_number: 'WPC-1',
      }),
      update: jest.fn().mockResolvedValue(1),
    });
    mockTables({
      projects,
      invoices,
      customers: chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: 'inv-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('send_in_progress');
      // The invoice claimed 'sending' a moment earlier was returned to draft.
      expect(invoices.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
      expect(ProjectEmail.sendProjectReportWithInvoice).not.toHaveBeenCalled();
      expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
    });
  });

  test('a recovered stale claim reverts to failed, never back to sending', async () => {
    // Stale takeover: the row still says 'sending' but the claim UPDATE wins
    // (10-minute recovery window). The send then aborts on the WDO no-email
    // gate — the revert must write 'failed', not re-lock the row as 'sending'.
    const projects = chain({
      first: jest.fn().mockResolvedValue(wdoProject({ delivery_status: 'sending' })),
      update: jest.fn().mockResolvedValue(1),
    });
    mockTables({
      projects,
      customers: chain({ first: jest.fn().mockResolvedValue({ ...CUSTOMER, email: '' }) }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('email_required');
      expect(projects.update).toHaveBeenCalledWith(expect.objectContaining({ delivery_status: 'failed' }));
      const reverted = projects.update.mock.calls.filter(([payload]) => payload?.delivery_status === 'sending');
      expect(reverted).toHaveLength(1); // the claim itself — never the revert
    });
  });

  test('photo mutations 409 while a send claim is active', async () => {
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject({ delivery_status: 'sending' })) });
    const photos = chain({ update: jest.fn().mockResolvedValue(1) });
    mockTables({ projects, project_photos: photos });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-9`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'Late edit' }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('send_in_progress');
      expect(photos.update).not.toHaveBeenCalled();
    });
  });

  test('findings edits 409 while a send claim is active', async () => {
    // PUT /:id must respect the same delivery claims as photo mutations — an
    // edit mid-send would fork the emailed PDF from the live public report.
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject({ delivery_status: 'sending' })) });
    mockTables({ projects });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: { ...FINDINGS, wdo_evidence: 'Edited mid-send' } }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('send_in_progress');
    });
  });

  test('a crashed (stale) send claim is recovered by the edit lock instead of blocking forever', async () => {
    // delivery_status stuck at 'sending' with a >10-minute-old updated_at =
    // a crashed send. The mutation lock must recover it (delivery_status →
    // 'failed', token cleared) and let the operator's change proceed.
    const projects = chain({
      first: jest.fn().mockResolvedValue(wdoProject({
        delivery_status: 'sending',
        updated_at: '2026-06-01T00:00:00Z',
      })),
    });
    const photos = chain({
      first: jest.fn().mockResolvedValue({ id: 'photo-9', project_id: 'project-1', caption: 'Old caption', category: null }),
      update: jest.fn().mockResolvedValue(1),
    });
    mockTables({ projects, project_photos: photos });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-9`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'Recovered edit' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(projects.update).toHaveBeenCalledWith(expect.objectContaining({
        delivery_status: 'failed',
        delivery_claim_token: null,
      }));
      expect(photos.update).toHaveBeenCalledTimes(1);
    });
  });

  test('photo mutations 409 while the payment-hold release is delivering', async () => {
    // The release sweep claims report_hold_status='releasing' without ever
    // setting delivery_status — the photo guard must respect that claim too.
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject({ report_hold_status: 'releasing' })) });
    const photos = chain({ update: jest.fn().mockResolvedValue(1) });
    mockTables({ projects, project_photos: photos });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-9`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'Late edit' }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('send_in_progress');
      expect(photos.update).not.toHaveBeenCalled();
    });
  });
});

describe('photo mutations flag a signed WDO signature stale', () => {
  test('PUT caption on a signed WDO flags stale in the same transaction', async () => {
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    const photos = chain({
      first: jest.fn().mockResolvedValue({ id: 'photo-1', project_id: 'project-1', caption: 'Old caption', category: 'wdo_evidence' }),
      update: jest.fn().mockResolvedValue(1),
    });
    mockTables({ projects, project_photos: photos });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'Frass at garage door frame' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.signature_stale).toBe(true);
      const sigWrite = projects.update.mock.calls.find(([arg]) => arg && arg.wdo_signature);
      expect(sigWrite).toBeDefined();
      expect(JSON.parse(sigWrite[0].wdo_signature).content_stale).toBe(true);
    });
  });

  test('a no-op caption save never flags the signature stale', async () => {
    // Opening the caption editor and saving the SAME text must not force a
    // legal re-sign — matched-but-unchanged rows are detected and skipped.
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    const photos = chain({
      first: jest.fn().mockResolvedValue({ id: 'photo-1', project_id: 'project-1', caption: 'Frass at garage door frame', category: 'wdo_evidence' }),
      update: jest.fn().mockResolvedValue(1),
    });
    mockTables({ projects, project_photos: photos });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'Frass at garage door frame' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.signature_stale).toBeUndefined();
      expect(photos.update).not.toHaveBeenCalled();
      const sigWrite = projects.update.mock.calls.find(([arg]) => arg && arg.wdo_signature);
      expect(sigWrite).toBeUndefined();
    });
  });

  test('DELETE photo on a signed WDO flags stale; unsigned project untouched', async () => {
    const signedProjects = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    const photoRow = { id: 'photo-1', project_id: 'project-1', s3_key: 'k', caption: null, category: null, visit: 'primary' };
    mockTables({
      projects: signedProjects,
      project_photos: chain({ first: jest.fn().mockResolvedValue(photoRow), del: jest.fn().mockResolvedValue(1) }),
    });
    mockS3Send.mockResolvedValue({});
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.signature_stale).toBe(true);
    });

    // Unsigned WDO: no signature write, no stale flag in the response.
    const unsignedProjects = chain({ first: jest.fn().mockResolvedValue(wdoProject({ wdo_signature: null })) });
    mockTables({
      projects: unsignedProjects,
      project_photos: chain({ first: jest.fn().mockResolvedValue(photoRow), del: jest.fn().mockResolvedValue(1) }),
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.signature_stale).toBeUndefined();
      const sigWrite = unsignedProjects.update.mock.calls.find(([arg]) => arg && arg.wdo_signature);
      expect(sigWrite).toBeUndefined();
    });
  });

  test('POST photo upload on a signed WDO flags stale', async () => {
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    mockTables({ projects });
    mockS3Send.mockResolvedValue({});
    await withServer(async (baseUrl) => {
      const form = new FormData();
      form.append('photo', new Blob([PNG_BYTES], { type: 'image/png' }), 'damage.png');
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
        body: form,
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.signature_stale).toBe(true);
      const sigWrite = projects.update.mock.calls.find(([arg]) => arg && arg.wdo_signature);
      expect(sigWrite).toBeDefined();
      expect(JSON.parse(sigWrite[0].wdo_signature).content_stale).toBe(true);
    });
  });
});

describe('future project_date clamp (legal-document types)', () => {
  test('PUT with a future date on a WDO 422s project_date_in_future', async () => {
    mockTables({
      projects: chain({ first: jest.fn().mockResolvedValue(wdoProject()) }),
    });
    const future = new Date(Date.now() + 30 * 24 * 3600e3).toISOString().slice(0, 10);
    expect(future > etDateString()).toBe(true);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_date: future }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('project_date_in_future');
    });
  });

  test("today's ET date is accepted", async () => {
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    mockTables({ projects });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_date: etDateString() }),
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('signature ink check fails closed', () => {
  test('an undecodable image 400s instead of saving as "signed"', async () => {
    mockSharpStats.mockRejectedValue(new Error('unsupported image format'));
    const projects = chain({ first: jest.fn().mockResolvedValue(wdoProject({ wdo_signature: null })) });
    mockTables({ projects });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/wdo-signature`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature: PNG_DATA_URL, signer_name: 'A. Licensee', signer_id_card: 'JF123456' }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.code).toBe('signature_blank');
      const sigWrite = projects.update.mock.calls.find(([arg]) => arg && arg.wdo_signature);
      expect(sigWrite).toBeUndefined();
    });
  });
});
