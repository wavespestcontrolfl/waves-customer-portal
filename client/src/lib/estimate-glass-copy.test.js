// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commercialGlassActive,
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
  setCommercialGlass,
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
  setCommercialGlass(false);
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
    // Lawn carries its own scoped terms line (owner copy ruling 2026-08-04):
    // no "Unlimited free callbacks" under a cadence-tier ladder — a lawn
    // service call spot-treats covered issues, it doesn't replay missed
    // applications.
    expect(glassCtaMicroFor('lawn_care')).toMatch(/Free between-visit service calls/);
    expect(glassCtaMicroFor('lawn_care')).not.toMatch(/Unlimited free callbacks/);
    expect(glassCtaMicroFor('lawn_care')).toMatch(/90-day money-back guarantee/);
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
    // Pest+lawn now carry DISTINCT terms lines (lawn's scoped 2026-08-04
    // line vs pest's callbacks claim) — the bundle CTA demotes to the
    // terms-neutral line rather than advertising callback terms next to a
    // lawn tier ladder.
    expect(glassCtaMicroForKeys(['pest_control', 'lawn_care'])).not.toMatch(/callbacks/);
    expect(glassCtaMicroForKeys(['pest_control', 'lawn_care'])).toMatch(/Satisfaction guaranteed/);
    expect(glassCtaMicroForKeys(['pest_control'])).toBe(GLASS_COPY.ctaMicro);
    expect(glassCtaMicroForKeys(['lawn_care'])).toMatch(/Free between-visit service calls/);
    // A rodent section in a split bundle demotes the combined CTA to the
    // terms-neutral line — no callback terms rodent copy avoids (codex rd2).
    expect(glassCtaMicroForKeys(['rodent_bait', 'lawn_care'])).not.toMatch(/callbacks/);
    expect(glassCtaMicroForKeys(['rodent_bait', 'lawn_care'])).toMatch(/Satisfaction guaranteed/);
    // Unresolvable composition (synthetic unsplit 'bundle' key) is neutral.
    expect(glassCtaMicroForKeys(['bundle'])).not.toMatch(/callbacks/);
    expect(glassCtaMicroForKeys([])).not.toMatch(/callbacks/);
    // memberKeys resolution: an unsplit mix containing lawn demotes to the
    // neutral line too (lawn's scoped 2026-08-04 terms differ from pest's).
    expect(glassCtaMicroForKeys(['pest_control', 'lawn_care', 'lawn_pest_control'])).not.toMatch(/callbacks/);
    expect(glassCtaMicroForKeys(['pest_control', 'lawn_care', 'lawn_pest_control'])).toMatch(/Satisfaction guaranteed/);
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
  it('shows the real tier name — recurring pest is the WaveGuard Bronze plan', () => {
    expect(glassTierDisplay('Bronze')).toBe('Bronze');
    expect(glassTierDisplay('WaveGuard Bronze')).toBe('Bronze');
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

describe('commercial glass release', () => {
  it('follows the server cta.commercialGlass flag only', () => {
    expect(commercialGlassActive()).toBe(false);
    setCommercialGlass(true);
    expect(commercialGlassActive()).toBe(true);
    setCommercialGlass(undefined);
    expect(commercialGlassActive()).toBe(false);
  });

  it('maps commercial keys to the commercial slug only while released', () => {
    // Gate off: today's behavior — commercial_pest falls through to pest.
    expect(glassServiceSlug('commercial_pest')).toBe('pest_control');
    expect(glassServiceSlug('Commercial Pest Control')).toBe('pest_control');
    setCommercialGlass(true);
    expect(glassServiceSlug('commercial_pest')).toBe('commercial_pest');
    expect(glassServiceSlug('Commercial Pest Control')).toBe('commercial_pest');
    // Residential keys are untouched by the release.
    expect(glassServiceSlug('pest_control')).toBe('pest_control');
    expect(glassServiceSlug('lawn_care')).toBe('lawn_care');
    // Commercial NON-pest lanes keep their service slugs (codex #3281 r1:
    // commercial_lawn must never inherit pest interior/tenant promises).
    expect(glassServiceSlug('commercial_lawn')).toBe('lawn_care');
    expect(glassServiceSlug('commercial_termite_bait')).toBe('termite_bait');
    expect(glassServiceSlug('commercial_rodent_bait')).toBe('rodent_bait');
  });

  it('gives commercial rows their own inclusions with no residential guarantee claims', () => {
    const stack = glassRowInclusions('commercial_pest');
    expect(Array.isArray(stack)).toBe(true);
    const joined = stack.join(' ');
    expect(joined).toContain('Interior treatment available on every visit');
    expect(joined).toContain('No long-term contract');
    expect(joined).not.toMatch(/auto pay|in the app/i);
    expect(joined).not.toMatch(/90-day/i);
    expect(joined).not.toMatch(/money-back/i);
    expect(joined).not.toMatch(/\$99/);
  });

  it('folds the commercial row slug to the commercial CTA micro line', () => {
    const micro = glassCtaMicroFor('commercial_pest');
    expect(micro).toContain('No long-term contract');
    // Billing-method claims stay out — commercial bills by manual invoice,
    // not Auto Pay (codex #3281 r2).
    expect(micro).not.toMatch(/auto pay/i);
    expect(micro).not.toBe(GLASS_COPY.ctaMicro);
    expect(micro).not.toMatch(/90-day/i);
  });

  it('serves the commercial pack for the commercial category', () => {
    setGlassDefault(true);
    const pack = glassEstimateCopyFor('commercial');
    expect(pack.eyebrow).toBe('Your commercial service plan');
    expect(`${pack.heroSub} ${pack.aiBody}`).not.toMatch(/90-day|money-back/i);
  });

  it('keeps the neutral commercial pack claim-free (codex #3281 r3)', () => {
    setGlassDefault(true);
    const pack = glassEstimateCopyFor('commercial_neutral');
    expect(pack.eyebrow).toBe('Your commercial service plan');
    const all = `${pack.heroH1} ${pack.heroSub} ${pack.aiTitle} ${pack.aiBody} ${pack.ctaMicro} ${pack.askChips.join(' ')}`;
    // No pest-scope, contract, tenant, or pricing-methodology claims —
    // authored proposals and non-pest commercial subtypes read this pack,
    // so any promise here could contradict operator terms or the actual
    // quoted service.
    expect(all).not.toMatch(/interior|tenant|long-term contract|satellite|county/i);
    expect(all).not.toMatch(/90-day|money-back|auto pay|unlimited/i);
  });
});
