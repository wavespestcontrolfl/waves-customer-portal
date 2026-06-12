/**
 * Unit tests for the pure helpers in services/seo/rankings-monitor.
 *
 * No DB / no network — the window queries and annotation fetchers hit
 * gsc_pages and the content-engine tables and are validated against real
 * data; everything assertable deterministically lives here.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const {
  chipForAction,
  urlJoinKey,
  dateColToString,
  classifyMovement,
  buildRows,
  attachAnnotations,
  summarize,
  MOVEMENT_EPSILON,
} = require('../services/seo/rankings-monitor')._internals;

// ── chipForAction ───────────────────────────────────────────────────

describe('chipForAction', () => {
  test.each([
    ['rewrite_title_meta', 'META'],
    ['refresh_existing_page', 'CONTENT'],
    ['new_supporting_blog', 'CONTENT'],
    ['add_internal_links', 'LINKS'],
    ['internal_linking', 'LINKS'],
    ['add_schema', 'SCHEMA'],
  ])('%s → %s', (action, chip) => {
    expect(chipForAction(action)).toBe(chip);
  });
  test('non-page-change actions map to null (no chip)', () => {
    expect(chipForAction('submit_indexnow')).toBeNull();
    expect(chipForAction('gbp_post')).toBeNull();
    expect(chipForAction('')).toBeNull();
    expect(chipForAction(null)).toBeNull();
  });
});

// ── urlJoinKey ──────────────────────────────────────────────────────

describe('urlJoinKey', () => {
  test('absolute URL: strips protocol, www, query, hash, trailing slash; lowercases', () => {
    expect(urlJoinKey('https://www.wavespestcontrol.com/Pest-Control-Bradenton-FL/?utm_source=gbp#x'))
      .toBe('wavespestcontrol.com/pest-control-bradenton-fl');
  });
  test('homepage keys to host + /', () => {
    expect(urlJoinKey('https://www.wavespestcontrol.com/')).toBe('wavespestcontrol.com/');
  });
  test('path-only input requires assumeHost (internal-link target_url is hub-only)', () => {
    expect(urlJoinKey('/blog/some-post/', { assumeHost: 'wavespestcontrol.com' }))
      .toBe('wavespestcontrol.com/blog/some-post');
    expect(urlJoinKey('/blog/some-post/')).toBeNull();
  });
  test('host/path form (normalize-url output) parses too', () => {
    expect(urlJoinKey('bradentonflpestcontrol.com/pest-control/'))
      .toBe('bradentonflpestcontrol.com/pest-control');
  });
  test('same page, different sources → identical keys', () => {
    const fromGsc = urlJoinKey('https://www.wavespestcontrol.com/termite-control-sarasota-fl/');
    const fromTask = urlJoinKey('/termite-control-sarasota-fl/', { assumeHost: 'wavespestcontrol.com' });
    expect(fromGsc).toBe(fromTask);
  });
  test('garbage in → null out', () => {
    expect(urlJoinKey('')).toBeNull();
    expect(urlJoinKey(null)).toBeNull();
    expect(urlJoinKey('not a url at all', {})).toBeNull();
  });
});

// ── dateColToString ─────────────────────────────────────────────────

describe('dateColToString', () => {
  test('passes pg DATE strings through', () => {
    expect(dateColToString('2026-05-07')).toBe('2026-05-07');
    expect(dateColToString('2026-05-07T00:00:00.000Z')).toBe('2026-05-07');
  });
  test('reads local components from a Date (pg parses DATE at local midnight — ET conversion would shift the day on a UTC host)', () => {
    const d = new Date(2026, 4, 7); // local midnight May 7
    expect(dateColToString(d)).toBe('2026-05-07');
  });
  test('null/invalid → null', () => {
    expect(dateColToString(null)).toBeNull();
    expect(dateColToString(new Date('garbage'))).toBeNull();
  });
});

// ── classifyMovement ────────────────────────────────────────────────

describe('classifyMovement', () => {
  test('negative change past epsilon = win (position number went DOWN)', () => {
    expect(classifyMovement(-12.6, true)).toBe('win');
    expect(classifyMovement(-MOVEMENT_EPSILON, true)).toBe('win');
  });
  test('positive change past epsilon = loss', () => {
    expect(classifyMovement(3.1, true)).toBe('loss');
  });
  test('within epsilon = flat; no prior = new', () => {
    expect(classifyMovement(0.2, true)).toBe('flat');
    expect(classifyMovement(-0.4, true)).toBe('flat');
    expect(classifyMovement(null, false)).toBe('new');
  });
});

// ── buildRows ───────────────────────────────────────────────────────

const cur = (over = {}) => ({
  page_url: 'https://www.wavespestcontrol.com/hotels/',
  domain: 'wavespestcontrol.com',
  page_type: 'landing',
  clicks: '2',
  impressions: '1146',
  avg_position: '31.92',
  ...over,
});
const pri = (over = {}) => ({
  page_url: 'https://www.wavespestcontrol.com/hotels/',
  domain: 'wavespestcontrol.com',
  page_type: 'landing',
  clicks: '0',
  impressions: '1174',
  avg_position: '64.83',
  ...over,
});

describe('buildRows', () => {
  test('joins windows per domain+url and computes the screenshot math', () => {
    const [row] = buildRows([cur()], [pri()]);
    expect(row.pos_before).toBe(64.8);
    expect(row.pos_now).toBe(31.9);
    expect(row.change).toBe(-32.9);
    expect(row.movement).toBe('win');
    expect(row.clicks_before).toBe(0);
    expect(row.clicks_now).toBe(2);
    expect(row.ctr_now).toBeCloseTo(0.17, 2);
  });
  test('page with no prior window data is "new", change null', () => {
    const [row] = buildRows([cur()], []);
    expect(row.movement).toBe('new');
    expect(row.pos_before).toBeNull();
    expect(row.change).toBeNull();
  });
  test('same path on two domains stays two rows (spoke fleet)', () => {
    const rows = buildRows(
      [cur({ page_url: 'https://bradentonflpestcontrol.com/pest-control/', domain: 'bradentonflpestcontrol.com' }),
       cur({ page_url: 'https://veniceflpestcontrol.com/pest-control/', domain: 'veniceflpestcontrol.com' })],
      []
    );
    expect(rows).toHaveLength(2);
  });
  test('noise floor: pages under minImpressions in BOTH windows are dropped', () => {
    const rows = buildRows(
      [cur({ impressions: '3' })],
      [pri({ impressions: '4' })],
      { minImpressions: 10 }
    );
    expect(rows).toHaveLength(0);
  });
  test('a page that lost its impressions stays (decay must be visible)', () => {
    const rows = buildRows([cur({ impressions: '2' })], [pri({ impressions: '500' })], { minImpressions: 10 });
    expect(rows).toHaveLength(1);
  });
});

// ── attachAnnotations ───────────────────────────────────────────────

describe('attachAnnotations', () => {
  const pageRow = () => buildRows([cur()], [pri()])[0];

  test('attaches chips by join key, newest first', () => {
    const row = pageRow();
    attachAnnotations([row], [
      { key: 'wavespestcontrol.com/hotels', type: 'META', date: '2026-04-17', source: 'experiment', status: 'running' },
      { key: 'wavespestcontrol.com/hotels', type: 'CONTENT', date: '2026-05-05', source: 'autonomous_run' },
      { key: 'wavespestcontrol.com/other', type: 'META', date: '2026-05-01', source: 'experiment' },
    ]);
    expect(row.annotations.map((a) => a.type)).toEqual(['CONTENT', 'META']);
    expect(row.annotations[1].status).toBe('running');
  });

  test('same page+type+day from two sources merges into one chip with both sources', () => {
    const row = pageRow();
    attachAnnotations([row], [
      { key: 'wavespestcontrol.com/hotels', type: 'META', date: '2026-04-17', source: 'autonomous_run' },
      { key: 'wavespestcontrol.com/hotels', type: 'META', date: '2026-04-17', source: 'experiment', status: 'accepted' },
    ]);
    expect(row.annotations).toHaveLength(1);
    expect(row.annotations[0].sources.sort()).toEqual(['autonomous_run', 'experiment']);
    expect(row.annotations[0].status).toBe('accepted'); // experiment verdict wins
    expect(row.annotations[0].count).toBe(2);
  });

  test('several merged links on one day collapse to one LINKS chip with a count', () => {
    const row = pageRow();
    attachAnnotations([row], [
      { key: 'wavespestcontrol.com/hotels', type: 'LINKS', date: '2026-06-12', source: 'internal_link' },
      { key: 'wavespestcontrol.com/hotels', type: 'LINKS', date: '2026-06-12', source: 'internal_link' },
      { key: 'wavespestcontrol.com/hotels', type: 'LINKS', date: '2026-06-12', source: 'internal_link' },
    ]);
    expect(row.annotations).toHaveLength(1);
    expect(row.annotations[0].count).toBe(3);
  });

  test('caps chips per page at 6, keeping the most recent', () => {
    const row = pageRow();
    const anns = Array.from({ length: 9 }, (_, i) => ({
      key: 'wavespestcontrol.com/hotels', type: 'META', date: `2026-04-0${i + 1}`, source: 'experiment',
    }));
    attachAnnotations([row], anns);
    expect(row.annotations).toHaveLength(6);
    expect(row.annotations[0].date).toBe('2026-04-09');
  });
});

// ── summarize ───────────────────────────────────────────────────────

describe('summarize', () => {
  test('totals, impression-weighted positions, and movement counts', () => {
    const rows = buildRows(
      [cur(), cur({ page_url: 'https://www.wavespestcontrol.com/brunches/', clicks: '0', impressions: '248', avg_position: '40.7' })],
      [pri(), pri({ page_url: 'https://www.wavespestcontrol.com/brunches/', clicks: '1', impressions: '194', avg_position: '18.4' })]
    );
    const s = summarize(rows);
    expect(s.clicks).toBe(2);
    expect(s.clicks_delta).toBe(1);
    expect(s.impressions).toBe(1146 + 248);
    expect(s.pages_tracked).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    // weighted: (31.9*1146 + 40.7*248) / 1394
    expect(s.avg_position).toBeCloseTo(33.5, 1);
  });
  test('empty rows → null positions, zero counts', () => {
    const s = summarize([]);
    expect(s.avg_position).toBeNull();
    expect(s.pages_tracked).toBe(0);
  });
});
