// Lawn report "From your technician" paragraph (GATE_LAWN_TECH_PARAGRAPH), FIXED
// SENTENCES (owner 2026-10-06, the tree & shrub design): the model only extracts
// closed-list ids plus a quote and a seen-today judgment from the technician's
// note; code verifies the quote and writes every word from LAWN_SENTENCES. These
// tests pin (1) the sentence list the owner approved, (2) that free text, advice,
// comparisons and color words cannot reach the output, (3) the quote check, (4)
// the deterministic lines, (5) the model call and (6) the freeze and read-back.
// Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const fs = require('fs');
const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const tech = require('../services/service-report/lawn-tech-paragraph');

const { LAWN_SENTENCES, CONDITIONS, PLACES, FINDING_LABELS, FINDING_OF_PHOTO_LABEL } = tech;

const NOTE = 'Found chinch bugs in the front lawn and crabgrass along the side yard. Applied Arena and fertilizer.';
const PRODUCTS = [{ name: 'Arena 50 WDG' }, { name: 'LESCO 24-0-11' }];
const inputs = (over = {}) => tech.normalizeInputs({ technicianNote: NOTE, products: PRODUCTS, findings: [], ...over });
const defaultQuote = (condition, place) => {
  const c = CONDITIONS[condition] ? CONDITIONS[condition].display : String(condition);
  return PLACES[place] ? `${c} in the ${PLACES[place].display}` : c;
};
const obs = (condition, place = 'none', seenToday = true, quote = defaultQuote(condition, place)) => ({ condition, place, quote, seenToday });
const slotsFor = (over, observations) => {
  const i = inputs(over);
  return tech.buildSlots(i, tech.verifyObservations(observations, i.technicianNote));
};
const textFor = (over, observations) => tech.render(slotsFor(over, observations));

const shapeRegexes = () => Object.values(LAWN_SENTENCES).map((tpl) => new RegExp(`^${tpl.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')}$`));
const onlyTemplateShapes = (text) => text.split(/(?<=\.)\s+/).every((s) => shapeRegexes().some((re) => re.test(s)));

beforeEach(() => dispatchWithFallback.mockReset());

describe('LAWN_SENTENCES is the only source of words (owner approved 2026-10-06)', () => {
  test('exactly the approved list: saw / may be / applied, nothing else', () => {
    expect(Object.isFrozen(LAWN_SENTENCES)).toBe(true);
    expect(LAWN_SENTENCES).toEqual({
      observed: 'Our technician saw {items}.',
      observedItemWithPlace: '{condition} {prep} the {place}',
      observedItem: '{condition}',
      maybe: 'There may be early signs of {labels}; we will keep an eye on it.',
      products: 'Today we applied {products}.',
    });
  });

  test('the approved problems and places', () => {
    expect(Object.values(CONDITIONS).map((c) => c.display)).toEqual([
      'chinch bugs', 'grubs', 'armyworms', 'sod webworms', 'mole crickets', 'billbugs', 'large patch', 'brown patch',
      'gray leaf spot', 'dollar spot', 'nutsedge', 'crabgrass', 'dollarweed', 'spurge', 'clover', 'goosegrass', 'weeds',
      'thin turf', 'yellowing grass',
    ]);
    expect(Object.values(PLACES).map((p) => `${p.prep} the ${p.display}`)).toEqual(['in the front lawn', 'in the back lawn', 'in the side yard']);
  });

  test('a full paragraph is the three sentences in the fixed order', () => {
    const text = textFor({ findings: [{ key: 'thinning_turf' }] }, [obs('chinch_bugs', 'front_lawn'), obs('crabgrass', 'side_yard', true, 'crabgrass along the side yard')]);
    expect(text).toBe('Our technician saw chinch bugs in the front lawn and crabgrass in the side yard. There may be early signs of thinning turf; we will keep an eye on it. Today we applied Arena 50 WDG and LESCO 24-0-11.');
    expect(onlyTemplateShapes(text)).toBe(true);
  });

  test('no take-all, no root rot, no color word, no comparison or progress word in any list or template', () => {
    const all = JSON.stringify([...Object.keys(CONDITIONS), ...Object.values(CONDITIONS).map((c) => c.display), ...Object.values(PLACES).map((p) => p.display), ...Object.values(FINDING_LABELS), ...Object.values(LAWN_SENTENCES)]);
    expect(all).not.toMatch(/take|root\s*rot|colou?r|green|brown(?!_patch| patch)|darker|lighter|better|worse|improv|since|than|thicker|healthier/i);
  });
});

describe('problems are grouped by place (owner trial 2026-10-06)', () => {
  test('several problems at one place share one phrase', () => {
    const text = tech.render({ observed: [{ condition: 'clover', place: 'back_lawn' }, { condition: 'spurge', place: 'back_lawn' }, { condition: 'goosegrass', place: 'back_lawn' }], maybe: [], products: [] });
    expect(text).toBe('Our technician saw clover, spurge and goosegrass in the back lawn.');
  });

  test('places keep their first-seen order; problems with no place come last and are never placed', () => {
    expect(tech.render({ observed: [{ condition: 'gray_leaf_spot', place: 'back_lawn' }, { condition: 'grubs', place: 'front_lawn' }, { condition: 'thin_turf', place: 'front_lawn' }], maybe: [], products: [] }))
      .toBe('Our technician saw gray leaf spot in the back lawn and grubs and thin turf in the front lawn.');
    expect(tech.render({ observed: [{ condition: 'dollarweed', place: 'none' }, { condition: 'nutsedge', place: 'side_yard' }], maybe: [], products: [] }))
      .toBe('Our technician saw nutsedge in the side yard and dollarweed.');
  });
});

describe('free text can never reach the output', () => {
  const HOSTILE = [
    { condition: 'It went on the front lawn.', place: 'front_lawn', seenToday: true, quote: 'It went on the front lawn.' },
    { condition: 'take_all', place: 'none', seenToday: true, quote: 'take-all' },
    { condition: 'chinch_bugs', place: 'the whole yard', seenToday: true, quote: 'chinch bugs' },
    { condition: 'chinch_bugs', place: 'none', seenToday: true, quote: 'chinch bugs', text: 'Water deeply twice a week.' },
    { paragraph: 'The lawn is greener than last time. Mow high.' },
  ];

  test('only template shapes render, whatever the answer carries', () => {
    const slots = slotsFor({}, HOSTILE);
    expect(slots.observed).toEqual([{ condition: 'chinch_bugs', place: 'none' }]);
    const text = tech.render(slots);
    expect(text).toBe('Our technician saw chinch bugs. Today we applied Arena 50 WDG and LESCO 24-0-11.');
    expect(onlyTemplateShapes(text)).toBe(true);
    for (const forbidden of [/water/i, /mow/i, /greener|than/i, /take/i, /whole yard/i, /went/i]) expect(text).not.toMatch(forbidden);
  });

  test('the prompt shows only the note; the system prompt carries the closed lists; the schema is closed enums', () => {
    const prompt = tech.buildPrompt(inputs());
    expect(prompt.text).toContain(NOTE);
    expect(prompt.text).not.toMatch(/LESCO|24-0-11|50 WDG/); // the product list never reaches the prompt
    for (const id of Object.keys(CONDITIONS)) expect(prompt.system).toContain(id);
    expect(prompt.promptVersion).toBe('lawn_tech_paragraph_v2');
    const item = prompt.jsonSchema.properties.observations.items;
    expect(item.required).toEqual(['condition', 'place', 'quote', 'seenToday']);
    expect(item.properties.condition.enum).toEqual(Object.keys(CONDITIONS));
    expect(item.properties.place.enum).toEqual([...Object.keys(PLACES), 'none']);
    expect(JSON.stringify(prompt.jsonSchema)).not.toMatch(/minimum|maximum|minItems|maxItems/);
  });

  test('there is no sighting, negation, purpose or time word list in the module (do not grow one)', () => {
    const src = fs.readFileSync(require.resolve('../services/service-report/lawn-tech-paragraph.js'), 'utf8');
    expect(src).not.toMatch(/\b(?:NEGATION_RE|HEDGE_RE|UNSURE_RE|TEMPORAL_RE|SIGHTING_RE|OBSERVED_CUE_RE|PURPOSE_CUE_RE|PURPOSE_RE|PRIOR_REF_RE)\b/);
  });
});

describe('the model judges, the code verifies the quote', () => {
  const verify = (note, ...items) => tech.verifyObservations(items, note);

  test('a quote copied from one note sentence, naming the condition, is kept with its place', () => {
    expect(verify('Found chinch bugs in the front lawn.', obs('chinch_bugs', 'front_lawn'))).toEqual([{ condition: 'chinch_bugs', place: 'front_lawn' }]);
    expect(verify('FOUND  Chinch bugs in the front lawn.', obs('chinch_bugs', 'front_lawn', true, 'found chinch bugs in the front lawn.'))).toEqual([{ condition: 'chinch_bugs', place: 'front_lawn' }]);
  });

  test('the place stays only when the quote names it', () => {
    expect(verify('Found grubs. Edged the front lawn.', obs('grubs', 'front_lawn', true, 'found grubs'))).toEqual([{ condition: 'grubs', place: null }]);
  });

  test('the model saying it was not a sighting today drops the item', () => {
    for (const note of ['Applied Arena for chinch bugs in the front lawn.', 'Last visit we saw chinch bugs in the front lawn.', 'No chinch bugs in the front lawn.']) {
      expect(verify(note, obs('chinch_bugs', 'front_lawn', false, 'chinch bugs in the front lawn'))).toEqual([]);
    }
  });

  test('a quote not in the note, across two sentences, missing the condition, or too long is dropped', () => {
    const note = 'Found grubs in the back lawn. Fed the lawn.';
    expect(verify(note, obs('grubs', 'back_lawn', true, 'saw many grubs in the back lawn'))).toEqual([]);
    expect(verify(note, obs('grubs', 'back_lawn', true, 'grubs in the back lawn. fed the lawn'))).toEqual([]);
    expect(verify(note, obs('grubs', 'none', true, 'fed the lawn'))).toEqual([]);
    expect(verify(note, obs('grubs', 'none', true, ''))).toEqual([]);
    expect(verify(`${'x'.repeat(250)} grubs.`, obs('grubs', 'none', true, `${'x'.repeat(250)} grubs`))).toEqual([]);
  });

  test('generic "weeds" whose quote names a specific weed becomes that weed, and never prints twice', () => {
    const note = 'Found crabgrass and dollarweed in the back lawn.';
    expect(verify(note, obs('weeds', 'back_lawn', true, 'found crabgrass and dollarweed in the back lawn'), obs('crabgrass', 'back_lawn', true, 'crabgrass')))
      .toEqual([{ condition: 'crabgrass', place: 'back_lawn' }]);
    expect(verify('Found weeds in the front lawn.', obs('weeds', 'front_lawn', true, 'found weeds in the front lawn'))).toEqual([{ condition: 'weeds', place: 'front_lawn' }]);
  });

  test('an unknown id, a repeat, a malformed item and everything past three are dropped', () => {
    const note = 'Found chinch bugs, grubs, armyworms and billbugs in the front lawn.';
    const out = verify(note, obs('chinch_bugs'), obs('chinch_bugs', 'front_lawn'), obs('take_all'), null, 'x', obs('grubs'), obs('armyworms'), obs('billbugs'));
    expect(out.map((o) => o.condition)).toEqual(['chinch_bugs', 'grubs', 'armyworms']);
  });
});

describe('deterministic lines', () => {
  test('a "may be" line comes from low-confidence photo findings the note does not cover, at most two', () => {
    const findings = [{ key: 'thinning_turf' }, { key: 'nutrient_stress' }, { key: 'lawn_stress' }];
    expect(textFor({ technicianNote: 'Applied Arena.', products: [], findings }, []))
      .toBe('There may be early signs of thinning turf and nutrient stress; we will keep an eye on it.');
    // The note wins: a note that mentions thin turf (even to deny it) covers the photo signal.
    expect(textFor({ technicianNote: 'No thin spots today.', products: [], findings: [{ key: 'thinning_turf' }] }, [])).toBe('');
  });

  test('both color photo labels read "nutrient stress"; the generic monitoring label is never named', () => {
    expect(FINDING_OF_PHOTO_LABEL['color stress']).toBe('nutrient_stress');
    expect(FINDING_OF_PHOTO_LABEL['color and nutrient stress']).toBe('nutrient_stress');
    expect(FINDING_OF_PHOTO_LABEL).not.toHaveProperty(['a lawn condition we are monitoring']);
  });

  test('a long catalog product name is printed whole, never cut (Codex r1: an 82-character row exists)', () => {
    const name = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
    expect(name.length).toBeGreaterThan(80);
    expect(textFor({ technicianNote: '', products: [{ name }] }, [])).toBe(`Today we applied ${name}.`);
  });

  test('the products line lists display names only, up to five', () => {
    const many = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((name) => ({ name }));
    expect(textFor({ technicianNote: '', products: many }, [])).toBe('Today we applied A1, B2, C3, D4 and E5.');
  });

  test('no all-clear, confirmed or progress line exists: a quiet visit with no products says nothing', () => {
    expect(textFor({ technicianNote: '', products: [] }, [])).toBe('');
  });

  test('a real catalog name the copy screen would mistake for an access code still prints (Codex r2)', () => {
    const combo = 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer';
    const text = textFor({ technicianNote: '', products: [{ name: combo }] }, []);
    expect(text).toBe(`Today we applied ${combo}.`);
    const slots = { observed: [], maybe: [], products: [combo] };
    expect(tech.readFrozenTechParagraph({ lawnTechParagraph: { 77: { v: tech.FREEZE_VERSION, assessmentId: '77', text, slots } } }, 77)).toBe(text);
  });

  test('a catalog name is still screened in full: only its credential nouns are neutralized (Codex r3)', () => {
    expect(textFor({ technicianNote: '', products: [{ name: 'Pet-safe Lawn Treatment' }] }, [])).toBe('');
    expect(textFor({ technicianNote: '', products: [{ name: 'Gate Code 4545 Blend' }] }, [])).toBe('');
    expect(textFor({ technicianNote: '', products: [{ name: 'Gate Combo 4545 Blend' }] }, [])).toBe('');
    // Only the exact known catalog name is exempt (Codex r5).
    for (const name of ['Security Combo 1234', 'Visitor Combo 4545', 'Combo 1234', 'LESCO High Manganese Combo 1234']) {
      expect(textFor({ technicianNote: '', products: [{ name }] }, [])).toBe('');
    }
    const slots = { observed: [], maybe: [], products: ['Pet-safe Lawn Treatment'] };
    expect(tech.readFrozenTechParagraph({ lawnTechParagraph: { 77: { v: tech.FREEZE_VERSION, assessmentId: '77', text: 'Today we applied Pet-safe Lawn Treatment.', slots } } }, 77)).toBeNull();
    // The other sentences survive a bad name.
    expect(textFor({ technicianNote: 'Found grubs.', products: [{ name: 'Pet-safe Lawn Treatment' }] }, [obs('grubs', 'none', true, 'found grubs')])).toBe('Our technician saw grubs.');
  });

  test('the text is fitted to the lead\'s own word cap: extra product names drop from the end, never a cut word', () => {
    const { FIELD_WORD_CAPS } = require('../services/service-report/lawn-report-lead');
    expect(tech.MAX_WORDS).toBe(FIELD_WORD_CAPS.techParagraph);
    const long = (c) => `${c} ${'Turf Builder Pro Granular Formula '.repeat(4).trim()}`;
    const slots = {
      observed: [{ condition: 'chinch_bugs', place: 'front_lawn' }, { condition: 'gray_leaf_spot', place: 'back_lawn' }, { condition: 'mole_crickets', place: 'side_yard' }],
      maybe: ['thinning_turf', 'nutrient_stress'],
      products: ['A', 'B', 'C', 'D', 'E'].map(long),
    };
    const text = tech.render(slots);
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(tech.MAX_WORDS);
    expect(text).toMatch(/^Our technician saw chinch bugs in the front lawn, gray leaf spot in the back lawn and mole crickets in the side yard\./);
    expect(text).toContain(long('A'));
    expect(text).not.toContain(long('E'));
    expect(onlyTemplateShapes(text)).toBe(true);
    // Same slots, same text: the frozen entry reads back.
    const entry = { v: tech.FREEZE_VERSION, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text, slots };
    expect(tech.readFrozenTechParagraph({ lawnTechParagraph: { 77: entry } }, 77)).toBe(text);
  });

  test('every legal render is within the read-time character cap', () => {
    const slots = { observed: [], maybe: [], products: ['A', 'B', 'C', 'D', 'E'].map((c) => `${c}${'x'.repeat(tech.MAX_PRODUCT_NAME_CHARS - 1)}`) };
    expect(tech.render(slots).length).toBeLessThanOrEqual(tech.MAX_TEXT_CHARS);
  });
});

describe('the model call (extraction only)', () => {
  const goodAnswer = { observations: [obs('chinch_bugs', 'front_lawn'), obs('crabgrass', 'side_yard', true, 'crabgrass along the side yard')] };

  test('one call through the report policy on lane lawn_tech_paragraph; the paragraph is rendered from slots', async () => {
    dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
      const result = { ok: true, json: goodAnswer, provider: 'openai' };
      return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
    });
    const out = await tech.generateTechParagraph(inputs());
    expect(out).toMatchObject({ ok: true, paragraph: 'Our technician saw chinch bugs in the front lawn and crabgrass in the side yard. Today we applied Arena 50 WDG and LESCO 24-0-11.' });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.report);
    expect(payload).toMatchObject({ laneId: 'lawn_tech_paragraph', promptVersion: 'lawn_tech_paragraph_v2', jsonMode: true });
    expect(options).toMatchObject({ hardDeadline: true, reserveFallbackBudget: true });
  });

  test('an item outside the schema makes the whole answer a miss, so the backup provider runs', () => {
    const v = (observations) => tech.validateExtraction({ observations }, inputs());
    expect(v([obs('take_all')])).toMatchObject({ ok: false, problems: ['malformed_item'] });
    expect(v([{ condition: 'chinch_bugs', place: 'none' }])).toMatchObject({ ok: false, problems: ['malformed_item'] });
    expect(v([obs('chinch_bugs', 'whole_yard')])).toMatchObject({ ok: false });
    expect(v([obs('chinch_bugs', 'front_lawn')])).toMatchObject({ ok: true });
  });

  test('model failure: deterministic lines only', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const out = await tech.generateTechParagraph(inputs({ findings: [{ key: 'lawn_stress' }] }));
    expect(out.paragraph).toBe('There may be early signs of lawn stress; we will keep an eye on it. Today we applied Arena 50 WDG and LESCO 24-0-11.');
  });

  test('no technician note: no model call, deterministic lines still produce a paragraph', async () => {
    const out = await tech.generateTechParagraph(inputs({ technicianNote: '' }));
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(out.paragraph).toBe('Today we applied Arena 50 WDG and LESCO 24-0-11.');
  });

  test('a short note is still read', async () => {
    const callModel = jest.fn(async () => ({ ok: true, json: { observations: [obs('grubs', 'none', true, 'grubs')] } }));
    const out = await tech.generateTechParagraph(inputs({ technicianNote: 'Grubs.' }), { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(out.paragraph).toMatch(/^Our technician saw grubs\./);
  });

  test('nothing to say at all: not ok', async () => {
    expect(await tech.generateTechParagraph(inputs({ technicianNote: '', products: [] }))).toEqual({ ok: false, reason: 'nothing_to_say' });
  });
});

describe('freeze and read back', () => {
  const SLOTS = { observed: [{ condition: 'chinch_bugs', place: 'front_lawn' }], maybe: [], products: ['Arena 50 WDG'] };
  const TEXT = tech.render(SLOTS);
  const ENTRY = { v: 2, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text: TEXT, slots: SLOTS, frozenAt: '2026-10-06T12:00:00.000Z' };
  const notes = (entry = ENTRY) => JSON.stringify({ lawnTechParagraph: { 77: entry } });

  test('reads only a v2 entry whose text equals render(slots); a v1 free-text entry never prints', () => {
    expect(tech.FREEZE_KEY).toBe('lawnTechParagraph');
    expect(tech.FREEZE_VERSION).toBe(2);
    expect(tech.readFrozenTechParagraph(notes(), 77)).toBe(TEXT);
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, v: 1 }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ v: 1, assessmentId: '77', text: 'Our technician saw chinch bugs, and the lawn looks greener than last time.' }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(JSON.stringify({ treeShrubTechParagraph: { 77: ENTRY } }), 77)).toBeNull();
  });

  test('a hand-edited text or drifted slots print nothing', () => {
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: `${TEXT} Mow high.` }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, slots: { ...SLOTS, observed: [{ condition: 'grubs', place: 'none' }] } }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, slots: undefined }), 77)).toBeNull();
  });

  test('the PDF signature is empty without a paragraph and follows the text', () => {
    expect(tech.techParagraphSignature('{}', 77)).toBe('');
    const a = tech.techParagraphSignature(notes(), 77);
    expect(a).toMatch(/^:tp=[0-9a-f]{8}$/);
    const other = { ...SLOTS, products: ['Arena 50 WDG', 'LESCO 24-0-11'] };
    expect(tech.techParagraphSignature(notes({ ...ENTRY, text: tech.render(other), slots: other }), 77)).not.toBe(a);
  });

  function fakeKnex(initial = {}) {
    const state = { notes: JSON.parse(JSON.stringify(initial)), updates: 0 };
    const knex = () => {
      const q = { guardKey: null };
      q.where = () => q;
      q.whereRaw = (_sql, bindings) => { q.guardKey = bindings[0]; return q; };
      q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
      q.update = async ({ structured_notes: raw }) => {
        state.updates += 1;
        if ((state.notes.lawnTechParagraph || {})[q.guardKey]) return 0;
        state.notes.lawnTechParagraph = { ...(state.notes.lawnTechParagraph || {}), ...JSON.parse(raw.bindings[0]) };
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }

  test('createAndFreeze stores { text, slots, v: 2 }; nothing to say writes a marker so a resume makes no second call', async () => {
    const runOn = (db) => (extra = {}) => tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: extra.structuredNotes || '{}', knex: db.knex, gatherInputs: async () => inputs(), deps: extra.deps });
    const markerDb = fakeKnex();
    expect((await runOn(markerDb)({ deps: { generate: async () => ({ ok: false, reason: 'nothing_to_say' }) } })).status).toBe('nothing_to_say');
    expect(markerDb.state.updates).toBe(1);
    const again = jest.fn();
    expect((await runOn(markerDb)({ structuredNotes: JSON.stringify(markerDb.state.notes), deps: { generate: again } })).status).toBe('already_frozen');
    expect(again).not.toHaveBeenCalled();
    expect(tech.readFrozenTechParagraph(markerDb.state.notes, 77)).toBeNull();

    const db = fakeKnex();
    dispatchWithFallback.mockImplementation(async (_p, _pl, options) => {
      const result = { ok: true, json: { observations: [obs('chinch_bugs', 'front_lawn')] } };
      return options.validate(result) ? { ok: false, reason: 'x' } : result;
    });
    const frozen = await runOn(db)({ deps: { now: () => new Date('2026-10-06T12:00:00Z') } });
    expect(frozen.status).toBe('frozen');
    const entry = db.state.notes.lawnTechParagraph['77'];
    expect(entry).toMatchObject({ v: 2, promptVersion: 'lawn_tech_paragraph_v2', assessmentId: '77', text: 'Our technician saw chinch bugs in the front lawn. Today we applied Arena 50 WDG and LESCO 24-0-11.' });
    expect(tech.readFrozenTechParagraph(db.state.notes, 77)).toBe(entry.text);
  });
});
