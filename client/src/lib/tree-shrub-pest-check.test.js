// GATE_TS_PEST_CHECK rules (pure). Synthetic data only.
import { describe, expect, test } from 'vitest';
import {
  MERIT_BLOCK_MESSAGE, MERIT_TRISTAR_BLOCK_MESSAGE, TRISTAR_BLOCK_MESSAGE, evaluatePestCheck, isMeritProduct, isTristarProduct,
  liveFindsOnlyLabel, pestCheckPayload, withPestCheck,
} from './tree-shrub-pest-check';

const row = (name, active = true, product = {}) => ({ productId: name, name, active, product: { name, ...product } });
const MERIT = row('Merit 2F');
const TRISTAR = row('TriStar 8.5 SL');

describe('Merit rule', () => {
  test('armored scale only + Merit blocks, and names the Merit rows to remove', () => {
    const result = evaluatePestCheck({ found: true, types: ['armored_scale'] }, [MERIT, row('Snapshot 2.5TG')]);
    expect(result.blockMessage).toBe(MERIT_BLOCK_MESSAGE);
    expect(MERIT_BLOCK_MESSAGE).toBe('Merit does not control armored scale. Use Distance or oil on crawlers, or a Zylam drench.');
    expect(result.blockedRows).toEqual([MERIT]);
    expect(result.blockedLabel).toBe('Merit');
    expect(result.noteMessages).toEqual([]);
  });
  test('armored scale + caterpillars or mites still blocks', () => {
    expect(evaluatePestCheck({ found: true, types: ['armored_scale', 'mites', 'caterpillars'] }, [MERIT]).blockMessage).toBe(MERIT_BLOCK_MESSAGE);
  });
  test('armored + soft scale is a note only', () => {
    const result = evaluatePestCheck({ found: true, types: ['armored_scale', 'soft_scale'] }, [MERIT]);
    expect(result.blockMessage).toBe('');
    expect(result.noteMessages).toEqual([MERIT_BLOCK_MESSAGE]);
  });
  test('armored + whitefly is a note only', () => {
    const result = evaluatePestCheck({ found: true, types: ['whitefly', 'armored_scale'] }, [MERIT]);
    expect(result.blockMessage).toBe('');
    expect(result.noteMessages).toEqual([MERIT_BLOCK_MESSAGE]);
  });
  test('nothing fires without armored scale, without Merit, with Merit off, or when not a Yes', () => {
    expect(evaluatePestCheck({ found: true, types: ['soft_scale'] }, [MERIT])).toMatchObject({ blockMessage: '', noteMessages: [] });
    expect(evaluatePestCheck({ found: true, types: ['whitefly'] }, [TRISTAR])).toMatchObject({ blockMessage: '', noteMessages: [] });
    expect(evaluatePestCheck({ found: true, types: ['armored_scale'] }, [row('Merit 2F', false)])).toMatchObject({ blockMessage: '' });
    expect(evaluatePestCheck({ found: false, types: ['armored_scale'] }, [MERIT]).blockMessage).toBe('');
    expect(evaluatePestCheck({ found: null, types: [] }, [MERIT])).toMatchObject({ blockMessage: '', noteMessages: [] });
  });
  test('Merit is matched by name or by imidacloprid', () => {
    expect(isMeritProduct(row('Merit 2F'))).toBe(true);
    expect(isMeritProduct(row('Some Drench', true, { active_ingredient: 'Imidacloprid 21.4%' }))).toBe(true);
    expect(isMeritProduct(row('Meritorious Mulch Co'))).toBe(false);
    expect(isMeritProduct(row('TriStar 8.5 SL', true, { active_ingredient: 'Acetamiprid' }))).toBe(false);
  });
});

describe('TriStar rule (owner 2026-10-09: not for armored scale)', () => {
  test('armored scale only + TriStar blocks, and names the TriStar rows to remove', () => {
    const result = evaluatePestCheck({ found: true, types: ['armored_scale'] }, [TRISTAR, row('Distance IGR')]);
    expect(result.blockMessage).toBe(TRISTAR_BLOCK_MESSAGE);
    expect(result.blockedRows).toEqual([TRISTAR]);
    expect(result.blockedLabel).toBe('TriStar');
  });
  test('an acetamiprid product under another name is the same rule', () => {
    const generic = { active: true, name: 'Acetamiprid 8.5 SL', product: { active_ingredient: 'Acetamiprid' } };
    expect(isTristarProduct(generic)).toBe(true);
    expect(evaluatePestCheck({ found: true, types: ['armored_scale', 'mites'] }, [generic]).blockMessage).toBe(TRISTAR_BLOCK_MESSAGE);
  });
  test('armored scale beside soft scale, whitefly or Other is a note only', () => {
    for (const other of ['soft_scale', 'whitefly', 'other']) {
      const result = evaluatePestCheck({ found: true, types: ['armored_scale', other] }, [TRISTAR]);
      expect(result.blockMessage).toBe('');
      expect(result.noteMessages).toEqual([TRISTAR_BLOCK_MESSAGE]);
      expect(result.blockedRows).toEqual([]);
    }
  });
  test('Merit and TriStar together on armored scale only: one line, both rows removed', () => {
    const result = evaluatePestCheck({ found: true, types: ['armored_scale'] }, [MERIT, TRISTAR]);
    expect(result.blockMessage).toBe(MERIT_TRISTAR_BLOCK_MESSAGE);
    expect(result.blockedRows).toEqual([MERIT, TRISTAR]);
    expect(result.blockedLabel).toBe('Merit and TriStar');
  });
  test('armored + Other: Merit still blocks, TriStar is a note', () => {
    const result = evaluatePestCheck({ found: true, types: ['armored_scale', 'other'] }, [MERIT, TRISTAR]);
    expect(result.blockMessage).toBe(MERIT_BLOCK_MESSAGE);
    expect(result.noteMessages).toEqual([TRISTAR_BLOCK_MESSAGE]);
    expect(result.blockedRows).toEqual([MERIT]);
  });
  test('no armored scale: TriStar is never flagged', () => {
    expect(evaluatePestCheck({ found: true, types: ['whitefly'] }, [TRISTAR])).toEqual({
      blockMessage: '', noteMessages: [], blockedRows: [], blockedLabel: '',
    });
  });
});

describe('live-finds-only rule', () => {
  test('No + TriStar is a non-blocking note', () => {
    expect(evaluatePestCheck({ found: false, types: [] }, [TRISTAR])).toEqual({
      blockMessage: '', noteMessages: ['No live insects recorded. TriStar is for live finds only.'], blockedRows: [], blockedLabel: '',
    });
  });
  test('one note per live-finds-only product, inactive and ordinary products are ignored', () => {
    const result = evaluatePestCheck({ found: false, types: [] }, [
      TRISTAR, row('Distance IGR'), row('DiPel PRO DF', false), row('Snapshot 2.5TG'), MERIT,
    ]);
    expect(result.noteMessages).toEqual([
      'No live insects recorded. TriStar is for live finds only.',
      'No live insects recorded. Distance IGR is for live finds only.',
    ]);
  });
  test('every product on the protocol list is recognised', () => {
    for (const name of ['TriStar 8.5 SL', 'Distance IGR', 'DiPel PRO DF', 'Conserve SC', 'Mainspring GNL', 'Floramite SC']) {
      expect(liveFindsOnlyLabel(row(name))).not.toBe('');
    }
    expect(liveFindsOnlyLabel(row('Snapshot 2.5TG'))).toBe('');
  });
  test('Yes or unanswered adds no live-finds note', () => {
    expect(evaluatePestCheck({ found: true, types: ['mites'] }, [TRISTAR]).noteMessages).toEqual([]);
    expect(evaluatePestCheck({ found: null, types: [] }, [TRISTAR]).noteMessages).toEqual([]);
  });
});

describe('payload', () => {
  test('unanswered sends nothing; the body is unchanged', () => {
    expect(pestCheckPayload({ found: null, types: ['mites'] })).toBeNull();
    const body = { visitOutcome: 'completed' };
    expect(withPestCheck(body, null)).toBe(body);
  });
  test('Yes sends the picks in enum order; No sends none', () => {
    expect(pestCheckPayload({ found: true, types: ['mites', 'armored_scale', 'nope'] })).toEqual({ liveInsectsFound: true, insectTypes: ['armored_scale', 'mites'] });
    expect(pestCheckPayload({ found: false, types: ['mites'] })).toEqual({ liveInsectsFound: false, insectTypes: [] });
  });
  test('it joins the review beside watch items without replacing them', () => {
    const payload = { liveInsectsFound: false, insectTypes: [] };
    expect(withPestCheck({ treeShrubReview: { watchItems: [{ key: 'scale' }] } }, payload).treeShrubReview)
      .toEqual({ watchItems: [{ key: 'scale' }], pestCheck: payload });
    expect(withPestCheck({}, payload).treeShrubReview).toEqual({ pestCheck: payload });
  });
  test('notes TriTek on a No answer (live finds only since 2026-10-09)', () => {
    const out = evaluatePestCheck({ found: false, types: [] }, [{ active: true, name: 'TriTek Spray Oil Emulsion' }]);
    expect(out.blockMessage).toBe('');
    expect(out.noteMessages).toEqual(['No live insects recorded. TriTek is for live finds only.']);
  });
});
