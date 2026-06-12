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
  addDaysToDateString,
  windowBounds,
  annotationBoundaries,
  capAnnotations,
  sortRows,
  classifyMovement,
  mergeWindowRows,
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

// ── window math ─────────────────────────────────────────────────────

describe('windowBounds', () => {
  test('anchors both windows on the latest synced GSC date (Codex P2: an ends-today window starves the current period by the sync lag)', () => {
    const b = windowBounds(7, '2026-06-10');
    expect(b.current_since).toBe('2026-06-04');
    expect(b.current_to).toBe('2026-06-10');
    expect(b.prior_since).toBe('2026-05-28');
    // both windows are exactly 7 calendar days
    expect(addDaysToDateString(b.current_since, 6)).toBe(b.current_to);
    expect(addDaysToDateString(b.prior_since, 6)).toBe(addDaysToDateString(b.current_since, -1));
  });
  test('addDaysToDateString crosses month/year boundaries', () => {
    expect(addDaysToDateString('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysToDateString('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysToDateString('garbage', 1)).toBeNull();
  });
});

describe('annotationBoundaries', () => {
  test('lookback starts at the anchored prior-window start, not wall-clock now (Codex r2)', () => {
    const b = annotationBoundaries('2026-06-09', '2026-06-10', 7);
    expect(b.sinceDateString).toBe('2026-05-27'); // oldest anchor - 13d = prior window start
    // timestamp boundary = ET midnight of that day (EDT = UTC-4 in June)
    expect(b.sinceDate.toISOString()).toBe('2026-05-27T04:00:00.000Z');
    // upper bound = newest anchor (displayed window end), not today (Codex r3)
    expect(b.untilDateString).toBe('2026-06-10');
  });
});

describe('capAnnotations', () => {
  test('drops chips dated after the displayed window end — a change shipped today must not imply it caused movement measured through an older anchor (Codex r3)', () => {
    const anns = [
      { date: '2026-06-09', type: 'META' },
      { date: '2026-06-10', type: 'LINKS' },
      { date: '2026-06-12', type: 'CONTENT' }, // after the anchor — GSC hasn't seen it
    ];
    expect(capAnnotations(anns, '2026-06-10').map((a) => a.date)).toEqual(['2026-06-09', '2026-06-10']);
    expect(capAnnotations(anns, null)).toHaveLength(3);
  });
});

describe('sortRows', () => {
  test('lost pages outrank ordinary movers so the limit slice can never cut them (Codex r2)', () => {
    const rows = [
      { movement: 'win', change: -32.9, impressions_now: 1146, impressions_before: 1174 },
      { movement: 'lost', change: null, impressions_now: 0, impressions_before: 50 },
      { movement: 'flat', change: 0.1, impressions_now: 9000, impressions_before: 9000 },
      { movement: 'lost', change: null, impressions_now: 0, impressions_before: 880 },
    ];
    sortRows(rows);
    expect(rows.map((r) => r.movement)).toEqual(['lost', 'lost', 'win', 'flat']);
    // within the lost tier, bigger prior exposure first
    expect(rows[0].impressions_before).toBe(880);
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
  test('a page ABSENT from the current window is emitted as lost with zeroed now-metrics (Codex P2)', () => {
    const rows = buildRows([], [pri({ impressions: '500' })], { minImpressions: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].movement).toBe('lost');
    expect(rows[0].pos_now).toBeNull();
    expect(rows[0].clicks_now).toBe(0);
    expect(rows[0].impressions_now).toBe(0);
    expect(rows[0].pos_before).toBe(64.8);
  });
  test('a vanished page below the floor stays dropped', () => {
    expect(buildRows([], [pri({ impressions: '4' })], { minImpressions: 10 })).toHaveLength(0);
  });
  test('windows join on the canonical key — /foo vs /foo/ across a canonical change is a move, not new+lost (Codex P2)', () => {
    const rows = buildRows(
      [cur({ page_url: 'https://www.wavespestcontrol.com/hotels' })],
      [pri({ page_url: 'https://wavespestcontrol.com/hotels/' })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].movement).toBe('win');
    expect(rows[0].pos_before).toBe(64.8);
  });
});

// ── mergeWindowRows ─────────────────────────────────────────────────

describe('mergeWindowRows', () => {
  test('URL variants within one window combine with impression-weighted position', () => {
    const merged = mergeWindowRows([
      cur({ page_url: 'https://www.wavespestcontrol.com/hotels/', impressions: '1000', avg_position: '50', clicks: '5' }),
      cur({ page_url: 'https://wavespestcontrol.com/hotels', impressions: '1', avg_position: '1', clicks: '1' }),
    ]);
    expect(merged.size).toBe(1);
    const entry = [...merged.values()][0];
    // (50×1000 + 1×1) / 1001 ≈ 50 — NOT the unweighted 25.5
    expect(entry.position).toBeCloseTo(50, 0);
    expect(entry.clicks).toBe(6);
    expect(entry.impressions).toBe(1001);
    // higher-impression variant's URL wins for display
    expect(entry.page_url).toBe('https://www.wavespestcontrol.com/hotels/');
  });
  test('unkeyable URLs are skipped, not crashed on', () => {
    expect(mergeWindowRows([cur({ page_url: 'garbage' })]).size).toBe(0);
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

  test('caps each row at its OWN domain anchor — a lagging spoke must not show a chip dated after its window even when a fresher domain anchors later (Codex r4)', () => {
    const [hubRow, spokeRow] = buildRows(
      [cur(), cur({ page_url: 'https://venicepestcontrol.com/lawn/', domain: 'venicepestcontrol.com' })],
      [pri(), pri({ page_url: 'https://venicepestcontrol.com/lawn/', domain: 'venicepestcontrol.com' })]
    );
    const anns = [
      { key: 'wavespestcontrol.com/hotels', type: 'META', date: '2026-06-10', source: 'experiment' },
      { key: 'venicepestcontrol.com/lawn', type: 'LINKS', date: '2026-06-10', source: 'internal_link' },
      { key: 'venicepestcontrol.com/lawn', type: 'CONTENT', date: '2026-06-09', source: 'autonomous_run' },
    ];
    attachAnnotations([hubRow, spokeRow], anns, {
      'wavespestcontrol.com': '2026-06-10',
      'venicepestcontrol.com': '2026-06-09', // spoke sync is a day behind
    });
    expect(hubRow.annotations.map((a) => a.date)).toEqual(['2026-06-10']);
    expect(spokeRow.annotations.map((a) => a.type)).toEqual(['CONTENT']); // 06-10 LINKS chip dropped
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
  test('lost pages count as lost and do NOT inflate pages_tracked', () => {
    const rows = buildRows([cur()], [pri(), pri({ page_url: 'https://www.wavespestcontrol.com/vanished/', impressions: '300' })]);
    const s = summarize(rows);
    expect(s.lost).toBe(1);
    expect(s.pages_tracked).toBe(1);
    expect(s.pages_tracked_delta).toBe(1 - 2);
  });
});
