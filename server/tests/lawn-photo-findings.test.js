// "What the photos showed" (lawn report rebuild P23b): the pure selection and
// block builder over a technician-reviewed assessment run. Synthetic data only.
const {
  selectPhotoFindings, photoFindingsSignatureState, buildPhotoFindings, photoCanConfirmSentence, filterByCardStatus,
  PHOTO_FINDING_LABELS, CARD_FOR_LABEL, CARD_STATUSES_THAT_PRINT, MAX_FINDINGS, MAX_THUMBNAILS,
} = require('../services/service-report/lawn-photo-findings');
const { keptRunRows, lawnFindingsFromRun } = require('../services/service-report/tip-library');
const { CONDITION_LABEL_VALUES } = require('../services/lawn-diagnostic-report');
const { buildVisualDiagnosisCategories } = require('../services/service-report/lawn-visual-diagnosis');

const ASSESSMENT = { id: 'la-1', customer_id: 'c-1', confirmed_by_tech: true };
const finding = (over = {}) => ({
  finding_id: 'f1', name: 'internal model name', label: 'weed pressure', severity: 'moderate', keep: true, can_determine: true,
  photo_refs: [1], observed_evidence: ['STORED EVIDENCE TEXT'], cannot_determine_reason: 'STORED REASON TEXT', confirmation_step: 'STORED STEP TEXT', customer_wording: 'STORED WORDING', ...over,
});
const run = (findings, over = {}) => ({
  assessment_id: 'la-1', customer_id: 'c-1', reviewed_at: '2026-09-30T15:00:00Z',
  photo_ids: ['ph-front', 'ph-close', 'ph-back'], reviewed_findings: findings, ...over,
});
const PHOTO_ROWS = [
  { id: 'ph-front', zone: 'front', url: 'https://x.test/front' },
  { id: 'ph-close', zone: 'close_up', url: 'https://x.test/close' },
  { id: 'ph-back', zone: 'back', url: 'https://x.test/back' },
];
const SET = [
  { url: 'https://x.test/front', shot: 'front', label: 'Front yard' },
  { url: 'https://x.test/back', shot: 'back', label: 'Back yard' },
  { url: 'https://x.test/close', shot: 'close_up', label: 'Close-up' },
];
const build = (r, over = {}) => buildPhotoFindings({ run: r, assessment: ASSESSMENT, photoRows: PHOTO_ROWS, photoSet: SET, ...over });

describe('selectPhotoFindings', () => {
  test('keeps a kept finding with an allowlisted label', () => {
    expect(selectPhotoFindings(run([finding()]), ASSESSMENT)).toEqual([{ index: 0, label: 'weed pressure', severity: 'moderate', canDetermine: true, refs: [1] }]);
  });

  test('nothing for an unreviewed run, an unconfirmed assessment, another assessment or another customer', () => {
    expect(selectPhotoFindings(run([finding()], { reviewed_at: null }), ASSESSMENT)).toEqual([]);
    expect(selectPhotoFindings(run([finding()]), { ...ASSESSMENT, confirmed_by_tech: false })).toEqual([]);
    expect(selectPhotoFindings(run([finding()], { assessment_id: 'la-OLD' }), ASSESSMENT)).toEqual([]);
    expect(selectPhotoFindings(run([finding()], { customer_id: 'c-2' }), ASSESSMENT)).toEqual([]);
    expect(selectPhotoFindings(null, ASSESSMENT)).toEqual([]);
    expect(selectPhotoFindings(run([finding()]), null)).toEqual([]);
    expect(selectPhotoFindings(run(null), ASSESSMENT)).toEqual([]);
  });

  test('a rejected finding, an unknown label and a non-string label print nothing', () => {
    const rows = run([finding({ keep: false }), finding({ label: 'invented condition' }), finding({ label: 42 }), finding({ label: 'constructor' }), finding({ label: undefined })]);
    expect(selectPhotoFindings(rows, ASSESSMENT)).toEqual([]);
  });

  test('the allowlist is explicit: symptom labels only, pinned', () => {
    expect([...PHOTO_FINDING_LABELS]).toEqual([
      'weed pressure', 'thinning turf', 'color and nutrient stress', 'color stress', 'general lawn stress', 'a lawn condition we are monitoring',
    ]);
    // every one is a real customer label, and every one has a category card
    for (const label of PHOTO_FINDING_LABELS) {
      expect(CONDITION_LABEL_VALUES).toContain(label);
      expect(CARD_FOR_LABEL[label]).toBeTruthy();
    }
    expect(Object.keys(CARD_FOR_LABEL).sort()).toEqual([...PHOTO_FINDING_LABELS].sort());
  });

  test('named causes, the water labels and the clean label never print; a label not on the allowlist prints nothing', () => {
    const left = CONDITION_LABEL_VALUES.filter((label) => !PHOTO_FINDING_LABELS.includes(label));
    expect(left.sort()).toEqual([
      'caterpillar activity', 'chinch bug activity', 'dollar spot', 'drought stress', 'fungal activity', 'grub activity',
      'gray leaf spot', 'large patch (fungal) activity', 'no major visible stress', 'overwatering signal',
    ].sort());
    for (const label of left) expect(selectPhotoFindings(run([finding({ label })]), ASSESSMENT)).toEqual([]);
    for (const label of PHOTO_FINDING_LABELS) expect(selectPhotoFindings(run([finding({ label })]), ASSESSMENT)).toHaveLength(1);
  });

  test('shares the tip ranking reader: keep and negate rules come from keptRunRows', () => {
    const r = run([finding(), finding({ keep: false, label: 'gray leaf spot' })], { added_details: [{ label: 'weed pressure', negated: true }, { label: 'grub activity' }] });
    expect(keptRunRows(r).reviewed).toHaveLength(1);
    expect(keptRunRows(r).added).toEqual([{ label: 'grub activity' }]);
    expect(lawnFindingsFromRun(r).sort()).toEqual(['weeds', 'white_grubs']);
    // technician-added details have no photos and are not part of this block
    expect(selectPhotoFindings(r, ASSESSMENT).map((f) => f.label)).toEqual(['weed pressure']);
  });

  test('most severe first, stored order inside a severity', () => {
    const rows = run([
      finding({ label: 'thinning turf', severity: 'mild' }),
      finding({ label: 'weed pressure', severity: 'severe' }),
      finding({ label: 'general lawn stress', severity: 'moderate' }),
      finding({ label: 'color stress', severity: 'moderate' }),
      finding({ label: 'color and nutrient stress', severity: 'severe' }),
    ]);
    expect(selectPhotoFindings(rows, ASSESSMENT).map((f) => f.label)).toEqual(['weed pressure', 'color and nutrient stress', 'general lawn stress', 'color stress', 'thinning turf']);
  });

  test('a stored severity the code does not know sorts last, never throws', () => {
    const rows = run([finding({ label: 'thinning turf', severity: 'weird' }), finding({ label: 'weed pressure', severity: 'mild' })]);
    expect(selectPhotoFindings(rows, ASSESSMENT).map((f) => f.label)).toEqual(['weed pressure', 'thinning turf']);
  });

  test('reads JSON text columns and drops malformed photo refs', () => {
    const rows = run(JSON.stringify([finding({ photo_refs: [1, 1, 2, 0, -1, 'x', 1.5] })]));
    expect(selectPhotoFindings(rows, ASSESSMENT)[0].refs).toEqual([1, 2]);
    expect(selectPhotoFindings(run('not json'), ASSESSMENT)).toEqual([]);
  });
});

describe('buildPhotoFindings', () => {
  test('capitalizes the allowlisted label and links the photos the finding cites, as photos of the set', () => {
    const out = build(run([finding({ photo_refs: [2, 1] })]));
    expect(out).toEqual([{ label: 'Weed pressure', photos: [{ url: 'https://x.test/close', label: 'Close-up' }, { url: 'https://x.test/front', label: 'Front yard' }] }]);
  });

  test('no link, a ref past the photo list, or a photo outside the set = no thumbnail, never another photo', () => {
    expect(build(run([finding({ photo_refs: [] })]))[0].photos).toEqual([]);
    expect(build(run([finding({ photo_refs: [9] })]))[0].photos).toEqual([]);
    const smallSet = SET.filter((entry) => entry.shot !== 'close_up');
    expect(build(run([finding({ photo_refs: [2, 3] })]), { photoSet: smallSet })[0].photos).toEqual([{ url: 'https://x.test/back', label: 'Back yard' }]);
  });

  test('at most three thumbnails per finding', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, zone: 'trouble', url: `https://x.test/p${i}` }));
    const out = build(run([finding({ photo_refs: [1, 2, 3, 4, 5] })], { photo_ids: many.map((r) => r.id) }), {
      photoRows: many, photoSet: many.map((r) => ({ url: r.url, shot: 'trouble', label: 'Trouble spot' })),
    });
    expect(MAX_THUMBNAILS).toBe(3);
    expect(out[0].photos).toHaveLength(3);
  });

  test('no set = no block', () => {
    expect(build(run([finding()]), { photoSet: [] })).toEqual([]);
    expect(build(run([finding()]), { photoSet: null })).toEqual([]);
  });

  test('never publishes stored free text', () => {
    const out = JSON.stringify(build(run([finding({ can_determine: false, photo_refs: [1] })])));
    for (const stored of ['STORED EVIDENCE TEXT', 'STORED REASON TEXT', 'STORED STEP TEXT', 'STORED WORDING', 'internal model name']) expect(out).not.toContain(stored);
  });

  describe('the "photo can confirm" line', () => {
    const undetermined = (over = {}) => finding({ label: 'general lawn stress', can_determine: false, photo_refs: [1], ...over });

    test('only where can_determine is false, naming a cause-supporting shot the visit lacks', () => {
      expect(build(run([undetermined()]))[0].confirm).toBe('The photos from this visit cannot confirm this. A blade close-up photo would let us confirm it.');
      expect(build(run([finding({ can_determine: true })]))[0].confirm).toBeUndefined();
      expect(build(run([finding({ can_determine: undefined })]))[0].confirm).toBeUndefined();
    });

    test('names the trouble spot shot when the blade close-up is already in the visit', () => {
      const withBlade = [...SET, { url: 'https://x.test/blade', shot: 'blade_crown', label: 'Blade close-up' }];
      expect(build(run([undetermined()]), { photoSet: withBlade })[0].confirm).toBe(photoCanConfirmSentence('trouble spot'));
    });

    test('prints nothing when the visit already has every cause-supporting shot', () => {
      const full = [...SET, { url: 'https://x.test/blade', shot: 'blade_crown', label: 'Blade close-up' }, { url: 'https://x.test/trouble', shot: 'trouble', label: 'Trouble spot' }];
      expect(build(run([undetermined()]), { photoSet: full })[0].confirm).toBeUndefined();
    });

    test('prints nothing when a cited photo cannot be placed (no refs, unknown id, no link)', () => {
      expect(build(run([undetermined({ photo_refs: [] })]))[0].confirm).toBeUndefined();
      expect(build(run([undetermined({ photo_refs: [9] })]))[0].confirm).toBeUndefined();
      expect(build(run([undetermined()]), { photoRows: [{ id: 'ph-front', zone: 'front', url: null }] })[0].confirm).toBeUndefined();
    });

    // Codex r1: an untagged photo could be the very shot we would call missing.
    test('prints nothing when a cited photo, or any photo of the set, has no known shot', () => {
      expect(build(run([undetermined()]), { photoRows: [{ id: 'ph-front', zone: '', url: 'https://x.test/front' }] })[0].confirm).toBeUndefined();
      expect(build(run([undetermined()]), { photoRows: [{ id: 'ph-front', zone: 'somewhere', url: 'https://x.test/front' }] })[0].confirm).toBeUndefined();
      const withUntagged = [...SET, { url: 'https://x.test/untagged', shot: null, label: 'Lawn photo' }];
      expect(build(run([undetermined()]), { photoSet: withUntagged })[0].confirm).toBeUndefined();
    });
  });
});

describe('photoFindingsSignatureState', () => {
  test('empty when the visit would have no block, so such a visit keeps its key', () => {
    expect(photoFindingsSignatureState(null, ASSESSMENT)).toBe('');
    expect(photoFindingsSignatureState(run([finding({ label: 'no major visible stress' })]), ASSESSMENT)).toBe('');
    expect(photoFindingsSignatureState(run([finding()], { reviewed_at: null }), ASSESSMENT)).toBe('');
  });

  test('moves when the reviewed findings, their photo refs or the run photo order change', () => {
    const base = photoFindingsSignatureState(run([finding()]), ASSESSMENT);
    expect(base).toMatch(/^[0-9a-f]{10}$/);
    expect(photoFindingsSignatureState(run([finding()]), ASSESSMENT)).toBe(base);
    expect(photoFindingsSignatureState(run([finding({ label: 'thinning turf' })]), ASSESSMENT)).not.toBe(base);
    expect(photoFindingsSignatureState(run([finding({ photo_refs: [2] })]), ASSESSMENT)).not.toBe(base);
    expect(photoFindingsSignatureState(run([finding({ keep: false }), finding({ label: 'thinning turf' })]), ASSESSMENT)).not.toBe(base);
    expect(photoFindingsSignatureState(run([finding()], { photo_ids: ['ph-close', 'ph-front', 'ph-back'] }), ASSESSMENT)).not.toBe(base);
    expect(photoFindingsSignatureState(run([finding({ can_determine: false })]), ASSESSMENT)).not.toBe(base);
  });

  test('stored free text does not move it', () => {
    const base = photoFindingsSignatureState(run([finding()]), ASSESSMENT);
    expect(photoFindingsSignatureState(run([finding({ observed_evidence: ['different'], confirmation_step: 'other' })]), ASSESSMENT)).toBe(base);
  });
});

describe('filterByCardStatus: the block never contradicts a card on the same page', () => {
  const card = (key, status) => ({ key, label: key, status });
  const block = (...labels) => labels.map((label) => ({ label: label.charAt(0).toUpperCase() + label.slice(1), photos: [] }));

  test('prints while the topic card shows a concern, in both directions', () => {
    for (const status of CARD_STATUSES_THAT_PRINT) {
      expect(filterByCardStatus(block('weed pressure'), [card('weed_pressure', status)])).toHaveLength(1);
    }
    expect([...CARD_STATUSES_THAT_PRINT]).toEqual(['watch', 'needs_attention']);
    for (const status of ['strong', 'healthy']) {
      expect(filterByCardStatus(block('weed pressure'), [card('weed_pressure', status)])).toEqual([]);
    }
  });

  test('a still-tracking, unknown or missing card leaves the finding out', () => {
    expect(filterByCardStatus(block('weed pressure'), [card('weed_pressure', 'tracking')])).toEqual([]);
    expect(filterByCardStatus(block('weed pressure'), [card('weed_pressure', 'odd')])).toEqual([]);
    expect(filterByCardStatus(block('weed pressure'), [card('weed_pressure', undefined)])).toEqual([]);
    expect(filterByCardStatus(block('weed pressure'), [card('coverage', 'watch')])).toEqual([]);
    expect(filterByCardStatus(block('weed pressure'), [])).toEqual([]);
    expect(filterByCardStatus(block('weed pressure'), null)).toEqual([]);
    expect(filterByCardStatus(block('not a known label'), [card('weed_pressure', 'watch')])).toEqual([]);
  });

  test('each label reads its own topic card', () => {
    const watching = ['coverage', 'color_vigor', 'weed_pressure', 'damage_disease_signals'].map((key) => card(key, 'watch'));
    for (const label of PHOTO_FINDING_LABELS) expect(filterByCardStatus(block(label), watching)).toHaveLength(1);
    expect(filterByCardStatus(block('thinning turf'), [card('coverage', 'strong'), card('weed_pressure', 'watch')])).toEqual([]);
    expect(filterByCardStatus(block('color stress', 'color and nutrient stress'), [card('color_vigor', 'healthy')])).toEqual([]);
    expect(filterByCardStatus(block('general lawn stress'), [card('damage_disease_signals', 'needs_attention')])).toHaveLength(1);
  });

  test('uses the real diagnosis the report builds (a strong weed score hides the finding, a low one shows it)', () => {
    const diagnosisFor = (weedSuppression) => buildVisualDiagnosisCategories({ scores: { turfDensity: 90, weedSuppression, colorHealth: 90, fungusControl: 90 } });
    expect(filterByCardStatus(block('weed pressure'), diagnosisFor(95))).toEqual([]);
    expect(filterByCardStatus(block('weed pressure'), diagnosisFor(50))).toHaveLength(1);
  });

  test('the cap of four applies after the card check, so a hidden finding never costs a shown one its place', () => {
    const many = block('weed pressure', 'thinning turf', 'color stress', 'color and nutrient stress', 'general lawn stress');
    const cards = [card('weed_pressure', 'strong'), card('coverage', 'watch'), card('color_vigor', 'watch'), card('damage_disease_signals', 'watch')];
    expect(MAX_FINDINGS).toBe(4);
    expect(filterByCardStatus(many, cards).map((f) => f.label)).toEqual(['Thinning turf', 'Color stress', 'Color and nutrient stress', 'General lawn stress']);
    const allWatch = ['weed_pressure', 'coverage', 'color_vigor', 'damage_disease_signals'].map((key) => card(key, 'watch'));
    expect(filterByCardStatus(many, allWatch)).toHaveLength(4);
  });
});
