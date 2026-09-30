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
        plantIdVision: {
          name: 'plantIdVision',
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
      expect(built.subject.plant).toMatchObject({
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
          turf: [{ slug: 'fixture-st-augustine', off_catalog_name: '', group_id: null, confidence: 0.6 }],
          weeds: [
            { slug: '', off_catalog_name: 'Weed A', group_id: null, confidence: 0.95 },
            { slug: '', off_catalog_name: 'Weed B', group_id: null, confidence: 0.9 },
            { slug: '', off_catalog_name: 'Weed C', group_id: null, confidence: 0.85 },
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
          quality: { usable: true, issue: 'none' }, shows: 'plant', turf: [{ slug: 'fixture-st-augustine', off_catalog_name: '', group_id: null, confidence: 0.6 }], weeds: [], host: [],
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
  // ── Codex #5186 round 1 regressions (one or more per finding) ─────────────

  describe('Codex #5186 round 1 regressions', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const MISS = { ok: false, reason: 'provider_error' };
    const idItem = (slug, confidence, extra = {}) => ({
      slug, off_catalog_name: '', group_id: null, confidence, ...extra,
    });
    const escIdItem = (slug, confidence, cuesVisible = [1], extra = {}) => ({ ...idItem(slug, confidence, extra), cues_visible: cuesVisible, cues_not_visible: [] });
    const condItem = ([slug, confidence, elementsVisible = [1]]) => ({
      slug, confidence, elements_visible: elementsVisible, signs_visible: [], symptoms_visible: [],
    });
    const candidatesLeg = ({
      shows = 'plant', quality = OK_QUALITY, turf = [], weeds = [], host = [],
    } = {}) => ({
      ok: true,
      json: {
        quality, shows, turf, weeds, host,
      },
    });
    const verifyLeg = (items) => ({
      ok: true,
      json: {
        candidates: items.map(([slug, confidence, cuesVisible = [1], cuesNotVisible = []]) => ({
          slug, confidence, cues_visible: cuesVisible, cues_not_visible: cuesNotVisible,
        })),
      },
    });
    const conditionsLeg = (items, { observed = ['browning'], quality = OK_QUALITY } = {}) => ({
      ok: true, json: { quality, observed_terms: observed, candidates: items.map(condItem) },
    });
    const escalationLeg = ({
      shows = 'plant', quality = OK_QUALITY, turf = [], weeds = [], host = [], conditions = [], observed = [],
    } = {}) => ({
      ok: true,
      json: {
        quality, shows, turf, weeds, host, observed_terms: observed, conditions: conditions.map(condItem),
      },
    });
    const queue = (...legs) => legs.forEach((leg) => dispatch.mockResolvedValueOnce(leg));
    const systemPromptOfCall = (n) => dispatch.mock.calls[n][1].system;
    const cand = (slug, confidence, extra = {}) => ({
      slug, entry: catalog.getEntry(slug), confidence, verified: true, checked: true, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: catalog.getEntry(slug).group, ...extra,
    });

    test('finding 1: a cue cited as both visible and not visible, or out of range, is dropped before `verified` is computed', () => {
      const turfIndex = engine.turfIndexFor();
      const raw = engine.resolveIdentityCandidate(idItem('fixture-st-augustine', 0.5), turfIndex);
      const [merged] = engine.mergeIdentityVerify([raw], {
        candidates: [{
          slug: 'fixture-st-augustine', confidence: 0.95, cues_visible: [1, 9], cues_not_visible: [1],
        }],
      });
      expect(merged).toMatchObject({
        checked: true, verified: false, cuesVisible: [], cuesNotVisible: [],
      });
      // No clean visible cue -> never pretty_sure, whatever the score.
      expect(engine.identityEntryLevelAnswer(merged).wording).toBe('likely');
    });

    describe('finding 2: escalation agreement only promotes a confidence whose cue check passed', () => {
      const geminiVerifiedAt60 = () => engine.mergeIdentityVerify(
        [engine.resolveIdentityCandidate(idItem('fixture-st-augustine', 0.5), engine.turfIndexFor())],
        {
          candidates: [{
            slug: 'fixture-st-augustine', confidence: 0.6, cues_visible: [1], cues_not_visible: [],
          }],
        },
      );
      const inContext = new Set(['fixture-st-augustine']);

      test('OpenAI 0.95 with no visible cue does not lift a verified 0.60', () => {
        const combined = engine._test.combineIdentity(geminiVerifiedAt60(), [escIdItem('fixture-st-augustine', 0.95, [])], engine.turfIndexFor(), inContext);
        expect(combined.disagreed).toBe(false);
        expect(combined.candidates[0]).toMatchObject({ confidence: 0.6, verified: true });
        expect(engine.identityEntryLevelAnswer(combined.candidates[0]).wording).toBe('likely');
      });

      test('OpenAI cue citations for a slug it was never given a numbered list for are not a check', () => {
        const combined = engine._test.combineIdentity(geminiVerifiedAt60(), [escIdItem('fixture-st-augustine', 0.95, [1])], engine.turfIndexFor(), new Set());
        expect(combined.candidates[0]).toMatchObject({ confidence: 0.6, verified: true });
      });

      test('two passed cue checks -> the higher, with its own provenance', () => {
        const combined = engine._test.combineIdentity(geminiVerifiedAt60(), [escIdItem('fixture-st-augustine', 0.95, [2])], engine.turfIndexFor(), inContext);
        expect(combined.candidates[0]).toMatchObject({ confidence: 0.95, verified: true, cuesVisible: [2] });
        expect(engine.identityEntryLevelAnswer(combined.candidates[0]).wording).toBe('pretty_sure');
      });
    });

    test.each([
      ['an empty candidates list', { ok: true, json: { candidates: [] } }],
      ['a list that omits the turf candidate', verifyLeg([['fixture-nutsedge', 0.9]])],
    ])('finding 3: a verify leg returning %s is a miss (escalates) and the uncovered candidate is never named', async (_label, verify) => {
      queue(
        candidatesLeg({ turf: [idItem('fixture-st-augustine', 0.85)], weeds: [idItem('fixture-nutsedge', 0.9)] }),
        verify,
        conditionsLeg([['fixture-large-patch', 0.9]]),
        MISS,
      );
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(result.internal.escalation_reasons).toContain('gemini_missed');
      expect(result.internal.identity.trigger_reasons).toContain('gemini_missed');
      expect(result.v2.subject.plant).toBeNull();
    });

    describe('finding 4: the providers\' `shows` reads gate naming', () => {
      test('`shows: nothing` makes the workup unusable even with a high-confidence candidate', async () => {
        queue(candidatesLeg({ shows: 'nothing', turf: [idItem('fixture-st-augustine', 0.95)] }));
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
        // Call A's `nothing` is final (combineQuality), so the ladder stops there (Codex #5186 r6 P2).
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(result.v2.quality).toMatchObject({ usable: false, shows: 'nothing' });
        expect(result.v2.answer).toMatchObject({ level: 'symptom', headline: engine.UNUSABLE_HEADLINE });
        expect(result.v2.subject.plant).toBeNull();
        expect(result.v2.tier).toBe('needs_more_evidence');
      });

      test('`shows: nothing` in identify mode -> unknown answer', async () => {
        queue(candidatesLeg({ shows: 'nothing', turf: [idItem('fixture-st-augustine', 0.95)] }));
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
        expect(result.v2.answer.level).toBe('unknown');
        expect(result.v2.entry).toBeNull();
        expect(result.v2.tier).toBe('needs_more_evidence');
      });

      const conflictRun = (openaiShows) => {
        queue(
          candidatesLeg({ shows: 'plant', turf: [idItem('fixture-st-augustine', 0.95)] }),
          verifyLeg([['fixture-st-augustine', 0.95]]),
          conditionsLeg([['fixture-large-patch', 0.7]]), // low confidence -> escalation
          escalationLeg({ shows: openaiShows, turf: [escIdItem('fixture-st-augustine', 0.95)], conditions: [['fixture-large-patch', 0.9]] }),
        );
        return engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      };

      test('Gemini `plant` vs OpenAI `damage` -> nothing named, symptom workup kept', async () => {
        const result = await conflictRun('damage');
        expect(result.v2.quality.shows).toBe('conflicting');
        expect(result.v2.answer).toMatchObject({ level: 'symptom', headline: 'Brown patches in the lawn' });
        expect(result.v2.subject.plant).toBeNull();
        expect(result.v2.tier).toBe('needs_more_evidence');
      });

      test('`both` is compatible with either read -> the same agreed run still names', async () => {
        const result = await conflictRun('both');
        expect(result.v2.quality.shows).toBe('plant');
        expect(result.v2.answer).toMatchObject({ level: 'entry', node_id: 'fixture-large-patch' });
        expect(result.v2.subject.plant).toMatchObject({ slug: 'fixture-st-augustine', wording: 'pretty_sure' });
      });
    });

    test('finding 5: identify mode applies the unusable-photo gate (no pretty_sure/likely, retake prompt)', async () => {
      queue(
        candidatesLeg({ quality: { usable: false, issue: 'blurry' }, host: [idItem('fixture-citrus', 0.95)] }),
        verifyLeg([['fixture-citrus', 0.95]]),
      );
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub', mode: 'identify' });
      expect(result.v2.quality.usable).toBe(false);
      expect(result.v2.answer).toMatchObject({ level: 'unknown', headline: engine.UNUSABLE_HEADLINE });
      expect(result.v2.entry).toBeNull();
      expect(result.v2.tier).toBe('needs_more_evidence');
      expect(result.v2.next_photo.ask).toBe(engine.RETAKE_TEXT.tree_shrub);
    });

    describe('finding 7: the next-photo request is derived from the chosen answer', () => {
      test('a group-level answer asks about a pair that supports that group, not the global top\'s look-alike', () => {
        const built = engine.buildIdentityResult(
          [cand('fixture-citrus', 0.45), cand('fixture-queen-palm', 0.35), cand('fixture-royal-palm', 0.3)],
          { subject: 'tree_shrub', currentMonth: 6 },
        );
        expect(built.answer).toMatchObject({ level: 'group', node_id: 'palms', headline: 'Looks like a palm' });
        expect(built.next_photo.ask).toBe('A photo of the trunk just below the fronds.');
      });

      test('a disagreement asks about the two providers\' own tops', () => {
        const queen = cand('fixture-queen-palm', 0.7);
        const royal = cand('fixture-royal-palm', 0.65);
        const built = engine.buildIdentityResult([queen, royal], {
          subject: 'palm', currentMonth: 6, disagreed: true, disagreementPair: [queen, royal],
        });
        expect(built.answer.level).not.toBe('entry');
        expect(built.next_photo.ask).toBe('A photo of the trunk just below the fronds.');
      });
    });

    describe('finding 8: the tree/shrub/palm condition index follows the host candidates', () => {
      test('built from the union of viable hosts, so an OpenAI host correction inside it needs no extra call', async () => {
        queue(
          candidatesLeg({ host: [idItem('fixture-sago-palm', 0.6), idItem('fixture-citrus', 0.3)] }),
          verifyLeg([['fixture-sago-palm', 0.6], ['fixture-citrus', 0.3]]),
          conditionsLeg([['fixture-herbicide-injury', 0.5]]),
          escalationLeg({ host: [escIdItem('fixture-citrus', 0.9)], conditions: [['fixture-citrus-greening', 0.6]] }),
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub' });
        expect(dispatch).toHaveBeenCalledTimes(4);
        expect(systemPromptOfCall(2)).toContain('fixture-citrus-greening');
        expect(systemPromptOfCall(2)).toContain('fixture-manganese-deficiency-palm');
        expect(result.v2.possibilities.map((p) => p.slug)).toContain('fixture-citrus-greening');
        expect(result.internal.conditions.host_union).toEqual(['fixture-sago-palm', 'fixture-citrus']);
        expect(result.internal.conditions.corrected_host).toBeNull();
      });

      const outsideUnionLegs = () => [
        candidatesLeg({ host: [idItem('fixture-sago-palm', 0.9)] }),
        verifyLeg([['fixture-sago-palm', 0.6]]),
        conditionsLeg([['fixture-manganese-deficiency-palm', 0.5]]),
        escalationLeg({ host: [escIdItem('fixture-citrus', 0.9)], conditions: [['fixture-herbicide-injury', 0.4]] }),
      ];

      test('a corrected host outside the union gets exactly one more Call C for that host', async () => {
        queue(...outsideUnionLegs(), conditionsLeg([['fixture-citrus-greening', 0.7]]));
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub' });
        expect(dispatch).toHaveBeenCalledTimes(5);
        expect(systemPromptOfCall(2)).not.toContain('fixture-citrus-greening');
        expect(systemPromptOfCall(4)).toContain('fixture-citrus-greening');
        expect(result.v2.possibilities.map((p) => p.slug)).toContain('fixture-citrus-greening');
        expect(result.internal.conditions.corrected_host).toBe('fixture-citrus');
        expect(result.internal.models.condition_rerun).toMatchObject({ ok: true });
      });

      test('no budget left for the extra call -> falls back to the class index (host-specific conditions dropped)', async () => {
        const saved = process.env.PHOTO_ID_V2_TIMEOUT_MS;
        process.env.PHOTO_ID_V2_TIMEOUT_MS = '1';
        try {
          queue(...outsideUnionLegs());
          const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub' });
          expect(dispatch).toHaveBeenCalledTimes(4);
          const classSlugs = engine.conditionIndexFor('tree_shrub', null).map((e) => e.slug);
          const slugs = result.v2.possibilities.map((p) => p.slug);
          expect(slugs).not.toContain('fixture-manganese-deficiency-palm');
          for (const slug of slugs) expect(classSlugs).toContain(slug);
          expect(result.internal.models.condition_rerun).toBeNull();
        } finally {
          if (saved === undefined) delete process.env.PHOTO_ID_V2_TIMEOUT_MS;
          else process.env.PHOTO_ID_V2_TIMEOUT_MS = saved;
        }
      });
    });

    describe('findings 9 and 10: identify mode on a lawn picks the populated lane and returns its evidence', () => {
      test('weeds-only lawn photo -> the weed identity, with matches evidence', async () => {
        queue(
          candidatesLeg({ weeds: [idItem('fixture-nutsedge', 0.9)] }),
          verifyLeg([['fixture-nutsedge', 0.9]]),
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
        expect(result.v2.answer).toMatchObject({ level: 'entry', node_id: 'fixture-nutsedge', wording: 'pretty_sure' });
        expect(result.internal.identity.lane).toBe('weeds');
        expect(result.v2.evidence).toEqual({ matches: ['Triangular stem cross-section'], still_need: [] });
      });

      test('both lanes populated -> the higher verified top confidence (turf on a tie)', () => {
        const { identifyLaneFor } = engine._test;
        expect(identifyLaneFor('lawn', { turf: [cand('fixture-st-augustine', 0.6)], weeds: [cand('fixture-nutsedge', 0.9)], host: [] })).toBe('weeds');
        expect(identifyLaneFor('lawn', { turf: [cand('fixture-st-augustine', 0.9)], weeds: [cand('fixture-nutsedge', 0.6)], host: [] })).toBe('turf');
        expect(identifyLaneFor('lawn', { turf: [cand('fixture-st-augustine', 0.8)], weeds: [cand('fixture-nutsedge', 0.8)], host: [] })).toBe('turf');
        expect(identifyLaneFor('palm', { turf: [], weeds: [], host: [] })).toBe('host');
      });
    });

    test('finding 11: internal reports the condition combiner\'s disagreement and OpenAI answer', async () => {
      queue(
        candidatesLeg({ shows: 'damage' }),
        conditionsLeg([['fixture-large-patch', 0.6]]),
        escalationLeg({ shows: 'damage', conditions: [['fixture-cosmetic-spot', 0.85]] }),
      );
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.internal.disagreed).toBe(true);
      expect(result.internal.openai_answered).toBe(true);
      expect(result.internal.conditions).toMatchObject({ disagreed: true, openai_answered: true, trigger_reasons: ['low_confidence'] });
      expect(result.internal.identity.turf).toEqual({ disagreed: false, openai_answered: false });
    });

    describe('finding 12: off-catalog identities carry a validated plant group', () => {
      test('group_id is kept only for a plant-section group of the slot\'s own index', () => {
        const palmIndex = engine.hostIndexFor('palm');
        const resolve = (groupId) => engine.resolveIdentityCandidate(idItem('', 0.7, { off_catalog_name: 'Foxtail palm', group_id: groupId }), palmIndex).groupId;
        expect(resolve('palms')).toBe('palms');
        expect(resolve('turfgrasses')).toBeNull(); // plant section, but not this slot's index
        expect(resolve('palm-diseases')).toBeNull(); // condition section
        expect(resolve('no-such-group')).toBeNull();
        expect(resolve(null)).toBeNull();
      });

      test('two providers agreeing on an off-catalog palm climb to the group generic', async () => {
        const foxtail = { off_catalog_name: 'Foxtail palm', group_id: 'palms' };
        queue(
          candidatesLeg({ host: [idItem('', 0.7, foxtail), idItem('fixture-queen-palm', 0.1)] }),
          verifyLeg([['fixture-queen-palm', 0.1]]),
          escalationLeg({ host: [escIdItem('', 0.75, [], foxtail)] }),
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'palm', mode: 'identify' });
        expect(result.internal.identity.host.disagreed).toBe(false);
        expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'palms', headline: 'Looks like a palm' });
      });
    });

    test('finding 13: each provider\'s conditions are ranked before the agreement check', () => {
      const index = [...conditionEntries(), ...pestEntries()];
      const openaiOutOfOrder = [condItem(['fixture-large-patch', 0.5]), condItem(['fixture-cosmetic-spot', 0.9])];
      const { combinePossibilities } = engine._test;
      expect(combinePossibilities([possibility('fixture-large-patch', 0.8, [1])], openaiOutOfOrder, index).disagreed).toBe(true);
      const agreed = combinePossibilities([possibility('fixture-cosmetic-spot', 0.8, [1])], openaiOutOfOrder, index);
      expect(agreed.disagreed).toBe(false);
      expect(agreed.possibilities[0].slug).toBe('fixture-cosmetic-spot');
    });

    describe('pre-push audit on round 1 fixes', () => {
      test('a disagreement resolves to the two providers\' deepest shared node, not a group only one of them supports', () => {
        const queen = cand('fixture-queen-palm', 0.7);
        const citrus = cand('fixture-citrus', 0.65);
        const built = engine.buildIdentityResult([queen, citrus], {
          subject: 'tree_shrub', currentMonth: 6, disagreed: true, disagreementPair: [queen, citrus],
        });
        expect(built.answer).toMatchObject({ level: 'category', node_id: 'plant', headline: 'Looks like a plant' });
      });

      test('low confidence is checked per populated slot: a confident weed does not suppress escalation for an uncertain turf', async () => {
        queue(
          candidatesLeg({ turf: [idItem('fixture-st-augustine', 0.6)], weeds: [idItem('fixture-nutsedge', 0.95)] }),
          verifyLeg([['fixture-st-augustine', 0.6], ['fixture-nutsedge', 0.95]]),
          conditionsLeg([['fixture-large-patch', 0.9]]),
          MISS,
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
        expect(dispatch).toHaveBeenCalledTimes(4);
        expect(result.internal.identity.trigger_reasons).toEqual(['low_confidence']);
        expect(result.v2.subject.plant).toMatchObject({ slug: 'fixture-st-augustine', wording: 'likely' });
      });

      test('an account turf whose catalog entry is not owner-approved is never shown by name, and still outranks a photo guess', () => {
        const built = engine.buildWorkup({
          subject: 'lawn',
          possibilities: [],
          turfCandidates: [cand('fixture-st-augustine', 0.9)],
          weedCandidates: [],
          hostCandidates: [],
          observedTerms: [],
          currentMonth: 6,
          chips: {},
          context: { grass_type_on_file: 'fixture-zoysia-draft' },
          photosCount: 1,
          quality: OK_QUALITY,
        });
        expect(built.subject.plant).toBeNull();
        // Nor by slug in the evidence echo (Codex #5186 r8 P2).
        expect(built.evidence.account).toEqual({});
      });

      test('an inspection-required possibility ranked 3rd still routes inspection (contract §6.6 "any possibility")', () => {
        const ranked = [possibility('fixture-cosmetic-spot', 0.9, [1]), possibility('fixture-drought', 0.5, [1]), possibility('fixture-herbicide-injury', 0.3, [1])];
        expect(engine.nextStepHintFor(ranked).hint).toEqual({ kind: 'inspection', text: engine.NEXT_STEP_TEMPLATES.inspection });
      });

      test('after a host re-run, OpenAI\'s conditions are read against the index it was shown, not the expanded one', async () => {
        queue(
          candidatesLeg({ host: [idItem('fixture-sago-palm', 0.9)] }),
          verifyLeg([['fixture-sago-palm', 0.6]]),
          conditionsLeg([['fixture-manganese-deficiency-palm', 0.5]]),
          // OpenAI names a condition that was NOT in its index, with element citations.
          escalationLeg({ host: [escIdItem('fixture-citrus', 0.9)], conditions: [['fixture-citrus-greening', 0.9, [1]]] }),
          // The re-run (which did list it) sees it weakly, with no element visible.
          conditionsLeg([['fixture-citrus-greening', 0.5, []]]),
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub' });
        expect(dispatch).toHaveBeenCalledTimes(5);
        const greening = result.v2.possibilities.find((p) => p.slug === 'fixture-citrus-greening');
        expect(greening).toMatchObject({ strength: 'possible', fits: [] });
      });

      test('identity evidence comes from the candidates that support the chosen answer', () => {
        const built = engine.buildIdentityResult(
          [cand('fixture-citrus', 0.45), cand('fixture-queen-palm', 0.35), cand('fixture-royal-palm', 0.3)],
          { subject: 'tree_shrub', currentMonth: 6 },
        );
        expect(built.answer.node_id).toBe('palms');
        expect(built.evidence.matches).toEqual(['Plumose drooping leaflets']);
      });

      test('a catalog top verified down below an off-catalog candidate is a self-contradiction', async () => {
        queue(
          candidatesLeg({ host: [idItem('fixture-citrus', 0.9), idItem('', 0.85, { off_catalog_name: 'Foxtail palm', group_id: 'palms' })] }),
          verifyLeg([['fixture-citrus', 0.1]]),
          MISS,
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub', mode: 'identify' });
        expect(dispatch).toHaveBeenCalledTimes(3);
        expect(result.internal.escalation_reasons).toEqual(['self_contradiction']);
      });

      test('a repeated condition slug is deduped before the top-two reads (escalation, display, referral)', async () => {
        queue(
          candidatesLeg({ shows: 'damage' }),
          conditionsLeg([
            ['fixture-palm-leaf-spot', 0.9], ['fixture-palm-leaf-spot', 0.9], ['fixture-palm-leaf-spot', 0.85], ['fixture-lethal-bronzing', 0.5],
          ]),
          MISS,
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'palm' });
        expect(result.internal.escalation_reasons).toEqual(['different_outcome_classes']);
        expect(result.v2.possibilities.map((p) => p.slug)).toEqual(['fixture-palm-leaf-spot', 'fixture-lethal-bronzing']);
        expect(result.v2.next_step_hint.kind).toBe('specialist');
      });

      test('an unusable photo shows no possibilities, observations or condition-specific settle_it (retake instead)', () => {
        const built = engine.buildWorkup({
          subject: 'lawn',
          possibilities: [possibility('fixture-drought', 0.9, [1])],
          turfCandidates: [],
          weedCandidates: [],
          hostCandidates: [],
          observedTerms: ['browning'],
          currentMonth: 6,
          chips: {},
          context: {},
          photosCount: 1,
          quality: { usable: false, issue: 'blurry' },
        });
        expect(built.possibilities).toEqual([]);
        expect(built.observed).toEqual([]);
        expect(built.settle_it).toEqual({ kind: 'retake', text: engine.RETAKE_TEXT.lawn });
        expect(built.next_step_hint.kind).toBe('unclear');
        expect(built.referral).toBeNull();
      });

      test('an off-catalog top below the threshold escalates too', async () => {
        queue(
          candidatesLeg({ host: [idItem('', 0.5, { off_catalog_name: 'Foxtail palm', group_id: 'palms' })] }),
          MISS,
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'palm', mode: 'identify' });
        expect(dispatch).toHaveBeenCalledTimes(2);
        // 0.5 is too little to climb to `palms`, so the lane would answer unknown as well.
        expect(result.internal.escalation_reasons).toEqual(['no_identity_candidate', 'low_confidence']);
      });
    });

    describe('finding 14: self-contradiction is checked per identity slot', () => {
      test('a flipped turf answer escalates even while a weed is the global top', async () => {
        queue(
          candidatesLeg({ turf: [idItem('fixture-st-augustine', 0.7), idItem('fixture-bahia', 0.6)], weeds: [idItem('fixture-nutsedge', 0.95)] }),
          verifyLeg([['fixture-st-augustine', 0.5], ['fixture-bahia', 0.85], ['fixture-nutsedge', 0.95]]),
          conditionsLeg([['fixture-large-patch', 0.9]]),
          MISS,
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
        // The flipped pair are two grasses, so the read is a close call as well.
        expect(result.internal.escalation_reasons).toEqual(['close_call', 'self_contradiction']);
      });

      test('a turf/weed confidence swap is not a contradiction', async () => {
        queue(
          candidatesLeg({ turf: [idItem('fixture-st-augustine', 0.9)], weeds: [idItem('fixture-nutsedge', 0.85)] }),
          verifyLeg([['fixture-st-augustine', 0.85], ['fixture-nutsedge', 0.95]]),
          conditionsLeg([['fixture-large-patch', 0.9]]),
        );
        const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
        expect(result.internal.escalation_triggered).toBe(false);
        expect(dispatch).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('Codex #5186 round 2 regressions', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const MISS = { ok: false, reason: 'provider_error' };
    const idItem = (slug, confidence) => ({
      slug, off_catalog_name: '', group_id: null, confidence,
    });
    const condItem = ([slug, confidence, elementsVisible = [1]]) => ({
      slug, confidence, elements_visible: elementsVisible, signs_visible: [], symptoms_visible: [],
    });
    const candidatesLeg = ({
      shows = 'plant', quality = OK_QUALITY, turf = [], weeds = [], host = [],
    } = {}) => ({ ok: true, json: { quality, shows, turf, weeds, host } });
    const conditionsLeg = (items, { observed = ['browning'], quality = OK_QUALITY } = {}) => ({
      ok: true, json: { quality, observed_terms: observed, candidates: items.map(condItem) },
    });
    const queue = (...legs) => legs.forEach((leg) => dispatch.mockResolvedValueOnce(leg));
    const cand = (slug, confidence, extra = {}) => {
      const entry = catalog.getEntry(slug);
      return {
        slug, entry, confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: entry.group, ...extra,
      };
    };
    const offCatalog = (name, confidence) => ({
      slug: null, entry: null, confidence, verified: false, checked: false, uncovered: false, cuesVisible: [], cuesNotVisible: [], offCatalogName: name, groupId: null,
    });

    test('finding 1: identify mode with a valid Call A that raises no candidate in any answerable lane escalates (no_identity_candidate) instead of settling for one inconclusive read', async () => {
      queue(candidatesLeg({ shows: 'plant' }), MISS);
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_triggered).toBe(true);
      expect(result.internal.escalation_reasons).toContain('no_identity_candidate');
      expect(dispatch).toHaveBeenCalledTimes(2); // candidates, then the escalation leg — no verify (nothing to verify)
      expect(result.v2.answer.level).toBe('unknown');
      expect(result.v2.tier).toBe('needs_more_evidence');
    });

    test('finding 1 (workup mode is unaffected): an empty identity read never triggers no_identity_candidate on its own', async () => {
      queue(candidatesLeg({ shows: 'damage' }), conditionsLeg([['fixture-large-patch', 0.9]]));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_reasons).not.toContain('no_identity_candidate');
    });

    test('finding 2: lane choice ranks each lane\'s real answer before confidence — a verified turf at 0.85 beats an off-catalog weed guess at 0.95', () => {
      const { identifyLaneFor, laneEligibilityRank } = engine._test;
      const turf = cand('fixture-st-augustine', 0.85);
      const groupedWeed = (confidence, name = 'some weed') => ({ ...offCatalog(name, confidence), groupId: 'broadleaf-weeds' });
      expect(laneEligibilityRank([turf])).toBe(5); // pretty_sure
      expect(laneEligibilityRank([cand('fixture-nutsedge', 0.9, { verified: false })])).toBe(4); // checked, no clean cue -> likely
      // Unnamed, but the lineage climb reaches the group: uncovered, unapproved, disagreed, or an off-catalog guess with a valid group.
      expect(laneEligibilityRank([cand('fixture-nutsedge', 0.95, { uncovered: true })])).toBe(2);
      expect(laneEligibilityRank([cand('fixture-zoysia-draft', 0.95)])).toBe(2); // unapproved
      expect(laneEligibilityRank([turf], { disagreed: true })).toBe(2); // a disagreed slot has no NAMED answer
      expect(laneEligibilityRank([groupedWeed(0.85)])).toBe(2);
      // Unknown: nothing resolves to a catalog node, or too little confidence to climb.
      expect(laneEligibilityRank([offCatalog('some weed', 0.95)])).toBe(0);
      expect(laneEligibilityRank([cand('fixture-st-augustine', 0.10)])).toBe(0);
      // Pre-push audit on r4: a turf guess with no group (unknown) must not beat a weed guess with a valid group (a group answer).
      expect(identifyLaneFor('lawn', { turf: [offCatalog('mystery turf', 0.95)], weeds: [groupedWeed(0.85)], host: [] })).toBe('weeds');
      // The rank is the lane's built answer, not its top alone: a resolvable turf top too weak to climb answers unknown,
      // and two weed guesses that climb together answer the group.
      expect(identifyLaneFor('lawn', { turf: [cand('fixture-zoysia-draft', 0.40)], weeds: [groupedWeed(0.35), groupedWeed(0.30, 'other weed')], host: [] })).toBe('weeds');
      // A more specific climbed answer wins: turf that only reaches the category ("a plant") yields to a weed group.
      expect(identifyLaneFor('lawn', { turf: [cand('fixture-zoysia-draft', 0.45), { ...offCatalog('odd palm', 0.20), groupId: 'palms' }], weeds: [groupedWeed(0.31), groupedWeed(0.30, 'other weed')], host: [] })).toBe('weeds');
      expect(identifyLaneFor('lawn', { turf: [turf], weeds: [offCatalog('some weed', 0.95)], host: [] })).toBe('turf');
      expect(identifyLaneFor('lawn', { turf: [turf], weeds: [cand('fixture-nutsedge', 0.95, { uncovered: true })], host: [] })).toBe('turf');
      // Pre-push audit: a verified turf at 0.10 must not outrank a likely weed at 0.90.
      expect(identifyLaneFor('lawn', { turf: [cand('fixture-st-augustine', 0.10)], weeds: [cand('fixture-nutsedge', 0.9, { verified: false })], host: [] })).toBe('weeds');
      // The lane's own escalation flags count: a disagreed turf yields to a nameable weed.
      expect(identifyLaneFor('lawn', { turf: [turf], weeds: [cand('fixture-nutsedge', 0.6)], host: [] }, { turf: { disagreed: true }, weeds: {} })).toBe('weeds');
      // Equal nameability: the higher confidence wins, turf on a tie.
      expect(identifyLaneFor('lawn', { turf: [turf], weeds: [cand('fixture-nutsedge', 0.95)], host: [] })).toBe('weeds');
      expect(identifyLaneFor('lawn', { turf: [turf], weeds: [cand('fixture-nutsedge', 0.85)], host: [] })).toBe('turf');
      expect(identifyLaneFor('lawn', { turf: [], weeds: [offCatalog('some weed', 0.4)], host: [] })).toBe('weeds');
    });

    test('finding 3: identity results carry catalog_version like the workup and the pest payload', async () => {
      queue(candidatesLeg({ host: [idItem('fixture-queen-palm', 0.9)] }), { ok: true, json: { candidates: [{ slug: 'fixture-queen-palm', confidence: 0.9, cues_visible: [1], cues_not_visible: [] }] } });
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'palm', mode: 'identify' });
      expect(result.ok).toBe(true);
      expect(result.v2.kind).toBe('identity');
      expect(result.v2.catalog_version).toBe(catalog.CATALOG_VERSION);
    });

    test('finding 4: a workup stands on a valid conditions leg when every identity leg and the escalation miss — never a 503', async () => {
      queue(MISS, conditionsLeg([['fixture-large-patch', 0.7]]), MISS);
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(result.v2.kind).toBe('workup');
      expect(result.v2.possibilities.map((p) => p.slug)).toContain('fixture-large-patch');
      expect(result.v2.subject.plant).toBeNull();
      expect(result.internal.escalation_reasons).toContain('gemini_missed');
    });

    test('finding 4 (identify mode still needs an identity envelope): identity legs and escalation missing -> vision_unavailable', async () => {
      queue(MISS, MISS);
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'palm', mode: 'identify' });
      expect(result).toEqual({ ok: false, reason: 'vision_unavailable' });
    });

    test('finding 5: a named identity entry carries the catalog safety line and flags (sago palm shows its pet warning)', () => {
      const built = engine.buildIdentityResult([cand('fixture-sago-palm', 0.9)], { subject: 'tree_shrub', currentMonth: 1 });
      expect(built.answer.level).toBe('entry');
      expect(built.entry.safety_line).toBe('Toxic to pets.');
      expect(built.entry.safety).toEqual(catalog.getEntry('fixture-sago-palm').safety);
      expect(built.entry.risk).toBe(catalog.getEntry('fixture-sago-palm').risk);
      // Weeds named on a workup carry the same fields.
      const weed = engine.weedWordingLine(catalog.getEntry('fixture-nutsedge'), 'likely');
      expect(weed).toHaveProperty('safety_line');
      expect(weed).toHaveProperty('safety');
    });

    test('finding 5 (pre-push audit): the workup\'s own named plant carries the safety line too, from the photo ladder and from the account', () => {
      const base = {
        subject: 'palm', possibilities: [], hostCandidates: [cand('fixture-sago-palm', 0.9)], observedTerms: [], currentMonth: 1, chips: {}, context: {}, photosCount: 1, quality: { usable: true, issue: 'none' },
      };
      const fromPhoto = engine.buildWorkup(base);
      expect(fromPhoto.subject.plant).toMatchObject({ slug: 'fixture-sago-palm', source: 'photo', safety_line: 'Toxic to pets.' });
      const fromAccount = engine.buildWorkup({
        ...base, subject: 'lawn', hostCandidates: [], context: { grass_type_on_file: 'fixture_st_augustine' },
      });
      expect(fromAccount.subject.plant).toMatchObject({ slug: 'fixture-st-augustine', source: 'account' });
      expect(fromAccount.subject.plant).toHaveProperty('safety_line');
    });

    test('finding 6: a regulated pest possibility reads outcome "regulated", routes to the FDACS referral template and joins the outcome-class guard', () => {
      const regulated = engine.resolveConditionCandidate({ slug: 'fixture-regulated-pest', confidence: 0.9, elements_visible: [1, 2] }, pestEntries());
      expect(engine._test.pestOutcomeFor(catalog.getEntry('fixture-regulated-pest'))).toBe('regulated');
      expect(engine.signatureFor(catalog.getEntry('fixture-chinch-bug')).outcome).toBe('treatable');
      expect(regulated.sig.outcome).toBe('regulated');
      const { hint, referral } = engine.nextStepHintFor([regulated]);
      expect(hint.kind).toBe('specialist');
      expect(referral).toEqual({ kind: 'report_fdacs', text: engine.REFERRAL_TEMPLATES.report_fdacs });
      // A manageable palm disorder next to a regulated pest at >=0.20 is not named.
      const potassium = engine.resolveConditionCandidate({ slug: 'fixture-potassium-deficiency-palm', confidence: 0.9, elements_visible: [1, 2] }, conditionEntries());
      const weevil = engine.resolveConditionCandidate({ slug: 'fixture-regulated-pest', confidence: 0.25, elements_visible: [] }, pestEntries());
      expect(engine.namedAnswerFor([potassium, weevil], potassium)).toBeNull();
      expect(engine.namedAnswerFor([potassium], potassium)).not.toBeNull();
    });

    test('finding 8: leg diagnostics record the answering model alongside the provider', async () => {
      queue(candidatesLeg({ shows: 'damage' }), conditionsLeg([['fixture-large-patch', 0.9]]));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.internal.models.candidates).toEqual({ ok: true, provider: 'gemini', model: 'gemini-3.8-flash-test', reason: null });
      expect(engine._test.legInfo({ ok: false, reason: 'provider_error', provider: 'openai', model: 'gpt-6-astra-test' })).toEqual({
        ok: false, provider: 'openai', model: 'gpt-6-astra-test', reason: 'provider_error',
      });
    });
  });

  describe('Codex #5186 round 3 regressions', () => {
    const cand = (slug, confidence, extra = {}) => {
      const entry = catalog.getEntry(slug);
      return {
        slug, entry, confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: entry.group, ...extra,
      };
    };
    const OK = { usable: true, issue: 'none' };

    test('finding 1: a displayed workup possibility carries the catalog safety line and flags (a regulated pest keeps its warning)', () => {
      const block = engine.possibilityBlockFor(possibility('fixture-regulated-pest', 0.9, [1, 2]));
      const entry = catalog.getEntry('fixture-regulated-pest');
      expect(block.safety_line).toBe(entry.safety_line);
      expect(block.safety).toEqual(entry.safety);
      expect(block.risk).toBe(entry.risk);
    });

    test('finding 2: an identity whose look-alike a photo cannot settle never reads pretty_sure, and its next photo is that pair\'s guidance', () => {
      const paspalum = catalog.getEntry('fixture-seashore-paspalum');
      expect(engine._test.hasPhotoVetoLookAlike(paspalum)).toBe(true);
      expect(engine._test.hasPhotoVetoLookAlike(catalog.getEntry('fixture-bahia'))).toBe(false);
      expect(engine.identityEntryLevelAnswer(cand('fixture-seashore-paspalum', 0.95)).wording).toBe('likely');
      expect(engine.identityEntryLevelAnswer(cand('fixture-bahia', 0.95)).wording).toBe('pretty_sure');
      const built = engine.buildIdentityResult([cand('fixture-seashore-paspalum', 0.95)], { subject: 'lawn', currentMonth: 6 });
      expect(built.answer).toMatchObject({ level: 'entry', wording: 'likely' });
      expect(built.next_photo).toEqual({ ask: paspalum.look_alikes[0].next_photo, why: paspalum.look_alikes[0].difference, photo_can_confirm: false });
    });

    test('finding 3: several unapproved candidates of one group collapse into one masked row with no locality badge', () => {
      const draftA = cand('fixture-zoysia-draft', 0.5);
      const draftB = cand('fixture-zoysia-draft', 0.4, { confidence: 0.4 });
      const rows = engine._test.plantCandidatesBlockFor([draftA, draftB, cand('fixture-bahia', 0.3)], 6);
      expect(rows).toEqual([
        {
          slug: null, common_name: 'a turfgrass', scientific_name: null, strength: 'possible', local: null, safety_line: null,
        },
        {
          slug: 'fixture-bahia', common_name: 'Fixture Bahia', scientific_name: 'Paspalum fixturicus', strength: 'possible', local: 'common_here_now', safety_line: null,
        },
      ]);
      // A named alternative carries its catalog warning (Codex #5250 r6): sago palm as a runner-up keeps its pet line.
      const withSago = engine._test.plantCandidatesBlockFor([cand('fixture-citrus', 0.8), cand('fixture-sago-palm', 0.3)], 6);
      expect(withSago[1]).toMatchObject({ slug: 'fixture-sago-palm', safety_line: 'Toxic to pets.' });
    });

    test('finding 4: a usable photo read of multiple_subjects still blocks naming (symptom / unknown, needs_more_evidence) while the workup keeps its possibilities', () => {
      const quality = { usable: true, issue: 'multiple_subjects' };
      expect(engine._test.namingGateFor(quality)).toEqual({ unusable: false, blocked: true });
      const large = possibility('fixture-large-patch', 0.9, [1]);
      const workup = engine.buildWorkup({
        subject: 'lawn', possibilities: [large], observedTerms: ['browning'], currentMonth: 1, chips: {}, context: {}, photosCount: 2, quality,
      });
      expect(workup.answer.level).toBe('symptom');
      expect(workup.tier).toBe('needs_more_evidence');
      expect(workup.possibilities.map((p) => p.slug)).toEqual(['fixture-large-patch']);
      const identity = engine.buildIdentityResult([cand('fixture-bahia', 0.95)], { subject: 'lawn', currentMonth: 6, quality });
      expect(identity.answer.level).not.toBe('entry');
      expect(identity.tier).toBe('needs_more_evidence');
      // The plain usable read still names.
      expect(engine.buildIdentityResult([cand('fixture-bahia', 0.95)], { subject: 'lawn', currentMonth: 6, quality: OK }).answer.level).toBe('entry');
    });

    test('finding 5: a plant_slug chip outside the subject\'s own host index is ignored for the condition-index host union', () => {
      const run = (plantSlug) => ({ subject: 'palm', chips: { plant_slug: plantSlug }, indexes: { host: engine.hostIndexFor('palm') } });
      expect(engine._test.viableHostSlugs(run('fixture-citrus'), [])).toEqual([]);
      expect(engine._test.viableHostSlugs(run('fixture-queen-palm'), [])).toEqual(['fixture-queen-palm']);
      // The palm index admits the REAL catalog's `sago-palm` slug by design; the fixture's own sago lives in shrubs-trees, so it is outside the palm index here.
      expect(engine._test.viableHostSlugs(run('fixture-sago-palm'), [])).toEqual([]);
    });
  });

  describe('Codex #5186 round 4 regressions', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const MISS = { ok: false, reason: 'provider_error' };
    const offItem = (name, confidence, groupId = null) => ({
      slug: '', off_catalog_name: name, group_id: groupId, confidence,
    });
    const candidatesLeg = ({ turf = [], weeds = [], host = [] } = {}) => ({
      ok: true, json: { quality: OK_QUALITY, shows: 'plant', turf, weeds, host },
    });
    const cand = (slug, confidence) => {
      const entry = catalog.getEntry(slug);
      return {
        slug, entry, confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: entry.group,
      };
    };

    test('finding 1: identify mode escalates when the lane holds only an off-catalog guess with no resolvable group', async () => {
      dispatch.mockResolvedValueOnce(candidatesLeg({ turf: [offItem('Mystery grass', 0.95)] }));
      dispatch.mockResolvedValueOnce(MISS);
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_reasons).toContain('no_identity_candidate');
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(result.v2.answer.level).toBe('unknown');
    });

    test('finding 1 (control): an off-catalog guess WITH a valid plant group is answerable at group level and does not trigger', async () => {
      dispatch.mockResolvedValueOnce(candidatesLeg({ turf: [offItem('Mystery grass', 0.95, 'turfgrasses')] }));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(result.ok).toBe(true);
      expect(result.internal.escalation_reasons).not.toContain('no_identity_candidate');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
    });

    test('finding 2: a tree_shrub request that resolves to a palm also draws the general palm conditions', () => {
      const queen = catalog.getEntry('fixture-queen-palm');
      expect(engine.classTokensFor('tree_shrub', queen)).toEqual(expect.arrayContaining(['shrubs', 'trees', 'palms']));
      // The `citrus` token keys off the REAL catalog slug; the fixture's citrus is a plain shrubs-trees host here.
      expect(engine.classTokensFor('tree_shrub', catalog.getEntry('fixture-citrus'))).toEqual(['shrubs', 'trees']);
      expect(engine.classTokensFor('palm', null)).toEqual(['palms']);
      expect(engine.classTokensFor('palm', catalog.getEntry('fixture-sago-palm'))).toEqual(['palms', 'shrubs', 'trees']);
      const leafSpot = catalog.getEntry('fixture-palm-leaf-spot');
      expect(leafSpot.condition.hosts).toEqual(['palms']);
      expect(queen.plant.common_problems).not.toContain('fixture-palm-leaf-spot');
      expect(engine.conditionIndexFor('tree_shrub', 'fixture-queen-palm').map((e) => e.slug)).toContain('fixture-palm-leaf-spot');
    });

    test('finding 5: a blank watering chip never earns fits_watering', () => {
      const drought = catalog.getEntry('fixture-drought');
      const sig = engine.signatureFor(drought);
      expect(sig.siteFactors).toContain('infrequent_irrigation');
      const tagsFor = (watering) => engine.localAnnotationsFor(drought, sig, { currentMonth: 1, chips: { watering_days: watering } });
      expect(tagsFor(null)).not.toContain('fits_watering');
      expect(tagsFor(undefined)).not.toContain('fits_watering');
      expect(tagsFor('')).not.toContain('fits_watering');
      expect(tagsFor('abc')).not.toContain('fits_watering');
      expect(tagsFor(1)).toContain('fits_watering');
      expect(tagsFor('0')).toContain('fits_watering');
      expect(tagsFor(3)).not.toContain('fits_watering');
    });

    test('finding 6: a zero, blank or out-of-range PHOTO_ID_ESCALATE_BELOW falls back to 0.80', () => {
      const saved = process.env.PHOTO_ID_ESCALATE_BELOW;
      try {
        for (const [value, expected] of [['0', 0.8], ['', 0.8], ['1.5', 0.8], ['abc', 0.8], ['0.5', 0.5], ['1', 1]]) {
          process.env.PHOTO_ID_ESCALATE_BELOW = value;
          expect(engine.escalateBelow()).toBe(expected);
        }
      } finally {
        if (saved === undefined) delete process.env.PHOTO_ID_ESCALATE_BELOW; else process.env.PHOTO_ID_ESCALATE_BELOW = saved;
      }
    });

    test('finding 7: a named plant identity carries the label fields the identity card renders', () => {
      const weed = engine.buildIdentityResult([cand('fixture-nutsedge', 0.9)], { subject: 'lawn', currentMonth: 6 });
      expect(weed.entry).toMatchObject({
        verdict_label: 'Keep an eye on it', role: 'weed', role_label: 'Weed', risk_label: 'Low risk when left alone', action: 'monitor', action_label: 'Keep an eye on it',
      });
      const sago = engine.buildIdentityResult([cand('fixture-sago-palm', 0.9)], { subject: 'tree_shrub', currentMonth: 6 });
      expect(sago.entry).toMatchObject({ verdict_label: 'Landscape plant', role_label: 'Landscape plant', risk_label: 'Can cause a medically significant reaction' });
      const turf = engine.buildIdentityResult([cand('fixture-bahia', 0.9)], { subject: 'lawn', currentMonth: 6 });
      expect(turf.entry).toMatchObject({ verdict_label: 'Lawn grass', role_label: 'Lawn grass' });
      const palm = engine.buildIdentityResult([cand('fixture-queen-palm', 0.9)], { subject: 'palm', currentMonth: 6 });
      expect(palm.entry.verdict_label).toBe('Palm');
    });
  });

  describe('Codex #5186 round 5 regressions', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const MISS = { ok: false, reason: 'provider_error' };
    const condItem = ([slug, confidence, elementsVisible = [1]]) => ({
      slug, confidence, elements_visible: elementsVisible, signs_visible: [], symptoms_visible: [],
    });
    const queue = (...legs) => legs.forEach((leg) => dispatch.mockResolvedValueOnce(leg));
    // A confident, verified turf keeps the identity side quiet, so only the condition read can escalate.
    const confidentTurfLegs = () => [
      { ok: true, json: { quality: OK_QUALITY, shows: 'plant', turf: [{ slug: 'fixture-bahia', off_catalog_name: '', group_id: null, confidence: 0.95 }], weeds: [], host: [] } },
      { ok: true, json: { candidates: [{ slug: 'fixture-bahia', confidence: 0.95, cues_visible: [1], cues_not_visible: [] }] } },
    ];
    const conditionsLeg = (items) => ({ ok: true, json: { quality: OK_QUALITY, observed_terms: ['browning'], candidates: items.map(condItem) } });
    const cand = (slug, confidence) => {
      const entry = catalog.getEntry(slug);
      return {
        slug, entry, confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: entry.group,
      };
    };

    test('finding 1: a schema-valid condition read that selects nothing in the index still gets the second opinion', async () => {
      queue(...confidentTurfLegs(), conditionsLeg([]), {
        ok: true,
        json: {
          quality: OK_QUALITY, shows: 'plant', turf: [], weeds: [], host: [], observed_terms: [], conditions: [condItem(['fixture-large-patch', 0.9])],
        },
      });
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(result.internal.escalation_reasons).toEqual(['low_confidence']);
      expect(result.v2.possibilities.map((p) => p.slug)).toEqual(['fixture-large-patch']);
    });

    test('finding 1: a condition read naming only slugs the index does not list escalates the same way', async () => {
      queue(...confidentTurfLegs(), conditionsLeg([['not-in-the-index', 0.9]]), MISS);
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(result.internal.escalation_reasons).toEqual(['low_confidence']);
      expect(result.v2.possibilities).toEqual([]);
    });

    test('finding 2: an entry-level identity whose deciding pair no photo can separate is needs_more_evidence, not an AI suggestion', () => {
      const paspalum = engine.buildIdentityResult([cand('fixture-seashore-paspalum', 0.95)], { subject: 'lawn', currentMonth: 6 });
      expect(paspalum.answer).toMatchObject({ level: 'entry', wording: 'likely' });
      expect(paspalum.next_photo.photo_can_confirm).toBe(false);
      expect(paspalum.tier).toBe('needs_more_evidence');
      // A pair a photo can separate keeps the entry-level answer an AI suggestion.
      const citrus = engine.buildIdentityResult([cand('fixture-citrus', 0.7)], { subject: 'tree_shrub', currentMonth: 6 });
      expect(citrus.answer).toMatchObject({ level: 'entry', wording: 'likely' });
      expect(citrus.next_photo.photo_can_confirm).toBe(true);
      expect(citrus.tier).toBe('ai_suggestion');
    });

    test('finding 2 (workup): a named condition whose runner-up no photo can separate is needs_more_evidence too', () => {
      const large = possibility('fixture-large-patch', 0.9, [1]);
      const build = (possibilities) => engine.buildWorkup({
        subject: 'lawn', possibilities, observedTerms: ['browning'], currentMonth: 1, chips: {}, context: {}, photosCount: 3, quality: OK_QUALITY,
      });
      const withDrought = build([large, possibility('fixture-drought', 0.3, [1])]);
      expect(withDrought.answer).toMatchObject({ level: 'entry', node_id: 'fixture-large-patch' });
      expect(withDrought.settle_it).toMatchObject({ kind: 'technician', photo_can_confirm: false });
      expect(withDrought.tier).toBe('needs_more_evidence');
      // Alone, its own photo signature settles it.
      const alone = build([large]);
      expect(alone.settle_it.kind).toBe('photo');
      expect(alone.tier).toBe('ai_suggestion');
    });

    test('finding 3: every retake prompt asks for no more views than the photos a request accepts', () => {
      const { MAX_PHOTOS } = jest.requireActual('../utils/request-photo-validation');
      for (const text of Object.values(engine.RETAKE_TEXT)) {
        const views = text.slice(text.indexOf(': ') + 2).replace(/\.$/, '').split(/,\s*(?:and\s+)?/);
        expect(views.length).toBeLessThanOrEqual(MAX_PHOTOS);
      }
    });
  });

  describe('Codex #5186 round 6 regressions', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const MISS = { ok: false, reason: 'provider_error' };
    const idItem = (slug, confidence, extra = {}) => ({
      slug, off_catalog_name: '', group_id: null, confidence, ...extra,
    });
    const escIdItem = (slug, confidence, cuesVisible = [1]) => ({ ...idItem(slug, confidence), cues_visible: cuesVisible, cues_not_visible: [] });
    const condItem = ([slug, confidence, elementsVisible = [1]]) => ({
      slug, confidence, elements_visible: elementsVisible, signs_visible: [], symptoms_visible: [],
    });
    const candidatesLeg = ({
      quality = OK_QUALITY, shows = 'plant', turf = [], weeds = [], host = [],
    } = {}) => ({
      ok: true,
      json: {
        quality, shows, turf, weeds, host,
      },
    });
    const verifyLeg = (items) => ({
      ok: true,
      json: {
        candidates: items.map(([slug, confidence, cuesVisible = [1]]) => ({
          slug, confidence, cues_visible: cuesVisible, cues_not_visible: [],
        })),
      },
    });
    const conditionsLeg = (items) => ({ ok: true, json: { quality: OK_QUALITY, observed_terms: ['browning'], candidates: items.map(condItem) } });
    const escalationLeg = ({
      turf = [], weeds = [], host = [], conditions = [],
    } = {}) => ({
      ok: true,
      json: {
        quality: OK_QUALITY, shows: 'plant', turf, weeds, host, observed_terms: [], conditions: conditions.map(condItem),
      },
    });
    const queue = (...legs) => legs.forEach((leg) => dispatch.mockResolvedValueOnce(leg));
    const cand = (slug, confidence) => {
      const entry = catalog.getEntry(slug);
      return {
        slug, entry, confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: entry.group,
      };
    };
    const offGroup = (name, confidence, groupId) => ({
      slug: null, entry: null, confidence, verified: false, checked: false, uncovered: false, cuesVisible: [], cuesNotVisible: [], offCatalogName: name, groupId,
    });

    test('finding 1: an unnamed identity carries a fixed safety line triaged for the worst plant under its node', () => {
      const { base, swallowed } = engine.UNNAMED_PLANT_SAFETY_CLAUSES;
      // "Looks like a shrub or tree": the group holds a medical-risk plant (the fixture sago palm).
      const shrub = engine.buildIdentityResult([offGroup('some shrub', 0.9, 'shrubs-trees')], { subject: 'tree_shrub', currentMonth: 6 });
      expect(shrub.answer).toMatchObject({ level: 'group', node_id: 'shrubs-trees' });
      expect(shrub.generic_safety_line).toBe(`${base} ${swallowed}`);
      // No hazard under the node: no line.
      const turf = engine.buildIdentityResult([offGroup('some grass', 0.9, 'turfgrasses')], { subject: 'lawn', currentMonth: 6 });
      expect(turf.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
      expect(turf.generic_safety_line).toBeNull();
      // Unknown: triaged over every plant the subject could have named.
      const unknown = engine.buildIdentityResult([], { subject: 'tree_shrub', currentMonth: 6 });
      expect(unknown.answer.level).toBe('unknown');
      expect(unknown.generic_safety_line).toBe(`${base} ${swallowed}`);
      // A named plant carries its own catalog line instead.
      const named = engine.buildIdentityResult([cand('fixture-sago-palm', 0.9)], { subject: 'tree_shrub', currentMonth: 6 });
      expect(named.entry.safety_line).toBe('Toxic to pets.');
      expect(named.generic_safety_line).toBeNull();
    });

    test('finding 1: identify mode passes the line through to the card payload', async () => {
      queue(candidatesLeg({ host: [idItem('', 0.9, { off_catalog_name: 'Some shrub', group_id: 'shrubs-trees' })] }));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub', mode: 'identify' });
      expect(result.ok).toBe(true);
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'shrubs-trees' });
      expect(result.v2.entry).toBeNull();
      expect(result.v2.generic_safety_line).toContain(engine.UNNAMED_PLANT_SAFETY_CLAUSES.base);
    });

    test('finding 2: a slot that did not ask for the second opinion keeps its pretty_sure when OpenAI leaves it empty', async () => {
      queue(
        candidatesLeg({ turf: [idItem('fixture-bahia', 0.95)], weeds: [idItem('fixture-nutsedge', 0.6)] }),
        verifyLeg([['fixture-bahia', 0.95], ['fixture-nutsedge', 0.6]]),
        conditionsLeg([['fixture-large-patch', 0.9]]),
        escalationLeg({ weeds: [escIdItem('fixture-nutsedge', 0.85)] }),
      );
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(result.internal.identity.trigger_reasons).toEqual(['low_confidence']); // the weed slot's
      expect(result.v2.subject.plant).toMatchObject({ slug: 'fixture-bahia', wording: 'pretty_sure' });
    });

    test('finding 2: with OpenAI unavailable, only the scope that triggered is capped', async () => {
      queue(
        candidatesLeg({ turf: [idItem('fixture-bahia', 0.95)], weeds: [idItem('fixture-nutsedge', 0.6)] }),
        verifyLeg([['fixture-bahia', 0.95], ['fixture-nutsedge', 0.6]]),
        conditionsLeg([['fixture-large-patch', 0.9]]),
        MISS,
      );
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(result.internal.escalation_triggered).toBe(true);
      expect(result.v2.subject.plant).toMatchObject({ slug: 'fixture-bahia', wording: 'pretty_sure' });
    });

    test('finding 2: the slot that did trigger stays capped when OpenAI leaves it unanswered', async () => {
      // The verify leg flips the turf slot's top (self_contradiction); OpenAI then answers nothing for turf.
      queue(
        candidatesLeg({ turf: [idItem('fixture-st-augustine', 0.9), idItem('fixture-bahia', 0.5)] }),
        verifyLeg([['fixture-st-augustine', 0.3, []], ['fixture-bahia', 0.95]]),
        conditionsLeg([['fixture-large-patch', 0.9]]),
        escalationLeg(),
      );
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      // The flipped pair are two grasses, so the read is a close call as well.
      expect(result.internal.identity.trigger_reasons).toEqual(['close_call', 'self_contradiction']);
      expect(result.v2.subject.plant).toMatchObject({ slug: 'fixture-bahia', wording: 'likely' });
    });

    test('finding 3: settle_it finds the curated comparison from either side of the pair', () => {
      // Only large patch names chinch bug; with chinch bug ranked first the comparison (and its soap flush) still applies.
      expect(catalog.getEntry('fixture-chinch-bug').look_alikes).toEqual([]);
      const chinch = possibility('fixture-chinch-bug', 0.9, [1]);
      const large = possibility('fixture-large-patch', 0.5, [1]);
      expect(engine.settleItFor([chinch, large], 'lawn')).toMatchObject({ kind: 'field_test', name: 'Soap flush' });
      expect(engine.settleItFor([large, chinch], 'lawn')).toMatchObject({ kind: 'field_test', name: 'Soap flush' });
    });

    test('finding 4: an application with an unknown age never earns fits_application', () => {
      const herbicide = catalog.getEntry('fixture-herbicide-injury');
      const sig = engine.signatureFor(herbicide);
      expect(sig.siteFactors).toContain('recent_herbicide');
      const tagsFor = (daysAgo) => engine.localAnnotationsFor(herbicide, sig, { currentMonth: 1, chips: {}, context: { applications: [{ kind: 'herbicide', days_ago: daysAgo }] } });
      for (const unknownAge of [null, undefined, '', 'abc', -3]) expect(tagsFor(unknownAge)).not.toContain('fits_application');
      expect(tagsFor(5)).toContain('fits_application');
      expect(tagsFor('10')).toContain('fits_application');
      expect(tagsFor(30)).not.toContain('fits_application');
    });

    test('finding 5: a completed cue check replaces an unchecked guess, even when it found no supporting cue', () => {
      const { combineIdentity } = engine._test;
      const turfIndex = engine.turfIndexFor();
      const inContext = new Set(['fixture-st-augustine']);
      // Gemini's verify leg missed, so its 0.9 is an unchecked guess; OpenAI checked it and found no cue at 0.1.
      const unchecked = engine.resolveIdentityCandidate(idItem('fixture-st-augustine', 0.9), turfIndex);
      expect(unchecked).toMatchObject({ checked: false, verified: false });
      const refuted = combineIdentity([unchecked], [escIdItem('fixture-st-augustine', 0.1, [])], turfIndex, inContext);
      expect(refuted.candidates[0]).toMatchObject({ confidence: 0.1, checked: true, verified: false });
      expect(engine.identityEntryLevelAnswer(refuted.candidates[0])).toBeNull();
      // Two checks that found no cue: the more doubtful score stands — neither can raise the other.
      const [checkedNoCue] = engine.mergeIdentityVerify([unchecked], {
        candidates: [{
          slug: 'fixture-st-augustine', confidence: 0.8, cues_visible: [], cues_not_visible: [],
        }],
      });
      expect(checkedNoCue).toMatchObject({ checked: true, verified: false });
      expect(combineIdentity([checkedNoCue], [escIdItem('fixture-st-augustine', 0.3, [])], turfIndex, inContext).candidates[0].confidence).toBe(0.3);
      expect(combineIdentity([checkedNoCue], [escIdItem('fixture-st-augustine', 0.95, [])], turfIndex, inContext).candidates[0].confidence).toBe(0.8);
    });

    test.each([
      ['usable: false', { quality: { usable: false, issue: 'blurry' } }],
      ['shows: nothing', { shows: 'nothing' }],
    ])('finding 6: a Call A read of %s ends the ladder — no verify, conditions or escalation call', async (_label, read) => {
      queue(candidatesLeg({ ...read, turf: [idItem('fixture-bahia', 0.5)] }));
      const workup = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(workup.ok).toBe(true);
      expect(workup.v2.quality.usable).toBe(false);
      expect(workup.v2.settle_it).toEqual({ kind: 'retake', text: engine.RETAKE_TEXT.lawn });
      expect(workup.internal.escalation_triggered).toBe(false);

      dispatch.mockReset();
      queue(candidatesLeg({ ...read, turf: [idItem('fixture-bahia', 0.5)] }));
      const identity = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(identity.v2.answer.level).toBe('unknown');
      expect(identity.v2.tier).toBe('needs_more_evidence');
    });

    test('pre-push audit on r6: only contract §3 chips and context reach a provider prompt', async () => {
      queue(
        candidatesLeg({ turf: [idItem('fixture-bahia', 0.95)] }),
        verifyLeg([['fixture-bahia', 0.95]]),
        conditionsLeg([['fixture-large-patch', 0.5]]), // low confidence, so the escalation prompt is built too
        MISS,
      );
      const result = await engine.identifyPlantV2({
        photos: PHOTOS,
        subject: 'lawn',
        chips: { light: 'full_sun', plant_name: 'Chip Free Text', nested: { note: 'Nested Chip Note' } },
        context: {
          grass_type_on_file: 'unknown',
          applications: [{ kind: 'herbicide', days_ago: 5, product: 'Brand X Product' }],
          name: 'Pat Example',
          phone: '941-555-0100',
          address: '1 Example Street',
        },
      });
      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(4);
      const sent = JSON.stringify(dispatch.mock.calls);
      for (const leaked of ['Pat Example', '941-555-0100', '1 Example Street', 'Brand X Product', 'Chip Free Text', 'Nested Chip Note']) {
        expect(sent).not.toContain(leaked);
      }
      // The contract's own facts still arrive.
      expect(sent).toContain('full_sun');
      expect(sent).toContain('herbicide');
      expect(sent).toContain('grass_type_on_file');
    });
  });

  describe('Codex #5186 round 7 regressions', () => {
    test('finding 2: an identity capped by a look-alike that is still a draft gets fixed technician guidance, never a retake', () => {
      const { approvalContentHash } = jest.requireActual('../services/species-catalog-approval');
      const { NO_PHOTO_CONFIRMS } = require('../services/photo-id-v2/pest-engine');
      const reapproved = (entry) => {
        const { review: _review, ...rest } = entry;
        const base = { ...rest, verification: [] };
        return { ...base, review: { status: 'owner_approved', approval_hash: approvalContentHash(base) } };
      };
      // An owner-approved bahia whose only look-alike, one a photo cannot separate, is the unapproved zoysia draft.
      const bahia = reapproved({
        ...catalog.getEntry('fixture-bahia'),
        look_alikes: [{
          slug: 'fixture-zoysia-draft', difference: 'Draft-only comparison.', next_photo: 'Draft-only photo tip.', photo_can_confirm: false,
        }],
      });
      const candidate = {
        slug: 'fixture-bahia', entry: bahia, confidence: 0.95, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: bahia.group,
      };
      const built = engine.buildIdentityResult([candidate], { subject: 'lawn', currentMonth: 6 });
      expect(built.answer).toMatchObject({ level: 'entry', wording: 'likely' });
      expect(built.next_photo).toEqual({ ask: NO_PHOTO_CONFIRMS.ask, why: NO_PHOTO_CONFIRMS.why, photo_can_confirm: false });
      expect(built.tier).toBe('needs_more_evidence');
      expect(JSON.stringify(built)).not.toContain('Draft-only');
    });
  });

  describe('catalog approvals (#5250) regressions', () => {
    const cand = (slug, confidence) => ({
      slug, entry: catalog.getEntry(slug), confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: catalog.getEntry(slug).group,
    });

    test('r7: the next-photo comparison carries the compared look-alike\'s warning, even when that plant is not a candidate', () => {
      // Citrus (likely) is compared against sago palm, which is not among the candidates.
      const citrus = engine.buildIdentityResult([cand('fixture-citrus', 0.7)], { subject: 'tree_shrub', currentMonth: 6 });
      expect(citrus.candidates.map((c) => c.slug)).toEqual(['fixture-citrus']);
      expect(citrus.next_photo).toMatchObject({ photo_can_confirm: true, safety_line: 'Toxic to pets.' });
      // A look-alike with no warning adds none.
      const paspalum = engine.buildIdentityResult([cand('fixture-seashore-paspalum', 0.95)], { subject: 'lawn', currentMonth: 6 });
      expect(paspalum.next_photo).not.toHaveProperty('safety_line');
    });
  });

  describe('photo eval 2026-09-28 follow-ups', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const idItem = (slug, confidence) => ({
      slug, off_catalog_name: '', group_id: null, confidence,
    });
    const verified = (slug, confidence) => ({
      slug, entry: catalog.getEntry(slug), confidence, verified: true, checked: true, uncovered: false, cuesVisible: [1], cuesNotVisible: [], offCatalogName: null, groupId: catalog.getEntry(slug).group,
    });
    const triggersForSlot = (slot, list) => engine._test.identitySlotTriggers({
      candidatesJson: {}, slots: { turf: [], weeds: [], host: [], [slot]: list }, verifyMissedSlots: { turf: false, weeds: false, host: false }, flippedSlots: { turf: false, weeds: false, host: false },
    }, { subject: 'lawn', mode: 'workup' })[slot];
    const triggersFor = (turf) => triggersForSlot('turf', turf);

    test('a confident read with a same-group runner-up is a close call that gets the second opinion', () => {
      expect(triggersFor([verified('fixture-st-augustine', 0.95), verified('fixture-bahia', 0.30)])).toEqual(['close_call']);
      // A runner-up of another group, or one too weak to be a real contender, is not a close call.
      expect(triggersFor([verified('fixture-st-augustine', 0.95), verified('fixture-nutsedge', 0.40)])).toEqual([]);
      expect(triggersFor([verified('fixture-st-augustine', 0.95), verified('fixture-bahia', 0.10)])).toEqual([]);
      expect(triggersFor([verified('fixture-st-augustine', 0.95)])).toEqual([]);
      // Codex #5255 r1: two weeds in one lawn are not rival answers — the weeds slot is never a close call.
      const secondWeed = { ...verified('fixture-nutsedge', 0.40), slug: 'fixture-other-weed' };
      expect(triggersForSlot('weeds', [verified('fixture-nutsedge', 0.95), secondWeed])).toEqual([]);
    });

    test('identify mode: a close call between two grasses runs the escalation, and a disagreement names neither', async () => {
      const candidatesLeg = { ok: true, json: { quality: OK_QUALITY, shows: 'plant', turf: [idItem('fixture-st-augustine', 0.95), idItem('fixture-bahia', 0.30)], weeds: [], host: [] } };
      const verifyLeg = {
        ok: true,
        json: {
          candidates: [
            { slug: 'fixture-st-augustine', confidence: 0.95, cues_visible: [1], cues_not_visible: [] },
            { slug: 'fixture-bahia', confidence: 0.30, cues_visible: [1], cues_not_visible: [] },
          ],
        },
      };
      const escalationLeg = {
        ok: true,
        json: {
          quality: OK_QUALITY, shows: 'plant', turf: [{ slug: 'fixture-bahia', off_catalog_name: '', group_id: null, confidence: 0.9, cues_visible: [1], cues_not_visible: [] }], weeds: [], host: [], observed_terms: [], conditions: [],
        },
      };
      [candidatesLeg, verifyLeg, escalationLeg].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.internal.escalation_reasons).toEqual(['close_call']);
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
    });
  });

  // ── referee (GATE_PLANT_ID_REFEREE, owner ruling 2026-09-29: narrowed to
  // plant-NAME tie-breaks, identify mode only) ────────────────────────────
  describe('referee (GATE_PLANT_ID_REFEREE, owner ruling 2026-09-29)', () => {
    const PHOTOS = [{ data: 'x', mimeType: 'image/jpeg' }];
    const OK_QUALITY = { usable: true, issue: 'none' };
    const idItem = (slug, confidence) => ({
      slug, off_catalog_name: '', group_id: null, confidence,
    });
    const savedGate = process.env.GATE_PLANT_ID_REFEREE;
    afterEach(() => {
      if (savedGate === undefined) delete process.env.GATE_PLANT_ID_REFEREE;
      else process.env.GATE_PLANT_ID_REFEREE = savedGate;
    });

    // Gemini's own top (st-augustine, verified 0.95) vs. Sol's escalation
    // top (bahia, 0.9) — a genuine disagreement, disagreementPair =
    // [st-augustine, bahia].
    const candidatesLeg = { ok: true, json: { quality: OK_QUALITY, shows: 'plant', turf: [idItem('fixture-st-augustine', 0.95), idItem('fixture-bahia', 0.30)], weeds: [], host: [] } };
    const verifyLeg = {
      ok: true,
      json: {
        candidates: [
          { slug: 'fixture-st-augustine', confidence: 0.95, cues_visible: [1], cues_not_visible: [] },
          { slug: 'fixture-bahia', confidence: 0.30, cues_visible: [1], cues_not_visible: [] },
        ],
      },
    };
    const disagreeingEscalationLeg = {
      ok: true,
      json: {
        quality: OK_QUALITY, shows: 'plant', turf: [{ slug: 'fixture-bahia', off_catalog_name: '', group_id: null, confidence: 0.9, cues_visible: [1], cues_not_visible: [] }], weeds: [], host: [], observed_terms: [], conditions: [],
      },
    };
    const refereeTurf = (slug, confidence) => ({
      ok: true,
      json: {
        quality: OK_QUALITY, shows: 'plant', turf: [{ slug, off_catalog_name: '', group_id: null, confidence, cues_visible: [1], cues_not_visible: [] }], weeds: [], host: [], observed_terms: [], conditions: [],
      },
    });

    test('Codex #5307 r10: two different off-catalog names in one group never draw the referee; the answer is that group either way', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      const offCatalog = (name, confidence) => ({
        slug: '', off_catalog_name: name, group_id: 'turfgrasses', confidence, cues_visible: [], cues_not_visible: [],
      });
      dispatch.mockImplementation(async (route, payload) => {
        const step = String(payload?.promptVersion || '').split(':')[1];
        if (step === 'candidates') return { ok: true, json: { quality: OK_QUALITY, shows: 'plant', turf: [offCatalog('Zoysia', 0.5)], weeds: [], host: [] } };
        if (step === 'escalation') {
          return {
            ok: true,
            json: {
              quality: OK_QUALITY, shows: 'plant', turf: [offCatalog('Centipede', 0.6)], weeds: [], host: [], observed_terms: [], conditions: [],
            },
          };
        }
        return { ok: false, reason: 'unused_leg' };
      });
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      // An off-catalog read is never named, so settling Zoysia vs Centipede
      // could not change the answer: it is the group, and no Fable call is billed.
      expect(dispatch.mock.calls.map(([, p]) => p.laneId)).not.toContain('plant_id_referee');
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
    });

    test('gate off: no 4th dispatch, result identical to the pre-referee disagreement outcome', async () => {
      delete process.env.GATE_PLANT_ID_REFEREE;
      [candidatesLeg, verifyLeg, disagreeingEscalationLeg].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
      expect(result.internal.referee).toEqual({ triggered: false, scopes: [], outcome: {} });
      expect(result.internal.models.referee).toBeNull();
    });

    test('identify + disagreement: the referee sides with side A (Gemini) -> that answer first, not disagreed, wording capped at likely', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      [candidatesLeg, verifyLeg, disagreeingEscalationLeg, refereeTurf('fixture-st-augustine', 0.85)].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(dispatch.mock.calls[3][1].laneId).toBe('plant_id_referee');
      // Codex #5307 r8: ledger rows join the switchboard lanes by exact id;
      // each step stays attributable through its prompt version.
      expect(dispatch.mock.calls.map(([, p]) => [p.laneId, p.promptVersion.split(':')[1]])).toEqual([
        ['plant_id', 'candidates'], ['plant_id', 'verify'], ['plant_id', 'escalation'], ['plant_id_referee', 'referee'],
      ]);
      // The first live run (2026-09-29) found every Fable call 400ing on the
      // schema's numeric bounds; what reaches Anthropic must carry none.
      // The shared llm/call.js anthropicSchema() strips them on the wire (#5347).
      const { anthropicSchema } = jest.requireActual('../services/llm/call');
      expect(JSON.stringify(anthropicSchema(dispatch.mock.calls[3][1].jsonSchema))).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)"/);
      // A tie-break never holds the request for the whole 4-minute ladder budget.
      expect(dispatch.mock.calls[3][1].timeoutMs).toBeLessThanOrEqual(engine._test.REFEREE_MAX_MS);
      // Settled on Gemini's own top — never pretty_sure, even though its own
      // confidence (0.95) clears the threshold, because a referee-settled
      // split is capped (owner ruling 2026-09-28, unchanged 09-29).
      expect(result.v2.answer).toMatchObject({ level: 'entry', node_id: 'fixture-st-augustine', wording: 'likely' });
      expect(result.internal.identity.turf.disagreed).toBe(false);
      expect(result.internal.referee.triggered).toBe(true);
      expect(result.internal.referee.scopes).toContain('turf');
      expect(result.internal.referee.outcome.turf).toBe('settled');
      expect(result.internal.models.referee).toMatchObject({ ok: true });
    });

    test('identify + disagreement: the referee sides with side B (Sol) -> that answer first instead', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      [candidatesLeg, verifyLeg, disagreeingEscalationLeg, refereeTurf('fixture-bahia', 0.6)].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(result.internal.referee.outcome.turf).toBe('settled');
      expect(result.v2.answer).toMatchObject({ level: 'entry', node_id: 'fixture-bahia', wording: 'likely' });
      expect(result.internal.identity.turf.disagreed).toBe(false);
    });

    test('identify + disagreement + a third answer: the lane is left exactly as escalation left it, outcome no_majority', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      [candidatesLeg, verifyLeg, disagreeingEscalationLeg, refereeTurf('fixture-seashore-paspalum', 0.7)].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(4);
      // Still no majority — owner ruling 2026-09-29: the lane is left EXACTLY
      // as the escalation left it (no append, unlike the removed 2-of-3
      // shape's `refereeOnly` third candidate).
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
      expect(result.internal.identity.turf.disagreed).toBe(true);
      expect(result.internal.referee.outcome.turf).toBe('no_majority');
      expect(result.v2.candidates.map((c) => c.slug)).not.toContain('fixture-seashore-paspalum');
    });

    test('referee invalid/unavailable: the escalation result stands unchanged, outcome unavailable', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      [candidatesLeg, verifyLeg, disagreeingEscalationLeg, { ok: false, reason: 'provider_error' }].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
      expect(result.internal.identity.turf.disagreed).toBe(true);
      expect(result.internal.referee.triggered).toBe(true);
      expect(result.internal.referee.outcome.turf).toBe('unavailable');
      expect(result.internal.models.referee).toMatchObject({ ok: false });
    });

    test('identify + low-confidence AGREEMENT (no split): no referee call', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      // Gemini and Sol both land on st-augustine (agreement) even though the
      // combined confidence never climbs — an undisputed but unsure top.
      // Owner ruling 2026-09-29: the referee never runs for an agreement,
      // low-confidence or not.
      const lowConfidenceAgreeingLeg = {
        ok: true,
        json: {
          quality: OK_QUALITY, shows: 'plant', turf: [{ slug: 'fixture-st-augustine', off_catalog_name: '', group_id: null, confidence: 0.4, cues_visible: [1], cues_not_visible: [] }], weeds: [], host: [], observed_terms: [], conditions: [],
        },
      };
      [candidatesLeg, verifyLeg, lowConfidenceAgreeingLeg].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.internal.identity.turf.disagreed).toBe(false);
      expect(result.internal.referee).toEqual({ triggered: false, scopes: [], outcome: {} });
    });

    test('identify + missing second opinion (Sol left the scope empty): no referee call', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      const emptyTurfEscalationLeg = {
        ok: true,
        json: { quality: OK_QUALITY, shows: 'plant', turf: [], weeds: [], host: [], observed_terms: [], conditions: [] },
      };
      [candidatesLeg, verifyLeg, emptyTurfEscalationLeg].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      // Only 3 dispatches (candidates, verify, escalation) — a missing
      // second opinion (`blockPrettySure`, never `disagreed`) is explicitly
      // excluded from the narrowed referee (owner ruling 2026-09-29).
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.internal.identity.turf.openai_answered).toBe(false);
      expect(result.internal.referee).toEqual({ triggered: false, scopes: [], outcome: {} });
    });

    test('workup mode: even with a condition disagreement, no referee call (workups stay Gemini -> Sol)', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      // Call A: no identity candidates at all (verify is skipped).
      dispatch.mockResolvedValueOnce({ ok: true, json: { quality: OK_QUALITY, shows: 'plant', turf: [], weeds: [], host: [] } });
      // Call C (conditions): Gemini's own top.
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: OK_QUALITY,
          observed_terms: ['browning'],
          candidates: [{ slug: 'fixture-drought', confidence: 0.5, elements_visible: [1], signs_visible: [], symptoms_visible: [] }],
        },
      });
      // Call D (escalation): Sol disagrees.
      dispatch.mockResolvedValueOnce({
        ok: true,
        json: {
          quality: OK_QUALITY, shows: 'plant', turf: [], weeds: [], host: [], observed_terms: [], conditions: [{ slug: 'fixture-herbicide-injury', confidence: 0.5, elements_visible: [1], signs_visible: [], symptoms_visible: [] }],
        },
      });
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'workup' });
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.internal.conditions.disagreed).toBe(true);
      expect(result.internal.referee).toEqual({ triggered: false, scopes: [], outcome: {} });
    });

    test('Codex #5307 r2: a run with no usable vision leg fails BEFORE the billed referee call', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      dispatch.mockResolvedValue({ ok: false, reason: 'gemini_503' });
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(result).toEqual({ ok: false, reason: 'vision_unavailable' });
      const lanes = dispatch.mock.calls.map(([, payload]) => payload?.laneId);
      expect(lanes).not.toContain('plant_id_referee');
    });

    test('Codex #5307 r6: a prior UNUSABLE read skips the billed referee call', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      const unusableEscalation = {
        ...disagreeingEscalationLeg,
        json: { ...disagreeingEscalationLeg.json, quality: { usable: false, issue: 'blurry' } },
      };
      [candidatesLeg, verifyLeg, unusableEscalation, refereeTurf('fixture-st-augustine', 0.85)].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.internal.referee.triggered).toBe(false);
    });

    test('finding 2: a prior BLOCKED (but still usable) read — multiple subjects — also skips the billed referee call', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      // Identify results discard every candidate once the combined read is
      // `blocked` (usable OR not), so the referee's vote could never
      // surface either way (Codex #5307 r7 finding 2, widened from
      // `.unusable` alone).
      const blockedEscalation = {
        ...disagreeingEscalationLeg,
        json: { ...disagreeingEscalationLeg.json, quality: { usable: true, issue: 'multiple_subjects' } },
      };
      [candidatesLeg, verifyLeg, blockedEscalation, refereeTurf('fixture-st-augustine', 0.85)].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(result.internal.referee.triggered).toBe(false);
    });

    test('an unusable referee read never merges its vote, and never downgrades the Gemini/Sol answer that stands', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      const unusableRefereeLeg = {
        ok: true,
        json: {
          quality: { usable: false, issue: 'blurry' }, shows: 'plant', turf: [{ slug: 'fixture-seashore-paspalum', off_catalog_name: '', group_id: null, confidence: 0.99, cues_visible: [1], cues_not_visible: [] }], weeds: [], host: [], observed_terms: [], conditions: [],
        },
      };
      [candidatesLeg, verifyLeg, disagreeingEscalationLeg, unusableRefereeLeg].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'lawn', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(4);
      // The disagreement stands exactly as it did before the referee — its
      // confident vote is never merged once it says the photos themselves
      // are unusable.
      expect(result.internal.referee.outcome.turf).toBe('unavailable');
      expect(result.internal.identity.turf.disagreed).toBe(true);
      // Pre-push audit on Codex #5307 r8: a tie-break that merged nothing
      // must not veto the earlier reads' usable photo — the answer is the
      // same Gemini/Sol split it would have been without the referee.
      expect(result.v2.quality.usable).toBe(true);
      expect(result.v2.answer).toMatchObject({ level: 'group', node_id: 'turfgrasses' });
    });

    test('finding 5: a tree_shrub run with a total Gemini miss and a confident Sol host makes NO referee call (turf/weeds never apply, and no disagreement)', async () => {
      process.env.GATE_PLANT_ID_REFEREE = 'true';
      const geminiMiss = { ok: false, reason: 'provider_error' };
      const solHostLeg = {
        ok: true,
        json: {
          quality: OK_QUALITY, shows: 'plant', turf: [], weeds: [], host: [{ slug: 'fixture-citrus', off_catalog_name: '', group_id: null, confidence: 0.95, cues_visible: [1], cues_not_visible: [] }], observed_terms: [], conditions: [],
        },
      };
      [geminiMiss, solHostLeg].forEach((leg) => dispatch.mockResolvedValueOnce(leg));
      const result = await engine.identifyPlantV2({ photos: PHOTOS, subject: 'tree_shrub', mode: 'identify' });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(result.internal.referee).toEqual({ triggered: false, scopes: [], outcome: {} });
      expect(result.v2.answer).toMatchObject({ level: 'entry', node_id: 'fixture-citrus' });
    });
  });

  // ── Codex #5307 r7 referee regressions (narrowed design) ────────────────
  describe('Codex #5307 r7 referee regressions (name tie-breaks only)', () => {
    test('identify mode gets its own subject lanes; workup mode never gets any (owner ruling 2026-09-29)', () => {
      expect(engine._test.refereeCandidateScopes({ subject: 'tree_shrub', mode: 'workup' })).toEqual([]);
      expect(engine._test.refereeCandidateScopes({ subject: 'palm', mode: 'workup' })).toEqual([]);
      expect(engine._test.refereeCandidateScopes({ subject: 'lawn', mode: 'workup' })).toEqual([]);
      expect(engine._test.refereeCandidateScopes({ subject: 'tree_shrub', mode: 'identify' })).toEqual(['host']);
      expect(engine._test.refereeCandidateScopes({ subject: 'palm', mode: 'identify' })).toEqual(['host']);
      expect(engine._test.refereeCandidateScopes({ subject: 'lawn', mode: 'identify' })).toEqual(['turf', 'weeds']);
    });

    test('a third referee answer never settles the tie, and the lane comes back untouched (no append, unlike the removed 2-of-3 shape)', () => {
      const turfIndex = engine.turfIndexFor();
      const bahia = {
        slug: 'fixture-bahia', offCatalogName: null, groupId: 'turfgrasses', confidence: 0.6, entry: turfIndex.find((e) => e.slug === 'fixture-bahia'), cuesVisible: [1], cuesNotVisible: [], checked: true, verified: true,
      };
      const stAug = {
        slug: 'fixture-st-augustine', offCatalogName: null, groupId: 'turfgrasses', confidence: 0.5, entry: turfIndex.find((e) => e.slug === 'fixture-st-augustine'), cuesVisible: [1], cuesNotVisible: [], checked: true, verified: true,
      };
      const escalation = {
        identityFlags: {
          turf: {
            disagreed: true, blockPrettySure: false, openaiAnswered: true, disagreementPair: [bahia, stAug],
          },
        },
        slots: { turf: [bahia, stAug] },
      };
      const refereeJson = { turf: [{ slug: 'fixture-seashore-paspalum', off_catalog_name: '', group_id: null, confidence: 0.99 }] };
      const merged = engine._test.mergeIdentityScope({ indexes: { turf: turfIndex } }, 'turf', escalation, refereeJson);
      expect(merged.outcome).toBe('no_majority');
      expect(merged.slots).toBeUndefined();
      expect(merged.flags).toBeUndefined();
    });

    test('no referee answer for the slot at all -> unavailable, no merge', () => {
      const turfIndex = engine.turfIndexFor();
      const bahia = {
        slug: 'fixture-bahia', offCatalogName: null, groupId: 'turfgrasses', confidence: 0.6, entry: turfIndex.find((e) => e.slug === 'fixture-bahia'), cuesVisible: [1], cuesNotVisible: [], checked: true, verified: true,
      };
      const stAug = {
        slug: 'fixture-st-augustine', offCatalogName: null, groupId: 'turfgrasses', confidence: 0.5, entry: turfIndex.find((e) => e.slug === 'fixture-st-augustine'), cuesVisible: [1], cuesNotVisible: [], checked: true, verified: true,
      };
      const escalation = {
        identityFlags: {
          turf: {
            disagreed: true, blockPrettySure: false, openaiAnswered: true, disagreementPair: [bahia, stAug],
          },
        },
        slots: { turf: [bahia, stAug] },
      };
      const merged = engine._test.mergeIdentityScope({ indexes: { turf: turfIndex } }, 'turf', escalation, { turf: [] });
      expect(merged.outcome).toBe('unavailable');
    });

    test('finding 1: an off-catalog third name in the SAME group does not settle the tie (sameCandidateKey alone would have matched it)', () => {
      const turfIndex = engine.turfIndexFor();
      const zoysia = engine.resolveIdentityCandidate({
        slug: '', off_catalog_name: 'Zoysia', group_id: 'turfgrasses', confidence: 0.6,
      }, turfIndex);
      const centipede = engine.resolveIdentityCandidate({
        slug: '', off_catalog_name: 'Centipede', group_id: 'turfgrasses', confidence: 0.5,
      }, turfIndex);
      const escalation = {
        identityFlags: {
          turf: {
            disagreed: true, blockPrettySure: false, openaiAnswered: true, disagreementPair: [zoysia, centipede],
          },
        },
        slots: { turf: [zoysia, centipede] },
      };
      // "Bermuda" is off-catalog, same group ('turfgrasses') as both sides —
      // `sameCandidateKey` alone (groupId only) would read this as matching
      // EITHER side. It matches neither name, so it must not settle.
      const thirdNameJson = { turf: [{ slug: '', off_catalog_name: 'Bermuda', group_id: 'turfgrasses', confidence: 0.9 }] };
      const noMatch = engine._test.mergeIdentityScope({ indexes: { turf: turfIndex } }, 'turf', escalation, thirdNameJson);
      expect(noMatch.outcome).toBe('no_majority');
      // A CATALOG referee answer in the same group never matches an
      // off-catalog side either (sameCandidateKey requires equal slugs once
      // either side has one).
      const catalogJson = { turf: [{ slug: 'fixture-bahia', off_catalog_name: '', group_id: null, confidence: 0.9 }] };
      const mixed = engine._test.mergeIdentityScope({ indexes: { turf: turfIndex } }, 'turf', escalation, catalogJson);
      expect(mixed.outcome).toBe('no_majority');
    });

    test('finding 1: an off-catalog referee answer matching a side\'s NAME (case/whitespace-insensitive) settles it', () => {
      const turfIndex = engine.turfIndexFor();
      const zoysia = engine.resolveIdentityCandidate({
        slug: '', off_catalog_name: 'Zoysia', group_id: 'turfgrasses', confidence: 0.6,
      }, turfIndex);
      const centipede = engine.resolveIdentityCandidate({
        slug: '', off_catalog_name: 'Centipede', group_id: 'turfgrasses', confidence: 0.5,
      }, turfIndex);
      const escalation = {
        identityFlags: {
          turf: {
            disagreed: true, blockPrettySure: false, openaiAnswered: true, disagreementPair: [zoysia, centipede],
          },
        },
        slots: { turf: [zoysia, centipede] },
      };
      const matchingNameJson = { turf: [{ slug: '', off_catalog_name: '  zoysia  ', group_id: 'turfgrasses', confidence: 0.9 }] };
      const matched = engine._test.mergeIdentityScope({ indexes: { turf: turfIndex } }, 'turf', escalation, matchingNameJson);
      expect(matched.outcome).toBe('settled');
      expect(matched.slots[0]).toBe(zoysia);
      expect(matched.flags.disagreed).toBe(false);
      expect(matched.flags.disagreementPair).toBeNull();
    });

    test('finding 4: earlierReadsFor\'s second read is exactly disagreementPair[1] — Sol\'s own ranked top for the slot (verified: already correct, made explicit)', () => {
      const geminiTop = { slug: 'fixture-st-augustine', offCatalogName: null, confidence: 0.95 };
      const solTop = { slug: 'fixture-bahia', offCatalogName: null, confidence: 0.9 };
      const escalation = {
        identityFlags: { turf: { disagreementPair: [geminiTop, solTop] } },
      };
      const reads = engine._test.earlierReadsFor(escalation, ['turf']);
      expect(reads).toEqual([{ scope: 'turf', first: { slug: 'fixture-st-augustine', confidence: 0.95 }, second: { slug: 'fixture-bahia', confidence: 0.9 } }]);
    });

    test('finding 7: describeIdentityRead reads the normalized offCatalogName field, not the raw off_catalog_name', () => {
      const resolved = engine.resolveIdentityCandidate({
        slug: '', off_catalog_name: 'Mystery Grass', group_id: null, confidence: 0.5,
      }, []);
      expect(engine._test.describeIdentityRead(resolved)).toEqual({ slug: 'Mystery Grass', confidence: 0.5 });
    });
  });
});

describe('plant-engine — schema-invalid answers flip their ledger row (Codex #5186 round 2, finding 7)', () => {
  let engine; let rejectCall;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../services/species-catalog', () => require('./helpers/plant-engine-fixtures').FIXTURE);
    jest.doMock('../services/llm/call', () => ({
      ...jest.requireActual('../services/llm/call'),
      dispatch: jest.fn(),
      rejectCall: jest.fn(),
    }));
    ({ rejectCall } = require('../services/llm/call'));
    engine = require('../services/photo-id-v2/plant-engine');
  });
  afterAll(() => {
    jest.dontMock('../services/species-catalog');
    jest.dontMock('../services/llm/call');
    jest.resetModules();
  });

  test('an ok result whose JSON fails the schema is rejected in the ledger with a schema_invalid reason, and a valid one is not', () => {
    const invalid = { ok: true, json: { turf: 'not-an-array' }, provider: 'gemini', model: 'gemini-3.8-flash-test' };
    expect(engine._test.validJson(invalid, 'candidatesA')).toBeNull();
    expect(rejectCall).toHaveBeenCalledTimes(1);
    expect(rejectCall).toHaveBeenCalledWith(invalid, `${engine._test.SCHEMA_INVALID_REASON}:candidatesA`);
    const valid = { ok: true, json: { quality: { usable: true, issue: 'none' }, shows: 'plant', turf: [], weeds: [], host: [] } };
    expect(engine._test.validJson(valid, 'candidatesA')).toBe(valid.json);
    expect(rejectCall).toHaveBeenCalledTimes(1);
    // A failed leg (ok:false) is already a failure in the ledger — never re-rejected.
    expect(engine._test.validJson({ ok: false, reason: 'provider_error' }, 'candidatesA')).toBeNull();
    expect(rejectCall).toHaveBeenCalledTimes(1);
  });

  test('the rejection names the dispatcher\'s OWN result object, not the provider-stamped copy (the ledger keys rows by identity)', async () => {
    const { dispatch } = require('../services/llm/call');
    rejectCall.mockClear();
    const original = { ok: true, json: { turf: 'not-an-array' }, model: 'gemini-3.8-flash-test' };
    dispatch.mockResolvedValueOnce(original);
    const stamped = await engine._test.callWithProvider({ provider: 'gemini', model: 'gemini-3.8-flash-test' }, { text: 'x' });
    expect(stamped).not.toBe(original);
    expect(stamped.provider).toBe('gemini');
    expect(engine._test.validJson(stamped, 'candidatesA')).toBeNull();
    expect(rejectCall).toHaveBeenCalledTimes(1);
    expect(rejectCall.mock.calls[0][0]).toBe(original);
  });
});

describe('plant-engine — real catalog', () => {
  let catalog; let engine;

  beforeAll(() => {
    catalog = require('../services/species-catalog');
    engine = require('../services/photo-id-v2/plant-engine');
  });

  test('unnamed identity safety line (Codex #5186 r6 P1): every real hazardous plant\'s own hazards reach its group\'s line', () => {
    const clauses = engine.UNNAMED_PLANT_SAFETY_CLAUSES;
    const lineFor = engine._test.unnamedPlantSafetyLineFor;
    const hazardous = catalog.listEntries({ section: 'plant' })
      .filter((e) => e.risk === 'medical' || e.risk === 'irritant' || e.safety?.irritant || e.safety?.toxic_to_pets);
    expect(hazardous.map((e) => e.slug)).toEqual(expect.arrayContaining(['sago-palm', 'oleander', 'spotted-spurge']));
    for (const entry of hazardous) {
      const line = lineFor('tree_shrub', entry.group);
      expect(line.startsWith(clauses.base)).toBe(true);
      if (entry.risk === 'medical') expect(line).toContain(clauses.swallowed);
      if (entry.safety?.irritant || entry.risk === 'irritant') expect(line).toContain(clauses.irritant);
      if (entry.safety?.toxic_to_pets) expect(line).toContain(clauses.pets);
    }
    expect(lineFor('palm', null)).toContain(clauses.pets); // sago palm is in the palm index
  });

  test('unnamed identity safety line (Codex #5186 r7 P1): date palm spines reach the palm lines, and no plant\'s own warning is dropped', () => {
    const lineFor = engine._test.unnamedPlantSafetyLineFor;
    const { puncture } = engine.UNNAMED_PLANT_SAFETY_CLAUSES;
    expect(lineFor('palm', 'palms')).toContain(puncture);
    expect(lineFor('palm', 'date-palms')).toContain(puncture);
    // Every plant with its own safety line triggers at least one clause. If this fails, a new
    // hazard is written only as text: give it a structured trigger in PLANT_HAZARD_CLAUSES.
    for (const entry of catalog.listEntries({ section: 'plant' }).filter((e) => e.safety_line)) {
      expect([entry.slug, lineFor('tree_shrub', entry.slug)]).not.toEqual([entry.slug, null]);
    }
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

  test('conditionIndexFor(lawn, st-augustinegrass): a draft condition never enters the index; owner-approved lawn pest possibilities do', () => {
    const index = engine.conditionIndexFor('lawn', 'st-augustinegrass');
    expect(index.map((e) => e.slug)).toContain('chinch-bug'); // approved pest possibility
    for (const entry of index) expect(catalog.isApproved(entry)).toBe(true);
  });

  test('naming gate walk over every real condition entry: with every element visible at 0.9 confidence, only an approved, confirmable_by "photo" entry can be named', () => {
    const conditions = catalog.listEntries({ section: 'condition' });
    expect(conditions.length).toBeGreaterThan(0);
    let sawPhotoConfirmable = false;
    for (const entry of conditions) {
      const sig = engine.signatureFor(entry);
      const elementsVisible = entry.condition.required_signature.elements.map((_, i) => i + 1);
      const possibility = { slug: entry.slug, entry, sig, confidence: 0.9, elementsVisible: new Set(elementsVisible), signsVisible: new Set(), symptomsVisible: new Set() };
      if (sig.confirmableBy === 'photo') sawPhotoConfirmable = true;
      // A draft, or a condition a photo cannot confirm, is never named.
      if (!catalog.isApproved(entry) || sig.confirmableBy !== 'photo') expect(engine.namedAnswerFor([possibility], possibility)).toBeNull();
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

  test('a real-catalog lawn workup never shows or names a draft condition, however confident the read', () => {
    const built = engine.buildWorkup({
      subject: 'lawn',
      // Simulate Call C selecting every real condition entry that hosts turf,
      // fully confident and fully visible — a draft among them still never shows.
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
    const drafts = new Set(catalog.listEntries({ section: 'condition' }).filter((e) => !catalog.isApproved(e)).map((e) => e.slug));
    expect(built.possibilities.filter((p) => drafts.has(p.slug))).toEqual([]);
    expect(drafts.has(built.answer.node_id)).toBe(false);
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
