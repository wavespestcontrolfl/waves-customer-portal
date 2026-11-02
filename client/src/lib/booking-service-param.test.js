import { describe, expect, it } from 'vitest';
import { SERVICE_PARAM_ALIASES, normalizeServiceId, parseServiceParam } from './booking-service-param';

const IDS = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite', 'rodent', 'bora_care'];

describe('normalizeServiceId', () => {
  it.each([
    ['pest-control', 'pest_control'],
    ['lawn-care', 'lawn_care'],
    ['mosquito-control', 'mosquito'],
    ['tree-shrub', 'tree_shrub'],
    ['tree-and-shrub', 'tree_shrub'],
    ['tree-shrub-care', 'tree_shrub'],
    ['termite-control', 'termite'],
    ['termite-inspection', 'termite'],
    ['rodent-control', 'rodent'],
    ['bora-care', 'bora_care'],
  ])('maps website name %s to %s', (alias, id) => {
    expect(normalizeServiceId(alias, IDS)).toBe(id);
    expect(SERVICE_PARAM_ALIASES[alias]).toBe(id);
  });

  it('keeps every exact catalog id working', () => {
    for (const id of IDS) expect(normalizeServiceId(id, IDS)).toBe(id);
  });

  it('ignores case, padding and spaces', () => {
    expect(normalizeServiceId('  Mosquito-Control ', IDS)).toBe('mosquito');
    expect(normalizeServiceId('PEST_CONTROL', IDS)).toBe('pest_control');
    expect(normalizeServiceId('Lawn Care', IDS)).toBe('lawn_care');
  });

  it('tries hyphen to underscore for ids with no alias', () => {
    expect(normalizeServiceId('mosquito', ['mosquito'])).toBe('mosquito');
    expect(normalizeServiceId('new-thing', ['new_thing'])).toBe('new_thing');
  });

  it('returns null for unknown, empty and non-string input', () => {
    expect(normalizeServiceId('gutter-cleaning', IDS)).toBeNull();
    expect(normalizeServiceId('', IDS)).toBeNull();
    expect(normalizeServiceId('   ', IDS)).toBeNull();
    expect(normalizeServiceId(null, IDS)).toBeNull();
    expect(normalizeServiceId(undefined, IDS)).toBeNull();
  });

  it('never returns an alias target that is not in the catalog', () => {
    expect(normalizeServiceId('mosquito-control', ['pest_control'])).toBeNull();
  });
});

describe('parseServiceParam', () => {
  it('reads a single website name', () => {
    expect(parseServiceParam('mosquito-control', IDS)).toEqual(['mosquito']);
  });

  it('reads composites, dedupes and keeps order', () => {
    expect(parseServiceParam('lawn-care+mosquito+lawn_care', IDS)).toEqual(['lawn_care', 'mosquito']);
  });

  it('caps a composite at 3 services', () => {
    expect(parseServiceParam('pest_control+lawn_care+mosquito+termite', IDS)).toEqual(['pest_control', 'lawn_care', 'mosquito']);
  });

  it('drops an unknown part but keeps the readable ones', () => {
    expect(parseServiceParam('nope+mosquito-control', IDS)).toEqual(['mosquito']);
  });

  it('returns [] when nothing is readable', () => {
    expect(parseServiceParam('nope+also-nope', IDS)).toEqual([]);
    expect(parseServiceParam('', IDS)).toEqual([]);
    expect(parseServiceParam(null, IDS)).toEqual([]);
  });
});
