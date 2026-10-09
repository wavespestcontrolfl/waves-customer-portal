/**
 * Customer watering lines follow the University of Florida rule (owner 2026-10-09):
 * change how OFTEN by the lawn's wilt signs, keep each run at 1/2 to 3/4 inch, fewer and
 * longer runs on the allowed watering days. No number of watering days, no "add a day",
 * no "shorten the runs". A one-day-a-week water shortage order is in force for Manatee and
 * Sarasota until 2027-03-31, so a day count is also a legal instruction.
 *
 * Pure copy: these tests pin the sentences and scan the customer-facing sources for the
 * old patterns. They do not touch a calculation, a send condition or a schedule.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/service-report/cross-sell', () => ({
  ...jest.requireActual('../services/service-report/cross-sell'),
  buildPortalOffer: jest.fn(async () => null),
}));

const COPY = require('../../shared/watering-copy.json');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { _test: { IRRIGATION_ADVICE } } = require('../services/property-recommendations');
const FawnWeather = require('../services/fawn-weather');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WILT = 'folded blades, a blue-gray tint, or footprints that stay pressed in';

// Handlers of the feed router, one fresh module instance per call (module-level cache).
function feedHandler(routePath) {
  jest.resetModules();
  jest.doMock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));
  jest.doMock('../services/local-news-store', () => ({}));
  jest.doMock('../services/pest-forecast/forecast', () => ({ getForecast: jest.fn() }));
  const router = require('../routes/feed');
  return router.stack.find((l) => l.route && l.route.path === routePath).route.stack[0].handle;
}

async function callHandler(handler) {
  let body;
  await handler({ query: {}, headers: {} }, { json: (b) => { body = b; } }, (e) => { throw e; });
  return body;
}

describe('shared watering sentences', () => {
  test('the shared file holds the UF wilt signs, the fewer-longer-runs sentence and the add-minutes sentence', () => {
    expect(COPY.wiltSigns).toBe(WILT);
    expect(COPY.surplusAdvice).toBe('Skip a watering day rather than shortening your runs — longer runs reach the roots better than short ones.');
    expect(COPY.deficitAdvice).toBe(`If the grass shows ${WILT}, run one full cycle on your next allowed watering day.`);
  });

  test('every shared sentence passes the customer copy screen', () => {
    for (const key of ['wiltSigns', 'surplusAdvice', 'deficitAdvice']) {
      expect(customerCopyViolations(COPY[key])).toEqual([]);
    }
  });

  test('the Monday plan wilt cues are the shared sentence (folded blades first)', () => {
    const src = read('server/services/irrigation-week-plan.js');
    expect(src).toContain('const WILT_CUES = WATERING_COPY.wiltSigns;');
  });
});

describe('portal recommendation cards (property-recommendations.js)', () => {
  test('surplus card: skip a watering day, do not shorten the runs, no result promise', () => {
    expect(IRRIGATION_ADVICE.wet_condition_watch.body).toBe(
      'Your recent lawn visits show more rain and sprinkler water than your lawn needs. Skip a watering day rather than shortening your runs — longer runs reach the roots better than short ones.',
    );
  });

  test('deficit card: wilt signs first, then more minutes on allowed days (never an added day)', () => {
    expect(IRRIGATION_ADVICE.water_deficit_likely.body).toBe(
      `Your recent lawn visits show less rain and sprinkler water than your lawn needs. If the grass shows ${WILT}, run one full cycle on your next allowed watering day.`,
    );
  });

  test('both cards pass the customer copy screen', () => {
    for (const k of ['wet_condition_watch', 'water_deficit_likely']) {
      expect(customerCopyViolations(IRRIGATION_ADVICE[k].body)).toEqual([]);
    }
  });
});

describe('feed tips and FAQ (feed.js)', () => {
  afterEach(() => { jest.useRealTimers(); });

  async function tipFor(monthIndex) {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    jest.setSystemTime(new Date(2026, monthIndex, 15, 12, 0, 0));
    return callHandler(feedHandler('/monthly-tip'));
  }

  test('January tip: water by the wilt signs, on allowed days, no weekly figure', async () => {
    const tip = await tipFor(0);
    expect(tip.tip).toBe(`Even though growth slows in winter, keep mowing at 4 inches. Taller grass shades out winter weeds. And don't forget about watering completely — in the cool season, water only when the grass shows ${WILT}, on your allowed watering days.`);
    expect(customerCopyViolations(tip.tip)).toEqual([]);
  });

  test('March tip: wilt signs, 1/2 to 3/4 inch each time, allowed days, early morning, no day count', async () => {
    const tip = await tipFor(2);
    expect(tip.tip).toBe(`Growth picks up in March. Water when the grass shows ${WILT} — ½ to ¾ inch each time, on your allowed watering days, in the early morning. Evening watering keeps the blades wet longer, and fungus needs wet blades to start.`);
    expect(customerCopyViolations(tip.tip)).toEqual([]);
  });

  test('summer FAQ answer: wilt signs, 1/2 to 3/4 inch, allowed day, no day count', async () => {
    const { categories } = await callHandler(feedHandler('/faq'));
    const item = categories.flatMap((c) => c.questions).find((q) => q.q === 'How much should I water my lawn in summer?');
    expect(item.a).toBe(`Water when the grass shows ${WILT} — then put down ½ to ¾ inch on an allowed watering day, early in the morning. In the rainy season that is often no sprinkler water at all.`);
    expect(customerCopyViolations(item.a)).toEqual([]);
  });
});

describe('seasonal context (fawn-weather.js)', () => {
  test('low rain: watch the wilt signs and water on an allowed day, no times-per-week figure', () => {
    const ctx = FawnWeather.getSeasonalContext(6, { temp_f: 90, rainfall_in: 0.05 });
    expect(ctx.explanation).toContain(
      ` Rainfall has been low. If you have irrigation, watch for ${WILT}, and water on an allowed watering day when you see them.`,
    );
    expect(ctx.explanation).not.toMatch(/times per week/i);
    expect(customerCopyViolations(ctx.explanation)).toEqual([]);
  });
});

describe('estimate page new-sod line (estimate-service-details.js)', () => {
  test('after rooting the line says as needed at 1/2 to 3/4 inch on allowed days; the sod ramp itself is unchanged', () => {
    const src = read('server/services/estimate-service-details.js');
    expect(src).toContain('weeks 3–4, 2–3 times a week at ¼–½ inch; once rooted (3 to 4 weeks after laying), as needed at ½–¾ inch on your allowed watering days.');
    expect(src).not.toContain('from week 5');
    const sodLine = src.split('\n').find((l) => l.includes('days 1–7, 2–3 short cycles a day'));
    expect(sodLine).toBeTruthy();
    expect(sodLine).not.toMatch(/fewer|longer/i);
  });
});

describe('Learn article "Dollar Weed" (PortalPage.jsx)', () => {
  const src = read('client/src/pages/PortalPage.jsx');
  const start = src.indexOf("title: 'Dollar Weed: What It Tells You'");
  const article = src.slice(start, src.indexOf('id: 5,', start));

  test('tips name the wilt signs and the 1/2 to 3/4 inch run, and never shorten runs or count days', () => {
    expect(start).toBeGreaterThan(0);
    expect(article).toContain(`'Water only when the grass shows ${COPY.wiltSigns} — never on a timer alone'`);
    expect(article).toContain("'Keep each run at ½ to ¾ inch and drop a watering day instead of shortening the runs'");
    expect(article).not.toMatch(/Reduce irrigation runtime|2-3x per week/);
  });
});

// A guard for the whole class: no customer-facing source we fixed may name a count of
// watering days, tell the customer to shorten runs, or to add a day.
describe('guard: old watering patterns are gone from the customer-facing sources', () => {
  const FILES = [
    'server/services/property-recommendations.js',
    'server/routes/feed.js',
    'server/services/fawn-weather.js',
    'server/services/irrigation-week-plan.js',
    'server/services/estimate-service-details.js',
    'client/src/pages/PortalPage.jsx',
    'client/src/dev-preview/portal-preview-main.jsx',
    'shared/watering-copy.json',
  ];
  // The new-sod ramp is the one place a count of days is right (UF LH010; the district allows
  // new lawns any day for 30 days, then three days). It is allowlisted by its exact text.
  const SOD_RAMP = 'days 1–7, 2–3 short cycles a day; days 8–14, once a day, early morning; weeks 3–4, 2–3 times a week at ¼–½ inch;';
  const COUNT_RE = /\b\d\s*(?:-|–|to)\s*\d\s*(?:x|times)\s*(?:per|a)\s*week/i;
  const OLD_PHRASES = [
    /extra watering day/i,
    /add(?:ing)? a watering (?:day|cycle)/i,
    /cut(?:ting)? back a watering cycle/i,
    /trim a few minutes/i,
    /reduce irrigation runtime/i,
    /2-3 waterings/i,
    /\d\s*-\s*\d\s*x per week/i,
    /about 0\.5 inches per week/i,
    /1 inch per week,? split/i,
    /#1 cause of fungus/i,
    /never after 10 AM/i,
    /from week 5/i,
  ];

  test.each(FILES)('%s', (rel) => {
    const text = read(rel).split(SOD_RAMP).join('');
    expect(text).not.toMatch(COUNT_RE);
    for (const re of OLD_PHRASES) expect(text).not.toMatch(re);
  });
});
