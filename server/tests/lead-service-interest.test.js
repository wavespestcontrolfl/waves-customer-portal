/**
 * composeServiceInterest — multi-service lead label (live call, 2026-07-15):
 * matched_service is single-slot, so "quarterly pest control and
 * lawn care" landed on the lead card as pest-only and the office priced half
 * the job. Pins: uncovered requested families append after the catalog match,
 * covered families never duplicate, matched-first ordering, the WDO⇄termite
 * same-lane alias, the null-matched legacy fallback, and the varchar(255) cap.
 */

const { composeServiceInterest } = require('../utils/lead-service-interest');

describe('composeServiceInterest', () => {
  test('the motivating call: pest match + lawn request → both on the label', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'Quarterly pest control and lawn care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('single-family request already covered by the match stays untouched', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'Spider treatment for a new build',
    })).toBe('Quarterly Pest Control Service');
  });

  test('no matched_service → null so call sites keep the legacy requested fallback', () => {
    expect(composeServiceInterest({
      matched_service: null,
      requested_service: 'Fly and gnat control',
    })).toBeNull();
    expect(composeServiceInterest({})).toBeNull();
  });

  test('extras append in the order the caller said them, matched always first', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'mosquito treatment, pest control, and the lawn',
    })).toBe('Quarterly Lawn Care Service + Mosquito Control Service + Pest Control Service');
  });

  test('reverse direction: lawn match + pest request appends pest', () => {
    expect(composeServiceInterest({
      matched_service: 'Monthly Lawn Care Service',
      requested_service: 'lawn care and pest control',
    })).toBe('Monthly Lawn Care Service + Pest Control Service');
  });

  test('WDO match covers a termite-worded request (same lane, no phantom tail)', () => {
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'Termite inspection for a VA loan',
    })).toBe('WDO Inspection Service');
  });

  test('explicit WDO request alongside a termite match stays visible (distinct deliverable)', () => {
    expect(composeServiceInterest({
      matched_service: 'Liquid Termite Perimeter',
      requested_service: 'termite treatment and a WDO report for closing',
    })).toBe('Liquid Termite Perimeter + WDO Inspection Service');
  });

  test('termite TREATMENT alongside a WDO match stays visible (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'WDO report and liquid termite treatment',
    })).toBe('WDO Inspection Service + Termite Service');
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'WDO inspection plus Termidor treatment',
    })).toBe('WDO Inspection Service + Termite Service');
  });

  test('turf pests are lawn context, not a second pest service (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'chinch bug treatment',
    })).toBe('Quarterly Lawn Care Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'mole cricket treatment and grubs',
    })).toBe('Quarterly Lawn Care Service');
    // ...and with a pest match, turf pests surface the LAWN service
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'roaches inside and chinch bugs',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('recomposing over persisted EXTRAS keeps secondary families (V2 backfill)', () => {
    // the backfill feeds only the "+ Family" tail forward, never the old primary
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: ' + Lawn Care Service pest control',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
    // a carried "+ Termite Service" tail is pre-vetted work — WDO in the same
    // tail must not re-suppress it on the backfill recompose (codex P1)
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: ' + WDO Inspection Service + Termite Service',
    })).toBe('Quarterly Pest Control Service + WDO Inspection Service + Termite Service');
  });

  test('wdo/termite same-lane suppression is order-independent (codex P1)', () => {
    // termite wording BEFORE the WDO mention, non-treatment → one lane, WDO only
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and termite inspection / WDO report',
    })).toBe('Quarterly Pest Control Service + WDO Inspection Service');
    // ...but treatment wording keeps both deliverables visible
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'WDO report and liquid termite treatment',
    })).toBe('Quarterly Pest Control Service + WDO Inspection Service + Termite Service');
  });

  test('specific_service_name counts as covered even when matched is generic', () => {
    expect(composeServiceInterest({
      matched_service: 'Waves Assessment',
      specific_service_name: 'German Roach Knockdown',
      requested_service: 'roaches in the kitchen and lawn weeds',
    })).toBe('Waves Assessment + Lawn Care Service');
  });

  test('bed bugs / rodents / tree & shrub map to their families', () => {
    expect(composeServiceInterest({
      matched_service: 'Bed Bug Treatment',
      requested_service: 'bed bugs at my Airbnb',
    })).toBe('Bed Bug Treatment');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'ants inside plus rats tearing up the AC',
    })).toBe('Quarterly Pest Control Service + Rodent Control Service');
    expect(composeServiceInterest({
      matched_service: 'Rodent Control',
      requested_service: 'rats and squirrels in the attic',
    })).toBe('Rodent Control + Wildlife Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and ornamental shrub care',
    })).toBe('Quarterly Pest Control Service + Tree & Shrub Care Service');
  });

  test('the combined catalog row covers both of its families', () => {
    expect(composeServiceInterest({
      matched_service: 'Lawn + Tree & Shrub',
      requested_service: 'lawn feeding and shrub trimming pests',
    })).toBe('Lawn + Tree & Shrub + Pest Control Service');
  });

  test('label never exceeds the varchar(255) column', () => {
    const label = composeServiceInterest({
      matched_service: `Quarterly Pest Control Service${' with extras'.repeat(18)}`,
      requested_service: 'lawn, mosquito, termite, rodent, tree and shrub',
    });
    expect(label.length).toBeLessThanOrEqual(255);
    expect(label.startsWith('Quarterly Pest Control Service')).toBe(true);
  });

  test('word boundaries: "wants"/"plants" are not ants, "grasshopper" is not lawn (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'wants help with plants around the yard',
    })).toBe('Quarterly Lawn Care Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'grasshopper treatment',
    })).toBe('Quarterly Pest Control Service');
  });

  test('flies and gnats count as pest (codex P1: "lawn care and fly control")', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn care and fly control',
    })).toBe('Quarterly Lawn Care Service + Pest Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'gnats in the kitchen plus the lawn',
    })).toBe('Quarterly Lawn Care Service + Pest Control Service');
  });

  test('location phrases are context, not requests (codex P1: "fire ants in the lawn")', () => {
    expect(composeServiceInterest({
      matched_service: 'Fire Ant Treatment',
      requested_service: 'fire ants in the lawn',
    })).toBe('Fire Ant Treatment');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'spiders in the house and roaches in the kitchen',
    })).toBe('Quarterly Pest Control Service');
    // no article = a real request, not a location — survives the strip
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and interested in lawn care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('fungus gnats are a pest, not a lawn request (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'fungus gnats in the kitchen',
    })).toBe('Quarterly Pest Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control plus lawn fungus treatment',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('bed bug is its own family, not generic pest (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn care and bed bug treatment',
    })).toBe('Quarterly Lawn Care Service + Bed Bug Treatment');
    expect(composeServiceInterest({
      matched_service: 'Bed Bug Treatment',
      requested_service: 'bed bugs plus roaches',
    })).toBe('Bed Bug Treatment + Pest Control Service');
  });

  test('negated services are not requests (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control only, not lawn care',
    })).toBe('Quarterly Pest Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'quarterly pest, no termite treatment',
    })).toBe('Quarterly Pest Control Service');
    // a positive mention in a later clause still wins
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: "don't want mosquito, just pest and lawn",
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
    // coordinated negated LIST drops whole (codex P1 round 2)
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: "don't need lawn, mosquito, or termite — pest only",
    })).toBe('Quarterly Pest Control Service');
    // contrast word rescues the positive after a negation
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'not lawn but mosquito control',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
  });

  test('nearby pest "treatment" is not termite work (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest treatment plus a termite inspection / WDO report',
    })).toBe('Quarterly Pest Control Service + WDO Inspection Service');
  });

  test('"not only X but also Y" requests both (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'not only pest control but also lawn care',
    })).toBe('Quarterly Lawn Care Service + Pest Control Service');
  });

  test('vegetation as pest location is not a tree & shrub request (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'mosquitoes around the palm trees',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'ants on a palm tree',
    })).toBe('Quarterly Pest Control Service');
    expect(composeServiceInterest({
      matched_service: 'Rodent Control',
      requested_service: 'palm rats in the attic',
    })).toBe('Rodent Control');
  });

  test('midges and no-see-ums are the mosquito program (codex P1)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn care and biting midges',
    })).toBe('Quarterly Lawn Care Service + Mosquito Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn plus no-see-ums on the lanai',
    })).toBe('Quarterly Lawn Care Service + Mosquito Control Service');
  });

  test('"treatment for termites" next to a WDO request stays visible as work (codex r3)', () => {
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'WDO report and treatment for termites',
    })).toBe('WDO Inspection Service + Termite Service');
  });

  test('coordinated vegetation locations strip whole ("bushes and shrubs", codex r3)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'mosquitoes around the bushes and shrubs',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
    // ...but a genuine request after the location survives the backtrack
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'ants around the bushes and shrub care',
    })).toBe('Quarterly Pest Control Service + Tree & Shrub Care Service');
  });

  test('"termite extermination" next to a WDO request stays visible as work (codex PR P2)', () => {
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'WDO report and termite extermination',
    })).toBe('WDO Inspection Service + Termite Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'WDO report plus an exterminator for the termites',
    })).toBe('Quarterly Pest Control Service + WDO Inspection Service + Termite Service');
  });

  test('"X extermination" is one service, standalone exterminator is pest (codex P2)', () => {
    expect(composeServiceInterest({
      matched_service: 'Termite Inspection',
      requested_service: 'termite extermination',
    })).toBe('Termite Inspection');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn care and an exterminator',
    })).toBe('Quarterly Lawn Care Service + Pest Control Service');
  });

  test('"not just" and ", I need" contrast phrasings keep the positive (codex P2)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'not just pest control but also lawn care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'not termite, I need lawn care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('article-less locations still strip, service phrases survive (codex P2)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'mosquitoes around palm trees',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
    expect(composeServiceInterest({
      matched_service: 'Fire Ant Treatment',
      requested_service: 'fire ants in lawn',
    })).toBe('Fire Ant Treatment');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and interested in lawn care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('turf-pest catalog match does not cover household pest (codex P2)', () => {
    expect(composeServiceInterest({
      matched_service: 'Chinch Bug Treatment',
      requested_service: 'lawn pests and roaches inside',
    })).toBe('Chinch Bug Treatment + Pest Control Service');
  });

  test('Bora-Care / borate / wood treatment is a termite request (codex P2)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and Bora-Care wood treatment',
    })).toBe('Quarterly Pest Control Service + Termite Service');
  });

  test('coordinated service phrases survive the location strip (codex r4)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'interested in lawn and shrub care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service + Tree & Shrub Care Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'interested in lawn and mosquito service',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service + Mosquito Control Service');
  });

  test('hyphenated bed-bug stays the specialty family (codex r4)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn care and bed-bug treatment',
    })).toBe('Quarterly Lawn Care Service + Bed Bug Treatment');
  });

  test('described termite treatment next to a WDO stays visible (codex r4)', () => {
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'WDO report and treatment for drywood termites',
    })).toBe('WDO Inspection Service + Termite Service');
    expect(composeServiceInterest({
      matched_service: 'WDO Inspection Service',
      requested_service: 'WDO report and treatment for subterranean termites',
    })).toBe('WDO Inspection Service + Termite Service');
  });

  test('pronounless "need/want" after a negation keeps the positive (codex r4)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'no lawn, need mosquito',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'not termite, want lawn care',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('hyphenated bed-bug extermination is one service (codex r5)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'bed-bug extermination',
    })).toBe('Quarterly Lawn Care Service + Bed Bug Treatment');
  });

  test('a located pest plus a separate service keeps only the request (codex r5)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'ants in the lawn and mosquito service',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'roaches around the bushes and shrubs and mosquito service',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
  });

  test('instead-of / rather-than alternatives are declined (codex r5)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control instead of lawn care',
    })).toBe('Quarterly Pest Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control rather than mosquito service',
    })).toBe('Quarterly Pest Control Service');
  });

  test('exterminator FOR hyphenated bed-bugs is one service (codex r6)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'lawn care and an exterminator for bed-bugs',
    })).toBe('Quarterly Lawn Care Service + Bed Bug Treatment');
  });

  test('termite bait stations are termite work, not rodent (codex r6)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control plus termite bait stations',
    })).toBe('Quarterly Pest Control Service + Termite Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'bait stations for the rats',
    })).toBe('Quarterly Pest Control Service + Rodent Control Service');
  });

  test('a positive after a comma survives an instead-of decline (codex r6)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control instead of lawn care, mosquito service too',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
  });

  test('palm injection is its own service, not tree & shrub (codex r6)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and palm injection',
    })).toBe('Quarterly Pest Control Service + Palm Injection');
  });

  test('article-marked located noun sheds, service-bound final noun stays (codex r6)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'ants in the lawn and shrub care',
    })).toBe('Quarterly Pest Control Service + Tree & Shrub Care Service');
  });

  test('termite-qualified bait stations after the noun are termite (codex r7)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control plus bait stations for termites',
    })).toBe('Quarterly Pest Control Service + Termite Service');
  });

  test('palm-injection target nouns never add tree & shrub (codex r7)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and trunk injection for palms',
    })).toBe('Quarterly Pest Control Service + Palm Injection');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'palm injection for my palms',
    })).toBe('Quarterly Pest Control Service + Palm Injection');
  });

  test('inspection-only termite wording labels as Termite Inspection (codex r7)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and termite inspection for VA loan',
    })).toBe('Quarterly Pest Control Service + Termite Inspection');
    // treatment wording still labels as work
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and liquid termite treatment',
    })).toBe('Quarterly Pest Control Service + Termite Service');
  });

  test('"interested in lawn" with no service word is a request (codex r7)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control and interested in lawn',
    })).toBe('Quarterly Pest Control Service + Lawn Care Service');
  });

  test('a positive "too" clause survives a negation comma (codex r7)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'no lawn, mosquito service too',
    })).toBe('Quarterly Pest Control Service + Mosquito Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'not termite, WDO report as well',
    })).toBe('Quarterly Pest Control Service + WDO Inspection Service');
  });

  test('"except" excludes the following service (codex r8)', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'pest control except lawn care',
    })).toBe('Quarterly Pest Control Service');
    expect(composeServiceInterest({
      matched_service: 'Quarterly Lawn Care Service',
      requested_service: 'full lawn program except for mosquito service',
    })).toBe('Quarterly Lawn Care Service');
  });

  test('non-service chatter appends nothing', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'Rescheduling a missed visit',
    })).toBe('Quarterly Pest Control Service');
  });
});
