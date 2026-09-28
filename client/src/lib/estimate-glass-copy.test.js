// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  glassPackWithoutGuarantee,
  applyCommercialExteriorScope,
  commercialGlassActive,
  copyHasPlanTermsClaim,
  glassCopyActive,
  glassCtaMicroFor,
  glassCtaMicroForKeys,
  glassDayLinesFor,
  glassEstimateCopyFor,
  glassOneTimeHeroOverlay,
  glassPackWithOneTimeHero,
  glassPestInclusions,
  glassRewriteSlotSummary,
  glassRowInclusions,
  glassSchedQualifier,
  glassSchedTitle,
  glassServiceSlug,
  glassTierDisplay,
  setCommercialGlass,
  setGlassDefault,
  treeShrubPalmBulletText,
  withTreeShrubPalmBullet,
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
  it('keeps regulated certificate copy free of AI quick questions', () => {
    setGlassDefault(true);
    expect(glassEstimateCopyFor('wdo_inspection').askChips).toEqual([]);
    expect(glassEstimateCopyFor('pre_slab_termiticide').askChips).toEqual([]);
  });

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
      expect(pack.askChips, category).toHaveLength(category === 'pre_slab_termiticide' ? 0 : 4);
    }
  });
});

describe('glassServiceSlug regulated certificate routing', () => {
  it.each([
    'pre_slab_termiticide',
    'Pre-Slab Termiticide Treatment',
    'Pre slab treatment',
  ])('keeps mixed-estimate pre-slab row %s out of the termite-bait fallback', (value) => {
    expect(glassServiceSlug(value)).toBe('pre_slab_termiticide');
  });

  it('keeps the standalone termite_inspection off the regulated WDO slug and recognizes the slab pre-treat catalog key', () => {
    // FS 482.226 standalone inspection — not a real-estate WDO report.
    expect(glassServiceSlug('termite_inspection')).not.toBe('wdo_inspection');
    expect(glassServiceSlug('termite_slab_pretreat')).toBe('pre_slab_termiticide');
    expect(glassServiceSlug('Slab Pre-Treat Termite Service')).toBe('pre_slab_termiticide');
  });

  it('does not classify ordinary termiticide treatment as pre-slab certificate work', () => {
    expect(glassServiceSlug('Liquid termiticide treatment')).not.toBe('pre_slab_termiticide');
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
    expect(glassCtaMicroFor('lawn_care')).toMatch(/Money-back guarantee/);
    // One-time projects must not advertise contract/callback terms, and the
    // license NUMBER stays out of static copy (GuaranteeStrip renders the
    // configured one — a hardcoded copy here would drift; codex P2).
    expect(glassCtaMicroFor('termite_trenching')).toMatch(/Licensed & insured/);
    expect(glassCtaMicroFor('termite_trenching')).not.toMatch(/JB351547/);
    expect(glassCtaMicroFor('termite_trenching')).not.toMatch(/long-term contract/);
    // Bora-Care is termite work, and termite carries no guarantee of any kind
    // (owner ruling; the same rule as the server's estimateMakesNoGuaranteeClaim).
    expect(glassCtaMicroFor('bora_care')).not.toMatch(/guarantee/i);
    expect(glassCtaMicroFor('bora_care')).toMatch(/Licensed & insured/);
    // Row-slug spelling of rodent resolves to the rodent pack's line.
    expect(glassCtaMicroFor('rodent_bait')).toBe(glassCtaMicroFor('rodent'));
    expect(glassCtaMicroFor('rodent')).not.toMatch(/callbacks/);
  });
});

describe('termite work never carries a guarantee (owner ruling; server estimateMakesNoGuaranteeClaim)', () => {
  const TERMITE = ['termite_bait', 'foam_recurring', 'termite_trenching', 'pre_slab_termiticide', 'bora_care', 'termite_foam', 'wdo_inspection'];

  it.each(TERMITE)('the %s CTA line makes no guarantee', (slug) => {
    expect(glassCtaMicroFor(slug)).not.toMatch(/guarantee/i);
    expect(glassCtaMicroFor(slug)).toMatch(/Licensed & insured/);
  });

  it('a CTA covering termite beside another service makes no guarantee', () => {
    expect(glassCtaMicroForKeys(['pest_control', 'termite_bait'])).not.toMatch(/guarantee/i);
    expect(glassCtaMicroForKeys(['Pest Control', 'Termite Trenching'])).not.toMatch(/guarantee/i);
  });

  it('a CTA covering a service the page cannot classify makes no guarantee', () => {
    expect(glassCtaMicroForKeys(['bundle'])).not.toMatch(/guarantee/i);
    expect(glassCtaMicroForKeys([])).not.toMatch(/guarantee/i);
  });

  it('non-termite plans keep their guarantee lines', () => {
    expect(glassCtaMicroForKeys(['pest_control'])).toBe(GLASS_COPY.ctaMicro);
    expect(glassCtaMicroForKeys(['rodent'])).toMatch(/Satisfaction guaranteed/);
    expect(glassCtaMicroForKeys(['pest_control', 'rodent_bait'])).toMatch(/Satisfaction guaranteed/);
  });

  it('the satisfaction scope keeps a satisfaction-only micro and neutralizes plan terms', () => {
    expect(glassCtaMicroForKeys(['rodent'], { scope: 'satisfaction' })).toMatch(/Satisfaction guaranteed/);
    expect(glassCtaMicroForKeys(['pest_control'], { scope: 'satisfaction' })).not.toMatch(/callbacks|money-back|contract/i);
    expect(glassCtaMicroForKeys(['pest_control'], { scope: 'satisfaction' })).toMatch(/Satisfaction guaranteed/);
    expect(glassCtaMicroForKeys(['pest_control'], { scope: 'none' })).not.toMatch(/guarantee/i);
  });

  it('the server noGuaranteeClaims decision overrides otherwise guaranteed recurring keys', () => {
    expect(glassCtaMicroForKeys(['pest_control'], { noGuarantee: true })).not.toMatch(/guarantee|callbacks/i);
    expect(glassCtaMicroForKeys(['pest_control'], { noGuarantee: true })).toMatch(/Licensed & insured/);
  });
});

describe('glassPackWithoutGuarantee (server noGuaranteeClaims on a recurring estimate)', () => {
  it('neutralizes every claim-bearing field it renders, not only the hero subline (Codex #4982)', () => {
    // The trap-only pack's aiBody promises an extra callback allowance; with
    // an intelligence payload the page renders it in the Waves AI card.
    const trapOnly = { heroSub: 'Setup and monitoring are shown separately.',
      aiBody: 'The priced lines separate setup, scheduled monitoring, and any additional callback allowance included in the plan.',
      askChips: ['What is included in setup?', 'What happens if I need an extra callback?'] };
    const stripped = glassPackWithoutGuarantee(trapOnly);
    expect(stripped.heroSub).toBe(trapOnly.heroSub);
    expect(stripped.aiBody).not.toMatch(/callback/i);
    expect(stripped.askChips).toEqual(['What is included in setup?']);
    // A pack with no claim in any field is returned as is.
    const plain = { heroSub: 'Priced from your property.', aiBody: 'We measured your home.' };
    expect(glassPackWithoutGuarantee(plain)).toBe(plain);
  });

  it.each([
    'Rain re-spray guarantee',
    'Retreat warranty applies',
    'Warranties apply to covered work',
    'Unlimited free callbacks',
    'Re-service between visits at no charge',
    'Between-visit service calls at no charge',
    'Free re-service between recurring visits',
    'Tenant-reported pests handled between visits — re-service requests are included in the plan',
    'No long-term contract — cancel anytime',
    'No contracts and no lock-in',
    'No long-term commitment',
    'Stop after any visit, without a cancellation fee',
    'Cancel any time',
  ])('recognizes recurring-plan terms in customer copy: %s', (claim) => {
    expect(copyHasPlanTermsClaim(claim)).toBe(true);
  });

  it('leaves neutral scope detail alone', () => {
    expect(copyHasPlanTermsClaim('Targets shaded foliage and standing water')).toBe(false);
  });

  it('replaces a hero subline that promises a guarantee and keeps the rest of the pack', () => {
    setGlassDefault(true);
    const pest = glassEstimateCopyFor('pest_control');
    expect(pest.heroSub).toMatch(/money-back guarantee/);
    const stripped = glassPackWithoutGuarantee(pest);
    expect(stripped.heroSub).not.toMatch(/guarantee/i);
    expect(stripped.heroSub).toBe(glassEstimateCopyFor('bundle').heroSub);
    expect(stripped.heroH1).toBe(pest.heroH1);
    expect(stripped.aiTitle).toBe(pest.aiTitle);
  });

  it.each(['30-day callback included', 'Free re-treatment if activity returns'])(
    'replaces a one-time hero whose guarantee is phrased as %s',
    (claim) => {
      setGlassDefault(true);
      const base = glassEstimateCopyFor('bundle');
      const staleHero = { ...base, heroSub: `One visit, licensed and insured. ${claim}.` };
      const stripped = glassPackWithoutGuarantee(staleHero);
      expect(stripped.heroSub).toBe(base.heroSub);
      expect(stripped.heroSub).not.toMatch(/callback|re[- ]?treat|guarantee/i);
    },
  );

  it('leaves a guarantee-free pack, or no pack, untouched', () => {
    setGlassDefault(true);
    const termite = glassEstimateCopyFor('termite_bait');
    expect(glassPackWithoutGuarantee(termite)).toBe(termite);
    expect(glassPackWithoutGuarantee(null)).toBeNull();
  });
});

describe('foam slug: termite foam only (rodent foam sealing stays rodent)', () => {
  it('routes rodent foam-sealing rows away from the termite foam slug', () => {
    expect(glassServiceSlug('Rodent Exclusion – Foam Sealing')).toBe('rodent_bait');
    expect(glassServiceSlug('Foam Sealing Follow-Up (Rodent)')).toBe('rodent_bait');
    expect(glassCtaMicroForKeys(['Rodent Exclusion – Foam Sealing'])).toMatch(/Satisfaction guaranteed/);
  });

  it('keeps termite foam work on its slugs', () => {
    expect(glassServiceSlug('foam_recurring')).toBe('foam_recurring');
    expect(glassServiceSlug('Foam Drill Treatment')).toBe('foam_recurring');
    expect(glassServiceSlug('Drill & Foam Treatment')).toBe('foam_recurring');
    expect(glassServiceSlug('Recurring Foam Treatment (Quarterly)')).toBe('foam_recurring');
    expect(glassServiceSlug('Termite Foam Treatment')).toBe('termite_foam');
    expect(glassServiceSlug('Termidor Foam Treatment')).toBe('termite_foam');
    expect(glassServiceSlug('Termite Treatment (Foam)')).toBe('termite_foam');
    expect(glassServiceSlug('Termite Foaming Treatment')).toBe('termite_foam');
  });

  it.each([
    ['WDO Inspection', 'wdo_inspection'],
    ['Pre-Slab Termiticide Treatment', 'pre_slab_termiticide'],
    ['Bora-Care Wood Treatment', 'termite_bait'],
    ['Borate Wood Treatment', 'termite_bait'],
    ['Trelona Bait Monitoring', 'termite_bait'],
    ['Lawn Care and Termite Bait Monitoring', 'lawn_care'],
    ['Mosquito and Termite Bait Monitoring', 'mosquito'],
    ['Plain Foam Treatment', null],
  ])('shares termite scope without changing the primary slug for %s', (name, slug) => {
    expect(glassServiceSlug(name)).toBe(slug);
  });

  it.each([
    ['Pest Control with Foam Drill', 'pest_control'],
    ['Lawn Care with Recurring Foam Treatment', 'lawn_care'],
    ['Tree & Shrub with Termidor Foam', 'tree_shrub'],
  ])('preserves the primary client slug for combined label %s', (name, slug) => {
    expect(glassServiceSlug(name)).toBe(slug);
  });

  it.each([
    'trap_only Termite Foam',
    'Trap-only Retainer with Termite Foam Treatment',
  ])('keeps trap-only precedence over a termite-foam suffix in %s', (name) => {
    expect(glassServiceSlug(name)).toBe('trap_only');
  });
});

describe('glassOneTimeHeroOverlay', () => {
  it('preserves explicit specialty-service headers while generic one-time work stays terms-neutral', () => {
    setGlassDefault(true);
    const wdo = glassEstimateCopyFor('wdo_inspection');
    expect(glassOneTimeHeroOverlay(wdo, { preserveServiceHero: true }).heroH1).toMatch(/WDO inspection/i);
    expect(glassOneTimeHeroOverlay(glassEstimateCopyFor('pest_control')).heroH1).toMatch(/service quote/i);
  });

  it('a no-guarantee estimate (server noGuaranteeClaims) drops "satisfaction guaranteed" from both one-time heroes', () => {
    setGlassDefault(true);
    const pack = glassEstimateCopyFor('bundle');
    expect(glassOneTimeHeroOverlay(pack).heroSub).toMatch(/satisfaction guaranteed/i);
    for (const reviewBeforeBooking of [false, true]) {
      const hero = glassOneTimeHeroOverlay(pack, { reviewBeforeBooking, noGuarantee: true });
      expect(hero.heroSub).not.toMatch(/guarantee/i);
      expect(hero.heroSub).toMatch(/Licensed & insured\./);
    }
    // The review-gated variant keeps its confirm-with-you clause.
    expect(glassOneTimeHeroOverlay(pack, { reviewBeforeBooking: true, noGuarantee: true }).heroSub).toMatch(/our team reviews it/);
  });
});

describe('glassPackWithOneTimeHero', () => {
  const hero = { eyebrow: 'Your flea treatment', h1: 'Hello {first}, your flea treatment quote is ready!', sub: 'Interior treatment priced from your home — approve online and pick a day.' };
  it('overlays the service hero on the glass pack and keeps the pack’s other copy', () => {
    setGlassDefault(true);
    const base = glassOneTimeHeroOverlay(glassEstimateCopyFor('pest_control'));
    const pack = glassPackWithOneTimeHero(base, { hero });
    expect(pack).toMatchObject({ eyebrow: hero.eyebrow, heroH1: hero.h1, heroSub: hero.sub, aiTitle: base.aiTitle });
  });
  it('still applies the service hero when the category glass copy is off (SSR parity)', () => {
    setGlassDefault(false);
    expect(glassEstimateCopyFor('pest_control')).toBeNull();
    const pack = glassPackWithOneTimeHero(null, { hero });
    expect(pack).toEqual({ eyebrow: hero.eyebrow, heroH1: hero.h1, heroSub: hero.sub });
    expect(pack.aiTitle).toBeUndefined();
  });
  it('a review-gated quote keeps the base confirm-with-you subline, or none without a base pack', () => {
    setGlassDefault(true);
    const base = glassOneTimeHeroOverlay(glassEstimateCopyFor('pest_control'), { reviewBeforeBooking: true });
    expect(glassPackWithOneTimeHero(base, { hero }, { reviewBeforeBooking: true }).heroSub).toBe(base.heroSub);
    expect(glassPackWithOneTimeHero(null, { hero }, { reviewBeforeBooking: true }).heroSub).toBeNull();
  });
  it('the no-guarantee transform runs after a stale guaranteed service hero overlay', () => {
    setGlassDefault(true);
    const base = glassOneTimeHeroOverlay(glassEstimateCopyFor('pest_control'));
    const staleServiceHero = {
      hero: { ...hero, sub: 'Two targeted visits — 100% guaranteed with the Waves Guarantee.' },
    };
    const overlaid = glassPackWithOneTimeHero(base, staleServiceHero);
    expect(overlaid.heroSub).toMatch(/100% guaranteed/i);

    const finalPack = glassPackWithoutGuarantee(overlaid);
    expect(finalPack.heroSub).not.toMatch(/guarantee/i);
    expect(finalPack.heroSub).toMatch(/actual property/);
  });
  it('no service hero leaves the pack untouched', () => {
    expect(glassPackWithOneTimeHero(null, null)).toBeNull();
    const base = { eyebrow: 'x', heroH1: 'y' };
    expect(glassPackWithOneTimeHero(base, {})).toBe(base);
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
    // Lawn keeps its three program bullets; the guarantee + no-contract lines
    // were trimmed (owner 2026-09-02) because the CTA micro states both.
    expect(glassRowInclusions('lawn_care')).toHaveLength(3);
    expect(glassRowInclusions('lawn_care').some((b) => /money-back|long-term contract/i.test(b))).toBe(false);
    expect(glassRowInclusions('pest_control').some((b) => /money-back/i.test(b))).toBe(true);
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

  it('applyCommercialExteriorScope swaps interior bullets on every stack, only for explicit exterior-only', () => {
    // codex #3432 r8 + r9: the swap must hold on the commercial glass stack,
    // the residential-pest stack the slug falls to while commercial glass is
    // off, and the baseline non-glass list — "available on every visit" (or
    // "Interior treatment included") contradicts the sold exterior-only
    // scope on all of them.
    for (const stack of [
      glassRowInclusions('commercial_pest'),
      glassRowInclusions('pest_control', 4, false),
      ['Interior treatment included — no awkward upsell, no surprise charge', 'Exterior perimeter protection'],
    ]) {
      const swapped = applyCommercialExteriorScope(stack, true, false);
      const joined = swapped.join(' ');
      expect(joined).not.toMatch(/interior treatment (available|included)/i);
      expect(joined).toContain('Exterior-only program — interior service can be added through our office');
    }
    // true / null keep every stack untouched; non-commercial rows never swap.
    const commercial = glassRowInclusions('commercial_pest');
    expect(applyCommercialExteriorScope(commercial, true, true)).toEqual(commercial);
    expect(applyCommercialExteriorScope(commercial, true, null)).toEqual(commercial);
    expect(applyCommercialExteriorScope(commercial, false, false)).toEqual(commercial);
  });

  it('withTreeShrubPalmBullet appends the palm-care bullet only for a positive integer count (owner 2026-09-24)', () => {
    const base = ['Ornamental inspection during service visits', 'Seasonal plant-health treatment support'];
    expect(withTreeShrubPalmBullet(base, 4)).toEqual([
      ...base,
      'Includes care for your 4 palms — seasonal palm nutrition and root-zone treatment when needed',
    ]);
    expect(withTreeShrubPalmBullet(base, 1)).toEqual([
      ...base,
      'Includes care for your 1 palm — seasonal palm nutrition and root-zone treatment when needed',
    ]);
    // Zero/absent/invalid — list comes back unchanged (same reference contents).
    expect(withTreeShrubPalmBullet(base, 0)).toEqual(base);
    expect(withTreeShrubPalmBullet(base, undefined)).toEqual(base);
    expect(withTreeShrubPalmBullet(base, -1)).toEqual(base);
    expect(withTreeShrubPalmBullet(base, 2.5)).toEqual(base);
    expect(withTreeShrubPalmBullet(null, 4)).toBeNull();
  });

  it('treeShrubPalmBulletText — pure text builder used by both the row-list appender and the rowless T&S card (Codex #3)', () => {
    expect(treeShrubPalmBulletText(4)).toBe(
      'Includes care for your 4 palms — seasonal palm nutrition and root-zone treatment when needed',
    );
    expect(treeShrubPalmBulletText(1)).toBe(
      'Includes care for your 1 palm — seasonal palm nutrition and root-zone treatment when needed',
    );
    expect(treeShrubPalmBulletText(0)).toBeNull();
    expect(treeShrubPalmBulletText(undefined)).toBeNull();
    expect(treeShrubPalmBulletText(-1)).toBeNull();
    expect(treeShrubPalmBulletText(2.5)).toBeNull();
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

describe('the retired fixed-window refund promise never appears in glass copy (owner ruling 2026-09-26)', () => {
  // Built via concatenation on purpose: a repo-wide grep audit for the
  // retired promise text runs over this same directory, and a literal
  // instance of that text right here (even inside a guard test) would be a
  // false positive on that audit.
  const NO_90_DAY = new RegExp('9' + '0-day money-back|don' + '.' + 't love it', 'i');

  // Every category glassEstimateCopyFor can serve, plus every row-level
  // inclusions key and every micro line — walked directly so a future
  // string added to any pack/stack is caught without needing its own test.
  const CATEGORIES = [
    'pest_control',
    'commercial',
    'commercial_neutral',
    'lawn_care',
    'mosquito',
    'tree_shrub',
    'termite_bait',
    'foam_recurring',
    'termite_trenching',
    'pre_slab_termiticide',
    'bora_care',
    'rodent',
    'wdo_inspection',
    'termite_foam',
    'trap_only',
    'bundle',
  ];

  const ROW_INCLUSION_KEYS = [
    'pest_control',
    'lawn_care',
    'mosquito',
    'tree_shrub',
    'termite_bait',
    'palm_injection',
    'rodent_bait',
    'foam_recurring',
    'commercial_pest',
  ];

  it('keeps every glassEstimateCopyFor pack free of the retired promise', () => {
    setGlassDefault(true);
    for (const category of CATEGORIES) {
      const pack = glassEstimateCopyFor(category);
      expect(pack).toBeTruthy();
      const flat = [
        pack.heroH1,
        pack.heroSub,
        pack.eyebrow,
        pack.aiTitle,
        pack.aiBody,
        pack.ctaMicro,
        ...(pack.askChips || []),
      ].join(' ');
      expect(flat).not.toMatch(NO_90_DAY);
    }
  });

  it('keeps every glassCtaMicroFor line free of the retired promise', () => {
    for (const category of [...CATEGORIES, 'rodent_bait']) {
      expect(glassCtaMicroFor(category) || '').not.toMatch(NO_90_DAY);
    }
    expect(GLASS_COPY.ctaMicro).not.toMatch(NO_90_DAY);
  });

  it('keeps every glassRowInclusions / glassPestInclusions stack free of the retired promise', () => {
    for (const key of ROW_INCLUSION_KEYS) {
      const stack = glassRowInclusions(key, 4, true) || [];
      expect(stack.join(' ')).not.toMatch(NO_90_DAY);
    }
    expect(glassPestInclusions(4, true).join(' ')).not.toMatch(NO_90_DAY);
  });
});
