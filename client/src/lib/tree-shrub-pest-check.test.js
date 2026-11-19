// GATE_TS_PEST_CHECK rules (pure). Synthetic data only.
import { describe, expect, test } from 'vitest';
import {
  DISTANCE_SCALE_BLOCK_MESSAGE, MERIT_BLOCK_MESSAGE, MERIT_TRISTAR_BLOCK_MESSAGE, TRISTAR_BLOCK_MESSAGE, evaluatePestCheck, isDistanceProduct, isMeritProduct, isTristarProduct,
  liveFindsOnlyLabel, pestCheckPayload, withPestCheck,
} from './tree-shrub-pest-check';

const row = (name, active = true, product = {}) => ({ productId: name, name, active, product: { name, ...product } });
const MERIT = row('Merit 2F');
const TRISTAR = row('TriStar 8.5 SL');
const live = (types) => ({ found: true, types, lifeStage: 'crawlers_nymphs' });

describe('Merit rule', () => {
  test('armored scale only + Merit blocks, and names the Merit rows to remove', () => {
    const result = evaluatePestCheck(live(['armored_scale']), [MERIT, row('Snapshot 2.5TG')]);
    expect(result.blockMessage).toBe(MERIT_BLOCK_MESSAGE);
    expect(MERIT_BLOCK_MESSAGE).toBe('Merit does not control armored scale. Distance scale use is on hold; use oil on live crawlers or a label-supported Zylam drench.');
    expect(result.blockedRows).toEqual([MERIT]);
    expect(result.blockedLabel).toBe('Merit');
    expect(result.noteMessages).toEqual([]);
  });
  test('armored scale + caterpillars or mites still blocks', () => {
    expect(evaluatePestCheck(live(['armored_scale', 'mites', 'caterpillars']), [MERIT]).blockMessage).toBe(MERIT_BLOCK_MESSAGE);
  });
  test('armored + soft scale is a note only', () => {
    const result = evaluatePestCheck(live(['armored_scale', 'soft_scale']), [MERIT]);
    expect(result.blockMessage).toBe('');
    expect(result.noteMessages).toEqual([MERIT_BLOCK_MESSAGE]);
  });
  test('armored + whitefly is a note only', () => {
    const result = evaluatePestCheck(live(['whitefly', 'armored_scale']), [MERIT]);
    expect(result.blockMessage).toBe('');
    expect(result.noteMessages).toEqual([MERIT_BLOCK_MESSAGE]);
  });
  test('the armored-scale rule stays quiet without armored scale or an active Merit row', () => {
    expect(evaluatePestCheck(live(['soft_scale']), [MERIT])).toMatchObject({ blockMessage: '', noteMessages: [] });
    expect(evaluatePestCheck(live(['whitefly']), [TRISTAR])).toMatchObject({ blockMessage: '', noteMessages: [] });
    expect(evaluatePestCheck(live(['armored_scale']), [row('Merit 2F', false)])).toMatchObject({ blockMessage: '' });
    expect(evaluatePestCheck({ found: false, types: ['armored_scale'], preventiveReason: 'Label-supported systemic timing.' }, [MERIT]).blockMessage).toBe('');
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
    const result = evaluatePestCheck(live(['armored_scale']), [TRISTAR, row('Snapshot 2.5TG')]);
    expect(result.blockMessage).toBe(TRISTAR_BLOCK_MESSAGE);
    expect(result.blockedRows).toEqual([TRISTAR]);
    expect(result.blockedLabel).toBe('TriStar');
  });
  test('an acetamiprid product under another name is the same rule', () => {
    const generic = { active: true, name: 'Acetamiprid 8.5 SL', product: { active_ingredient: 'Acetamiprid' } };
    expect(isTristarProduct(generic)).toBe(true);
    expect(evaluatePestCheck(live(['armored_scale', 'mites']), [generic]).blockMessage).toBe(TRISTAR_BLOCK_MESSAGE);
  });
  test('armored scale beside soft scale, whitefly or Other is a note only', () => {
    for (const other of ['soft_scale', 'whitefly', 'other']) {
      const result = evaluatePestCheck(live(['armored_scale', other]), [TRISTAR]);
      expect(result.blockMessage).toBe('');
      expect(result.noteMessages).toEqual([TRISTAR_BLOCK_MESSAGE]);
      expect(result.blockedRows).toEqual([]);
    }
  });
  test('Merit and TriStar together on armored scale only: one line, both rows removed', () => {
    const result = evaluatePestCheck(live(['armored_scale']), [MERIT, TRISTAR]);
    expect(result.blockMessage).toBe(MERIT_TRISTAR_BLOCK_MESSAGE);
    expect(result.blockedRows).toEqual([MERIT, TRISTAR]);
    expect(result.blockedLabel).toBe('Merit and TriStar');
  });
  test('armored + Other: Merit still blocks, TriStar is a note', () => {
    const result = evaluatePestCheck(live(['armored_scale', 'other']), [MERIT, TRISTAR]);
    expect(result.blockMessage).toBe(MERIT_BLOCK_MESSAGE);
    expect(result.noteMessages).toEqual([TRISTAR_BLOCK_MESSAGE]);
    expect(result.blockedRows).toEqual([MERIT]);
  });
  test('no armored scale: TriStar is never flagged', () => {
    expect(evaluatePestCheck(live(['whitefly']), [TRISTAR])).toEqual({
      blockMessage: '', noteMessages: [], blockedRows: [], blockedLabel: '',
    });
  });
});

describe('Distance scale hold', () => {
  const DISTANCE = row('Distance IGR');

  test('either armored or soft scale holds Distance and names the row to remove', () => {
    for (const scale of ['armored_scale', 'soft_scale']) {
      const result = evaluatePestCheck(live([scale]), [DISTANCE, row('TriTek Spray Oil Emulsion')]);
      expect(result.blockMessage).toBe(DISTANCE_SCALE_BLOCK_MESSAGE);
      expect(result.blockedRows).toEqual([DISTANCE]);
      expect(result.blockedLabel).toBe('Distance');
    }
  });

  test('whitefly stays the supported Distance target and name matching is bounded', () => {
    expect(evaluatePestCheck(live(['whitefly']), [DISTANCE]).blockMessage).toBe('');
    expect(isDistanceProduct(DISTANCE)).toBe(true);
    expect(isDistanceProduct(row('Long Distance Soil Conditioner'))).toBe(false);
  });
});

describe('live-finds-only rule', () => {
  test('No + TriStar holds because a live-finds-only product needs target evidence', () => {
    expect(evaluatePestCheck({ found: false, types: [] }, [TRISTAR])).toEqual({
      blockMessage: 'TriStar requires a live target and stage. Remove the treatment or record what was found.', noteMessages: [], blockedRows: [], blockedLabel: '',
    });
  });
  test('the hold names each live-finds-only product; inactive and ordinary products are ignored', () => {
    const result = evaluatePestCheck({ found: false, types: [] }, [
      TRISTAR, row('Distance IGR'), row('DiPel PRO DF', false), row('Snapshot 2.5TG'), MERIT,
    ]);
    expect(result.blockMessage).toBe('TriStar, Distance IGR require a live target and stage. Remove the treatment or record what was found.');
    expect(result.noteMessages).toEqual([]);
  });
  test('every product on the protocol list is recognised', () => {
    for (const name of ['TriStar 8.5 SL', 'Distance IGR', 'DiPel PRO DF', 'Conserve SC', 'Mainspring GNL', 'Acelepryn Insecticide', 'Floramite SC']) {
      expect(liveFindsOnlyLabel(row(name))).not.toBe('');
    }
    expect(liveFindsOnlyLabel(row('Snapshot 2.5TG'))).toBe('');
    expect(liveFindsOnlyLabel(row('Acelepryn Xtra'))).toBe('');
  });
  test('Yes or unanswered adds no live-finds note', () => {
    expect(evaluatePestCheck(live(['mites']), [TRISTAR]).noteMessages).toEqual([]);
    expect(evaluatePestCheck({ found: null, types: [] }, [TRISTAR]).noteMessages).toEqual([]);
  });
});

describe('payload', () => {
  test('unanswered sends nothing; the body is unchanged', () => {
    expect(pestCheckPayload({ found: null, types: ['mites'] })).toBeNull();
    const body = { visitOutcome: 'completed' };
    expect(withPestCheck(body, null)).toBe(body);
  });
  test('Yes sends target and stage; No sends the preventive reason', () => {
    expect(pestCheckPayload({ found: true, types: ['mites', 'armored_scale', 'nope'], lifeStage: 'crawlers_nymphs' })).toEqual({ liveInsectsFound: true, insectTypes: ['armored_scale', 'mites'], lifeStage: 'crawlers_nymphs' });
    expect(pestCheckPayload({ found: false, types: ['mites'], preventiveReason: '  Label timing and site history. ' })).toEqual({ liveInsectsFound: false, insectTypes: [], preventiveReason: 'Label timing and site history.' });
  });
  test('it joins the review beside watch items without replacing them', () => {
    const payload = { liveInsectsFound: false, insectTypes: [] };
    expect(withPestCheck({ treeShrubReview: { watchItems: [{ key: 'scale' }] } }, payload).treeShrubReview)
      .toEqual({ watchItems: [{ key: 'scale' }], pestCheck: payload });
    expect(withPestCheck({}, payload).treeShrubReview).toEqual({ pestCheck: payload });
  });
  test('holds TriTek on a No answer (live finds only since 2026-10-09)', () => {
    const out = evaluatePestCheck({ found: false, types: [] }, [{ active: true, name: 'TriTek Spray Oil Emulsion' }]);
    expect(out.blockMessage).toBe('TriTek requires a live target and stage. Remove the treatment or record what was found.');
    expect(out.noteMessages).toEqual([]);
  });
});
