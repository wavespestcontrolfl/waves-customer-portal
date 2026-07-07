// Controls for the db mock — set per test.
let mockIdentificationRow = null;  // what pest_identifications .first() returns (claim path)
let mockUpdateResult = 1;          // rows affected by the one-shot claim update
const inserts = { pest_identifications: [], pest_identification_photos: [], leads: [], ad_service_attribution: [] };

function builder(table) {
  const b = {
    where: () => b,
    whereNull: () => b,
    whereNotNull: () => b,
    first: () => Promise.resolve(table === 'pest_identifications' ? mockIdentificationRow : null),
    insert: (obj) => {
      (inserts[table] = inserts[table] || []).push(obj);
      if (table === 'leads') return { returning: () => Promise.resolve([{ id: 'lead-uuid-1' }]) };
      if (table === 'ad_service_attribution') return { onConflict: () => ({ ignore: () => Promise.resolve() }) };
      if (table === 'pest_identifications') {
        return { returning: () => Promise.resolve([{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]) };
      }
      return Promise.resolve([]);
    },
    update: () => Promise.resolve(mockUpdateResult),
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.fn = { now: () => 'NOW' };
mockDb.transaction = (cb) => {
  const trx = (t) => builder(t);
  trx.fn = { now: () => 'NOW' };
  return Promise.resolve().then(() => cb(trx));
};

const mockGateState = { pestIdentifier: true, leadTurnstile: false };
let mockHoneypotTripped = false;
const mockIdentifyPest = jest.fn();

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (gate) => !!mockGateState[gate] }));
jest.mock('../utils/turnstile', () => ({
  verifyTurnstileToken: jest.fn(async () => ({ ok: true, enforced: false })),
}));
jest.mock('../utils/lead-abuse', () => ({
  isHoneypotTripped: () => mockHoneypotTripped,
  resolveSubmitHost: () => 'wavespestcontrol.com',
}));
jest.mock('../utils/funnel-photos', () => ({ storeFunnelPhotos: jest.fn(async () => {}) }));
jest.mock('../services/pest-identification', () => {
  const actual = jest.requireActual('../services/pest-identification');
  return { ...actual, identifyPest: (...args) => mockIdentifyPest(...args) };
});
jest.mock('../services/pricing-engine', () => ({
  syncConstantsFromDB: jest.fn(async () => {}),
  generateEstimate: jest.fn(() => ({
    lineItems: [{ service: 'pest_control', perApp: 117, annual: 468, monthly: 39, visitsPerYear: 4 }],
  })),
}));

const express = require('express');
const { PEST_LIBRARY } = jest.requireActual('../services/pest-identification');
const funnelRouter = require('../routes/public-pest-identifier');

const ROW_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAIM_TOKEN = 'd'.repeat(32);

function appServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/public/pest-identifier', funnelRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

function libraryEntry(slug) {
  return PEST_LIBRARY.find((e) => e.slug === slug);
}

function identifyResult(slug, confidence = 'high') {
  const entry = libraryEntry(slug);
  return {
    ok: true,
    identification: { entry, confidence, category: entry.category, contested: false },
    perPhoto: [{ entry, confidence, category: entry.category, agreement: 'match', model_count: 2, observations: ['raw obs'], distinguishing_features: [], alternate_slugs: [] }],
    observations: ['raw model observation text'],
    distinguishing_features: ['raw feature'],
    alternate_slugs: [],
  };
}

function analyzeBody(overrides = {}) {
  return { photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }], note: 'saw it in the kitchen', turnstile_token: 'tok', ...overrides };
}

function claimBody(overrides = {}) {
  return {
    claim_token: CLAIM_TOKEN,
    first_name: 'Dana',
    email: 'dana@example.com',
    phone: '941-555-1234',
    ...overrides,
  };
}

function analyzedRow(overrides = {}) {
  const entry = libraryEntry('ghost-ant');
  return {
    id: ROW_ID,
    status: 'analyzed',
    mode: 'prospect',
    source: 'public_funnel',
    claim_token: CLAIM_TOKEN,
    lead_id: null,
    species_slug: 'ghost-ant',
    category: 'insect',
    urgency: 'moderate',
    report_contract: {
      identification: { slug: 'ghost-ant', label: entry.label, group: entry.group, category: 'insect', confidence: 'high', contested: false },
      service: { line: entry.service_line, key: entry.service_key, label: entry.service_label, inspection_required: entry.inspection_required },
      urgency: entry.urgency,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentificationRow = null;
  mockUpdateResult = 1;
  mockHoneypotTripped = false;
  mockGateState.pestIdentifier = true;
  Object.keys(inserts).forEach((k) => { inserts[k] = []; });
  mockIdentifyPest.mockResolvedValue(identifyResult('ghost-ant'));
});

describe('gate contract', () => {
  test('the whole surface 404s while GATE_PEST_IDENTIFIER is off', async () => {
    mockGateState.pestIdentifier = false;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(404);
      expect(mockIdentifyPest).not.toHaveBeenCalled();
    });
  });
});

describe('POST /analyze', () => {
  test('honeypot pretends success and never runs the paid pipeline', async () => {
    mockHoneypotTripped = true;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(200);
      expect(mockIdentifyPest).not.toHaveBeenCalled();
    });
  });

  test('teaser withholds the species and every raw model string', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.claimToken).toMatch(/^[a-f0-9]{32}$/);
      expect(body.teaser.identified_teaser).toBe('We identified an ant species.');
      const json = JSON.stringify(body);
      expect(json).not.toContain('Ghost Ants');
      expect(json).not.toContain('raw model observation');
      expect(json).not.toContain('report_contract');
      // Denormalized triage fields land on the stored row for the admin list.
      const stored = inserts.pest_identifications[0];
      expect(stored.species_slug).toBe('ghost-ant');
      expect(stored.service_line).toBe('pest');
      expect(stored.ai_analysis).toContain('saw it in the kitchen');
    });
  });

  test('vision outage degrades honestly with a 503, no row written', async () => {
    mockIdentifyPest.mockResolvedValue({ ok: false, reason: 'vision_unavailable' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(503);
      expect(inserts.pest_identifications).toHaveLength(0);
    });
  });
});

describe('POST /:id/claim', () => {
  test('happy path creates the lead, mints the token, prices the mapped service', async () => {
    mockIdentificationRow = analyzedRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.reportUrl).toBe(`/pest-report/${body.token}`);
      expect(body.pricing.tiers[0].monthly).toBe(39);

      expect(inserts.leads).toHaveLength(1);
      const lead = inserts.leads[0];
      expect(lead.lead_type).toBe('pest_identifier');
      expect(lead.first_contact_channel).toBe('pest_identifier_funnel');
      expect(JSON.parse(lead.extracted_data).species_slug).toBe('ghost-ant');

      // Funnel-by-source attribution row: reports alongside every other channel.
      expect(inserts.ad_service_attribution).toHaveLength(1);
      const attribution = inserts.ad_service_attribution[0];
      expect(attribution.lead_id).toBe('lead-uuid-1');
      expect(attribution.lead_source).toBe('pest_identifier');
      expect(attribution.service_line).toBe('pest');
      expect(attribution.funnel_stage).toBe('lead');
      expect(attribution.is_paid).toBe(false);
    });
  });

  test('replayed claim writes no attribution row', async () => {
    mockIdentificationRow = analyzedRow();
    mockUpdateResult = 0;
    await withServer(async (base) => {
      await fetch(`${base}/api/public/pest-identifier/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(inserts.ad_service_attribution).toHaveLength(0);
    });
  });

  test('inspection-first service line (termite) gets no pricing block', async () => {
    const entry = libraryEntry('subterranean-termite');
    mockIdentificationRow = analyzedRow({
      species_slug: 'subterranean-termite',
      report_contract: {
        identification: { slug: entry.slug, label: entry.label, group: entry.group, category: 'insect', confidence: 'high', contested: false },
        service: { line: entry.service_line, key: entry.service_key, label: entry.service_label, inspection_required: true },
        urgency: entry.urgency,
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.pricing).toBeNull();
    });
  });

  test('replayed claim returns 409', async () => {
    mockIdentificationRow = analyzedRow();
    mockUpdateResult = 0;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(409);
    });
  });
});

describe('GET /:token', () => {
  test('sent + unexpired report renders the allowlisted payload', async () => {
    mockIdentificationRow = analyzedRow({
      status: 'sent',
      report_token: 'e'.repeat(32),
      report_expires_at: new Date(Date.now() + 86400000).toISOString(),
      contact_snapshot: JSON.stringify({ first_name: 'Dana' }),
      address_snapshot: JSON.stringify({ city: 'Venice' }),
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/${'e'.repeat(32)}`);
      expect(res.status).toBe(200);
      const { report } = await res.json();
      expect(report.identified.label).toBe('Ghost Ants');
      expect(report.first_name).toBe('Dana');
      expect(report.city).toBe('Venice');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    });
  });

  test('malformed token is a generic 404', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/pest-identifier/not-a-token`);
      expect(res.status).toBe(404);
    });
  });
});
