// Controls for the db mock — set per test.
let mockRows = { lawn_diagnostics: [], pest_identifications: [], tree_shrub_identifications: [] };
let mockPhotoRows = [];
let mockLeadRow = null;
let mockCustomerRow = null;
let mockUpdateReturning = {}; // per-table rows resolved by update(...).returning(...)
// message_id → message row, conversation_id → conversation row — real
// id-filtered lookups (unlike the other tables here, a test may need two
// distinct rows in play at once: the requested message and a decoy).
let mockMessagesById = {};
let mockConversationsById = {};
const inserts = {};
const updates = {};

function builder(table) {
  const state = { table, where: {} };
  const b = {
    where: (cond) => {
      if (cond && typeof cond === 'object') Object.assign(state.where, cond);
      return b;
    },
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
      if (table === 'messages') return Promise.resolve(mockMessagesById[state.where.id] || null);
      if (table === 'conversations') return Promise.resolve(mockConversationsById[state.where.id] || null);
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
      table === 'lawn_diagnostic_photos' || table === 'pest_identification_photos' || table === 'tree_shrub_identification_photos'
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
// The tree & shrub engine's per-photo dual-vision call is mocked at the
// module boundary; everything else in the engine (completeness check,
// merge, scoring, findings) and the five-category builder stay REAL, so the
// stored scores/labels are production behavior.
const mockAnalyzeTreeShrub = jest.fn();
jest.mock('../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../services/tree-shrub-assessment'),
  analyzePhoto: (...args) => mockAnalyzeTreeShrub(...args),
}));
const mockIdentifyPest = jest.fn();
jest.mock('../services/pest-identification', () => {
  const actual = jest.requireActual('../services/pest-identification');
  return { ...actual, identifyPest: (...args) => mockIdentifyPest(...args) };
});
// photos.js is the ONE S3 reader (getPhotoBuffer) the route calls for the
// message_photos path — same module server/services/photos.js#getPhotoBase64
// uses for vision/OCR, so this mock stands in for that shared reader rather
// than a route-local S3Client. mockGetPhotoBuffer resolves { buffer,
// contentType }, matching PhotoService.getPhotoBuffer's real return shape;
// sharp's chain always resolves a fixed re-encoded buffer so tests can
// assert on it deterministically.
const mockGetPhotoBuffer = jest.fn();
jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(async () => 'https://signed.example/url'),
  getPhotoBuffer: (...args) => mockGetPhotoBuffer(...args),
}));
const mockResizedJpeg = Buffer.from('resized-jpeg-bytes');
jest.mock('sharp', () => jest.fn(() => ({
  rotate: jest.fn().mockReturnThis(),
  resize: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(mockResizedJpeg),
})));

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
    // Claimed by default: public_funnel rows must go through /claim before
    // the admin can mint or send (the releasability contract).
    claimed_at: '2026-07-07T12:30:00.000Z',
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
    claimed_at: '2026-07-07T13:30:00.000Z',
    lead_id: null,
    customer_id: null,
    report_token: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = { lawn_diagnostics: [], pest_identifications: [], tree_shrub_identifications: [] };
  mockPhotoRows = [];
  mockLeadRow = null;
  mockCustomerRow = null;
  mockUpdateReturning = {};
  mockMessagesById = {};
  mockConversationsById = {};
  Object.keys(inserts).forEach((k) => delete inserts[k]);
  Object.keys(updates).forEach((k) => delete updates[k]);
  mockSendEmail.mockResolvedValue({ ok: true, messageId: 'msg-1' });
  mockGetPhotoBuffer.mockResolvedValue({ buffer: Buffer.from('raw-mms-bytes'), contentType: 'image/jpeg' });
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

  test('lead-linking an UNCLAIMED public-funnel row is a 409 (claim would 409 on the lead), no write', async () => {
    mockRows.lawn_diagnostics = [lawnRow({ claimed_at: null })];
    mockLeadRow = { id: LEAD_ID };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: LEAD_ID }),
      });
      expect(res.status).toBe(409);
      expect(updates.lawn_diagnostics).toBeUndefined();
    });
  });

  test('an unclaimed public-funnel row still accepts a customer link and a lead UNLINK', async () => {
    const CUSTOMER = 'cccccccc-dddd-4eee-8fff-000000000000';
    mockRows.lawn_diagnostics = [lawnRow({ claimed_at: null })];
    mockCustomerRow = { id: CUSTOMER };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER, lead_id: null }),
      });
      expect(res.status).toBe(200);
      expect(updates.lawn_diagnostics[0].customer_id).toBe(CUSTOMER);
      expect(updates.lawn_diagnostics[0].lead_id).toBeNull();
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
    const CUSTOMER = 'cccccccc-dddd-4eee-8fff-000000000000';
    // customer_id is ALSO linked: the delivery log must attribute the send to
    // the lead that actually supplied the address, not the customer link.
    mockRows.lawn_diagnostics = [lawnRow({ contact_snapshot: null, lead_id: LEAD, customer_id: CUSTOMER })];
    mockLeadRow = { id: LEAD, email: 'lead@example.com', first_name: 'Lee' };
    mockCustomerRow = { id: CUSTOMER, email: 'customer@example.com', first_name: 'Casey' };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'lead@example.com',
        firstName: 'Lee',
        recipientType: 'lead',
        recipientId: LEAD,
      }));
    });
  });

  test('an explicit email override is delivered without entity linkage', async () => {
    const CUSTOMER = 'cccccccc-dddd-4eee-8fff-000000000000';
    mockRows.lawn_diagnostics = [lawnRow({ customer_id: CUSTOMER })];
    mockCustomerRow = { id: CUSTOMER, email: 'customer@example.com', first_name: 'Casey' };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'typed@example.com' }),
      });
      expect(res.status).toBe(200);
      // An admin-typed address belongs to no linked entity — recording it
      // against the customer would misdirect suppression/bounce handling.
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'typed@example.com',
        recipientType: null,
        recipientId: null,
      }));
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
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'customer@example.com',
        firstName: 'Casey',
        recipientType: 'customer',
        recipientId: CUSTOMER,
      }));
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

  test('unclaimed public-funnel rows cannot mint OR send — claim is the only unlock path', async () => {
    // Minting would flip status to sent, which the /claim transaction 409s on
    // — permanently bypassing lead capture, attribution, and the pricing
    // snapshot. Both admin release paths must refuse.
    mockRows.lawn_diagnostics = [lawnRow({ claimed_at: null })];
    await withServer(async (base) => {
      const mint = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/generate-link`, { method: 'POST' });
      expect(mint.status).toBe(409);
      const send = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}/send-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(send.status).toBe(409);
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(updates.lawn_diagnostics || []).toHaveLength(0);
    });
  });

  test('admin-created rows never claim and stay releasable', async () => {
    mockRows.pest_identifications = [pestRow({ source: 'admin', claimed_at: null })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}/generate-link`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).reportUrl).toContain('/pest-report/');
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

describe('POST /:type (admin create) — message_photos (inbound MMS)', () => {
  const MESSAGE_ID = 'dddddddd-eeee-4fff-8000-111111111111';
  const CONVERSATION_ID = 'eeeeeeee-ffff-4000-8111-222222222222';
  const CUSTOMER_ID = 'ffffffff-0000-4111-8222-333333333333';
  const INBOUND_KEY = 'sms-media/inbound/abc123';

  function inboundMessageRow(overrides = {}) {
    return {
      id: MESSAGE_ID,
      conversation_id: CONVERSATION_ID,
      direction: 'inbound',
      channel: 'sms',
      media: JSON.stringify([
        { key: INBOUND_KEY, contentType: 'image/jpeg', size: 12345 },
      ]),
      ...overrides,
    };
  }

  beforeEach(() => {
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
  });

  test('accepts a valid inbound key, fetches + resizes it via S3/sharp, and feeds it to the analysis as base64', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      const body = await res.json();
      expect(res.status).toBe(201);
      expect(mockGetPhotoBuffer).toHaveBeenCalledTimes(1);
      expect(mockIdentifyPest).toHaveBeenCalledTimes(1);
      const photosArg = mockIdentifyPest.mock.calls[0][0];
      expect(photosArg).toHaveLength(1);
      expect(photosArg[0].mimeType).toBe('image/jpeg');
      expect(photosArg[0].data).toBe(mockResizedJpeg.toString('base64'));
      expect(body.id).toBeTruthy();
    });
  });

  test('combines message_photos with an uploaded photo up to the 5-photo cap', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
          message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }],
        }),
      });
      expect(res.status).toBe(201);
      expect(mockIdentifyPest.mock.calls[0][0]).toHaveLength(2);
    });
  });

  test('rejects a key that is not on that message (400, no S3 fetch, no row)', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: 'sms-media/inbound/not-this-one' }] }),
      });
      expect(res.status).toBe(400);
      expect(mockGetPhotoBuffer).not.toHaveBeenCalled();
      expect(mockIdentifyPest).not.toHaveBeenCalled();
      expect(inserts.pest_identifications).toBeUndefined();
    });
  });

  test('rejects a key that is on the message but not in a signable prefix (400)', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow({
      media: JSON.stringify([{ key: 'private/other-bucket-object', contentType: 'image/jpeg' }]),
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: 'private/other-bucket-object' }] }),
      });
      expect(res.status).toBe(400);
      expect(mockGetPhotoBuffer).not.toHaveBeenCalled();
    });
  });

  test('rejects an outbound message (400, no S3 fetch)', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow({ direction: 'outbound' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      expect(res.status).toBe(400);
      expect(mockGetPhotoBuffer).not.toHaveBeenCalled();
    });
  });

  test('a nonexistent message is a 404', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      expect(res.status).toBe(404);
    });
  });

  test('an unsupported media type on the message is rejected (400, no S3 fetch)', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow({
      media: JSON.stringify([{ key: INBOUND_KEY, contentType: 'video/mp4' }]),
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      expect(res.status).toBe(400);
      expect(mockGetPhotoBuffer).not.toHaveBeenCalled();
    });
  });

  test('an S3 fetch failure is a 502 and is logged at error level', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockGetPhotoBuffer.mockRejectedValue(new Error('NoSuchKey'));
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      expect(res.status).toBe(502);
      expect(require('../services/logger').error).toHaveBeenCalled();
      expect(inserts.pest_identifications).toBeUndefined();
    });
  });

  test('defaults customer_id from the message thread when customer_id is omitted', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    mockCustomerRow = { id: CUSTOMER_ID };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      expect(res.status).toBe(201);
      expect(inserts.pest_identifications[0].customer_id).toBe(CUSTOMER_ID);
    });
  });

  test('an explicit customer_id that MATCHES the message thread succeeds', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    mockCustomerRow = { id: CUSTOMER_ID };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }], customer_id: CUSTOMER_ID }),
      });
      expect(res.status).toBe(201);
      expect(inserts.pest_identifications[0].customer_id).toBe(CUSTOMER_ID);
    });
  });

  test('an explicit customer_id that CONTRADICTS the message thread is refused (400, no row) — defense in depth against a client-side mixup', async () => {
    const OTHER_CUSTOMER = 'aaaaaaaa-1111-4222-8333-444444444444';
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    mockCustomerRow = { id: OTHER_CUSTOMER };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }], customer_id: OTHER_CUSTOMER }),
      });
      expect(res.status).toBe(400);
      expect(inserts.pest_identifications).toBeUndefined();
    });
  });

  test('message_photos spanning two different customers is refused (400, no S3 fetch on the conflicting entry, no row)', async () => {
    const OTHER_MESSAGE_ID = 'dddddddd-eeee-4fff-8000-999999999999';
    const OTHER_CONVERSATION_ID = 'eeeeeeee-ffff-4000-8111-999999999999';
    const OTHER_CUSTOMER = 'aaaaaaaa-1111-4222-8333-444444444444';
    const OTHER_KEY = 'sms-media/inbound/other456';
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockMessagesById[OTHER_MESSAGE_ID] = inboundMessageRow({
      id: OTHER_MESSAGE_ID, conversation_id: OTHER_CONVERSATION_ID,
      media: JSON.stringify([{ key: OTHER_KEY, contentType: 'image/jpeg' }]),
    });
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    mockConversationsById[OTHER_CONVERSATION_ID] = { id: OTHER_CONVERSATION_ID, customer_id: OTHER_CUSTOMER };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_photos: [
            { message_id: MESSAGE_ID, key: INBOUND_KEY },
            { message_id: OTHER_MESSAGE_ID, key: OTHER_KEY },
          ],
        }),
      });
      expect(res.status).toBe(400);
      expect(inserts.pest_identifications).toBeUndefined();
    });
  });

  test('a message linked to a customer mixed with an UNLINKED message (null customer_id) is refused — null is a distinct ownership state, not "no opinion"', async () => {
    const UNLINKED_MESSAGE_ID = 'dddddddd-eeee-4fff-8000-777777777777';
    const UNLINKED_KEY = 'sms-media/inbound/unlinked789';
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockMessagesById[UNLINKED_MESSAGE_ID] = inboundMessageRow({
      // No conversation_id at all — loadMessagePhoto never even queries
      // conversations for this one, so its customerId resolves to null.
      id: UNLINKED_MESSAGE_ID, conversation_id: null,
      media: JSON.stringify([{ key: UNLINKED_KEY, contentType: 'image/jpeg' }]),
    });
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_photos: [
            { message_id: MESSAGE_ID, key: INBOUND_KEY },
            { message_id: UNLINKED_MESSAGE_ID, key: UNLINKED_KEY },
          ],
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Selected photos belong to different customers — pick photos from one customer.');
      expect(inserts.pest_identifications).toBeUndefined();
    });
  });

  test('a defaulted customer_id that no longer exists is a 404', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    mockCustomerRow = null;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] }),
      });
      expect(res.status).toBe(404);
    });
  });

  test('more than 5 combined photos is a 400 before any S3 fetch', async () => {
    mockMessagesById[MESSAGE_ID] = inboundMessageRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: [1, 2, 3, 4].map(() => ({ data: 'aGVsbG8=', mimeType: 'image/jpeg' })),
          message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }, { message_id: MESSAGE_ID, key: INBOUND_KEY }],
        }),
      });
      expect(res.status).toBe(400);
      expect(mockGetPhotoBuffer).not.toHaveBeenCalled();
    });
  });
});

// Direct unit coverage for the units POST /:type decomposes into
// (Codex round-4 P2: reduce the handler's own complexity for real, not by
// relocating branches into a one-use wrapper). Each is independently
// callable via module.exports._test and exercised here without going
// through the HTTP layer — the describe block above already proves the
// handler wires them together correctly end to end.
describe('resolveRequestPhotos / resolveAssociations / lookupAssociation (unit)', () => {
  const { resolveRequestPhotos, resolveAssociations, lookupAssociation } = adminRouter._test;
  const MESSAGE_ID = 'dddddddd-eeee-4fff-8000-111111111111';
  const CONVERSATION_ID = 'eeeeeeee-ffff-4000-8111-222222222222';
  const CUSTOMER_ID = 'ffffffff-0000-4111-8222-333333333333';
  const INBOUND_KEY = 'sms-media/inbound/unit123';

  test('resolveRequestPhotos: no photos of either kind is a 400', async () => {
    const result = await resolveRequestPhotos({});
    expect(result).toEqual({ error: 'At least one photo is required', status: 400 });
  });

  test('resolveRequestPhotos: photos + message_photos combined over the cap is a 400', async () => {
    const result = await resolveRequestPhotos({
      photos: [1, 2, 3].map(() => ({ data: 'aGVsbG8=', mimeType: 'image/jpeg' })),
      message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }, { message_id: MESSAGE_ID, key: INBOUND_KEY }, { message_id: MESSAGE_ID, key: INBOUND_KEY }],
    });
    expect(result).toEqual({ error: 'At most 5 photos per assessment', status: 400 });
  });

  test('resolveRequestPhotos: a plain base64 photo resolves with no messageCustomerId', async () => {
    const result = await resolveRequestPhotos({ photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }] });
    expect(result.error).toBeUndefined();
    expect(result.photos).toHaveLength(1);
    expect(result.messageCustomerId).toBeNull();
  });

  test('resolveRequestPhotos: a message_photos error (message not found) bubbles up unchanged', async () => {
    const result = await resolveRequestPhotos({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] });
    expect(result).toEqual({ error: `Message ${MESSAGE_ID} not found`, status: 404 });
  });

  test('resolveRequestPhotos: a resolved message_photos entry carries its conversation customer through', async () => {
    mockMessagesById[MESSAGE_ID] = {
      id: MESSAGE_ID, conversation_id: CONVERSATION_ID, direction: 'inbound', channel: 'sms',
      media: JSON.stringify([{ key: INBOUND_KEY, contentType: 'image/jpeg' }]),
    };
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    const result = await resolveRequestPhotos({ message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] });
    expect(result.error).toBeUndefined();
    expect(result.photos).toHaveLength(1);
    expect(result.messageCustomerId).toBe(CUSTOMER_ID);
  });

  test('lookupAssociation: invalid uuid is a 400 named for the field', async () => {
    expect(await lookupAssociation('lead_id', 'not-a-uuid')).toEqual({ error: 'invalid lead_id', status: 400 });
  });

  test('lookupAssociation: a missing row is a 404 with the field\'s label', async () => {
    mockLeadRow = null;
    expect(await lookupAssociation('lead_id', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')).toEqual({ error: 'Lead not found', status: 404 });
    mockCustomerRow = null;
    expect(await lookupAssociation('customer_id', CUSTOMER_ID)).toEqual({ error: 'Customer not found', status: 404 });
  });

  test('lookupAssociation: a found row resolves its id', async () => {
    mockCustomerRow = { id: CUSTOMER_ID };
    expect(await lookupAssociation('customer_id', CUSTOMER_ID)).toEqual({ id: CUSTOMER_ID, row: { id: CUSTOMER_ID } });
  });

  test('resolveAssociations: neither lead_id, customer_id, nor a message customer resolves both null', async () => {
    expect(await resolveAssociations({}, null)).toEqual({ leadId: null, customerId: null, customerContact: null });
  });

  test('resolveAssociations: an explicit customer_id that CONTRADICTS the message thread customer is refused', async () => {
    const OTHER = 'aaaaaaaa-1111-4222-8333-444444444444';
    const result = await resolveAssociations({ customer_id: OTHER }, CUSTOMER_ID);
    expect(result).toEqual({ error: 'customer_id does not match the selected photos’ customer', status: 400 });
  });

  test('resolveAssociations: customer_id defaults from the message thread and is validated', async () => {
    mockCustomerRow = { id: CUSTOMER_ID, first_name: 'Dana', last_name: 'Reed', email: 'dana@example.com', phone: '+12395550100' };
    expect(await resolveAssociations({}, CUSTOMER_ID)).toEqual({
      leadId: null,
      customerId: CUSTOMER_ID,
      customerContact: { first_name: 'Dana', last_name: 'Reed', email: 'dana@example.com', phone: '+12395550100' },
    });
  });

  test('buildSnapshots: falls back to the linked customer contact when the body has none, explicit contact wins', () => {
    const { buildSnapshots } = adminRouter._test;
    const customerContact = { first_name: 'Dana', last_name: 'Reed', email: 'dana@example.com', phone: '+12395550100' };
    expect(buildSnapshots({}, customerContact).contactSnapshot).toEqual(customerContact);
    expect(buildSnapshots({}, null).contactSnapshot).toBeNull();
    expect(buildSnapshots({ contact: { email: 'other@example.com' } }, customerContact).contactSnapshot)
      .toEqual({ first_name: null, last_name: null, email: 'other@example.com', phone: null });
  });

  test('resolveAssociations: an explicit lead_id and matching customer_id both resolve', async () => {
    const LEAD_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    mockLeadRow = { id: LEAD_ID };
    mockCustomerRow = { id: CUSTOMER_ID };
    expect(await resolveAssociations({ lead_id: LEAD_ID, customer_id: CUSTOMER_ID }, CUSTOMER_ID))
      .toEqual({
        leadId: LEAD_ID,
        customerId: CUSTOMER_ID,
        customerContact: { first_name: null, last_name: null, email: null, phone: null },
      });
  });
});

describe('tree & shrub — third assessment type', () => {
  const { storeFunnelPhotos } = require('../utils/funnel-photos');
  const {
    TYPES, TYPE_KEYS, configFor, listRowShape, releaseRefusal, worstTreeShrubSignal,
  } = adminRouter._test;
  const MESSAGE_ID = 'dddddddd-eeee-4fff-8000-111111111111';
  const CONVERSATION_ID = 'eeeeeeee-ffff-4000-8111-222222222222';
  const CUSTOMER_ID = 'ffffffff-0000-4111-8222-333333333333';
  const INBOUND_KEY = 'sms-media/inbound/abc123';

  // One provider's raw read of a photo (the vision prompt's JSON schema).
  // HEDGE_CLOSEUP: light pest signals, a strong leaf-spot read.
  const HEDGE_CLOSEUP = {
    foliage_fullness: 82,
    leaf_color_vigor: 74,
    pest_signals: 'minor',
    disease_signals: 'moderate',
    water_heat_stress: 'none',
    pruning_mechanical: 'none',
    observations: 'Leaf spotting on the lower hedge is consistent with fungal leaf spot.',
  };
  const CLEAN_OVERVIEW = {
    foliage_fullness: 90,
    leaf_color_vigor: 90,
    pest_signals: 'none',
    disease_signals: 'none',
    water_heat_stress: 'none',
    pruning_mechanical: 'none',
    observations: 'Dense, even canopy across the front beds with healthy new growth.',
  };
  // analyzePhoto's return shape: both providers agree, composite = the read.
  const visionResult = (raw) => ({ claude: raw, gemini: raw, composite: raw, divergenceFlags: [] });
  const STORED_SCORES = {
    foliageFullness: 82, leafColorVigor: 74, pestActivity: 75, diseaseLeafSpot: 50, waterHeatStress: 95, overallScore: 75,
  };
  const STORED_FINDINGS = [{ key: 'disease_leaf_spot', label: 'Leaf-spot / disease signals', status: 'attention', detail: 'Possible leaf-spot or disease-like signals.', score: 50, defaultAction: 'monitor' }];

  function treeShrubRow(overrides = {}) {
    return {
      id: ROW_ID,
      mode: 'prospect',
      status: 'analyzed',
      source: 'admin',
      overall_score: 75,
      worst_signal: 'disease_leaf_spot',
      report_contract: {
        scores: STORED_SCORES,
        categories: [{ key: 'disease_leaf_spot', label: 'Disease / Leaf Spot Signals', score: 50, status: 'needs_attention' }],
        worst_signal: { key: 'disease_leaf_spot', label: 'Disease / Leaf Spot Signals', score: 50, status: 'needs_attention' },
        observations: 'Leaf spotting on the lower hedge is consistent with fungal leaf spot.',
        photo_observations: [{ index: 0, observations: 'Leaf spotting on the lower hedge is consistent with fungal leaf spot.', worst_signal: 'disease_leaf_spot' }],
        findings: STORED_FINDINGS,
        ai_summary: 'AI flagged 1 item to review.',
        suggested_customer_action: 'Recommend an on-site look to confirm the leaf-spot signals and quote treatment.',
        scored_count: 1,
        photo_count: 1,
      },
      ai_analysis: JSON.stringify({ prospect_note: 'hedge by the pool', provenance: { source: 'admin' } }),
      contact_snapshot: JSON.stringify({ first_name: 'Robin', email: 'robin@example.com' }),
      created_at: '2026-09-24T14:00:00.000Z',
      claimed_at: null,
      lead_id: null,
      customer_id: null,
      report_token: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockAnalyzeTreeShrub.mockResolvedValue(visionResult(HEDGE_CLOSEUP));
  });

  test('TYPES config: own tables, treeshrub photo prefix, no report page', () => {
    expect(TYPE_KEYS).toEqual(['lawn', 'pest', 'tree_shrub']);
    expect(TYPES.tree_shrub).toMatchObject({
      table: 'tree_shrub_identifications',
      photoTable: 'tree_shrub_identification_photos',
      photoFk: 'identification_id',
      photoKeyPrefix: 'treeshrub',
      reportPath: null,
      label: 'Tree & Shrub Assessment',
    });
    // Never the visit-keyed engine table.
    expect(TYPES.tree_shrub.table).not.toBe('tree_shrub_assessments');
  });

  test('configFor only resolves real types — prototype keys never become a config', () => {
    expect(configFor('tree_shrub')).toBe(TYPES.tree_shrub);
    expect(configFor('toString')).toBeNull();
    expect(configFor('constructor')).toBeNull();
    expect(configFor(undefined)).toBeNull();
  });

  test('listRowShape: overall score + worst signal headline', () => {
    const shaped = listRowShape('tree_shrub', treeShrubRow());
    expect(shaped.type).toBe('tree_shrub');
    expect(shaped.headline).toBe('75/100 · Disease / Leaf Spot Signals');
    expect(shaped.overall_score).toBe(75);
    expect(shaped.worst_signal).toBe('disease_leaf_spot');
    expect(shaped.worst_signal_label).toBe('Disease / Leaf Spot Signals');
  });

  test('listRowShape: nothing flagged / unscored rows read cleanly', () => {
    expect(listRowShape('tree_shrub', treeShrubRow({ overall_score: 91, worst_signal: null })).headline)
      .toBe('91/100 · No flagged signals');
    const unscored = listRowShape('tree_shrub', treeShrubRow({ overall_score: null, worst_signal: 'bogus_key' }));
    expect(unscored.headline).toBe('Unscored · No flagged signals');
    expect(unscored.worst_signal).toBeNull();
  });

  test('worstTreeShrubSignal picks the lowest flagged category, null when none is flagged', () => {
    const cats = [
      { key: 'foliage_fullness', score: 90, status: 'strong' },
      { key: 'pest_activity', score: 60, status: 'watch' },
      { key: 'disease_leaf_spot', score: 40, status: 'needs_attention' },
    ];
    expect(worstTreeShrubSignal(cats).key).toBe('disease_leaf_spot');
    expect(worstTreeShrubSignal([{ key: 'foliage_fullness', score: 90, status: 'strong' }])).toBeNull();
  });

  test('GET /?type=tree_shrub lists only tree & shrub rows', async () => {
    mockRows.lawn_diagnostics = [lawnRow()];
    mockRows.pest_identifications = [pestRow()];
    mockRows.tree_shrub_identifications = [treeShrubRow()];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments?type=tree_shrub`);
      expect(res.status).toBe(200);
      const { assessments } = await res.json();
      expect(assessments).toHaveLength(1);
      expect(assessments[0].type).toBe('tree_shrub');
      expect(assessments[0].headline).toBe('75/100 · Disease / Leaf Spot Signals');
    });
  });

  test('GET / (all) merges all three types; a prototype-key type filter falls back to all', async () => {
    mockRows.lawn_diagnostics = [lawnRow()];
    mockRows.pest_identifications = [pestRow({ id: 'cccccccc-dddd-4eee-8fff-000000000000' })];
    mockRows.tree_shrub_identifications = [treeShrubRow({ id: 'dddddddd-eeee-4fff-8000-000000000000' })];
    await withServer(async (base) => {
      for (const query of ['', '?type=toString']) {
        const res = await fetch(`${base}/api/admin/photo-assessments${query}`);
        expect(res.status).toBe(200);
        const { assessments } = await res.json();
        expect(assessments.map((a) => a.type)).toEqual(['tree_shrub', 'pest', 'lawn']);
      }
    });
  });

  test('GET /funnel reports a tree_shrub key alongside lawn and pest', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/funnel?days=30`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['days', 'lawn', 'pest', 'tree_shrub']);
      expect(body.tree_shrub).toHaveProperty('admin_created');
    });
  });

  test('GET /tree_shrub/:id: admin detail with scores + observations, no customer preview, no report link', async () => {
    // Even a row that somehow carries a released token never surfaces a URL:
    // there is no public page for it to open.
    mockRows.tree_shrub_identifications = [treeShrubRow({
      status: 'sent',
      report_token: 'a'.repeat(32),
      report_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })];
    mockPhotoRows = [{ id: 'p1', photo_index: 0, mime_type: 'image/jpeg', s3_key: 'key1' }];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/tree_shrub/${ROW_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assessment.report_available).toBe(false);
      expect(body.assessment.can_release).toBe(false);
      expect(body.assessment.report_url).toBeNull();
      expect(body.assessment.prospect_note).toBe('hedge by the pool');
      expect(body.customer_preview).toBeNull();
      expect(body.tech_view.scores.overallScore).toBe(75);
      expect(body.tech_view.worst_signal.key).toBe('disease_leaf_spot');
      expect(body.tech_view.observations).toContain('consistent with');
      expect(body.tech_view.findings).toHaveLength(1);
      expect(body.photos[0].url).toBe('https://signed.example/url');
    });
  });

  test('detail can_release mirrors the mint gate: an unclaimed public-funnel row is not releasable', async () => {
    mockRows.lawn_diagnostics = [lawnRow({ claimed_at: null })];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/lawn/${ROW_ID}`);
      const body = await res.json();
      expect(body.assessment.report_available).toBe(true);
      expect(body.assessment.can_release).toBe(false);
    });
  });

  test('lawn/pest detail payloads report report_available: true', async () => {
    mockRows.pest_identifications = [pestRow()];
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/pest/${ROW_ID}`);
      const body = await res.json();
      expect(body.assessment.report_available).toBe(true);
      // Claimed public-funnel pest row → releasable, matching the mint gate.
      expect(body.assessment.can_release).toBe(true);
    });
  });

  test('generate-link and send-report refuse tree_shrub (409) — nothing minted or emailed', async () => {
    mockRows.tree_shrub_identifications = [treeShrubRow()];
    await withServer(async (base) => {
      for (const action of ['generate-link', 'send-report']) {
        const res = await fetch(`${base}/api/admin/photo-assessments/tree_shrub/${ROW_ID}/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'robin@example.com' }),
        });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toMatch(/no customer report for tree & shrub assessment yet/i);
      }
      expect(updates.tree_shrub_identifications).toBeUndefined();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  test('releaseRefusal keeps the lawn/pest status + unclaimed messages', () => {
    expect(releaseRefusal(TYPES.pest, { status: 'archived', source: 'admin' }, 'send a report'))
      .toBe('Cannot send a report for a archived assessment');
    expect(releaseRefusal(TYPES.lawn, { status: 'analyzed', source: 'public_funnel', claimed_at: null }, 'send a report'))
      .toMatch(/has not unlocked the report yet/);
    expect(releaseRefusal(TYPES.lawn, { status: 'analyzed', source: 'admin' }, 'send a report')).toBeNull();
  });

  test('POST /tree_shrub/:id/link links a customer', async () => {
    mockRows.tree_shrub_identifications = [treeShrubRow()];
    mockCustomerRow = { id: CUSTOMER_ID };
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/photo-assessments/tree_shrub/${ROW_ID}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }),
      });
      expect(res.status).toBe(200);
      expect(updates.tree_shrub_identifications[0].customer_id).toBe(CUSTOMER_ID);
    });
  });

  const postTreeShrub = (base, body) => fetch(`${base}/api/admin/photo-assessments/tree_shrub`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  test('POST /tree_shrub with uploaded photos runs the engine and stores scores + signals — the note never reaches the model', async () => {
    await withServer(async (base) => {
      const res = await postTreeShrub(base, {
        photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
        contact: { first_name: 'Robin', phone: '941-555-0100' },
        note: 'hedge by the pool is thinning',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe('tree_shrub');

      // The engine sees only the photo bytes + mime type — never the note.
      expect(mockAnalyzeTreeShrub).toHaveBeenCalledTimes(1);
      expect(mockAnalyzeTreeShrub.mock.calls[0]).toEqual(['aGVsbG8=', 'image/jpeg']);

      const stored = inserts.tree_shrub_identifications[0];
      expect(stored).toMatchObject({ mode: 'prospect', status: 'analyzed', source: 'admin', overall_score: 75, worst_signal: 'disease_leaf_spot' });
      const contract = JSON.parse(stored.report_contract);
      expect(contract.scores).toEqual(STORED_SCORES);
      expect(contract.categories.map((c) => c.key)).toEqual([
        'foliage_fullness', 'leaf_color_vigor', 'pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress',
      ]);
      expect(contract.worst_signal).toEqual({ key: 'disease_leaf_spot', label: 'Disease / Leaf Spot Signals', score: 50, status: 'needs_attention' });
      expect(contract.findings).toEqual([expect.objectContaining({ key: 'disease_leaf_spot', status: 'attention' })]);
      expect(contract.scored_count).toBe(1);
      expect(contract.photo_count).toBe(1);
      expect(JSON.parse(stored.ai_analysis).prospect_note).toBe('hedge by the pool is thinning');
      expect(stored.ai_summary).toContain('consistent with');
      expect(inserts.leads).toBeUndefined();
      expect(mockSendEmail).not.toHaveBeenCalled();

      expect(storeFunnelPhotos).toHaveBeenCalledWith(expect.objectContaining({
        table: 'tree_shrub_identification_photos',
        fkColumn: 'identification_id',
        keyPrefix: 'treeshrub',
      }));
    });
  });

  test('stored contract carries no visit promises or confirmed-diagnosis words (standalone lane, signals only)', async () => {
    await withServer(async (base) => {
      await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] });
      const contract = JSON.parse(inserts.tree_shrub_identifications[0].report_contract);
      const text = JSON.stringify(contract);
      expect(text).not.toMatch(/next visit|recheck|documented today|treated today/i);
      expect(text).not.toMatch(/infestation|diseased/i);
      // The report builder's visit-written category copy is not stored.
      expect(contract.categories.every((c) => !('customerExplanation' in c))).toBe(true);
      expect(contract.suggested_customer_action).toBe(adminRouter._test.TREE_SHRUB_NEXT_STEPS.disease_leaf_spot);
    });
  });

  test('TREE_SHRUB_NEXT_STEPS: one prospect-safe next step per category plus the clean case, none promising a visit', () => {
    const { TREE_SHRUB_NEXT_STEPS } = adminRouter._test;
    const { buildTreeShrubVisualCategories } = require('../services/service-report/tree-shrub-visual-categories');
    const categoryKeys = buildTreeShrubVisualCategories({}).map((c) => c.key);
    expect(Object.keys(TREE_SHRUB_NEXT_STEPS).sort()).toEqual([...categoryKeys, 'none'].sort());
    for (const copy of Object.values(TREE_SHRUB_NEXT_STEPS)) {
      expect(copy).not.toMatch(/next visit|recheck|we'll|we’ll|today/i);
      expect(copy).not.toMatch(/infestation|diseased/i);
    }
    expect(TREE_SHRUB_NEXT_STEPS.none).toMatch(/No treatment signals/);
    for (const key of categoryKeys) expect(TREE_SHRUB_NEXT_STEPS[key]).toMatch(/^Recommend an on-site look/);
  });

  test('a clean assessment gets the no-signals next step and no worst signal', async () => {
    mockAnalyzeTreeShrub.mockResolvedValue(visionResult(CLEAN_OVERVIEW));
    await withServer(async (base) => {
      expect((await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] })).status).toBe(201);
      const stored = inserts.tree_shrub_identifications[0];
      const contract = JSON.parse(stored.report_contract);
      expect(stored.worst_signal).toBeNull();
      expect(contract.worst_signal).toBeNull();
      expect(contract.suggested_customer_action).toBe('No treatment signals in these photos — offer a seasonal check.');
    });
  });

  test('clean overview + flagged close-up: every photo’s observations are kept, and the headline comes from the flagged photo', async () => {
    // Upload order: overview FIRST (the engine merge would keep its text),
    // close-up second (the one that drives the worst signal).
    mockAnalyzeTreeShrub.mockImplementation(async (data) => visionResult(data === 'b3ZlcnZpZXc=' ? CLEAN_OVERVIEW : HEDGE_CLOSEUP));
    await withServer(async (base) => {
      const res = await postTreeShrub(base, { photos: [{ data: 'b3ZlcnZpZXc=' }, { data: 'Y2xvc2V1cA==' }] });
      expect(res.status).toBe(201);
      const stored = inserts.tree_shrub_identifications[0];
      const contract = JSON.parse(stored.report_contract);
      expect(contract.photo_observations).toEqual([
        { index: 0, observations: CLEAN_OVERVIEW.observations, worst_signal: null },
        { index: 1, observations: HEDGE_CLOSEUP.observations, worst_signal: 'disease_leaf_spot' },
      ]);
      expect(contract.observations).toBe(HEDGE_CLOSEUP.observations);
      expect(stored.ai_summary).toBe(HEDGE_CLOSEUP.observations);
      expect(contract.worst_signal.key).toBe('disease_leaf_spot');
    });
  });

  test('headlineTreeShrubPhoto falls back to the first photo when nothing is flagged', () => {
    const { headlineTreeShrubPhoto } = adminRouter._test;
    const first = { index: 0, categories: [{ key: 'pest_activity', score: 95 }] };
    const second = { index: 1, categories: [{ key: 'pest_activity', score: 90 }] };
    expect(headlineTreeShrubPhoto([first, second], null)).toBe(first);
    expect(headlineTreeShrubPhoto([first, second], 'pest_activity')).toBe(second);
  });

  test('POST /tree_shrub with message_photos feeds the resized inbound MMS photo to the engine and links the thread customer', async () => {
    mockMessagesById[MESSAGE_ID] = {
      id: MESSAGE_ID,
      conversation_id: CONVERSATION_ID,
      direction: 'inbound',
      channel: 'sms',
      media: JSON.stringify([{ key: INBOUND_KEY, contentType: 'image/jpeg', size: 12345 }]),
    };
    mockConversationsById[CONVERSATION_ID] = { id: CONVERSATION_ID, customer_id: CUSTOMER_ID };
    mockCustomerRow = { id: CUSTOMER_ID, first_name: 'Robin', last_name: 'Lee', email: 'robin@example.com', phone: '9415550100' };
    await withServer(async (base) => {
      const res = await postTreeShrub(base, { message_photos: [{ message_id: MESSAGE_ID, key: INBOUND_KEY }] });
      expect(res.status).toBe(201);
      expect(mockGetPhotoBuffer).toHaveBeenCalledTimes(1);
      expect(mockAnalyzeTreeShrub.mock.calls).toEqual([[mockResizedJpeg.toString('base64'), 'image/jpeg']]);
      const stored = inserts.tree_shrub_identifications[0];
      expect(stored.customer_id).toBe(CUSTOMER_ID);
      expect(JSON.parse(stored.contact_snapshot).first_name).toBe('Robin');
    });
  });

  test('a photo the engine could not score fails the whole request (503) — no partial row, no photo storage', async () => {
    // Both providers failed on the second photo (analyzePhoto → null): the
    // rest must not be persisted as a full analysis.
    mockAnalyzeTreeShrub.mockImplementation(async (data) => (data === 'd29ybGQ=' ? null : visionResult(HEDGE_CLOSEUP)));
    await withServer(async (base) => {
      const res = await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }, { data: 'd29ybGQ=' }] });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/Could not analyze every photo/);
      expect(mockAnalyzeTreeShrub).toHaveBeenCalledTimes(2);
      expect(inserts.tree_shrub_identifications).toBeUndefined();
      expect(storeFunnelPhotos).not.toHaveBeenCalled();
    });
  });

  test('a provider result missing a schema field (e.g. pest signals) counts as unscored → 503, no row', async () => {
    // Syntactically valid JSON with pest_signals omitted by BOTH providers:
    // the engine's averaging would default it to a clean "none"/95.
    const { pest_signals: _omitted, ...incomplete } = HEDGE_CLOSEUP;
    mockAnalyzeTreeShrub.mockResolvedValue(visionResult(incomplete));
    await withServer(async (base) => {
      const res = await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/Could not analyze every photo/);
      expect(inserts.tree_shrub_identifications).toBeUndefined();
      expect(storeFunnelPhotos).not.toHaveBeenCalled();
    });
  });

  test('an unrecognized severity word or a non-numeric score also counts as unscored → 503', async () => {
    await withServer(async (base) => {
      mockAnalyzeTreeShrub.mockResolvedValue(visionResult({ ...HEDGE_CLOSEUP, disease_signals: 'high' }));
      expect((await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] })).status).toBe(503);
      mockAnalyzeTreeShrub.mockResolvedValue(visionResult({ ...HEDGE_CLOSEUP, foliage_fullness: 'lush' }));
      expect((await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] })).status).toBe(503);
      expect(inserts.tree_shrub_identifications).toBeUndefined();
    });
  });

  test('a blank severity from one provider (which would dilute the other\'s signal) counts as unscored → 503', async () => {
    mockAnalyzeTreeShrub.mockResolvedValue({
      claude: { ...HEDGE_CLOSEUP, pest_signals: 'severe' },
      gemini: { ...HEDGE_CLOSEUP, pest_signals: '' },
      composite: { ...HEDGE_CLOSEUP, pest_signals: 'moderate' },
      divergenceFlags: [],
    });
    await withServer(async (base) => {
      expect((await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] })).status).toBe(503);
      expect(inserts.tree_shrub_identifications).toBeUndefined();
    });
  });

  test('one provider omitting a field the other read is still complete (the engine uses the available read)', async () => {
    const { pest_signals: _omitted, ...geminiRead } = HEDGE_CLOSEUP;
    mockAnalyzeTreeShrub.mockResolvedValue({ claude: HEDGE_CLOSEUP, gemini: geminiRead, composite: HEDGE_CLOSEUP, divergenceFlags: [] });
    await withServer(async (base) => {
      expect((await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] })).status).toBe(201);
    });
  });

  test('a data-less photo entry is not sent to the engine and does not count against completeness', async () => {
    await withServer(async (base) => {
      const res = await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }, { mimeType: 'image/jpeg' }] });
      expect(res.status).toBe(201);
      expect(mockAnalyzeTreeShrub).toHaveBeenCalledTimes(1);
      expect(inserts.tree_shrub_identifications).toHaveLength(1);
    });
  });

  test('engine outage (no provider answers) degrades to 503, no row, no photo storage', async () => {
    mockAnalyzeTreeShrub.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] });
      expect(res.status).toBe(503);
      expect(inserts.tree_shrub_identifications).toBeUndefined();
      expect(storeFunnelPhotos).not.toHaveBeenCalled();
    });
  });

  test('an analyzePhoto throw is contained as unscored → 503', async () => {
    mockAnalyzeTreeShrub.mockRejectedValue(new Error('vision boom'));
    await withServer(async (base) => {
      expect((await postTreeShrub(base, { photos: [{ data: 'aGVsbG8=' }] })).status).toBe(503);
      expect(inserts.tree_shrub_identifications).toBeUndefined();
    });
  });
});
