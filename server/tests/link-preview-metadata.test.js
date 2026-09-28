/**
 * Per-link Open Graph preview metadata — route matching per customer token
 * kind, the privacy rule (no $ / amount / customer-identifying fields ever
 * reach a card), the suppressed-report → default fallback, and the
 * unknown-token → default fallback for every other kind.
 *
 * All DB access is mocked — nothing here needs DATABASE_URL / Postgres.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../routes/appointment-public', () => ({
  previewForVisit: jest.fn(async () => ({ state: 'upcoming', arrivalWindow: '9:00 AM - 11:00 AM' })),
}));

const db = require('../models/db');
const { previewForVisit } = require('../routes/appointment-public');
const {
  FIXED_CARDS,
  matchLinkPreviewRoute,
  resolveCardContent,
  loadLinkPreviewMetadata,
} = require('../services/link-preview-metadata');

// A minimal fluent knex-chain double: every non-terminal method returns the
// same object; `.first()` / `.select()` resolve to whatever the test wired
// up. Good enough for these resolvers, which never inspect the callback
// passed to a nested `.where(fn)` — only the final resolved row(s) matter.
function chainable({ first, rows } = {}) {
  const q = {};
  ['where', 'leftJoin', 'join', 'whereNull', 'whereNotNull', 'orderBy', 'limit'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.first = jest.fn(async (...args) => (typeof first === 'function' ? first(...args) : first));
  q.select = jest.fn(async (...args) => (typeof rows === 'function' ? rows(...args) : (rows || [])));
  return q;
}

function mockTables(map) {
  db.mockImplementation((table) => {
    if (!map[table]) throw new Error(`unexpected table in test: ${table}`);
    return map[table];
  });
}

beforeEach(() => {
  db.mockReset();
  process.env.GATE_APPOINTMENT_PAGE = 'true';
});

describe('route matching per customer link kind', () => {
  test.each([
    ['/report/project/jane-sample-0123456789ab', 'report-project', 'jane-sample-0123456789ab'],
    ['/estimate/est-token-abc', 'estimate', 'est-token-abc'],
    ['/appointment/' + 'a'.repeat(64), 'appointment', 'a'.repeat(64)],
    ['/reschedule/' + 'b'.repeat(64), 'reschedule', 'b'.repeat(64)],
    ['/reservice/' + 'c'.repeat(64), 'reservice', 'c'.repeat(64)],
    ['/prep/' + 'd'.repeat(32), 'prep', 'd'.repeat(32)],
    // /pay/statement/:token must resolve as pay-statement, never as a bare
    // /pay/:token match (statement is not the invoice's own token space).
    ['/pay/statement/' + 'e'.repeat(64), 'pay-statement', 'e'.repeat(64)],
    ['/pay/' + 'f'.repeat(64), 'pay', 'f'.repeat(64)],
    ['/receipt/' + 'g'.repeat(64), 'receipt', 'g'.repeat(64)],
    ['/rate/review-token-1', 'rate', 'review-token-1'],
    // The client's own redirects: a crawler never runs them.
    ['/recap/' + '1'.repeat(32), 'report', '1'.repeat(32)],
    ['/review/review-token-1', 'rate', 'review-token-1'],
    ['/book/est-token-abc', 'estimate', 'est-token-abc'],
    ['/inspection/tok', 'inspection', 'tok'],
    ['/secure/tok', 'secure', 'tok'],
    ['/track/tok', 'track', 'tok'],
    ['/visit/tok', 'visit', 'tok'],
    ['/lawn-report/tok', 'lawn-report', 'tok'],
    ['/pest-report/tok', 'pest-report', 'tok'],
    ['/service-outlines/tok', 'service-outline', 'tok'],
    ['/contract/tok', 'contract', 'tok'],
    ['/price-change/tok', 'price-change', 'tok'],
    ['/card/tok', 'card', 'tok'],
    ['/careers/interview/tok', 'interview', 'tok'],
  ])('%s -> kind=%s token=%s', (path, kind, token) => {
    expect(matchLinkPreviewRoute(path)).toEqual({ kind, token });
  });

  test('service report paths are NOT matched here — report-page-metadata owns them', () => {
    expect(matchLinkPreviewRoute('/report/' + '0'.repeat(32))).toBeNull();
  });

  test('a lookup kind only matches a path the privacy headers also cover; tokens are never URL-decoded', () => {
    // /recap/%61 + 31 a's decodes to a valid report token but slips the
    // hex-only limiter and header checks, so it must not match at all.
    expect(matchLinkPreviewRoute(`/recap/%61${'a'.repeat(31)}`)).toBeNull();
    expect(matchLinkPreviewRoute(`/appointment/%61${'a'.repeat(63)}`)).toBeNull();
    expect(matchLinkPreviewRoute(`/prep/%63${'c'.repeat(31)}`)).toBeNull();
    expect(matchLinkPreviewRoute(`/reschedule/${'b'.repeat(63)}`)).toBeNull();
    expect(matchLinkPreviewRoute(`/appointment/${'A'.repeat(64)}`)).toBeNull();
    expect(matchLinkPreviewRoute('/report/project/jane_sample-0123456789ab')).toBeNull();
    // token-free kinds read nothing, so an odd token still gets its card
    expect(matchLinkPreviewRoute('/pay/%61bc')).toEqual({ kind: 'pay', token: '%61bc' });
  });

  test('an unrecognized path matches nothing', () => {
    expect(matchLinkPreviewRoute('/login')).toBeNull();
    expect(matchLinkPreviewRoute('/')).toBeNull();
  });
});

describe('privacy: no $, amount, or customer-identifying field ever reaches a card', () => {
  const FORBIDDEN_KEY_RE = /first_name|last_name|address|phone|email|tech_name|notes/i;

  function assertPrivacySafe(content) {
    expect(content).toBeTruthy();
    const json = JSON.stringify(content);
    expect(json).not.toMatch(/\$\s?\d/);
    expect(json).not.toMatch(/\d{2,}\.\d{2}/); // no dollar-and-cents shaped number
    expect(Object.keys(content).join(' ')).not.toMatch(FORBIDDEN_KEY_RE);
    expect(json).not.toMatch(FORBIDDEN_KEY_RE);
  }

  test.each(Object.keys(FIXED_CARDS))('fixed card %s carries no price or customer detail and reads nothing', async (kind) => {
    db.mockImplementation(() => { throw new Error('a fixed card must not query the DB'); });
    const content = await resolveCardContent(kind, 'any-token-real-or-not');
    assertPrivacySafe(content);
    expect(content).toBe(FIXED_CARDS[kind]);
  });

  test('estimate card stays generic — no services, no prices', () => {
    expect(FIXED_CARDS.estimate).toEqual({ eyebrow: 'ESTIMATE', headline: 'Your estimate', subline: 'See your options and book online' });
  });
});

describe('appointment / reschedule cards (scheduled_services.reschedule_token)', () => {
  test('appointment card reads service_type + date, never the customer', async () => {
    mockTables({
      'scheduled_services as s': chainable({
        first: {
          id: 1, scheduled_date: '2026-09-26', window_start: '09:00',
          service_type: 'Pest Control', customer_deleted_at: null,
        },
      }),
    });
    const content = await resolveCardContent('appointment', 'a'.repeat(64));
    expect(content.eyebrow).toBe('APPOINTMENT');
    expect(content.headline).toBe('Pest Control');
    expect(content.subline).toMatch(/September 26, 2026/);
  });

  test('the window is the page\'s own (a grouped visit\'s canonical window), not the token row\'s start', async () => {
    previewForVisit.mockResolvedValueOnce({ state: 'upcoming', arrivalWindow: '8:00 AM - 10:00 AM' });
    mockTables({
      'scheduled_services as s': chainable({
        first: {
          id: 2, status: 'confirmed', visit_id: 'v1', scheduled_date: '2026-10-02', window_start: '10:30',
          service_type: 'Mosquito Control', customer_deleted_at: null,
        },
      }),
    });
    const content = await resolveCardContent('appointment', 'a'.repeat(64));
    expect(content.subline).toBe('October 2, 2026 · 8:00 AM - 10:00 AM');
  });

  test('a visit the page would not show as upcoming keeps its old slot off the card', async () => {
    previewForVisit.mockResolvedValueOnce({ state: 'pending_rebook', arrivalWindow: '9:00 AM - 11:00 AM' });
    mockTables({
      'scheduled_services as s': chainable({
        first: {
          id: 1, status: 'rescheduled', scheduled_date: '2026-09-26', window_start: '09:00',
          service_type: 'Pest Control', customer_deleted_at: null,
        },
      }),
    });
    const content = await resolveCardContent('appointment', 'a'.repeat(64));
    expect(content).toEqual({ eyebrow: 'APPOINTMENT', headline: 'Pest Control', subline: 'View your visit details' });
  });

  test('appointment page dark (gate off) falls back to no card', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'false';
    const content = await resolveCardContent('appointment', 'a'.repeat(64));
    expect(content).toBeNull();
  });

  test('a deleted customer\'s appointment token yields no card (matches the real page\'s 404)', async () => {
    mockTables({
      'scheduled_services as s': chainable({
        first: { id: 1, scheduled_date: '2026-09-26', window_start: '09:00', service_type: 'Pest Control', customer_deleted_at: new Date() },
      }),
    });
    const content = await resolveCardContent('appointment', 'a'.repeat(64));
    expect(content).toBeNull();
  });

  test('reschedule card reads only service_type', async () => {
    mockTables({
      'scheduled_services as s': chainable({ first: { id: 2, service_type: 'lawn_care', customer_deleted_at: null } }),
    });
    const content = await resolveCardContent('reschedule', 'b'.repeat(64));
    expect(content).toEqual({ eyebrow: 'RESCHEDULE', headline: 'Lawn Care', subline: 'Pick a time that works for you' });
  });

  test('an unknown reschedule token resolves to no card', async () => {
    mockTables({ 'scheduled_services as s': chainable({ first: null }) });
    const content = await resolveCardContent('reschedule', 'b'.repeat(64));
    expect(content).toBeNull();
  });
});

describe('unknown/invalid token -> null for every kind (caller falls back to the default card)', () => {
  test.each([
    ['appointment', 'scheduled_services as s'],
    ['reschedule', 'scheduled_services as s'],
  ])('kind=%s with no matching row -> null', async (kind, table) => {
    mockTables({ [table]: chainable({ first: null }) });
    const content = await resolveCardContent(kind, 'does-not-exist-token-000000000000');
    expect(content).toBeNull();
  });

  test('prep with no matching project or service -> null', async () => {
    mockTables({
      projects: chainable({ first: null }),
      scheduled_services: chainable({ first: null }),
    });
    const content = await resolveCardContent('prep', 'd'.repeat(32));
    expect(content).toBeNull();
  });

  test('a failed lookup logs the error code, never the knex message that embeds the token', async () => {
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const tok = 'b'.repeat(64);
    const err = Object.assign(new Error(`select * from "scheduled_services" where "reschedule_token" = '${tok}'`), { code: 'ECONNRESET' });
    mockTables({ 'scheduled_services as s': chainable({ first: () => { throw err; } }) });
    expect(await resolveCardContent('reschedule', tok)).toBeNull();
    const logged = logger.warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain(tok);
  });

  test('a malformed token never reaches the database at all', async () => {
    db.mockImplementation(() => { throw new Error('must not query the DB for a malformed token'); });
    expect(await resolveCardContent('appointment', 'not-a-hex-token')).toBeNull();
    expect(await resolveCardContent('reschedule', 'short')).toBeNull();
    expect(await resolveCardContent('prep', 'too-short')).toBeNull();
  });

  test('an unregistered kind resolves to null without touching the DB', async () => {
    db.mockImplementation(() => { throw new Error('must not query the DB for an unknown kind'); });
    expect(await resolveCardContent('not-a-real-kind', 'whatever')).toBeNull();
  });
});

describe('report suppression (typedReportDelivery) carries through resolveCardContent', () => {
  test('internal_only report -> null (no existence leak)', async () => {
    mockTables({
      service_records: chainable({
        first: {
          service_type: 'Rodent Trapping',
          service_date: '2026-06-11',
          structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }),
        },
      }),
    });
    const content = await resolveCardContent('report', '0'.repeat(32));
    expect(content).toBeNull();
  });

  test('auto_send report resolves a card', async () => {
    mockTables({
      service_records: chainable({
        first: { service_type: 'Pest Inspection', service_date: '2026-06-11', structured_notes: null },
      }),
    });
    const content = await resolveCardContent('report', '0'.repeat(32));
    expect(content).toEqual({ eyebrow: 'SERVICE REPORT', headline: 'Pest Inspection', subline: 'June 11, 2026' });
  });
});

describe('loadLinkPreviewMetadata (the full HTML <head> path)', () => {
  test('a service report path builds title/description/image from report-page-metadata', async () => {
    mockTables({
      service_records: chainable({
        first: { service_type: 'Quarterly Pest Control Service', service_date: '2026-05-16', structured_notes: null },
      }),
    });
    const metadata = await loadLinkPreviewMetadata('/report/' + '1'.repeat(32));
    expect(metadata.title).toBe('Service report · May 16, 2026 · Quarterly Pest Control Service');
    expect(metadata.image.url).toContain('/og/report/');
    expect(metadata.image.url).toContain('1'.repeat(32));
  });

  test('a matched-but-invalid token returns null (caller keeps the default og:image)', async () => {
    mockTables({ 'scheduled_services as s': chainable({ first: null }) });
    const metadata = await loadLinkPreviewMetadata('/reschedule/' + 'b'.repeat(64));
    expect(metadata).toBeNull();
  });

  test('an unmatched path returns null', async () => {
    const metadata = await loadLinkPreviewMetadata('/some/unrelated/path');
    expect(metadata).toBeNull();
  });

  test('a looked-up kind builds an absolute /og/:kind/:token.jpg image URL; the preview title is just "Waves"', async () => {
    mockTables({ 'scheduled_services as s': chainable({ first: { id: 1, service_type: 'Lawn Care', customer_deleted_at: null } }) });
    const metadata = await loadLinkPreviewMetadata('/reschedule/' + 'b'.repeat(64));
    expect(metadata.image.url).toMatch(new RegExp(`^https?://.+/og/reschedule/${'b'.repeat(64)}\\.jpg$`));
    expect(metadata.image.width).toBe(1200);
    expect(metadata.image.height).toBe(630);
    expect(metadata.previewTitle).toBe('Waves');
    expect(metadata.title).toBe('Lawn Care · Waves Pest Control');
  });

  test('a fixed kind\'s image URL carries no token', async () => {
    db.mockImplementation(() => { throw new Error('a fixed card must not query the DB'); });
    const metadata = await loadLinkPreviewMetadata('/pay/' + 'f'.repeat(64));
    expect(metadata.image.url).toMatch(/^https?:\/\/.+\/og\/pay\.jpg$/);
    expect(metadata.image.url).not.toContain('f'.repeat(64));
    expect(metadata.previewTitle).toBe('Waves');
  });
});
