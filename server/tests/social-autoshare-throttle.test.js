// Blog auto-share throttle (2026-07-24 social audit).
//
// The regression this guards: the blog→social lane publishes on blog cadence
// with no awareness of the curated social calendar. In the 30 days to 07-24 it
// produced 44 feed posts + 88 GBP posts (every blog fanned to all 4 city
// profiles), and on 07-23 fired 5 posts including two near-duplicate LinkedIn
// posts hours apart. The cap and the GBP rotation must bound the AUTOMATED blog
// lanes ONLY — manual admin posts, the content studio, and newsletter shares
// must stay untouched, and an explicit location pick must always be honored.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: {} }));

const social = require('../services/social-media');
const {
  AUTOSHARE_SOURCES, autoshareDailyCap, autoshareGbpSingleLocation, rotateGbpLocation,
} = social;

const ENV_KEYS = ['SOCIAL_AUTOSHARE_DAILY_CAP', 'SOCIAL_AUTOSHARE_GBP_SINGLE_LOCATION'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
});
afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

describe('AUTOSHARE_SOURCES scope', () => {
  test('covers exactly the automated blog lanes', () => {
    expect([...AUTOSHARE_SOURCES].sort()).toEqual(['autonomous_blog', 'blog_scheduled', 'rss']);
  });

  test('does NOT capture manual, studio, or newsletter sources', () => {
    for (const src of ['manual', 'autonomous_studio', 'newsletter', 'tech_field']) {
      expect(AUTOSHARE_SOURCES.has(src)).toBe(false);
    }
  });
});

describe('autoshareDailyCap', () => {
  test('defaults to 1/day when unset or empty — the throttle is ON by default', () => {
    expect(autoshareDailyCap()).toBe(1);
    process.env.SOCIAL_AUTOSHARE_DAILY_CAP = '';
    expect(autoshareDailyCap()).toBe(1);
  });

  test('0 disables the cap (documented kill switch)', () => {
    process.env.SOCIAL_AUTOSHARE_DAILY_CAP = '0';
    expect(autoshareDailyCap()).toBe(0);
  });

  test('honors an explicit higher cap', () => {
    process.env.SOCIAL_AUTOSHARE_DAILY_CAP = '3';
    expect(autoshareDailyCap()).toBe(3);
  });

  test('garbage and negatives fall back to the safe default, never to unlimited', () => {
    for (const bad of ['abc', '-2', 'NaN', '{}']) {
      process.env.SOCIAL_AUTOSHARE_DAILY_CAP = bad;
      expect(autoshareDailyCap()).toBe(1);
    }
  });
});

describe('autoshareGbpSingleLocation', () => {
  test('defaults ON — one city profile per auto-shared post', () => {
    expect(autoshareGbpSingleLocation()).toBe(true);
  });

  test('only the exact string "false" restores the 4x fanout', () => {
    process.env.SOCIAL_AUTOSHARE_GBP_SINGLE_LOCATION = 'false';
    expect(autoshareGbpSingleLocation()).toBe(false);
    process.env.SOCIAL_AUTOSHARE_GBP_SINGLE_LOCATION = 'FALSE';
    expect(autoshareGbpSingleLocation()).toBe(false);
  });

  test('other truthy-ish values keep the guard ON (fails safe)', () => {
    for (const val of ['true', '1', 'yes', 'no', 'off']) {
      process.env.SOCIAL_AUTOSHARE_GBP_SINGLE_LOCATION = val;
      expect(autoshareGbpSingleLocation()).toBe(true);
    }
  });
});

describe('rotateGbpLocation', () => {
  const locs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  test('narrows a 4-location fanout to exactly one', () => {
    expect(rotateGbpLocation(locs, new Date('2026-07-24T12:00:00Z'))).toHaveLength(1);
  });

  test('rotates across consecutive days so all 4 profiles get used', () => {
    const picked = new Set();
    for (let d = 0; d < 4; d += 1) {
      const day = new Date(Date.UTC(2026, 6, 24 + d, 12));
      picked.add(rotateGbpLocation(locs, day)[0].id);
    }
    expect(picked.size).toBe(4);
  });

  test('passes through 0- and 1-length lists untouched', () => {
    expect(rotateGbpLocation([])).toEqual([]);
    expect(rotateGbpLocation([{ id: 'only' }])).toEqual([{ id: 'only' }]);
  });

  // Codex P1 (2026-07-24): the index must key off the EASTERN calendar day.
  // Railway runs TZ=UTC, so a UTC epoch-day index rolls over at 8pm EDT while
  // the ET daily cap is still on the prior business day — the two disagree and
  // posts straddling that cutoff skip or repeat a profile.
  describe('ET calendar day, not UTC epoch day', () => {
    test('20:00 and 23:00 EDT on the same ET day pick the SAME profile', () => {
      // 2026-07-24 20:00 EDT = 07-25 00:00Z — UTC day has already rolled over.
      const evening = new Date('2026-07-25T00:00:00Z');
      const later = new Date('2026-07-25T03:00:00Z'); // 23:00 EDT, same ET day
      expect(rotateGbpLocation(locs, evening)[0].id).toBe(rotateGbpLocation(locs, later)[0].id);
    });

    test('the same ET day picks one profile from morning through late evening', () => {
      const morning = new Date('2026-07-24T13:00:00Z'); // 09:00 EDT 07-24
      const evening = new Date('2026-07-25T02:00:00Z'); // 22:00 EDT 07-24
      expect(rotateGbpLocation(locs, morning)[0].id).toBe(rotateGbpLocation(locs, evening)[0].id);
    });

    test('crossing into the next ET day advances the profile', () => {
      const lateJul24 = new Date('2026-07-25T03:00:00Z'); // 23:00 EDT 07-24
      const earlyJul25 = new Date('2026-07-25T05:00:00Z'); // 01:00 EDT 07-25
      expect(rotateGbpLocation(locs, lateJul24)[0].id)
        .not.toBe(rotateGbpLocation(locs, earlyJul25)[0].id);
    });
  });
});
