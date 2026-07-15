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

  test('non-service chatter appends nothing', () => {
    expect(composeServiceInterest({
      matched_service: 'Quarterly Pest Control Service',
      requested_service: 'Rescheduling a missed visit',
    })).toBe('Quarterly Pest Control Service');
  });
});
