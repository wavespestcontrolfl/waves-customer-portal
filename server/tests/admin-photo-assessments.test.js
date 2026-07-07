// Controls for the db mock — set per test.
let mockRows = { lawn_diagnostics: [], pest_identifications: [] };
let mockPhotoRows = [];
let mockLeadRow = null;
let mockCustomerRow = null;
let mockUpdateReturning = {}; // per-table rows resolved by update(...).returning(...)
const inserts = {};
const updates = {};

function builder(table) {
  const state = { table };
  const b = {
    where: () => b,
    whereIn: () => b,
    whereNull: () => b,
    orderBy: () => b,
    limit: () => b,
    select: () => b,
    join: () => b,
    count: () => Promise.resolve([{ n: 0 }]),
    first: () => {
      if (table === 'leads') return Promise.resolve(mockLeadRow);
      if (table === 'customers') return Promise.resolve(mockCustomerRow);
      return Promise.resolve((mockRows[table] || [])[0] || null);
    },
    insert: (obj) => {
      (inserts[table] = inserts[table] || []).push(obj);
      return { returning: () => Promise.resolve([{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]) };
    },
    update: (obj) => {
      (updates[table] = updates[table] || []).push(obj);
      const chain = Promise.resolve(1);
      chain.returning = () => Promise.resolve(mockUpdateReturning[table] || []);
      return chain;
    },
    then: (resolve, reject) => Promise.resolve(
      table === 'lawn_diagnostic_photos' || table === 'pest_identification_photos'
        ? mockPhotoRows
        : (mockRows[table] || []),
    ).then(resolve, reject),
  };
  return b;
}
const mockDb = jest.fn((table) => builder(String(table).split(' ')[0]));
mockDb.fn = { now: () => 'NOW' };
mockDb.raw = (sql, bindings) => ({ __raw: sql, __bindings: bindings });

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.user = { id: 'admin-1', role: 'admin' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));
jest.mock('../utils/funnel-photos', () => ({ storeFunnelPhotos: jest.fn(async () => {}) }));
const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'msg-1' }));
jest.mock('../services/assessment-report-email', () => ({
  sendAssessmentReportEmail: (...args) => mockSendEmail(...args),
  TYPE_LABELS: { lawn: 'Lawn Assessment', pest: 'Pest Identification Report' },
}));
const mockLadder = jest.fn();
jest.mock('../services/lawn-diagnostic-analyze', () => {
  const actual = jest.requireActual('../services/lawn-diagnostic-analyze');
  return {
    ...actual,
    runFindingsLadder: (...args) => mockLadder(...args),
    applyWriterSummary: jest.fn(async () => {}),
  };
});
jest.mock('../services/lawn-assessment', () => ({ getSeason: () => 'peak' }));
const mockIdentifyPest = jest.fn();
jest.mock('../services/pest-identification', () => {
  const actual = jest.requireActual('../services/pest-identification');
  return { ...actual, identifyPest: (...args) => mockIdentifyPest(...args) };
});
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(async () => 'https://signed.example/url') }));

const express = require('express');
const adminRouter = require('../routes/admin-photo-assessments');

const ROW_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LEAD_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function appServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/admin/photo-assessments', adminRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

function lawnRow(overrides = {}) {
  return {
    id: ROW_ID,
    mode: 'prospect',
    status: 'analyzed',
    source: 'public_funnel',
    overall_score: 55,
    report_contract: {},
    ai_analysis: JSON.stringify({ prospect_note: 'brown patches', provenance: { source: 'public_funnel' } }),
    contact_snapshot: JSON.stringify({ first_name: 'Dana', email: 'dana@example.com' }),
    created_at: '2026-07-07T12:00:00.000Z',
    lead_id: null,
    customer_id: null,
    report_token: null,
    ...overrides,
  };
}

function pestRow(overrides = {}) {
  return {
    id: ROW_ID,
    status: 'analyzed',
    source: 'public_funnel',
    species_slug: 'ghost-ant',
    category: 'insect',
    urgency: 'moderate',
    report_contract: {
      identification: { slug: 'ghost-ant', category: 'insect', confidence: 'high', contested: false },
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_required: false },
      urgency: 'moderate',
      observations: ['raw model text'],
      alternate_slugs: ['bigheaded-ant'],
    },
    ai_analysis: JSON.stringify({ prospect_note: 'kitchen counter' }),
    contact_snapshot: JSON.stringify({ first_name: 'Sam', email: 'sam@example.com' }),
    created_at: '2026-07-07T13:00:00.000Z',
    lead_id: null,
    customer_id: null,
    report_token: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = { lawn_diagnostics: [], pest_identifications: [] };
  mockPhotoRows = [];
  mockLeadRow = null;
  mockCustomerRow = null;
  mockUpdateReturning = {};
  Object.keys(inserts).forEach((k) => delete inserts[k]);
  Object.keys(updates).forEach((k) => delete updates[k]);
  mockSendEmail.mockResolvedValue({ ok: true, messageId: 'msg-1' });
});

describe('GET / (list)', () => {
  test('merges both types newest-first with the unified row shape', async () => {
    mockRows.lawn_diagnostics = [lawnRow()];
    mockRows.pest_identifications = [pestRow({ id: 'cccccccc-dddd-4eee-8fff-000000000000' })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments`);
      expect(res.status).toBe(200);
      const { assessments } = await res.json();
      expect(assessments).toHaveLength(2);
      // Pest row is newer → first.
      expect(assessments[0].type).toBe('pest');
      expect(assessments[0].headline).toBe('Ghost Ants');
      expect(assessments[1].type).toBe('lawn');
      expect(assessments[1].headline).toBe('Keep an eye on it');
      expect(assessments[1].contact.first_name).toBe('Dana');
    });
  });
});

describe('GET /:type/:id (detail)', () => {
  test('returns tech view + customer preview + signed photo URLs for pest', async () => {
    mockRows.pest_identifications = [pestRow()];
    mockPhotoRows = [{ id: 'p1', photo_index: 0, mime_type: 'image/jpeg', s3_key: 'key1' }];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tech_view.identification.label).toBe('Ghost Ants');
      expect(body.tech_view.tech_notes).toContain('Baiting program');
      expect(body.tech_view.differentials[0].slug).toBe('bigheaded-ant');
      expect(body.customer_preview.identified.label).toBe('Ghost Ants');
      expect(body.photos[0].url).toBe('https://signed.example/url');
      expect(body.assessment.prospect_note).toBe('kitchen counter');
    });
  });

  test('unknown type is a 404', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/bird/${ROW_ID}`);
      expect(res.status).toBe(404);
    });
  });

  test('malformed id is a 404', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/not-a-uuid`);
      expect(res.status).toBe(404);
    });
  });
});

describe('POST /:type/:id/link', () => {
  test('links an existing lead', async () => {
    mockRows.lawn_diagnostics = [lawnRow()];
    mockLeadRow = { id: LEAD_ID };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: LEAD_ID }),
      });
      expect(res.status).toBe(200);
      expect(updates.lawn_diagnostics[0].lead_id).toBe(LEAD_ID);
    });
  });

  test('missing lead is a 404, no write', async () => {
    mockRows.lawn_diagnostics = [lawnRow()];
    mockLeadRow = null;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: LEAD_ID }),
      });
      expect(res.status).toBe(404);
      expect(updates.lawn_diagnostics).toBeUndefined();
    });
  });

  test('explicit null unlinks', async () => {
    mockRows.pest_identifications = [pestRow({ lead_id: LEAD_ID })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: null }),
      });
      expect(res.status).toBe(200);
      expect(updates.pest_identifications[0].lead_id).toBeNull();
    });
  });
});

describe('POST /:type/:id/send-report', () => {
  test('mints the token atomically (COALESCE keeps the first), marks sent, emails the snapshot contact', async () => {
    const persisted = 'a'.repeat(32);
    mockRows.lawn_diagnostics = [lawnRow()];
    mockUpdateReturning.lawn_diagnostics = [{ report_token: persisted }];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sent).toBe(true);
      // The URL carries the PERSISTED token (returning), never a token another
      // concurrent send may have overwritten.
      expect(body.reportUrl).toBe(`https://portal.wavespestcontrol.com/lawn-report/${persisted}`);
      const update = updates.lawn_diagnostics[0];
      expect(update.status).toBe('sent');
      expect(update.report_token.__raw).toContain('COALESCE(report_token');
      // Delivery timestamp is a SECOND update, stamped only after the email
      // actually went out — the mint update must not carry it.
      expect(update.last_sent_at).toBeUndefined();
      expect(updates.lawn_diagnostics[1].last_sent_at).toBe('NOW');
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
        type: 'lawn',
        to: 'dana@example.com',
        firstName: 'Dana',
      }));
    });
  });

  test('resend keeps the existing token stable', async () => {
    const token = 'f'.repeat(32);
    mockRows.pest_identifications = [pestRow({ status: 'sent', report_token: token })];
    mockUpdateReturning.pest_identifications = [{ report_token: token }];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reportUrl).toBe(`https://portal.wavespestcontrol.com/pest-report/${token}`);
    });
  });

  test('falls back to the linked lead email when the snapshot has none', async () => {
    const LEAD = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    mockRows.lawn_diagnostics = [lawnRow({ contact_snapshot: null, lead_id: LEAD })];
    mockLeadRow = { id: LEAD, email: 'lead@example.com', first_name: 'Lee' };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'lead@example.com', firstName: 'Lee' }));
    });
  });

  test('no usable email anywhere is a 400 with no send', async () => {
    mockRows.lawn_diagnostics = [lawnRow({ contact_snapshot: null })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  test('email failure still returns the minted link (sent:false) and never stamps last_sent_at', async () => {
    mockSendEmail.mockResolvedValue({ ok: false, error: 'suppressed' });
    mockRows.lawn_diagnostics = [lawnRow()];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sent).toBe(false);
      expect(body.reportUrl).toBeTruthy();
      // Failed sends must not read as "Report sent" in stages/metrics.
      expect(updates.lawn_diagnostics).toHaveLength(1);
      expect(updates.lawn_diagnostics[0].last_sent_at).toBeUndefined();
    });
  });

  test('an expired report link is withheld from the detail payload (copy-link hides)', async () => {
    mockRows.pest_identifications = [pestRow({
      report_token: 'f'.repeat(32),
      report_expires_at: new Date(Date.now() - 86400000).toISOString(),
    })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}`);
      const body = await res.json();
      expect(body.assessment.report_url).toBeNull();
    });
  });

  test('a phone-only lead falls through to the linked customer email', async () => {
    const LEAD = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const CUSTOMER = 'cccccccc-dddd-4eee-8fff-000000000000';
    mockRows.lawn_diagnostics = [lawnRow({ contact_snapshot: null, lead_id: LEAD, customer_id: CUSTOMER })];
    mockLeadRow = { id: LEAD, email: null, first_name: 'Pat' };
    mockCustomerRow = { id: CUSTOMER, email: 'customer@example.com', first_name: 'Casey' };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'customer@example.com', firstName: 'Casey' }));
    });
  });

  test('the detail payload only returns report links the public readers accept (sent + unexpired)', async () => {
    // Positive case: sent + future expiry → link offered.
    mockRows.pest_identifications = [pestRow({
      status: 'sent',
      report_token: 'f'.repeat(32),
      report_expires_at: new Date(Date.now() + 86400000).toISOString(),
    })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}`);
      const body = await res.json();
      expect(body.assessment.report_url).toContain(`/pest-report/${'f'.repeat(32)}`);
    });
    // Archived rows 404 at the public readers even with a live token —
    // the copy-link URL would be dead, so it must be withheld.
    mockRows.pest_identifications = [pestRow({
      status: 'archived',
      report_token: 'f'.repeat(32),
      report_expires_at: new Date(Date.now() + 86400000).toISOString(),
    })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}`);
      const body = await res.json();
      expect(body.assessment.report_url).toBeNull();
    });
    // A token with no expiry stamp fails the readers' whereNotNull guard.
    mockRows.pest_identifications = [pestRow({
      status: 'sent',
      report_token: 'f'.repeat(32),
      report_expires_at: null,
    })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}`);
      const body = await res.json();
      expect(body.assessment.report_url).toBeNull();
    });
  });
});

describe('POST /:type/:id/generate-link', () => {
  test('mints the released link without sending anything (phone-only path)', async () => {
    mockRows.lawn_diagnostics = [lawnRow({ contact_snapshot: null })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/generate-link`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reportUrl).toContain('/lawn-report/');
      expect(body.expiresAt).toBeTruthy();
      expect(mockSendEmail).not.toHaveBeenCalled();
      // Same released-state contract as send-report: the public readers
      // require status='sent'; last_sent_at is NOT stamped (nothing sent).
      expect(updates.lawn_diagnostics).toHaveLength(1);
      expect(updates.lawn_diagnostics[0].status).toBe('sent');
      expect(updates.lawn_diagnostics[0].last_sent_at).toBeUndefined();
    });
  });

  test('archived assessments cannot mint a link (public readers 404 them)', async () => {
    mockRows.lawn_diagnostics = [lawnRow({ status: 'archived' })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/generate-link`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(updates.lawn_diagnostics || []).toHaveLength(0);
    });
  });
});

describe('POST /:type (admin create)', () => {
  test('creates a pest assessment with source=admin and NO lead/attribution/email', async () => {
    const actual = jest.requireActual('../services/pest-identification');
    const entry = actual.PEST_LIBRARY.find((e) => e.slug === 'ghost-ant');
    mockIdentifyPest.mockResolvedValue({
      ok: true,
      identification: { entry, confidence: 'high', category: 'insect', contested: false },
      perPhoto: [{ entry, confidence: 'high', category: 'insect', agreement: 'match', model_count: 2, observations: ['obs'], distinguishing_features: [], alternate_slugs: [] }],
      observations: ['obs'],
      distinguishing_features: [],
      alternate_slugs: [],
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
          contact: { first_name: 'Pat', phone: '941-555-0000' },
          note: 'phone prospect',
        }),
      });
      expect(res.status).toBe(201);
      const stored = inserts.pest_identifications[0];
      expect(stored.source).toBe('admin');
      expect(stored.mode).toBe('prospect');
      expect(stored.status).toBe('analyzed');
      expect(inserts.leads).toBeUndefined();
      expect(inserts.ad_service_attribution).toBeUndefined();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  test('requires at least one photo', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [] }),
      });
      expect(res.status).toBe(400);
      expect(mockLadder).not.toHaveBeenCalled();
    });
  });

  test('pest vision outage degrades to 503, no row', async () => {
    mockIdentifyPest.mockResolvedValue({ ok: false, reason: 'vision_unavailable' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [{ data: 'aGVsbG8=' }] }),
      });
      expect(res.status).toBe(503);
      expect(inserts.pest_identifications).toBeUndefined();
    });
  });
});
