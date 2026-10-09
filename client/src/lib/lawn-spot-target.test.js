import { describe, expect, test } from 'vitest';
import { spotTargetOffer, spotTargetsOf, targetBodyFields } from './lawn-spot-target';

const BLOCK = { v: 1, fungicide: ['Large patch', 'Dollar spot', 'Take-all root rot'], insecticide: ['Southern chinch bugs', 'White grubs'], chinch: 'Southern chinch bugs', takeAll: 'Take-all root rot' };
const config = spotTargetsOf({ spotTargets: BLOCK });
const row = (category, extra = {}) => ({ productId: 'AAAA-1', product: { category }, method: 'spot_treatment', ...extra });

describe('spotTargetsOf', () => {
  test('reads the server block, or answers null', () => {
    expect(config).toMatchObject({ chinch: 'Southern chinch bugs', takeAll: 'Take-all root rot' });
    expect(spotTargetsOf({})).toBeNull();
    expect(spotTargetsOf({ spotTargets: { v: 2, fungicide: ['x'] } })).toBeNull();
    expect(spotTargetsOf({ spotTargets: { v: 1, fungicide: [], insecticide: [] } })).toBeNull();
  });
});

describe('spotTargetOffer', () => {
  test('a spot fungicide offers its names without the take-all name', () => {
    expect(spotTargetOffer(row('fungicide'), { config })).toEqual({ kind: 'choose', choices: ['Large patch', 'Dollar spot'] });
  });
  test('the take-all product offers only the take-all name', () => {
    expect(spotTargetOffer(row('fungicide'), { config, takeAll: new Set(['aaaa-1']) })).toEqual({ kind: 'choose', choices: ['Take-all root rot'] });
  });
  test('a spot insecticide offers the insect names without the chinch name', () => {
    expect(spotTargetOffer(row('insecticide'), { config })).toEqual({ kind: 'choose', choices: ['White grubs'] });
  });
  test('a chinch find (the entry opened it, the place rule or the server says so) is stored with no tap', () => {
    const auto = { kind: 'auto', target: 'Southern chinch bugs' };
    expect(spotTargetOffer(row('insecticide', { guided: 'chinch' }), { config })).toEqual(auto);
    expect(spotTargetOffer(row('insecticide', { chinchRow: true }), { config })).toEqual(auto);
    expect(spotTargetOffer(row('insecticide'), { config, chinch: { chinchOnlyIds: ['AAAA-1'] } })).toEqual(auto);
  });
  test('a whole-lawn row, another category, or no lists offer nothing', () => {
    expect(spotTargetOffer(row('fungicide', { method: 'broadcast_spray' }), { config })).toBeNull();
    expect(spotTargetOffer(row('herbicide'), { config })).toBeNull();
    expect(spotTargetOffer(row('fungicide'), { config: null })).toBeNull();
  });
});

describe('targetBodyFields', () => {
  test('always carries targets; the chinch hint only for a row the chinch entry opened', () => {
    expect(targetBodyFields(row('fungicide'))).toEqual({ targets: [] });
    expect(targetBodyFields(row('fungicide', { spotTarget: 'Dollar spot' }))).toEqual({ targets: ['Dollar spot'] });
    expect(targetBodyFields(row('insecticide', { guided: 'chinch' }))).toEqual({ targets: [], targetFind: 'chinch' });
  });
});
