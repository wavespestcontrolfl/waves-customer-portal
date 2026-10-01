/**
 * Per-link Open Graph preview metadata — route matching per customer link
 * kind, the privacy rule (no $ / amount / customer-identifying field ever
 * reaches a card), the service report's own lookup + suppression, fixed
 * cards that read nothing, and dark surfaces falling back to the default.
 *
 * All DB access is mocked — nothing here needs DATABASE_URL / Postgres.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => true),
  leadInspectionLinkLive: jest.fn(() => true),
}));
jest.mock('../services/reservice-scheduler', () => ({ reserviceSelfServeEnabled: jest.fn(() => true) }));

const db = require('../models/db');
const gates = require('../config/feature-gates');
const { reserviceSelfServeEnabled } = require('../services/reservice-scheduler');
const {
  FIXED_CARDS,
  fixedCardHeadTags,
  matchLinkPreviewRoute,
  resolveCardContent,
  loadLinkPreviewMetadata,
} = require('../services/link-preview-metadata');

// A minimal fluent knex-chain double: `.first()` resolves to what the test
// wired up.
function chainable({ first } = {}) {
  const q = {};
  ['where', 'leftJoin', 'whereNull', 'orderBy', 'limit'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.first = jest.fn(async (...args) => (typeof first === 'function' ? first(...args) : first));
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
  gates.isEnabled.mockImplementation(() => true);
  gates.leadInspectionLinkLive.mockImplementation(() => true);
  reserviceSelfServeEnabled.mockImplementation(() => true);
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

  test('the report card only matches a path the privacy headers cover; tokens are never URL-decoded', () => {
    // /recap/%61 + 31 a's decodes to a valid report token but slips the
    // hex-only limiter and header checks, so it must not match at all.
    expect(matchLinkPreviewRoute(`/recap/%61${'a'.repeat(31)}`)).toBeNull();
    // fixed kinds read nothing, so an odd token still gets its card
    expect(matchLinkPreviewRoute('/pay/%61bc')).toEqual({ kind: 'pay', token: '%61bc' });
  });

  test('an unrecognized path matches nothing', () => {
    expect(matchLinkPreviewRoute('/login')).toBeNull();
    expect(matchLinkPreviewRoute('/')).toBeNull();
  });
});

describe('fixed cards', () => {
  const FORBIDDEN_KEY_RE = /first_name|last_name|address|phone|email|tech_name|notes/i;

  test.each(Object.keys(FIXED_CARDS))('%s carries no price or customer detail and reads nothing', async (kind) => {
    db.mockImplementation(() => { throw new Error('a fixed card must not query the DB'); });
    const content = await resolveCardContent(kind, 'any-token-real-or-not');
    expect(content).toBe(FIXED_CARDS[kind]);
    const json = JSON.stringify(content);
    expect(json).not.toMatch(/\$\s?\d/);
    expect(json).not.toMatch(/\d{2,}\.\d{2}/);
    expect(json).not.toMatch(FORBIDDEN_KEY_RE);
  });

  test('estimate card stays generic — no services, no prices', () => {
    expect(FIXED_CARDS.estimate).toEqual({ eyebrow: 'ESTIMATE', headline: 'Your estimate', subline: 'See your options and book online' });
  });

  test.each([
    ['appointment', () => { process.env.GATE_APPOINTMENT_PAGE = 'false'; }],
    ['pay-statement', () => gates.isEnabled.mockImplementation((g) => g !== 'payerStatements')],
    ['interview', () => gates.isEnabled.mockImplementation((g) => g !== 'recruitingComms')],
    ['inspection', () => gates.leadInspectionLinkLive.mockImplementation(() => false)],
    ['reservice', () => reserviceSelfServeEnabled.mockImplementation(() => false)],
  ])('a dark %s surface gets no card (the default stands)', async (kind, goDark) => {
    expect(await resolveCardContent(kind, 'x')).toBe(FIXED_CARDS[kind]);
    goDark();
    expect(await resolveCardContent(kind, 'x')).toBeNull();
    expect(await loadLinkPreviewMetadata(`/${kind === 'pay-statement' ? 'pay/statement' : kind === 'interview' ? 'careers/interview' : kind}/tok`)).toBeNull();
  });

  test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'not-a-real-kind'])('unregistered or inherited kind %s gets no card', async (kind) => {
    db.mockImplementation(() => { throw new Error('must not query the DB for an unknown kind'); });
    expect(await resolveCardContent(kind, 'x')).toBeNull();
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
    expect(metadata.previewTitle).toBe('Waves');
    expect(metadata.image.url).toMatch(new RegExp(`^https?://.+/og/report/${'1'.repeat(32)}\\.jpg$`));
  });

  test('a recap link resolves the same report card; an unknown one gets none', async () => {
    mockTables({ service_records: chainable({ first: { service_type: 'Lawn Care', service_date: '2026-05-16', structured_notes: null } }) });
    const metadata = await loadLinkPreviewMetadata('/recap/' + '2'.repeat(32));
    expect(metadata.image.url).toContain(`/og/report/${'2'.repeat(32)}.jpg`);
    expect(metadata.title).toBeUndefined(); // the page keeps its own <title>
    mockTables({ service_records: chainable({ first: null }) });
    expect(await loadLinkPreviewMetadata('/recap/' + '3'.repeat(32))).toBeNull();
  });

  test('a failed report lookup logs the error code, never the knex message that embeds the token', async () => {
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const tok = '4'.repeat(32);
    const err = Object.assign(new Error(`select * from "service_records" where "report_view_token" = '${tok}'`), { code: 'ECONNRESET' });
    mockTables({ service_records: chainable({ first: () => { throw err; } }) });
    expect(await loadLinkPreviewMetadata(`/recap/${tok}`)).toBeNull();
    const logged = logger.warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain(tok);
  });

  test('an unmatched path returns null', async () => {
    expect(await loadLinkPreviewMetadata('/some/unrelated/path')).toBeNull();
  });

  test('a fixed kind\'s image URL carries no token; the preview title is just "Waves"', async () => {
    db.mockImplementation(() => { throw new Error('a fixed card must not query the DB'); });
    const metadata = await loadLinkPreviewMetadata('/appointment/' + 'f'.repeat(64));
    expect(metadata.image.url).toMatch(/^https?:\/\/.+\/og\/appointment\.jpg$/);
    expect(metadata.image.url).not.toContain('f'.repeat(64));
    expect(metadata.previewTitle).toBe('Waves');
    expect(metadata.title).toBeUndefined(); // the page keeps its own <title>
  });
});

describe('legacy server-rendered estimate view', () => {
  test('fixedCardHeadTags gives only the preview tags for the estimate card', () => {
    const tags = fixedCardHeadTags('estimate');
    expect(tags).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+\/og\/estimate\.jpg">/);
    expect(tags).toContain('<meta property="og:title" content="Waves">');
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(tags).not.toMatch(/<title>|name="description"/);
    expect(fixedCardHeadTags('not-a-kind')).toBe('');
  });

  test('the legacy renderPage head carries them', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    expect(src).toMatch(/<title>Your Waves Estimate<\/title>[\s\S]{0,200}fixedCardHeadTags\('estimate'\)/);
  });
});
