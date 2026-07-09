// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  glassCopyActive,
  glassCtaMicroFor,
  glassCtaMicroForKeys,
  glassDayLinesFor,
  glassEstimateCopyFor,
  glassPestInclusions,
  glassRewriteSlotSummary,
  glassRowInclusions,
  glassSchedQualifier,
  glassSchedTitle,
  glassServiceSlug,
  glassTierDisplay,
  setGlassDefault,
  GLASS_COPY,
  GLASS_DAY_LINES,
} from './estimate-glass-copy';

const setSearch = (search) => {
  window.history.replaceState(null, '', `/e/test${search}`);
};

afterEach(() => {
  setSearch('');
  setGlassDefault(false);
  vi.useRealTimers();
});

describe('glassCopyActive', () => {
  it('follows the server glassDefault flag only', () => {
    expect(glassCopyActive()).toBe(false);
    setGlassDefault(true);
    expect(glassCopyActive()).toBe(true);
    // Only a literal payload true releases.
    setGlassDefault(undefined);
    expect(glassCopyActive()).toBe(false);
  });

  it('ignores the retired ?glass URL param (2026-07-07 owner decision)', () => {
    setSearch('?glass=1');
    expect(glassCopyActive()).toBe(false);
    setGlassDefault(true);
    setSearch('?glass=0');
    expect(glassCopyActive()).toBe(true);
  });
});

describe('glassEstimateCopyFor', () => {
  it('returns a pack for every service category under glass, none when glass is off', () => {
    setGlassDefault(true);
    expect(glassEstimateCopyFor('pest_control').heroH1).toMatch(/pest-free \{city\} plan/);
    expect(glassEstimateCopyFor('lawn_care').heroH1).toMatch(/lawn/i);
    expect(glassEstimateCopyFor('mosquito').heroH1).toMatch(/mosquito/i);
    expect(glassEstimateCopyFor('termite_bait').heroH1).toMatch(/termite/i);
    expect(glassEstimateCopyFor('termite_trenching').heroH1).toMatch(/barrier/i);
    expect(glassEstimateCopyFor('bundle').heroH1).toMatch(/complete home protection/i);
    setGlassDefault(false);
    expect(glassEstimateCopyFor('pest_control')).toBeNull();
    expect(glassEstimateCopyFor('lawn_care')).toBeNull();
  });

  it('falls back to the property-generic bundle pack for unknown categories', () => {
    setGlassDefault(true);
    expect(glassEstimateCopyFor('mystery_service')).toEqual(glassEstimateCopyFor('bundle'));
  });

  it('every pack carries the full field set the page consumes', () => {
    setGlassDefault(true);
    const categories = [
      'pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait',
      'foam_recurring', 'termite_trenching', 'pre_slab_termiticide',
      'bora_care', 'rodent', 'bundle',
    ];
    for (const category of categories) {
      const pack = glassEstimateCopyFor(category);
      expect(pack.heroH1, category).toContain('{first}');
      expect(pack.heroSub, category).toBeTruthy();
      expect(pack.eyebrow, category).toBeTruthy();
      expect(pack.aiTitle, category).toBeTruthy();
      expect(pack.aiBody, category).toBeTruthy();
      expect(pack.askChips, category).toHaveLength(4);
    }
  });
});

describe('glassCtaMicroFor', () => {
  it('keeps the recurring terms for recurring plans and swaps them for one-time projects', () => {
    expect(glassCtaMicroFor('pest_control')).toBe(GLASS_COPY.ctaMicro);
    expect(glassCtaMicroFor('lawn_care')).toBe(GLASS_COPY.ctaMicro);
    // One-time projects must not advertise contract/callback terms, and the
    // license NUMBER stays out of static copy (GuaranteeStrip renders the
    // configured one — a hardcoded copy here would drift; codex P2).
    expect(glassCtaMicroFor('termite_trenching')).toMatch(/Licensed & insured/);
    expect(glassCtaMicroFor('termite_trenching')).not.toMatch(/JB351547/);
    expect(glassCtaMicroFor('termite_trenching')).not.toMatch(/long-term contract/);
    expect(glassCtaMicroFor('bora_care')).toMatch(/Satisfaction guaranteed/);
    // Row-slug spelling of rodent resolves to the rodent pack's line.
    expect(glassCtaMicroFor('rodent_bait')).toBe(glassCtaMicroFor('rodent'));
    expect(glassCtaMicroFor('rodent')).not.toMatch(/callbacks/);
  });
});

describe('glassCtaMicroForKeys', () => {
  it('keeps recurring terms only when every covered service carries them', () => {
    expect(glassCtaMicroForKeys(['pest_control', 'lawn_care'])).toBe(GLASS_COPY.ctaMicro);
    expect(glassCtaMicroForKeys(['lawn_care'])).toBe(GLASS_COPY.ctaMicro);
    // A rodent section in a split bundle demotes the combined CTA to the
    // terms-neutral line — no callback terms rodent copy avoids (codex rd2).
    expect(glassCtaMicroForKeys(['rodent_bait', 'lawn_care'])).not.toMatch(/callbacks/);
    expect(glassCtaMicroForKeys(['rodent_bait', 'lawn_care'])).toMatch(/Satisfaction guaranteed/);
    // Unresolvable composition (synthetic unsplit 'bundle' key) is neutral.
    expect(glassCtaMicroForKeys(['bundle'])).not.toMatch(/callbacks/);
    expect(glassCtaMicroForKeys([])).not.toMatch(/callbacks/);
    // memberKeys resolution: unsplit pest+lawn keeps the full recurring line.
    expect(glassCtaMicroForKeys(['pest_control', 'lawn_care', 'lawn_pest_control'])).toBe(GLASS_COPY.ctaMicro);
  });
});

describe('glassDayLinesFor', () => {
  it('keeps the cadence-matched trio for pest and gives other programs a service-matched line', () => {
    expect(glassDayLinesFor('pest_control')).toBe(GLASS_DAY_LINES);
    const lawn = glassDayLinesFor('lawn_care');
    expect(lawn.quarterly).toContain('{amount}');
    expect(lawn.monthly).toBe(lawn.quarterly);
    expect(glassDayLinesFor('termite_bait').monthly).toMatch(/termite/i);
    // Unknown sections keep the server-provided wording.
    expect(glassDayLinesFor('wdo_inspection')).toBeNull();
  });
});

describe('glassRowInclusions', () => {
  it('routes pest rows through the visit-count-aware pest stack', () => {
    expect(glassRowInclusions('pest_control', 6)[1]).toMatch(/^Protected 6× a year/);
    expect(glassRowInclusions('pest_control', 4, true)).toHaveLength(7);
  });

  it('returns the glass rewrite for known service rows and null for unknown ones', () => {
    expect(glassRowInclusions('lawn_care').some((b) => /money-back/.test(b))).toBe(true);
    expect(glassRowInclusions('mosquito').length).toBeGreaterThanOrEqual(3);
    expect(glassRowInclusions('palm_injection').length).toBeGreaterThanOrEqual(3);
    // Fail-safe: no glass list means the caller keeps the baseline list.
    expect(glassRowInclusions('unknown_row')).toBeNull();
  });
});

describe('glassServiceSlug', () => {
  it('maps known service keys/labels and returns null for synthetic sections', () => {
    expect(glassServiceSlug('lawn_care')).toBe('lawn_care');
    expect(glassServiceSlug('Mosquito Control')).toBe('mosquito');
    expect(glassServiceSlug('Tree & Shrub')).toBe('tree_shrub');
    expect(glassServiceSlug('foam_recurring')).toBe('foam_recurring');
    expect(glassServiceSlug('termite_bait')).toBe('termite_bait');
    expect(glassServiceSlug('Palm Injection')).toBe('palm_injection');
    expect(glassServiceSlug('Rodent Bait Stations')).toBe('rodent_bait');
    expect(glassServiceSlug('pest_control')).toBe('pest_control');
    // lawn_pest_* is pest (server recurringServiceKey semantics).
    expect(glassServiceSlug('lawn_pest_control')).toBe('pest_control');
    // Synthetic/unknown section keys must NOT inherit pest copy — the
    // server's unsplittable multi-service section is keyed 'bundle'
    // (codex P2: a lawn+mosquito bundle was getting pest day lines).
    expect(glassServiceSlug('bundle')).toBe(null);
    expect(glassServiceSlug('')).toBe(null);
    expect(glassDayLinesFor(glassServiceSlug('bundle'))).toBe(null);
  });
});

describe('glassTierDisplay', () => {
  it('renames only Bronze — no ladder on a single-plan estimate', () => {
    expect(glassTierDisplay('Bronze')).toBe('Home Protection');
    expect(glassTierDisplay('WaveGuard Bronze')).toBe('Home Protection');
    expect(glassTierDisplay('Silver')).toBe('Silver');
    expect(glassTierDisplay('Gold')).toBe('Gold');
    expect(glassTierDisplay(null)).toBe(null);
  });
});

describe('glassPestInclusions', () => {
  it('states the real visit count in the perimeter bullet', () => {
    expect(glassPestInclusions(6)[1]).toMatch(/^Protected 6× a year/);
    expect(glassPestInclusions(0)[1]).toMatch(/^Protected 4× a year/);
  });

  it('advertises the $99 setup waiver only when the estimate carries a waivable fee', () => {
    expect(glassPestInclusions(4)).toHaveLength(6);
    const withSetup = glassPestInclusions(4, true);
    expect(withSetup).toHaveLength(7);
    expect(withSetup[6]).toMatch(/^\$99 setup disappears/);
  });
});

describe('glassSchedQualifier', () => {
  it('maps the first slot date to today / tomorrow / this week on the ET calendar', () => {
    vi.useFakeTimers();
    // 15:00Z = 11:00 ET → the ET date is 2026-07-05 whatever the machine TZ.
    vi.setSystemTime(new Date('2026-07-05T15:00:00Z'));
    expect(glassSchedQualifier('2026-07-05')).toBe('today');
    expect(glassSchedQualifier('2026-07-06')).toBe('tomorrow');
    expect(glassSchedQualifier('2026-07-10')).toBe('this week');
    // Beyond a week (or no slot) → no claim, caller falls back.
    expect(glassSchedQualifier('2026-07-20')).toBe(null);
    expect(glassSchedQualifier(null)).toBe(null);
    expect(glassSchedTitle(null)).toBe(null);
    expect(glassSchedTitle('today')).toBe('Lock in your spot — openings as soon as today');
  });
});

describe('glassRewriteSlotSummary', () => {
  it('leads with availability instead of the missing route', () => {
    expect(glassRewriteSlotSummary(
      'No route near you that day yet, but here are 4 open times for Tuesday, July 8.',
      'sometime Tuesday',
    )).toBe('4 open times for Tuesday, July 8 — pick what works:');
  });

  it('rewrites the singular one-slot form too', () => {
    expect(glassRewriteSlotSummary(
      'No route near you that day yet, but here is 1 open time for Monday, July 7.',
      'monday',
    )).toBe('1 open time for Monday, July 7 — pick what works:');
  });

  it('folds in the customer’s daypart qualifier when they used one', () => {
    expect(glassRewriteSlotSummary(
      'No route near you that day yet, but here are 2 open times for Friday, July 11.',
      'Friday Morning if possible',
    )).toBe('2 open times for Friday morning (July 11) — pick what works:');
  });

  it('passes anything else through untouched', () => {
    expect(glassRewriteSlotSummary('Booked solid that day.', 'x')).toBe('Booked solid that day.');
    expect(glassRewriteSlotSummary(undefined, '')).toBe(undefined);
  });
});
