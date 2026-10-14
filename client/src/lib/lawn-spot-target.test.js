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

describe('targetBodyFields (decided at payload time)', () => {
  test('always carries targets; the chinch hint only for a spot insecticide row the chinch entry opened', () => {
    expect(targetBodyFields(row('fungicide'), config)).toEqual({ targets: [] });
    expect(targetBodyFields(row('fungicide', { spotTarget: 'Dollar spot' }), config)).toEqual({ targets: ['Dollar spot'] });
    expect(targetBodyFields(row('insecticide', { guided: 'chinch' }), config)).toEqual({ targets: [], targetFind: 'chinch' });
  });
  test('the standing Found tap (the product id, no guided marker) is a chinch find for that spot insecticide row only', () => {
    expect(targetBodyFields(row('insecticide'), config, { chinchTap: 'aaaa-1' })).toEqual({ targets: [], targetFind: 'chinch' });
    expect(targetBodyFields(row('insecticide'), config, { chinchTap: 'bbbb-2' })).toEqual({ targets: [] });
    expect(targetBodyFields(row('insecticide', { method: 'broadcast_spray' }), config, { chinchTap: 'aaaa-1' })).toEqual({ targets: [] });
    expect(targetBodyFields(row('fungicide'), config, { chinchTap: 'aaaa-1' })).toEqual({ targets: [] });
    expect(targetBodyFields(row('insecticide'), null, { chinchTap: 'aaaa-1' })).toEqual({ targets: [] });
    expect(spotTargetOffer(row('insecticide'), { config, chinchTap: 'aaaa-1' })).toEqual({ kind: 'auto', target: 'Southern chinch bugs' });
    expect(spotTargetOffer(row('insecticide'), { config, chinchTap: 'bbbb-2' })).toEqual({ kind: 'choose', choices: ['White grubs'] });
  });
  test('a row that is no longer a spot row sends no target and no chinch hint', () => {
    expect(targetBodyFields(row('fungicide', { spotTarget: 'Dollar spot', method: 'broadcast_spray' }), config)).toEqual({ targets: [] });
    expect(targetBodyFields(row('insecticide', { guided: 'chinch', method: 'granular_broadcast' }), config)).toEqual({ targets: [] });
  });
  test('a target of another family than the row\'s product (a product changed under the pick) is not sent', () => {
    expect(targetBodyFields(row('insecticide', { spotTarget: 'Dollar spot' }), config)).toEqual({ targets: [] });
    expect(targetBodyFields(row('fungicide', { spotTarget: 'White grubs' }), config)).toEqual({ targets: [] });
    expect(targetBodyFields(row('herbicide', { spotTarget: 'Dollar spot' }), config)).toEqual({ targets: [] });
  });
  test('a fungicide row never sends the chinch hint, and with no lists in the context nothing is sent', () => {
    expect(targetBodyFields(row('fungicide', { guided: 'chinch' }), config)).toEqual({ targets: [] });
    expect(targetBodyFields(row('fungicide', { spotTarget: 'Dollar spot' }), null)).toEqual({ targets: [] });
    expect(targetBodyFields(row('insecticide', { guided: 'chinch' }))).toEqual({ targets: [] });
  });
});
