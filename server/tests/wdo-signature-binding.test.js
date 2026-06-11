/**
 * WDO signature ↔ content binding (FDACS-13645 integrity).
 *
 * A captured licensee signature only authorizes the findings it was drawn
 * against: capture stores a content hash, findings edits flag the signature
 * stale, and both send routes refuse to stamp stale content (422
 * signature_stale) until the licensee re-signs.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();
const mockAnthropicCreate = jest.fn();

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return mock;
});
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const roles = {
      admin: { id: 'admin-1', role: 'admin' },
      'tech-1': { id: 'tech-1', role: 'technician' },
    };
    const tech = roles[token];
    if (!tech) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
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
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicCreate },
})));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(),
}));
// signatureHasInk decodes with sharp; the ink heuristic has its own concerns —
// here it just needs to pass so capture reaches the hash-binding logic.
jest.mock('sharp', () => jest.fn(() => ({
  stats: jest.fn().mockResolvedValue({ channels: [{ stdev: 25 }] }),
})));

const crypto = require('crypto');
const express = require('express');
const db = require('../models/db');
const projectsRouter = require('../routes/admin-projects');

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
    orderByRaw: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
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

// Mirror of wdoContentHash in routes/admin-projects.js. Deliberately
// duplicated: if the canonicalization or digest ever changes, this fails —
// which is the point, because a silent algorithm change would mark every
// previously captured production signature stale.
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

const PNG_DATA_URL = (() => {
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
})();

const WDO_FINDINGS = {
  wdo_finding: 'Visible evidence of WDO observed',
  wdo_evidence: 'Frass at garage door frame',
  applicator_name: 'Adam Benetti',
  applicator_fdacs_id: 'JF000000',
};

function wdoProject(overrides = {}) {
  return {
    id: 'project-1',
    project_type: 'wdo_inspection',
    customer_id: 'customer-1',
    created_by_tech_id: 'tech-1',
    status: 'draft',
    project_date: '2026-06-10',
    findings: WDO_FINDINGS,
    ...overrides,
  };
}

describe('WDO signature content binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn.now.mockReturnValue('NOW');
    mockS3Send.mockResolvedValue({});
  });

  test('signature capture stores the content hash of the signed findings', async () => {
    const project = wdoProject();
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    const colInfo = chain();
    const sigUpdate = chain();
    const projectQueries = [projectRead, colInfo, sigUpdate];
    const activityLog = chain();
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'activity_log') return activityLog;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/wdo-signature`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature: PNG_DATA_URL,
          signer_name: 'Adam Benetti',
          signer_id_card: 'JF000000',
        }),
      });
      expect(res.status).toBe(200);
      const savedArg = sigUpdate.update.mock.calls[0][0];
      const saved = JSON.parse(savedArg.wdo_signature);
      expect(saved.content_hash).toBe(expectedContentHash(WDO_FINDINGS, '2026-06-10'));
      expect(saved.content_stale).toBeUndefined();
    });
  });

  test('editing findings on a signed WDO project flags the signature stale', async () => {
    const signature = {
      image: PNG_DATA_URL,
      signer_name: 'Adam Benetti',
      signed_at: '2026-06-10T12:00:00.000Z',
      content_hash: expectedContentHash(WDO_FINDINGS, '2026-06-10'),
    };
    const editedFindings = { ...WDO_FINDINGS, wdo_finding: 'No visible signs of WDO observed' };
    const before = wdoProject({ wdo_signature: JSON.stringify(signature) });
    const after = wdoProject({ findings: editedFindings, wdo_signature: JSON.stringify(signature) });

    const projectRead = chain({ first: jest.fn().mockResolvedValue(before) });
    const projectUpdate = chain();
    const projectRefetch = chain({ first: jest.fn().mockResolvedValue(after) });
    const staleUpdate = chain();
    const projectQueries = [projectRead, projectUpdate, projectRefetch, staleUpdate];
    const activityLog = chain();
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'activity_log') return activityLog;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: editedFindings }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.signature_stale).toBe(true);
      const savedArg = staleUpdate.update.mock.calls[0][0];
      const saved = JSON.parse(savedArg.wdo_signature);
      expect(saved.content_stale).toBe(true);
      expect(saved.content_hash).toBe(signature.content_hash);
      const actions = activityLog.insert.mock.calls.map(([row]) => row.action);
      expect(actions).toContain('project_wdo_signature_stale');
    });
  });

  test('editing findings back to the signed content self-heals a stale signature', async () => {
    const signature = {
      image: PNG_DATA_URL,
      signer_name: 'Adam Benetti',
      content_hash: expectedContentHash(WDO_FINDINGS, '2026-06-10'),
      content_stale: true,
    };
    const before = wdoProject({
      findings: { ...WDO_FINDINGS, wdo_evidence: 'edited away' },
      wdo_signature: JSON.stringify(signature),
    });
    const after = wdoProject({ wdo_signature: JSON.stringify(signature) });

    const projectRead = chain({ first: jest.fn().mockResolvedValue(before) });
    const projectUpdate = chain();
    const projectRefetch = chain({ first: jest.fn().mockResolvedValue(after) });
    const unstaleUpdate = chain();
    const projectQueries = [projectRead, projectUpdate, projectRefetch, unstaleUpdate];
    const activityLog = chain();
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'activity_log') return activityLog;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: WDO_FINDINGS }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.signature_stale).toBe(false);
      const saved = JSON.parse(unstaleUpdate.update.mock.calls[0][0].wdo_signature);
      expect(saved.content_stale).toBe(false);
      const actions = activityLog.insert.mock.calls.map(([row]) => row.action);
      expect(actions).not.toContain('project_wdo_signature_stale');
    });
  });

  test('/send 422s with signature_stale when the signature is flagged stale', async () => {
    const project = wdoProject({
      wdo_signature: JSON.stringify({ image: PNG_DATA_URL, signer_name: 'A', content_stale: true }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('signature_stale');
    });
  });

  test('/send 422s with signature_stale when the content hash no longer matches', async () => {
    const project = wdoProject({
      wdo_signature: JSON.stringify({
        image: PNG_DATA_URL,
        signer_name: 'A',
        content_hash: 'deadbeef'.repeat(8),
      }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('signature_stale');
    });
  });

  test('/send still 422s with signature_required when unsigned', async () => {
    const projectRead = chain({ first: jest.fn().mockResolvedValue(wdoProject()) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('signature_required');
    });
  });

  test('/send-with-invoice 422s with signature_stale when the signature is flagged stale', async () => {
    const project = wdoProject({
      wdo_signature: JSON.stringify({ image: PNG_DATA_URL, signer_name: 'A', content_stale: true }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('signature_stale');
    });
  });

  test('a fresh hashed signature still sends (gate passes through to readiness)', async () => {
    // Signature hash matches current content — the gate must NOT 422; the next
    // gate (readiness) catches the missing-required-fields project instead,
    // proving we got past the signature check.
    const project = wdoProject({
      findings: { wdo_finding: 'No visible signs of WDO observed' },
      wdo_signature: JSON.stringify({
        image: PNG_DATA_URL,
        signer_name: 'A',
        content_hash: expectedContentHash({ wdo_finding: 'No visible signs of WDO observed' }, '2026-06-10'),
      }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    const customerRead = chain({ first: jest.fn().mockResolvedValue({ id: 'customer-1', email: 'c@example.com' }) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBeUndefined();
      expect(body.missing.map((m) => m.key)).toEqual(expect.arrayContaining(['wdo_property_address']));
    });
  });

  // Section 2 contradiction gate: "NO visible signs" (box A) must never file
  // with text still on the Section 2.B lines — box A checked over B findings
  // text is an internally contradictory legal document.
  test('/send 422s contradictory_findings when "No visible signs" coexists with Section 2.B text', async () => {
    const findings = {
      ...WDO_FINDINGS,
      wdo_finding: 'No visible signs of WDO observed',
      // wdo_evidence kept from WDO_FINDINGS — typed before the select flip
    };
    const project = wdoProject({
      findings,
      wdo_signature: JSON.stringify({
        image: PNG_DATA_URL,
        signer_name: 'A',
        content_hash: expectedContentHash(findings, '2026-06-10'),
      }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('contradictory_findings');
      expect(body.error).toMatch(/Evidence of WDO/);
    });
  });

  test('/send-with-invoice 422s contradictory_findings the same way', async () => {
    const findings = {
      ...WDO_FINDINGS,
      wdo_finding: 'No visible signs of WDO observed',
      wdo_damage: 'Galleries in sill plate',
    };
    const project = wdoProject({
      findings,
      wdo_signature: JSON.stringify({
        image: PNG_DATA_URL,
        signer_name: 'A',
        content_hash: expectedContentHash(findings, '2026-06-10'),
      }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-with-invoice`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('contradictory_findings');
    });
  });

  test('"No visible signs" with clean Section 2.B lines passes the gate (reaches readiness)', async () => {
    // Same shape as the fresh-signature pass-through test: getting the
    // readiness 422 (no `code`) proves the contradiction gate let it through.
    const findings = { wdo_finding: 'No visible signs of WDO observed', live_wdo: '   ' };
    const project = wdoProject({
      findings,
      wdo_signature: JSON.stringify({
        image: PNG_DATA_URL,
        signer_name: 'A',
        content_hash: expectedContentHash(findings, '2026-06-10'),
      }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(project) });
    const customerRead = chain({ first: jest.fn().mockResolvedValue({ id: 'customer-1', email: 'c@example.com' }) });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBeUndefined();
      expect(body.missing.map((m) => m.key)).toEqual(expect.arrayContaining(['wdo_property_address']));
    });
  });

  test('DELETE wdo-signature rejects non-WDO projects and logs the clear on WDO', async () => {
    const nonWdoRead = chain({
      first: jest.fn().mockResolvedValue(wdoProject({ project_type: 'rodent_exclusion' })),
    });
    db.mockImplementation((table) => {
      if (table === 'projects') return nonWdoRead;
      throw new Error(`Unexpected table query: ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/wdo-signature`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(400);
    });

    const signed = wdoProject({
      wdo_signature: JSON.stringify({ image: PNG_DATA_URL, signer_name: 'Adam Benetti', signed_at: '2026-06-10T12:00:00.000Z' }),
    });
    const projectRead = chain({ first: jest.fn().mockResolvedValue(signed) });
    const colInfo = chain();
    const clearUpdate = chain();
    const projectQueries = [projectRead, colInfo, clearUpdate];
    const activityLog = chain();
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'activity_log') return activityLog;
      throw new Error(`Unexpected table query: ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/wdo-signature`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      expect(clearUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ wdo_signature: null }));
      const actions = activityLog.insert.mock.calls.map(([row]) => row.action);
      expect(actions).toContain('project_wdo_signature_cleared');
    });
  });
});
