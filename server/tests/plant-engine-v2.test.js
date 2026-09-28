/**
 * Photo ID v2 lawn/plant engine tests (L3).
 *
 * Two independent groups, because the catalog module is a singleton
 * `require`: `describe('deterministic builder — fixture catalog', ...)`
 * mocks `../services/species-catalog` to the small hand-built fixture in
 * `helpers/plant-engine-fixtures.js` (model calls mocked at `llm/call`'s
 * `dispatch` — nothing here hits a real provider), while
 * `describe('real catalog', ...)` requires the LIVE `species-catalog-v1`
 * data straight (no mocking) to prove the naming gate, hard cap and
 * identity indices behave correctly against the actual content #5143/#5158
 * landed — today all drafts for `plant`/`condition`, all owner-approved for
 * `pest` (see PLANT-ENGINE-CONTRACT.md §8).
 */

'use strict';

function loadFixtureEngine() {
  jest.resetModules();
  jest.doMock('../services/species-catalog', () => require('./helpers/plant-engine-fixtures').FIXTURE);
  jest.doMock('../services/llm/call', () => ({
    ...jest.requireActual('../services/llm/call'),
    dispatch: jest.fn(),
  }));
  jest.doMock('../config/models', () => {
    const actual = jest.requireActual('../config/models');
    return {
      ...actual,
      TEXT_POLICIES: {
        ...actual.TEXT_POLICIES,
        photoIdVision: {
          name: 'photoIdVision',
          primary: { provider: 'gemini', model: 'gemini-3.8-flash-test' },
          fallback: { provider: 'openai', model: 'gpt-6-astra-test' },
        },
      },
    };
  });
  const catalog = require('../services/species-catalog');
  const { dispatch } = require('../services/llm/call');
  const engine = require('../services/photo-id-v2/plant-engine');
  return { catalog, dispatch, engine };
}

function unloadFixtureEngine() {
  jest.dontMock('../services/species-catalog');
  jest.dontMock('../services/llm/call');
  jest.dontMock('../config/models');
  jest.resetModules();
}

describe('plant-engine — deterministic builder (fixture catalog)', () => {
  let catalog; let dispatch; let engine;

  beforeAll(() => {
    ({ catalog, dispatch, engine } = loadFixtureEngine());
  });
  afterAll(() => {
    unloadFixtureEngine();
  });
  beforeEach(() => {
    dispatch.mockReset();
  });

  const conditionEntries = () => catalog.listEntries({ section: 'condition' });
  const pestEntries = () => catalog.listEntries({ section: 'pest' });

  function possibility(slug, confidence, elementsVisible = []) {
    const entries = [...conditionEntries(), ...pestEntries()];
    return engine.resolveConditionCandidate({ slug, confidence, elements_visible: elementsVisible }, entries);
  }

  // ── naming gate (§6.3) ────────────────────────────────────────────────

  describe('naming gate', () => {
    test('photo-confirmable, all elements visible, high confidence -> named', () => {
      const p = possibility('fixture-large-patch', 0.9, [1]);
      expect(engine.namedAnswerFor([p], p)).not.toBeNull();
    });

    test('one required element missing -> never named, whatever the confidence', () => {
      const p = possibility('fixture-large-patch', 0.99, []);
      expect(engine.namedAnswerFor([p], p)).toBeNull();
    });

    test.each([
      ['technician', 'fixture-herbicide-injury'],
      ['lab', 'fixture-nematode'],
      ['field_test', 'fixture-drought'],
    ])('confirmable_by %s is never named, however high the confidence', (confirmableBy, slug) => {
      const entry = catalog.getEntry(slug);
      expect(entry.condition.required_signature.confirmable_by).toBe(confirmableBy);
      const p = possibility(slug, 0.99, [1]);
      expect(engine.namedAnswerFor([p], p)).toBeNull();
    });

    test('an unapproved (draft) entry is never named, however high the confidence', () => {
      const entry = catalog.getEntry('fixture-unreviewed-condition');
      expect(entry.review.status).not.toBe('owner_approved');
      const p = possibility('fixture-unreviewed-condition', 0.99, [1]);
      expect(engine.namedAnswerFor([p], p)).toBeNull();
    });

    test('confidence below 0.55 is never named even with every element visible', () => {
      const p = possibility('fixture-large-patch', 0.5, [1]);
      expect(engine.namedAnswerFor([p], p)).toBeNull();
    });
  });

  // ── hard cap (§6.3) ───────────────────────────────────────────────────

  describe('hard cap', () => {
    test('turf-diseases group entry reads at most likely, even at 0.95', () => {
      const p = possibility('fixture-large-patch', 0.95, [1]);
      expect(engine.namedAnswerFor([p], p).wording).toBe('likely');
    });

    test('every disorder reads at most likely, even at 0.95', () => {
      const p = possibility('fixture-potassium-deficiency-palm', 0.95, [1, 2]);
      expect(engine.namedAnswerFor([p], p).wording).toBe('likely');
    });

    test('a pest possibility reads at most likely, even at 0.99', () => {
      const p = possibility('fixture-chinch-bug', 0.99, [1, 2]);
      const named = engine.namedAnswerFor([p], p);
      expect(named.wording).toBe('likely');
    });

    test('a disease OUTSIDE turf-diseases and not a disorder CAN reach pretty_sure (the cap is scoped, not blanket)', () => {
      const p = possibility('fixture-palm-leaf-spot', 0.9, [1]);
      expect(engine.namedAnswerFor([p], p).wording).toBe('pretty_sure');
    });
  });

  // ── outcome-class rule (§6.3 condition 4, §5 escalation trigger) ───────

  describe('outcome-class rule', () => {
    test('potassium deficiency (0.9) with lethal bronzing (0.25, a different outcome class) alongside it -> not named', () => {
      const potassium = possibility('fixture-potassium-deficiency-palm', 0.9, [1, 2]);
      const bronzing = possibility('fixture-lethal-bronzing', 0.25, [1]);
      expect(engine.namedAnswerFor([potassium, bronzing], potassium)).toBeNull();
    });

    test('settle_it falls to their differential (lab test over time) when neither is named', () => {
      const potassium = possibility('fixture-potassium-deficiency-palm', 0.9, [1, 2]);
      const bronzing = possibility('fixture-lethal-bronzing', 0.25, [1]);
      expect(engine.settleItFor([potassium, bronzing], 'palm')).toMatchObject({
        kind: 'technician', photo_can_confirm: false,
      });
    });

    test('the SAME outcome class alongside does not block naming', () => {
      const large = possibility('fixture-large-patch', 0.9, [1]);
      const drought = possibility('fixture-drought', 0.3, [1]); // both 'manageable'/'cultural_fix' -> 'other' class
      expect(engine.namedAnswerFor([large, drought], large)).not.toBeNull();
    });

    test('a 4th-ranked conflicting-outcome-class candidate still blocks naming — buildWorkup must check ALL approved possibilities, not just the displayed top 3 (Codex pre-push P1)', () => {
      const leafSpot = possibility('fixture-palm-leaf-spot', 0.9, [1]); // rank 1, photo-confirmable, no_cure-free
      const fillerA = possibility('fixture-manganese-deficiency-palm', 0.5, [1]); // rank 2
      const fillerB = possibility('fixture-cosmetic-spot', 0.4, [1]); // rank 3
      const bronzing = possibility('fixture-lethal-bronzing', 0.25, [1]); // rank 4 — no_cure, >=0.20
      const built = engine.buildWorkup({
        subject: 'palm',
        possibilities: [leafSpot, fillerA, fillerB, bronzing],
        turfCandidates: [],
        weedCandidates: [],
        hostCandidates: [],
        observedTerms: [],
        currentMonth: 1,
        chips: {},
        context: {},
        photosCount: 1,
        quality: { usable: true, issue: 'none' },
      });
      expect(built.answer.level).toBe('symptom');
      expect(built.possibilities).toHaveLength(3); // the display list is still capped at 3
    });
  });

  // ── settle_it selection order (§6.5) ────────────────────────────────────

  describe('settle_it', () => {
    test('order 1: pair differential upgraded to the customer field test the text names (soap flush, chinch-bug pair)', () => {
      const large = possibility('fixture-large-patch', 0.9, [1]);
      const chinch = possibility('fixture-chinch-bug', 0.5, [1]);
      expect(engine.settleItFor([large, chinch], 'lawn')).toMatchObject({
        kind: 'field_test', name: 'Soap flush', who: 'customer', photo_can_confirm: true,
      });
    });

    test('order 2: own signature, confirmable_by field_test -> the entry\'s own first customer test', () => {
      const drought = possibility('fixture-drought', 0.9, [1]);
      expect(engine.settleItFor([drought], 'lawn')).toMatchObject({
        kind: 'field_test', name: 'Water response check',
      });
    });

    test('order 2: own signature, confirmable_by photo -> the required_signature text', () => {
      const large = possibility('fixture-large-patch', 0.9, [1]);
      expect(engine.settleItFor([large], 'lawn')).toEqual({
        kind: 'photo', text: 'A close-up of the orange ring and rotted sheaths.',
      });
    });

    test('order 2: own signature, confirmable_by technician -> the fixed technician template', () => {
      const herb = possibility('fixture-herbicide-injury', 0.9, [1]);
      expect(engine.settleItFor([herb], 'lawn')).toEqual({
        kind: 'technician', text: engine.TECHNICIAN_CONFIRM_TEXT,
      });
    });

    test('order 2: own signature, confirmable_by lab -> the fixed lab template — nematode is NEVER kind "photo"', () => {
      const nematode = possibility('fixture-nematode', 0.9, [1]);
      const settle = engine.settleItFor([nematode], 'lawn');
      expect(settle).toEqual({ kind: 'technician', text: engine.LAB_CONFIRM_TEXT });
      expect(settle.kind).not.toBe('photo');
    });

    test('order 3: no possibilities -> the subject\'s retake template', () => {
      expect(engine.settleItFor([], 'lawn')).toEqual({ kind: 'retake', text: engine.RETAKE_TEXT.lawn });
      expect(engine.settleItFor([], 'tree_shrub')).toEqual({ kind: 'retake', text: engine.RETAKE_TEXT.tree_shrub });
      expect(engine.settleItFor([], 'palm')).toEqual({ kind: 'retake', text: engine.RETAKE_TEXT.palm });
    });
  });

  // ── next_step_hint mapping (§6.6) ───────────────────────────────────────

  describe('next_step_hint', () => {
    test('no_cure + referral in the top 2 -> specialist, with the referral template', () => {
      const bronzing = possibility('fixture-lethal-bronzing', 0.9, [1]);
      const { hint, referral } = engine.nextStepHintFor([bronzing]);
      expect(hint).toEqual({ kind: 'specialist', text: engine.REFERRAL_TEMPLATES.arborist });
      expect(referral).toEqual({ kind: 'arborist', text: engine.REFERRAL_TEMPLATES.arborist });
    });

    test('herbicide-injury (inspection_first) -> inspection', () => {
      const herb = possibility('fixture-herbicide-injury', 0.9, [1]);
      expect(engine.nextStepHintFor([herb]).hint).toEqual({ kind: 'inspection', text: engine.NEXT_STEP_TEMPLATES.inspection });
    });

    test('cosmetic (watch/harmless, service.line none, action monitor) -> none', () => {
      const cosmetic = possibility('fixture-cosmetic-spot', 0.9, [1]);
      expect(engine.nextStepHintFor([cosmetic]).hint).toEqual({ kind: 'none', text: engine.NEXT_STEP_TEMPLATES.none });
    });

    test('fix_conditions action + service.line none -> fix_conditions, with the recovery_note', () => {
      const drought = possibility('fixture-drought', 0.9, [1]);
      expect(engine.nextStepHintFor([drought]).hint).toEqual({
        kind: 'fix_conditions', text: catalog.getEntry('fixture-drought').condition.recovery_note,
      });
    });

    test('no possibilities -> unclear', () => {
      expect(engine.nextStepHintFor([]).hint.kind).toBe('unclear');
    });
  });

  // ── identity (Layer A, §6.1) ────────────────────────────────────────────

  describe('identity', () => {
    function identityCand(slug, confidence, { verified = true, cuesVisible = [1], cuesNotVisible = [] } = {}) {
      return {
        slug, entry: catalog.getEntry(slug), confidence, verified, checked: verified, cuesVisible, cuesNotVisible, offCatalogName: null, groupId: catalog.getEntry(slug).group,
      };
    }

    test('resolveIdentityCandidate only matches within the slot\'s own index — an out-of-slot slug degrades to off-catalog (Codex pre-push P1 round 2)', () => {
      const turfOnlyIndex = [catalog.getEntry('fixture-st-augustine')];
      const resolved = engine.resolveIdentityCandidate({ slug: 'fixture-nutsedge', off_catalog_name: '', confidence: 0.9 }, turfOnlyIndex);
      expect(resolved.entry).toBeNull();
      expect(resolved.offCatalogName).toBe('fixture-nutsedge');
    });

    test('a disagreed identity slot is never named', () => {
      const named = engine.identityEntryLevelAnswer(identityCand('fixture-st-augustine', 0.95), { disagreed: true });
      expect(named).toBeNull();
    });

    test('an unanswered escalation trigger caps identity wording at likely, never pretty_sure', () => {
      const named = engine.identityEntryLevelAnswer(identityCand('fixture-st-augustine', 0.95), { blockPrettySure: true });
      expect(named.wording).toBe('likely');
    });

    test('account grass type wins over a photo guess for lawn subject.plant', () => {
      const built = engine.buildWorkup({
        subject: 'lawn',
        possibilities: [],
        turfCandidates: [identityCand('fixture-nutsedge', 0.99)], // wrong photo guess, ignored
        weedCandidates: [],
        hostCandidates: [],
        observedTerms: [],
        currentMonth: 6,
        chips: {},
        context: { grass_type_on_file: 'fixture_st_augustine' },
        photosCount: 1,
        quality: { usable: true, issue: 'none' },
      });
      expect(built.subject.plant).toEqual({
        slug: 'fixture-st-augustine', common_name: 'Fixture St. Augustine', scientific_name: 'Stenotaphrum fixturicus', source: 'account', wording: null,
      });
      expect(built.evidence.account).toEqual({ grass_type: 'fixture-st-augustine' });
    });

    test('no account fact -> subject.plant comes from the photo ladder', () => {
      const built = engine.buildWorkup({
        subject: 'lawn',
        possibilities: [],
        turfCandidates: [identityCand('fixture-st-augustine', 0.85)],
        weedCandidates: [],
        hostCandidates: [],
        observedTerms: [],
        currentMonth: 6,
        chips: {},
        context: {},
        photosCount: 1,
        quality: { usable: true, issue: 'none' },
      });
      expect(built.subject.plant).toMatchObject({ slug: 'fixture-st-augustine', source: 'photo', wording: 'pretty_sure' });
    });

    test('weeds are named alongside the turf identity, up to 2', () => {
      const built = engine.buildWorkup({
        subject: 'lawn',
        possibilities: [],
        turfCandidates: [identityCand('fixture-st-augustine', 0.85)],
        weedCandidates: [identityCand('fixture-nutsedge', 0.9)],
        hostCandidates: [],
        observedTerms: [],
        currentMonth: 6,
        chips: {},
        context: {},
        photosCount: 1,
        quality: { usable: true, issue: 'none' },
      });
      expect(built.subject.weeds).toHaveLength(1);
      expect(built.subject.weeds[0]).toMatchObject({ slug: 'fixture-nutsedge', common_name: 'Fixture Nutsedge', wording: 'pretty_sure' });
    });

    test('a weed answer never suppresses the condition workup', () => {
      const large = possibility('fixture-large-patch', 0.9, [1]);
      const built = engine.buildWorkup({
        subject: 'lawn',
        possibilities: [large],
        turfCandidates: [],
        weedCandidates: [identityCand('fixture-nutsedge', 0.9)],
        hostCandidates: [],
        observedTerms: [],
        currentMonth: 6,
        chips: {},
        context: {},
        photosCount: 1,
        quality: { usable: true, issue: 'none' },
      });
      expect(built.subject.weeds).toHaveLength(1);
      expect(built.answer.level).toBe('entry');
      expect(built.answer.node_id).toBe('fixture-large-patch');
    });

    test('tree_shrub/palm subject.plant comes from the host ladder', () => {
      const built = engine.buildWorkup({
        subject: 'tree_shrub',
        possibilities: [],
        turfCandidates: [],
        weedCandidates: [],
        hostCandidates: [identityCand('fixture-citrus', 0.85)],
        observedTerms: [],
        currentMonth: 6,
        chips: {},
        context: {},
        photosCount: 1,
        quality: { usable: true, issue: 'none' },
      });
      expect(built.subject.plant).toMatchObject({ slug: 'fixture-citrus', source: 'photo' });
    });
  });

  // ── symptom headline table (§6.3) ───────────────────────────────────────

  describe('symptom headline table', () => {
    const lawnTerms = ['browning', 'thinning', 'yellowing', 'spotting', 'wilting', 'dieback', 'weed_pressure', 'mushrooms'];
    const plantTerms = ['browning', 'thinning', 'yellowing', 'spotting', 'wilting', 'dieback', 'frond_discoloration', 'trunk_damage', 'mushrooms'];

    test.each(lawnTerms)('lawn / %s has a lawn-column headline', (term) => {
      expect(engine.symptomHeadlineFor(term, 'lawn')).toBe(engine.SYMPTOM_HEADLINES[term].lawn);
      expect(engine.symptomHeadlineFor(term, 'lawn')).not.toBe(engine.UNUSABLE_HEADLINE);
    });

    test.each(plantTerms)('tree_shrub / %s has a plant-column headline', (term) => {
      expect(engine.symptomHeadlineFor(term, 'tree_shrub')).toBe(engine.SYMPTOM_HEADLINES[term].plant);
      expect(engine.symptomHeadlineFor(term, 'tree_shrub')).not.toBe(engine.UNUSABLE_HEADLINE);
    });

    test('a term with no column for that subject falls back to the unusable headline', () => {
      expect(engine.symptomHeadlineFor('weed_pressure', 'palm')).toBe(engine.UNUSABLE_HEADLINE);
      expect(engine.symptomHeadlineFor('trunk_damage', 'lawn')).toBe(engine.UNUSABLE_HEADLINE);
    });

    test('no observed term at all -> the unusable headline', () => {
      const built = engine.buildWorkup({
        subject: 'lawn', possibilities: [], turfCandidates: [], weedCandidates: [], hostCandidates: [],
        observedTerms: [], currentMonth: 6, chips: {}, context: {}, photosCount: 1, quality: { usable: false, issue: 'blurry' },
      });
      expect(built.answer).toMatchObject({ level: 'symptom', headline: engine.UNUSABLE_HEADLINE, symptom: null });
    });
  });

  // ── string provenance (§8) ───────────────────────────────────────────────

  describe('string provenance', () => {
    test('every customer-visible string in a workup is a catalog field or a template constant', () => {
      const large = possibility('fixture-large-patch', 0.9, [1]);
      const chinch = possibility('fixture-chinch-bug', 0.5, [1]);
      const built = engine.buildWorkup({
        subject: 'lawn',
        possibilities: [large, chinch],
        turfCandidates: [{
          slug: 'fixture-st-augustine', entry: catalog.getEntry('fixture-st-augustine'), confidence: 0.85, verified: true, checked: true, cuesVisible: [1], cuesNotVisible: [],
        }],
        weedCandidates: [],
        hostCandidates: [],
        observedTerms: ['browning'],
        currentMonth: 1,
        chips: {},
        context: {},
        photosCount: 3,
        quality: { usable: true, issue: 'none' },
      });

      // Every catalog string this workup could possibly cite (both
      // possibilities' full field set) plus every entry's own name fields.
      const catalogStrings = new Set();
      for (const entry of [...conditionEntries(), ...pestEntries(), catalog.getEntry('fixture-st-augustine')]) {
        catalogStrings.add(entry.common_name);
        if (entry.scientific_name) catalogStrings.add(entry.scientific_name);
        if (entry.copy?.what_it_means) catalogStrings.add(entry.copy.what_it_means);
        if (entry.copy?.fact) catalogStrings.add(entry.copy.fact);
        for (const t of entry.traits || []) catalogStrings.add(t);
        if (entry.condition) {
          for (const t of entry.condition.signs || []) catalogStrings.add(t);
          for (const t of entry.condition.symptoms || []) catalogStrings.add(t);
          for (const t of entry.condition.required_signature?.elements || []) catalogStrings.add(t);
          if (entry.condition.required_signature?.text) catalogStrings.add(entry.condition.required_signature.text);
          if (entry.condition.recovery_note) catalogStrings.add(entry.condition.recovery_note);
          for (const ft of entry.condition.field_tests || []) { catalogStrings.add(ft.name); catalogStrings.add(ft.how); catalogStrings.add(ft.reads_as); }
          for (const d of entry.condition.differentials || []) { if (d.next_observation) catalogStrings.add(d.next_observation); }
        }
      }
      // Fixed templates this module owns.
      const templateStrings = new Set([
        ...Object.values(engine.RETAKE_TEXT),
        engine.TECHNICIAN_CONFIRM_TEXT,
        engine.LAB_CONFIRM_TEXT,
        ...Object.values(engine.REFERRAL_TEMPLATES),
        ...Object.values(engine.NEXT_STEP_TEMPLATES),
        ...Object.values(engine.SYMPTOM_HEADLINES).flatMap((row) => Object.values(row)),
        engine.UNUSABLE_HEADLINE,
      ]);
      // Headlines are `${template}: ${common_name}` — derived, not a bare
      // member of either set, so allow that one constructed pattern.
      const isHeadlinePattern = (s) => /^(We're pretty sure|Likely): .+$/.test(s);

      function walk(value, path) {
        if (value === null || value === undefined) return;
        if (path === 'v2.catalog_version') return; // a version stamp, not customer prose
        if (typeof value === 'string') {
          const ok = catalogStrings.has(value) || templateStrings.has(value) || isHeadlinePattern(value)
            // enum-like fields (kind/verdict/action/outcome/symptom term/slug/source/wording) are catalog
            // vocabulary, not free customer prose — never model output either way.
            || /^[a-z0-9_-]+$/.test(value);
          if (!ok) throw new Error(`Unprovenanced string at ${path}: ${JSON.stringify(value)}`);
          return;
        }
        if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
        if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`); }
      }
      expect(() => walk(built, 'v2')).not.toThrow();
    });
  });

  // ── orchestration (§5) ───────────────────────────────────────────────────

  describe('identifyPlantV2 orchestration', () => {
    test('no_photos', async () => {
      const result = await engine.identifyPlantV2({ photos: [], subject: 'lawn' });
      expect(result).toEqual({ ok: false, reason: 'no_photos' });
    });

    test('invalid_subject', async () => {
      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'bogus' });
      expect(result).toEqual({ ok: false, reason: 'invalid_subject' });
    });

    test('Ajv schema rejection counts as a miss (candidates call returns a shape that fails the schema)', async () => {
      dispatch.mockResolvedValueOnce({ ok: true, json: { turf: 'not-an-array' }, model: 'gemini-3.8-flash-test' }); // fails CANDIDATES_A_SCHEMA
      dispatch.mockResolvedValueOnce({ ok: false, reason: 'provider_error' }); // conditions call also misses
      dispatch.mockResolvedValueOnce({ // escalation (triggered by gemini_missed) answers validly, so the workup isn't fully unavailable
        ok: true,
        json: {
          quality: { usable: true, issue: 'none' }, shows: 'nothing', turf: [], weeds: [], host: [], observed_terms: [], conditions: [],
        },
      });
      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_reasons).toContain('gemini_missed');
      expect(result.v2.answer.level).not.toBe('entry');
    });

    test('vision_unavailable when every leg misses', async () => {
      dispatch.mockResolvedValue({ ok: false, reason: 'provider_error' });
      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'lawn' });
      expect(result).toEqual({ ok: false, reason: 'vision_unavailable' });
    });

    test('different-outcome-classes escalation trigger fires when the top two Gemini possibilities split outcome class', async () => {
      // Call A (identity candidates): nothing found.
      dispatch.mockResolvedValueOnce({ ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'damage', turf: [], weeds: [], host: [] } });
      // Call C (conditions): top two split outcome class (bronzing no_cure vs potassium manageable).
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: { usable: true, issue: 'none' },
          observed_terms: ['browning'],
          candidates: [
            { slug: 'fixture-lethal-bronzing', confidence: 0.7, elements_visible: [1], signs_visible: [], symptoms_visible: [] },
            { slug: 'fixture-potassium-deficiency-palm', confidence: 0.6, elements_visible: [1, 2], signs_visible: [], symptoms_visible: [] },
          ],
        },
      });
      // Call D (escalation): OpenAI unavailable.
      dispatch.mockResolvedValueOnce({ ok: false, reason: 'provider_error' });

      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'palm' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_triggered).toBe(true);
      expect(result.internal.escalation_reasons).toContain('different_outcome_classes');
      expect(dispatch).toHaveBeenCalledTimes(3); // candidates, conditions, escalation — no verify (no catalog identity candidate)
    });

    test('three higher-confidence weeds do not wipe out the turf identity — each identity slot is deduped separately (Codex pre-push P1)', async () => {
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: { usable: true, issue: 'none' },
          shows: 'plant',
          turf: [{ slug: 'fixture-st-augustine', off_catalog_name: '', confidence: 0.6 }],
          weeds: [
            { slug: '', off_catalog_name: 'Weed A', confidence: 0.95 },
            { slug: '', off_catalog_name: 'Weed B', confidence: 0.9 },
            { slug: '', off_catalog_name: 'Weed C', confidence: 0.85 },
          ],
          host: [],
        },
      });
      dispatch.mockResolvedValue({ ok: false, reason: 'provider_error' }); // every later leg misses

      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'lawn' });
      expect(result.ok).toBe(true);
      // The turf candidate must have survived being combined with 3
      // higher-confidence weed candidates before the old code's shared,
      // capped-at-3 dedupe ran.
      expect(result.v2.subject.plant).toMatchObject({ slug: 'fixture-st-augustine', source: 'photo' });
    });

    test('a schema-invalid identity verify response is treated as a miss, not consumed (Codex pre-push P1)', async () => {
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: { usable: true, issue: 'none' }, shows: 'plant', turf: [{ slug: 'fixture-st-augustine', off_catalog_name: '', confidence: 0.6 }], weeds: [], host: [],
        },
      });
      // Malformed verify response: `candidates` items missing the required
      // cues_visible/cues_not_visible arrays entirely — must not be
      // consumed as if it verified anything.
      dispatch.mockResolvedValueOnce({ ok: true, json: { candidates: [{ slug: 'fixture-st-augustine', confidence: 0.99 }] } });
      dispatch.mockResolvedValue({ ok: false, reason: 'provider_error' }); // conditions, escalation

      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_reasons).toContain('gemini_missed');
      // The bogus 0.99 must not have been consumed — an unverified 0.6
      // reads "likely" at best, never "pretty_sure".
      expect(result.v2.subject.plant.wording).not.toBe('pretty_sure');
    });

    test('an unusable-photo read from the CONDITIONS leg alone still gates naming, even when the candidates leg read usable (Codex pre-push P1 round 2)', async () => {
      dispatch.mockResolvedValueOnce({
        ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'damage', turf: [], weeds: [], host: [] },
      });
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: { usable: false, issue: 'blurry' },
          observed_terms: ['browning'],
          candidates: [{ slug: 'fixture-large-patch', confidence: 0.9, elements_visible: [1], signs_visible: [1, 2], symptoms_visible: [1] }],
        },
      });
      dispatch.mockResolvedValue({ ok: false, reason: 'provider_error' });

      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(result.v2.quality.usable).toBe(false);
      expect(result.v2.answer.level).toBe('symptom');
      expect(result.v2.answer.headline).toBe(engine.UNUSABLE_HEADLINE);
      expect(result.v2.tier).toBe('needs_more_evidence');
      expect(result.v2.next_step_hint.kind).toBe('unclear');
    });

    test('conditions disagreement (Gemini and OpenAI name different top possibilities) forces the symptom fallback, never a named answer (Codex pre-push P1 round 2)', async () => {
      dispatch.mockResolvedValueOnce({
        ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'damage', turf: [], weeds: [], host: [] },
      });
      // Gemini: low confidence on large-patch -> triggers escalation.
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: { usable: true, issue: 'none' },
          observed_terms: ['browning'],
          candidates: [{ slug: 'fixture-large-patch', confidence: 0.6, elements_visible: [1], signs_visible: [], symptoms_visible: [] }],
        },
      });
      // OpenAI escalation: names a DIFFERENT top possibility.
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: { usable: true, issue: 'none' },
          shows: 'damage',
          turf: [],
          weeds: [],
          host: [],
          observed_terms: ['browning'],
          conditions: [{ slug: 'fixture-cosmetic-spot', confidence: 0.85, elements_visible: [1], signs_visible: [1], symptoms_visible: [] }],
        },
      });

      const result = await engine.identifyPlantV2({ photos: [{ data: 'x', mimeType: 'image/jpeg' }], subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(result.v2.answer.level).toBe('symptom');
      expect(result.v2.tier).toBe('needs_more_evidence');
    });
  });
});

describe('plant-engine — real catalog', () => {
  let catalog; let engine;

  beforeAll(() => {
    catalog = require('../services/species-catalog');
    engine = require('../services/photo-id-v2/plant-engine');
  });

  test('identity index: palm subject includes sago-palm', () => {
    const slugs = engine.identityIndexFor('palm').map((e) => e.slug);
    expect(slugs).toContain('sago-palm');
  });

  test('identity index: lawn subject includes turfgrasses and weed groups', () => {
    const slugs = engine.identityIndexFor('lawn').map((e) => e.slug);
    expect(slugs).toContain('st-augustinegrass');
    expect(slugs).toContain('purple-nutsedge'); // sedge
    expect(slugs).toContain('crabgrass'); // grassy weed
    expect(slugs).toContain('dollarweed'); // broadleaf weed
  });

  test('conditionIndexFor(lawn, st-augustinegrass): today\'s all-draft CONDITION content never enters the index, but owner-approved lawn pest possibilities do', () => {
    const index = engine.conditionIndexFor('lawn', 'st-augustinegrass');
    const conditionSlugsInIndex = index.filter((e) => e.condition).map((e) => e.slug);
    expect(conditionSlugsInIndex).toEqual([]); // every real condition entry is still a draft
    expect(index.map((e) => e.slug)).toContain('chinch-bug'); // approved pest possibility
    for (const entry of index) expect(catalog.isApproved(entry)).toBe(true);
  });

  test('naming gate walk over every real condition entry: with every element visible at 0.9 confidence, only confirmable_by "photo" entries would even be ELIGIBLE, and none are named because none are approved yet', () => {
    const conditions = catalog.listEntries({ section: 'condition' });
    expect(conditions.length).toBeGreaterThan(0);
    let sawPhotoConfirmable = false;
    for (const entry of conditions) {
      const sig = engine.signatureFor(entry);
      const elementsVisible = entry.condition.required_signature.elements.map((_, i) => i + 1);
      const possibility = { slug: entry.slug, entry, sig, confidence: 0.9, elementsVisible: new Set(elementsVisible), signsVisible: new Set(), symptomsVisible: new Set() };
      if (sig.confirmableBy === 'photo') sawPhotoConfirmable = true;
      // Never named today: the real catalog is all drafts.
      expect(engine.namedAnswerFor([possibility], possibility)).toBeNull();
      expect(catalog.isApproved(entry)).toBe(false);
    }
    expect(sawPhotoConfirmable).toBe(true); // the gate's photo-confirmable path is real content, not vacuous
  });

  test('one element missing on an otherwise-eligible real condition entry -> not named (structural check, independent of approval)', () => {
    const photoConfirmable = catalog.listEntries({ section: 'condition' })
      .find((e) => e.condition.required_signature.confirmable_by === 'photo' && e.condition.required_signature.elements.length >= 1);
    expect(photoConfirmable).toBeTruthy();
    const sig = engine.signatureFor(photoConfirmable);
    const possibility = {
      slug: photoConfirmable.slug, entry: photoConfirmable, sig, confidence: 0.99, elementsVisible: new Set(), signsVisible: new Set(), symptomsVisible: new Set(),
    };
    expect(engine.passesOwnSignatureGate(possibility)).toBe(false);
  });

  test('hard cap over the real catalog: every turf-diseases entry, every disorder, and drought-irrigation-stress are hard-capped', () => {
    for (const entry of catalog.listEntries({ section: 'condition' })) {
      const sig = engine.signatureFor(entry);
      const shouldCap = entry.group === 'turf-diseases' || entry.kind === 'disorder' || entry.slug === 'drought-irrigation-stress';
      if (shouldCap) expect(engine.isHardCapped(entry, sig)).toBe(true);
    }
    for (const entry of catalog.listEntries({ section: 'pest' }).filter((e) => e.service?.line === 'lawn')) {
      expect(engine.isHardCapped(entry, engine.signatureFor(entry))).toBe(true);
    }
  });

  test('a real-catalog lawn workup is symptom-only with zero possibilities today (every condition entry is a draft)', () => {
    const built = engine.buildWorkup({
      subject: 'lawn',
      // Simulate Call C selecting every real condition entry that hosts turf,
      // fully confident and fully visible — even so, none are approved.
      possibilities: catalog.listEntries({ section: 'condition' })
        .filter((e) => (e.condition.hosts || []).includes('turf'))
        .map((entry) => {
          const sig = engine.signatureFor(entry);
          const elementsVisible = entry.condition.required_signature.elements.map((_, i) => i + 1);
          return {
            slug: entry.slug, entry, sig, confidence: 0.95, elementsVisible: new Set(elementsVisible), signsVisible: new Set(), symptomsVisible: new Set(),
          };
        }),
      turfCandidates: [],
      weedCandidates: [],
      hostCandidates: [],
      observedTerms: ['browning'],
      currentMonth: 1,
      chips: {},
      context: {},
      photosCount: 3,
      quality: { usable: true, issue: 'none' },
    });
    expect(built.possibilities).toEqual([]);
    expect(built.answer).toMatchObject({ level: 'symptom', headline: 'Brown patches in the lawn' });
    expect(built.tier).toBe('needs_more_evidence');
  });

  test('headline table covers every OBSERVED_TERMS entry for both lawn and plant, or explicitly has no column', () => {
    for (const term of engine.OBSERVED_TERMS) {
      expect(engine.SYMPTOM_HEADLINES).toHaveProperty(term);
      const row = engine.SYMPTOM_HEADLINES[term];
      expect('lawn' in row).toBe(true);
      expect('plant' in row).toBe(true);
    }
  });
});
