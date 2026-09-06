/**
 * Tips from your tech — registry contract.
 *
 * The registry copy prints verbatim on the customer's service report, so
 * every entry is held to the same screen as any other customer string, plus
 * the rule that a canned tip is advice and never a claim about this visit.
 * The resolver is the trust boundary: ids in, frozen copy out, nothing else.
 */

const {
  TIPS,
  TIP_GROUPS,
  SERVICE_LINES,
  SEASONS,
  MAX_TIPS_PER_VISIT,
  MAX_CUSTOM_TIP_CHARS,
  seasonForDate,
  registryLineFor,
  tipsForVisit,
  resolveTipIds,
  freezeTechTips,
  sentenceCount,
} = require('../services/service-report/tip-library');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');

// A canned tip must not read as an observation of this house — that is what
// the tech's [Found] note lines are for.
const VISIT_CLAIM_RE = /\b(?:I|we)\s+(?:saw|noticed|found|spotted|observed)\b|\btoday\s+I\b|\bon\s+today'?s\s+visit\b/i;

const GROUP_IDS = new Set(TIP_GROUPS.map((g) => g.id));
const ID_RE = /^[a-z][a-z0-9_]+$/;

describe('tip-library registry', () => {
  test('has a usable library', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
  });

  test.each(TIPS.map((tip) => [tip.id, tip]))('%s is well-formed', (id, tip) => {
    expect(id).toMatch(ID_RE);
    expect(GROUP_IDS.has(tip.group)).toBe(true);
    expect(SEASONS).toContain(tip.season);
    expect(tip.lines.length).toBeGreaterThan(0);
    for (const line of tip.lines) expect(SERVICE_LINES).toContain(line);
    expect(tip.label.trim().length).toBeGreaterThan(0);
    expect(tip.label.length).toBeLessThanOrEqual(48);
    // keywords: lowercase, unique, and not just the label again
    expect(tip.keywords.length).toBeGreaterThan(0);
    expect(new Set(tip.keywords).size).toBe(tip.keywords.length);
    for (const kw of tip.keywords) expect(kw).toBe(kw.toLowerCase().trim());
    expect(tip.keywords).not.toContain(tip.label.toLowerCase());
  });

  test.each(TIPS.map((tip) => [tip.id, tip.copy]))('%s copy passes the customer-copy screen', (id, copy) => {
    expect(copy.trim().length).toBeGreaterThan(40);
    expect(customerCopyViolations(copy)).toEqual([]);
  });

  test.each(TIPS.map((tip) => [tip.id, tip.copy]))('%s copy is advice, not a visit claim', (id, copy) => {
    expect(copy).not.toMatch(VISIT_CLAIM_RE);
  });

  test('the visit-claim lint actually rejects a claim', () => {
    expect('I noticed your bromeliads were full.').toMatch(VISIT_CLAIM_RE);
    expect('Today I found a trail at the slider.').toMatch(VISIT_CLAIM_RE);
    expect('If you have bromeliads, flush the cups weekly.').not.toMatch(VISIT_CLAIM_RE);
  });

  test('every service line has at least one tip that leads for it', () => {
    for (const line of SERVICE_LINES) {
      expect(TIPS.some((tip) => tip.lines.includes(line))).toBe(true);
    }
  });

  test('the registry is deep-frozen — a consumer cannot alter what later resolutions emit', () => {
    'use strict';
    const tip = TIPS.find((t) => t.id === 'lawn_irrigation_portal');
    expect(Object.isFrozen(tip)).toBe(true);
    expect(Object.isFrozen(tip.keywords)).toBe(true);
    expect(Object.isFrozen(tip.link)).toBe(true);
    expect(() => { tip.copy = 'unscreened'; }).toThrow(TypeError);
    expect(() => { tip.link.path = '/evil'; }).toThrow(TypeError);
    const served = tipsForVisit({ serviceLine: 'lawn', date: new Date('2026-08-15T16:00:00Z') }).groups.flatMap((g) => g.tips).find((t) => t.id === tip.id);
    expect(Object.isFrozen(served)).toBe(true);
    expect(resolveTipIds([tip.id])[0].copy).toBe(tip.copy);
  });

  test('a tip that links only links inside the portal', () => {
    for (const tip of TIPS.filter((t) => t.link)) {
      expect(tip.link.path).toMatch(/^\/portal(?:\?|$)/);
      expect(tip.link.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('seasonForDate', () => {
  test('June through October is the wet season, in ET', () => {
    expect(seasonForDate(new Date('2026-06-01T04:00:00Z'))).toBe('wet');
    expect(seasonForDate(new Date('2026-10-31T23:00:00-04:00'))).toBe('wet');
    expect(seasonForDate(new Date('2026-11-01T00:30:00-04:00'))).toBe('dry');
    expect(seasonForDate(new Date('2026-02-14T12:00:00Z'))).toBe('dry');
  });

  test('the ET calendar day decides, not UTC', () => {
    // 2026-05-31 23:30 ET is still May in ET but already June 1 in UTC.
    expect(seasonForDate(new Date('2026-06-01T03:30:00Z'))).toBe('dry');
  });

  test('a YYYY-MM-DD calendar day is read as that day, never as UTC midnight', () => {
    expect(seasonForDate('2026-06-01')).toBe('wet');
    expect(seasonForDate('2026-11-01')).toBe('dry');
    expect(seasonForDate('2026-10-31')).toBe('wet');
  });
});

describe('freezeTechTips', () => {
  test('resolves ids and appends a clean custom line as the technician\'s own', () => {
    const { tips, dropped } = freezeTechTips({ ids: ['light_warm_bulbs'], custom: '  Keep the lanai door sweep tight — that is where the ants come in.  ' });
    expect(dropped).toEqual([]);
    expect(tips.map((t) => t.id)).toEqual(['light_warm_bulbs', 'custom']);
    expect(tips[1]).toEqual({ id: 'custom', copy: 'Keep the lanai door sweep tight — that is where the ants come in.', source: 'technician' });
  });

  test('a custom line the customer-copy screen rejects is dropped and reported', () => {
    const { tips, dropped } = freezeTechTips({ ids: [], custom: 'The ants are gone and your home is safe now.' });
    expect(tips).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].violations.length).toBeGreaterThan(0);
  });

  test('the cap counts the custom line; three library picks leave no room', () => {
    const { tips, dropped } = freezeTechTips({ ids: ['light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip'], custom: 'Flip the mats.' });
    expect(tips).toHaveLength(MAX_TIPS_PER_VISIT);
    expect(tips.map((t) => t.source)).toEqual(['library', 'library', 'library']);
    expect(dropped).toEqual([{ copy: 'Flip the mats.', violations: ['over_cap'] }]);
  });

  test('an over-long custom line is rejected as too_long, never truncated', () => {
    const long = `Flip the mats after rain. ${'Really. '.repeat(40)}`.trim();
    expect(long.length).toBeGreaterThan(MAX_CUSTOM_TIP_CHARS);
    const { tips, dropped } = freezeTechTips({ ids: [], custom: long });
    expect(tips).toEqual([]);
    expect(dropped).toEqual([{ copy: long, violations: ['too_long'] }]);
    const exact = 'x'.repeat(MAX_CUSTOM_TIP_CHARS - 26) + ' flip the mats after rain.';
    expect(exact.length).toBeLessThanOrEqual(MAX_CUSTOM_TIP_CHARS);
    expect(freezeTechTips({ ids: [], custom: exact }).tips[0].copy).toBe(exact);
  });

  test('a gate or access code in a custom line is rejected by the shared copy screen', () => {
    for (const line of ['Use 4417 to open the side gate.', 'Gate code is 4417.', 'The gate code 4417 gets you in.']) {
      const { tips, dropped } = freezeTechTips({ ids: [], custom: line });
      expect(tips).toEqual([]);
      expect(dropped[0].violations).toContain('access_code');
    }
  });

  test('a custom line is one sentence; several are rejected as multi_sentence', () => {
    expect(sentenceCount('Keep the lanai door sweep tight — that is where the ants come in.')).toBe(1);
    expect(sentenceCount('Set the A/C fan to Auto so the house settles near 50% humidity.')).toBe(1);
    expect(sentenceCount('Water 1.25 inches a week, early morning.')).toBe(1);
    expect(sentenceCount('Flip the mats. Empty the saucers. Trim the hedge!')).toBe(3);
    expect(sentenceCount('Do you have bromeliads? Flush them weekly.')).toBe(2);
    // capitalisation is not a sentence boundary signal
    expect(sentenceCount('Flip the mats. then empty the saucers.')).toBe(2);
    expect(sentenceCount('flip the mats! empty the saucers')).toBe(2);
    expect(freezeTechTips({ ids: [], custom: 'Flip the mats. then empty the saucers.' }).dropped[0].violations).toEqual(['multi_sentence']);
    const { tips, dropped } = freezeTechTips({ ids: [], custom: 'Flip the mats. Empty the saucers. Trim the hedge. Fix the drip.' });
    expect(tips).toEqual([]);
    expect(dropped).toEqual([{ copy: 'Flip the mats. Empty the saucers. Trim the hedge. Fix the drip.', violations: ['multi_sentence'] }]);
    expect(freezeTechTips({ ids: [], custom: 'Flip the mats after rain so they dry.' }).tips).toHaveLength(1);
  });

  test('an unknown id and a pick past the cap are reported, never silently dropped', () => {
    const { tips, dropped } = freezeTechTips({ ids: ['light_warm_bulbs', 'retired_tip', 'water_bromeliads', 'moisture_ac_drip', 'seal_door_sweeps'] });
    expect(tips.map((t) => t.id)).toEqual(['light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip']);
    expect(dropped).toEqual([
      { id: 'retired_tip', violations: ['unknown_tip'] },
      { id: 'seal_door_sweeps', violations: ['over_cap'] },
    ]);
    expect(freezeTechTips({ ids: ['light_warm_bulbs', 'light_warm_bulbs'] }).dropped).toEqual([]);
  });

  test('malformed input freezes nothing', () => {
    for (const bad of [undefined, null, 'x', 42, ['light_warm_bulbs'], { ids: 'light_warm_bulbs' }]) {
      expect(freezeTechTips(bad).tips).toEqual([]);
    }
    // a non-string custom value is ignored, never stringified into copy
    for (const custom of [{ text: 'x' }, ['Flip the mats.'], 42, true]) {
      expect(freezeTechTips({ ids: ['light_warm_bulbs'], custom })).toEqual({
        tips: [expect.objectContaining({ id: 'light_warm_bulbs', source: 'library' })],
        dropped: [],
      });
    }
  });
});

describe('registryLineFor', () => {
  test('exact registry lines pass through', () => {
    expect(registryLineFor('lawn')).toBe('lawn');
    expect(registryLineFor('Tree_Shrub')).toBe('tree_shrub');
  });

  test('service keys and display names go through the canonical detector; palm is the tree & shrub line', () => {
    expect(registryLineFor('wdo_inspection')).toBe('termite');
    expect(registryLineFor('WDO Inspection')).toBe('termite');
    expect(registryLineFor('Palm Injection')).toBe('tree_shrub');
    expect(registryLineFor('palm')).toBe('tree_shrub');
    expect(registryLineFor('Mosquito Treatment')).toBe('mosquito');
    expect(registryLineFor('Rodent Exclusion')).toBe('rodent');
    expect(registryLineFor('Quarterly Pest Control')).toBe('pest');
  });

  test('nothing recognisable falls back to pest', () => {
    expect(registryLineFor('bed_bug')).toBe('pest');
    expect(registryLineFor(undefined)).toBe('pest');
  });
});

describe('tipsForVisit', () => {
  test.each(SERVICE_LINES)('only offers tips relevant to %s, including search results', (serviceLine) => {
    const { line, groups } = tipsForVisit({ serviceLine, date: '2026-08-15' });
    const all = groups.flatMap((group) => group.tips);
    expect(line).toBe(serviceLine);
    expect(all.map((tip) => tip.id).sort()).toEqual(TIPS.filter((tip) => tip.lines.includes(serviceLine)).map((tip) => tip.id).sort());
    expect(groups.every((group) => group.tips.length > 0)).toBe(true);
  });

  test('dry season leads with lighting and exclusion for a pest visit', () => {
    const { season, groups } = tipsForVisit({ serviceLine: 'pest', date: new Date('2026-01-20T16:00:00Z') });
    expect(season).toBe('dry');
    expect(groups[0].id).toBe('lighting');
    expect(groups[1].id).toBe('sealing');
  });

  test('never hides an out-of-season tip; it sorts after in-season tips in its group', () => {
    const { groups } = tipsForVisit({ serviceLine: 'pest', date: new Date('2026-01-20T16:00:00Z') });
    const water = groups.find((g) => g.id === 'water');
    expect(water.tips.map((t) => t.id)).toContain('water_gutters');
    expect(water.tips.map((t) => t.id)).not.toContain('water_weekly_dump');
    const allTip = water.tips.findIndex((t) => t.season === 'all');
    const wetTip = water.tips.findIndex((t) => t.season === 'wet');
    expect(allTip).toBeLessThan(wetTip);
  });

  test('a lawn visit leads with the lawn group', () => {
    const { groups } = tipsForVisit({ serviceLine: 'lawn', date: new Date('2026-08-15T16:00:00Z') });
    expect(groups.filter((g) => g.primary).map((g) => g.id)).toContain('lawn');
    expect(groups.find((g) => g.id === 'lawn').tips.map((t) => t.id)).toContain('lawn_irrigation_portal');
  });
});

describe('resolveTipIds', () => {
  test('resolves known ids to frozen copy and drops everything else', () => {
    const resolved = resolveTipIds(['light_warm_bulbs', 'not_a_tip', '', null, 'water_bromeliads']);
    expect(resolved.map((t) => t.id)).toEqual(['light_warm_bulbs', 'water_bromeliads']);
    for (const entry of resolved) {
      expect(entry.source).toBe('library');
      expect(entry.copy).toBe(TIPS.find((t) => t.id === entry.id).copy);
    }
  });

  test('never carries client-supplied copy', () => {
    const resolved = resolveTipIds([{ id: 'light_warm_bulbs', copy: 'unreviewed text' }]);
    expect(resolved).toEqual([]);
  });

  test('collapses duplicates and caps at the per-visit maximum', () => {
    const ids = ['light_warm_bulbs', 'light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip', 'seal_door_sweeps'];
    const resolved = resolveTipIds(ids);
    expect(resolved.length).toBe(MAX_TIPS_PER_VISIT);
    expect(resolved.map((t) => t.id)).toEqual(['light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip']);
  });

  test('carries the portal link for a linking tip and nothing for the rest', () => {
    const [linked, plain] = resolveTipIds(['lawn_irrigation_portal', 'lawn_sharp_blade']);
    expect(linked.link).toEqual({ label: 'My Property', path: '/portal?tab=property' });
    expect(plain.link).toBeUndefined();
  });

  test('the link is a snapshot — editing a resolved payload never edits the registry', () => {
    const [first] = resolveTipIds(['lawn_irrigation_portal']);
    first.link.path = '/evil';
    expect(resolveTipIds(['lawn_irrigation_portal'])[0].link.path).toBe('/portal?tab=property');
    expect(TIPS.find((t) => t.id === 'lawn_irrigation_portal').link.path).toBe('/portal?tab=property');
  });

  test('tolerates non-array input', () => {
    expect(resolveTipIds(undefined)).toEqual([]);
    expect(resolveTipIds('light_warm_bulbs')).toEqual([]);
  });
});
