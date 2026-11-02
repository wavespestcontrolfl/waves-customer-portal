/**
 * "Sent another way" (GATE_WDO_MARK_SENT_OUTSIDE): POST
 * /api/admin/projects/:id/mark-sent-outside records that a signed WDO report
 * went out by some other route than the portal. Records only — sent_at stays
 * NULL, nothing is sent, no filing is archived.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockGate = { on: true };
const mockAudit = jest.fn().mockResolvedValue('audit-1');

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (cb) => cb(mock));
  return mock;
});
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  wdoMarkSentOutsideLive: jest.fn(() => mockGate.on),
}));
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: (...args) => mockAudit(...args),
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/project-email', () => ({
  PREP_TEMPLATE_BY_PROJECT_TYPE: {},
  resolveProjectEmailRecipient: jest.fn(() => ({ email: '', name: '', role: 'primary' })),
  resolvePortalInviteRecipient: jest.fn(() => ({ email: '', name: '', role: 'primary' })),
  sendProjectReportReady: jest.fn(),
  sendPrepGuide: jest.fn(),
  sendPortalInvite: jest.fn(),
  prepTemplateForProjectType: jest.fn(() => null),
  isPrepTemplateKey: jest.fn(() => false),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({ lookupPropertyFromAITrio: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const ProjectEmail = require('../services/project-email');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const projectsRouter = require('../routes/admin-projects');

const SIGNED = { image: 'data:image/png;base64,AAAA', signer_name: 'A. Licensee', signed_at: '2026-10-20T14:00:00Z' };

function baseProject(over = {}) {
  return {
    id: 'project-1',
    customer_id: 'customer-1',
    project_type: 'wdo_inspection',
    created_by_tech_id: 'tech-1',
    wdo_signature: SIGNED,
    sent_at: null,
    sent_outside_portal_at: null,
    ...over,
  };
}

function chain(overrides = {}) {
  const c = {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue([1]),
    ...overrides,
  };
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/projects', projectsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body, token = 'admin') {
  return fetch(`${baseUrl}/admin/projects/project-1/mark-sent-outside`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// Wire db() for the mark route. `current` is the project row the first read
// returns; `updateRows` is what the guarded UPDATE ... RETURNING gives back.
function wire({ current = baseProject(), updateRows = [{
  sent_outside_portal_at: '2026-11-02T15:00:00.000Z', sent_outside_portal_by: 'admin-1', sent_outside_portal_note: null,
}] } = {}) {
  const read = chain({ first: jest.fn().mockResolvedValue(current) });
  const write = chain({ returning: jest.fn().mockResolvedValue(updateRows) });
  const activity = chain();
  let projectCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'projects') { projectCalls += 1; return projectCalls === 1 ? read : write; }
    if (table === 'activity_log') return activity;
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { read, write, activity };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.on = true;
  db.fn.now.mockReturnValue('NOW');
});

describe('POST /:id/mark-sent-outside', () => {
  test('gate off -> 404 and nothing is read or written', async () => {
    mockGate.on = false;
    wire();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {});
      expect(res.status).toBe(404);
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('a technician gets 403 and nothing is written', async () => {
    const { write } = wire();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {}, 'tech-1');
      expect(res.status).toBe(403);
    });
    expect(write.update).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each([
    ['not a WDO report', { project_type: 'termite_treatment' }, 'not_wdo_report'],
    ['not signed', { wdo_signature: null }, 'not_signed'],
    ['already sent through the portal', { sent_at: '2026-10-21T10:00:00Z' }, 'already_sent'],
    ['already marked', { sent_outside_portal_at: '2026-10-22T10:00:00Z' }, 'already_marked'],
  ])('409 when the report is %s', async (_label, over, code) => {
    const { write } = wire({ current: baseProject(over) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { note: 'x' });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe(code);
    });
    expect(write.update).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('404 for an unknown project', async () => {
    wire({ current: null });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, {})).status).toBe(404);
    });
  });

  test('400 when the note is over 500 characters, 400 for a non-text note', async () => {
    const { write } = wire();
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { note: 'a'.repeat(501) })).status).toBe(400);
      expect((await post(baseUrl, { note: { x: 1 } })).status).toBe(400);
    });
    expect(write.update).not.toHaveBeenCalled();
  });

  test('a 500-character note is accepted after trimming', async () => {
    const { write } = wire();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { note: `  ${'a'.repeat(500)}  ` });
      expect(res.status).toBe(200);
    });
    expect(write.update.mock.calls[0][0].sent_outside_portal_note).toBe('a'.repeat(500));
  });

  test('success writes the three columns under the state guard, audits, and leaves sent_at alone', async () => {
    const { write, activity } = wire({
      updateRows: [{ sent_outside_portal_at: '2026-11-02T15:00:00.000Z', sent_outside_portal_by: 'admin-1', sent_outside_portal_note: 'Emailed to the closing agent' }],
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { note: '  Emailed to the closing agent  ' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({
        ok: true,
        sent_outside_portal_at: '2026-11-02T15:00:00.000Z',
        sent_outside_portal_by: 'admin-1',
        sent_outside_portal_note: 'Emailed to the closing agent',
      });
    });

    // Guarded update: same state predicate as the pre-check.
    expect(write.where).toHaveBeenCalledWith({ id: 'project-1', project_type: 'wdo_inspection' });
    expect(write.whereNotNull).toHaveBeenCalledWith('wdo_signature');
    expect(write.whereNull).toHaveBeenCalledWith('sent_at');
    expect(write.whereNull).toHaveBeenCalledWith('sent_outside_portal_at');
    const patch = write.update.mock.calls[0][0];
    expect(patch).toEqual({
      sent_outside_portal_at: 'NOW',
      sent_outside_portal_by: 'admin-1',
      sent_outside_portal_note: 'Emailed to the closing agent',
    });
    expect(patch).not.toHaveProperty('sent_at');
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('wdo_sent_filings');

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const audit = mockAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      actor_type: 'technician',
      actor_id: 'admin-1',
      action: 'wdo.report_marked_sent_outside',
      resource_type: 'project',
      resource_id: 'project-1',
      critical: true,
    });
    expect(audit.action.length).toBeLessThanOrEqual(96);
    expect(audit.trx).toBeDefined();
    expect(activity.insert).toHaveBeenCalledTimes(1);

    // Records only: no customer message, no email.
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ProjectEmail.sendProjectReportReady).not.toHaveBeenCalled();
  });

  test('an empty note is stored as NULL', async () => {
    const { write } = wire();
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, {})).status).toBe(200);
    });
    expect(write.update.mock.calls[0][0].sent_outside_portal_note).toBeNull();
  });

  test('a race (guarded update matches no row) is a 409 with no audit row', async () => {
    wire({ updateRows: [] });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {});
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('state_changed');
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('GET /:id canMarkSentOutside', () => {
  function wireDetail(project) {
    const read = chain({ first: jest.fn().mockResolvedValue({ ...project, first_name: 'A', last_name: 'B' }) });
    db.mockImplementation((table) => {
      if (table === 'projects as p') return read;
      if (table === 'project_photos') return chain({ orderBy: jest.fn().mockResolvedValue([]) });
      throw new Error(`Unexpected table query: ${table}`);
    });
  }

  async function getFlag(token = 'admin') {
    return withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      return (await res.json()).project;
    });
  }

  test('true for an admin on a signed, unsent, unmarked WDO report with the gate on', async () => {
    wireDetail(baseProject());
    expect((await getFlag()).canMarkSentOutside).toBe(true);
  });

  test.each([
    ['gate off', () => { mockGate.on = false; }, baseProject()],
    ['not signed', () => {}, baseProject({ wdo_signature: null })],
    ['sent through the portal', () => {}, baseProject({ sent_at: '2026-10-21T10:00:00Z' })],
    ['already marked', () => {}, baseProject({ sent_outside_portal_at: '2026-10-22T10:00:00Z' })],
    ['not a WDO report', () => {}, baseProject({ project_type: 'termite_treatment' })],
  ])('false when %s', async (_label, setup, project) => {
    setup();
    wireDetail(project);
    expect((await getFlag()).canMarkSentOutside).toBe(false);
  });

  test('false for a technician even when everything else holds', async () => {
    wireDetail(baseProject());
    expect((await getFlag('tech-1')).canMarkSentOutside).toBe(false);
  });

  test('the saved mark rides the payload', async () => {
    wireDetail(baseProject({ sent_outside_portal_at: '2026-10-22T10:00:00Z', sent_outside_portal_note: 'Mailed' }));
    const p = await getFlag();
    expect(p.sent_outside_portal_at).toBe('2026-10-22T10:00:00Z');
    expect(p.sent_outside_portal_note).toBe('Mailed');
  });
});

afterAll(() => { expect(logger.error).not.toHaveBeenCalled(); });
