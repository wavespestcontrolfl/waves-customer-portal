// Chip serialization for the lawn/tree_shrub/palm Photo ID engine's `chips`
// object (PLANT-ENGINE-CONTRACT.md §3, §6.7 — watering_days is a number,
// spreading/pets/recently_planted/fruit_dropping are booleans, everything
// else is a string enum). Unanswered questions, and "not sure" on a question
// whose enum has no not_sure value, are both omitted — the contract treats
// a missing chip the same as "not sure" ("chips … may be {}").
import { describe, expect, it } from 'vitest';
import { NOT_SURE_VALUE, buildChipsPayload } from './photoIdCopy';

describe('buildChipsPayload', () => {
  it('returns {} when nothing was answered', () => {
    expect(buildChipsPayload('lawn', {})).toEqual({});
  });

  it('coerces watering_days to a number and passes through string enums', () => {
    const chips = buildChipsPayload('lawn', {
      watering_days: '3',
      recent_application: 'fertilizer',
      onset: 'weeks',
      light: 'full_sun',
    });
    expect(chips).toEqual({
      watering_days: 3,
      recent_application: 'fertilizer',
      onset: 'weeks',
      light: 'full_sun',
    });
  });

  it('coerces boolean-typed chips (spreading, pets) to real booleans', () => {
    const chips = buildChipsPayload('lawn', { spreading: 'true', pets: 'false' });
    expect(chips).toEqual({ spreading: true, pets: false });
  });

  it('"not sure" sends the literal not_sure enum value only where the engine defines one (recent_application)', () => {
    expect(buildChipsPayload('lawn', { recent_application: NOT_SURE_VALUE })).toEqual({ recent_application: 'not_sure' });
  });

  it('"not sure" omits the key entirely where the engine has no not_sure value (onset, spreading, light, pets, watering_days)', () => {
    const chips = buildChipsPayload('lawn', {
      watering_days: NOT_SURE_VALUE,
      onset: NOT_SURE_VALUE,
      spreading: NOT_SURE_VALUE,
      light: NOT_SURE_VALUE,
      pets: NOT_SURE_VALUE,
    });
    expect(chips).toEqual({});
  });

  it('never emits a grass_type chip for lawn (omitted — no client-side "on file" signal today)', () => {
    const chips = buildChipsPayload('lawn', { grass_type: 'st_augustine' });
    expect(chips).not.toHaveProperty('grass_type');
  });

  it('tree_shrub always sends plant_slug: null and includes a trimmed, length-capped plant_name only when non-blank', () => {
    expect(buildChipsPayload('tree_shrub', { watering: 'hand' })).toEqual({ watering: 'hand', plant_slug: null });
    expect(buildChipsPayload('tree_shrub', { watering: 'hand', plant_name: '  Hibiscus  ' }))
      .toEqual({ watering: 'hand', plant_slug: null, plant_name: 'Hibiscus' });
    const longName = 'x'.repeat(200);
    expect(buildChipsPayload('tree_shrub', { plant_name: longName }).plant_name).toHaveLength(80);
  });

  it('palm serializes fronds/recently_planted/fruit_dropping and always sends plant_slug: null', () => {
    const chips = buildChipsPayload('palm', {
      fronds: 'oldest', recently_planted: 'true', fruit_dropping: 'false', plant_name: 'Queen palm',
    });
    expect(chips).toEqual({
      fronds: 'oldest', recently_planted: true, fruit_dropping: false, plant_slug: null, plant_name: 'Queen palm',
    });
  });

  it('an unknown subject yields {}', () => {
    expect(buildChipsPayload('pest', { anything: 'x' })).toEqual({});
  });
});
