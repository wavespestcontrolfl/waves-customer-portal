// Tree & shrub report "From your technician" paragraph (GATE_TS_TECH_PARAGRAPH),
// FIXED-SENTENCE design (owner 2026-10-05): the model only extracts closed-list
// ids from the technician's note; code verifies them against the note and writes
// every word from TS_SENTENCES. These tests pin (1) that every Codex round 1 and
// round 2 example is impossible by construction, (2) the note checks, (3) the
// deterministic lines, (4) the model call and (5) the freeze and read-back.
// Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const tech = require('../services/service-report/tree-shrub-tech-paragraph');

const { TS_SENTENCES, CONDITIONS, PLANTS, FINDING_LABELS } = tech;

const NOTE = 'Found scale on the hedges and sooty mold on the ixora. Applied Merit and fed the palms.';
const PRODUCTS = [{ name: 'Merit 2F' }, { name: 'Palm Gro 8-2-12' }];
const inputs = (over = {}) => tech.normalizeInputs({ technicianNote: NOTE, products: PRODUCTS, findings: [], landscapeCondition: null, ...over });
// A model item. The default quote is the plain phrase "{condition} on the {plant}"
// (or the condition alone), which the fixture notes contain word for word.
const defaultQuote = (condition, plant) => {
  const c = CONDITIONS_DISPLAY(condition);
  const p = tech.PLANTS[plant] ? tech.PLANTS[plant].display : null;
  return p ? `${c} on the ${p}` : c;
};
function CONDITIONS_DISPLAY(id) { return tech.CONDITIONS[id] ? tech.CONDITIONS[id].display : String(id); }
const obs = (condition, plant = 'none', seenToday = true, quote = defaultQuote(condition, plant)) => ({ condition, plant, quote, seenToday });
const slotsFor = (over, observations, opts) => {
  const i = inputs(over);
  return tech.buildSlots(i, tech.verifyObservations(observations, i.technicianNote), opts);
};
const textFor = (over, observations, opts) => tech.render(slotsFor(over, observations, opts));

// Every character of any output must come from these shapes: a regex built from
// TS_SENTENCES with each placeholder as a wildcard, plus the product names.
const shapeRegexes = () => Object.values(TS_SENTENCES).map((tpl) => new RegExp(`^${tpl.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')}$`.replace(/\\\{\\w\+\\\}/g, '.+')));
function sentencesOf(text) { return text.split(/(?<=\.)\s+/); }
const onlyTemplateShapes = (text) => sentencesOf(text).every((s) => shapeRegexes().some((re) => re.test(s)));

describe('TS_SENTENCES is the only source of words', () => {
  test('it is frozen, small and readable: the owner approves exactly this', () => {
    expect(Object.isFrozen(TS_SENTENCES)).toBe(true);
    expect(TS_SENTENCES).toEqual({
      observed: 'Our technician saw {items}.',
      observedItemWithPlant: '{condition} on the {plant}',
      observedItem: '{condition}',
      maybe: 'There may be early signs of {labels}; we will keep an eye on it.',
      confirmed: 'Our technician confirmed signs of {labels}.',
      products: 'Today we applied {products}.',
      allClear: 'Your landscape looked {rating} today.',
    });
  });

  test('a full paragraph is the five sentences in the fixed order, nothing else', () => {
    const text = textFor(
      { findings: [{ key: 'water_heat_mechanical_stress', kind: 'maybe' }, { key: 'foliage_fullness', kind: 'confirmed' }] },
      [obs('scale', 'hedges'), obs('sooty_mold')],
    );
    expect(text).toBe('Our technician saw scale on the hedges and sooty mold. There may be early signs of stress; we will keep an eye on it. Our technician confirmed signs of thin foliage. Today we applied Merit 2F and Palm Gro 8-2-12.');
    expect(onlyTemplateShapes(text)).toBe(true);
  });

  test('the all-clear line comes last', () => {
    expect(textFor({ landscapeCondition: 'Excellent', technicianNote: '' }, [])).toBe('Today we applied Merit 2F and Palm Gro 8-2-12. Your landscape looked excellent today.');
  });
});

describe('Codex round 1 and 2 examples are impossible by construction', () => {
  // A hostile model answer: every field is either a closed-list id or ignored.
  const HOSTILE = [
    { condition: 'It went on the palms.', plant: 'palms', seenToday: true, quote: 'It went on the palms.' },
    { condition: 'pruning', plant: 'hedges', seenToday: true, quote: 'scale on the hedges' },
    { condition: 'scale', plant: 'the front yard', seenToday: true, quote: 'scale' },
    { condition: 'imidacloprid', plant: 'none', seenToday: true, quote: 'Applied Merit' },
    { condition: 'scale', plant: 'none', seenToday: true, quote: 'scale', text: 'Prune the hedge again.' },
    { paragraph: 'The photos found scale. Prune the hedge.' },
  ];

  test('free text in any field never reaches the output', () => {
    const slots = slotsFor({}, HOSTILE);
    expect(slots.observed).toEqual([{ condition: 'scale', plant: 'none' }]);
    const text = tech.render(slots);
    expect(text).toBe('Our technician saw scale. Today we applied Merit 2F and Palm Gro 8-2-12.');
    for (const forbidden of [/palms/i, /prune/i, /again/i, /photos/i, /imidacloprid/i, /yard/i, /before/i]) expect(text).not.toMatch(forbidden);
  });

  test('cross-sentence placement ("It went on the palms"), gerund advice, "again/before", photo attribution and passive voice have no template', () => {
    const everyTemplate = Object.values(TS_SENTENCES).join(' ').replace(/\{\w+\}/g, '_');
    // No sentence starts with a pronoun ("It went on the palms" has no template).
    for (const tpl of Object.values(TS_SENTENCES)) expect(tpl).not.toMatch(/^(?:it|they|this|that|these|those|we)\b/i);
    for (const shape of [/\bwent\b/i, /\bagain\b/i, /\bbefore\b/i, /\bphotos?\b/i, /\bwas\b|\bwere\b|\bbeen\b/i, /\b\w+ing\b/i]) {
      expect(everyTemplate).not.toMatch(shape);
    }
    // And no model-controlled field carries a verb: ids and display names only.
    for (const { display } of [...Object.values(CONDITIONS), ...Object.values(PLANTS)]) expect(display).not.toMatch(/\b(?:prune|trim|water|fertilize|apply|applied|put|went)\b/i);
    for (const label of Object.values(FINDING_LABELS)) expect(label).not.toMatch(/\b(?:photos?|found|confirmed)\b/i);
  });

  test('a product sentence names no plant or place; an observed sentence names no product', () => {
    const text = textFor({}, [obs('scale', 'hedges')]);
    const [observed, products] = sentencesOf(text);
    expect(observed).not.toMatch(/Merit|Palm Gro/);
    expect(products).toBe('Today we applied Merit 2F and Palm Gro 8-2-12.');
    expect(products).not.toMatch(/hedges|palms|shrubs|trees|plants|beds/);
  });

  test('no active ingredient exists in the inputs, the prompt or the output', () => {
    const i = tech.normalizeInputs({ technicianNote: 'Found scale on the hedges.', products: [{ name: 'Merit 2F', activeIngredient: 'imidacloprid', targets: ['scale'], method: 'drench' }] });
    expect(JSON.stringify(i)).not.toMatch(/imidacloprid|drench|targets/);
    expect(tech.buildPrompt(i).text).not.toMatch(/imidacloprid|Merit|drench/);
  });

  test('the headline, the last visit and the watch list are not inputs', () => {
    const i = tech.normalizeInputs({ technicianNote: NOTE, products: PRODUCTS, facts: { headline: 'Healthy — monitoring pest pressure' }, prior: { date: '2026-08-12', products: [{ name: 'Safari 20 SG' }] }, watchItems: [{ key: 'scale', state: 'seen' }] });
    expect(Object.keys(i).sort()).toEqual(['findings', 'landscapeCondition', 'products', 'technicianNote']);
    expect(JSON.stringify(tech.buildPrompt(i))).not.toMatch(/headline|Safari|watch/i);
  });

  test('the prompt shows only the note; the system prompt carries the closed lists', () => {
    const prompt = tech.buildPrompt(inputs({ technicianNote: 'Found scale on the hedges and sooty mold on the ixora.' }));
    expect(prompt.text).toContain('Found scale on the hedges and sooty mold on the ixora.');
    expect(prompt.text).not.toMatch(/Merit|Palm Gro|PRODUCTS/);
    for (const id of Object.keys(CONDITIONS)) expect(prompt.system).toContain(id);
    for (const id of Object.keys(PLANTS)) expect(prompt.system).toContain(id);
    expect(prompt.system).not.toMatch(/ganoderma|\bconks?\b|lethal\s+bronzing|fusarium/i);
    expect(prompt.promptVersion).toBe('ts_tech_paragraph_v4');
  });

  test('the schema is closed enums, nothing numeric, and the lawn source enum is gone', () => {
    const schema = tech.extractionSchema();
    expect(schema.required).toEqual(['observations']);
    const item = schema.properties.observations.items;
    expect(item.properties.condition.enum).toEqual(Object.keys(CONDITIONS));
    expect(item.properties.plant.enum).toEqual([...Object.keys(PLANTS), 'none']);
    expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems|exclusiveMinimum|exclusiveMaximum)"|sources|note|product/);
  });
});

describe('the model judges, the code verifies the quote (owner 2026-10-05)', () => {
  const verify = (note, ...items) => tech.verifyObservations(items, note);

  test('a quote copied from one note sentence, naming the condition, is kept', () => {
    expect(verify('Found scale on the hedges.', obs('scale', 'hedges'))).toEqual([{ condition: 'scale', plant: 'hedges' }]);
    // Case, curly quotes and spacing fold; trailing punctuation drops.
    expect(verify('FOUND  Scale on the hedges.', obs('scale', 'hedges', true, 'found scale on the hedges.'))).toEqual([{ condition: 'scale', plant: 'hedges' }]);
  });

  test('the plant stays only when the quote names it', () => {
    expect(verify('Found scale along the fence. Trimmed the hedges.', obs('scale', 'hedges', true, 'found scale along the fence'))).toEqual([{ condition: 'scale', plant: null }]);
  });

  test('the model saying it was not a sighting today drops the item (Codex r6, r7, r9 wordings)', () => {
    for (const note of ['Applied Merit for scale on the hedges.', 'Saw yellowing on palms, and used Merit due to scale on hedges.', 'Last visit we saw scale on the hedges.', 'No scale on the hedges.']) {
      expect(verify(note, obs('scale', 'hedges', false, 'scale on the hedges'))).toEqual([]);
    }
  });

  test('a quote that is not in the note, spans two sentences, misses the condition or is too long is dropped', () => {
    const note = 'Found scale on the hedges. Fed the palms.';
    expect(verify(note, obs('scale', 'hedges', true, 'saw heavy scale on the hedges'))).toEqual([]);
    expect(verify(note, obs('scale', 'hedges', true, 'scale on the hedges. fed the palms'))).toEqual([]);
    expect(verify(note, obs('scale', 'palms', true, 'fed the palms'))).toEqual([]);
    expect(verify(note, obs('scale', 'hedges', true, ''))).toEqual([]);
    expect(verify(`${'x'.repeat(250)} scale.`, obs('scale', 'none', true, `${'x'.repeat(250)} scale`))).toEqual([]);
  });

  test('a palm-banned term in the quote drops the item', () => {
    expect(verify('Scale on the palm crown.', obs('scale', 'palms', true, 'scale on the palm crown'))).toEqual([]);
    expect(verify('Scale near the conk on one palm.', obs('scale', 'palms', true, 'scale near the conk on one palm'))).toEqual([]);
  });

  test('an unknown id, a repeat, a malformed item and everything past three are dropped', () => {
    const note = 'Found scale on the hedges, whitefly, aphids, thrips and sooty mold.';
    const out = verify(note, obs('scale', 'hedges'), obs('scale', 'trees'), obs('made_up'), null, 'x', obs('whitefly'), obs('aphids'), obs('thrips'));
    expect(out.map((o) => o.condition)).toEqual(['scale', 'whitefly', 'aphids']);
  });

  test('there is no sighting, negation or purpose word list in the module (do not grow one)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/service-report/tree-shrub-tech-paragraph.js'), 'utf8');
    expect(src).not.toMatch(/\b(?:NEGATION_RE|HEDGE_RE|TEMPORAL_RE|SIGHTING_RE|PURPOSE_RE)\b/);
  });

  test('palm-banned terms can never be rendered: they are in no list', () => {
    const all = JSON.stringify([...Object.keys(CONDITIONS), ...Object.keys(PLANTS), ...Object.values(CONDITIONS).map((c) => c.display), ...Object.values(PLANTS).map((p) => p.display), ...Object.values(FINDING_LABELS), ...Object.values(TS_SENTENCES)]);
    expect(all).not.toMatch(/ganoderma|conk|lethal|fusarium|crown|spear|newest|frond/i);
  });
});

describe('deterministic lines', () => {
  const LOW = (key) => ({ key, kind: 'maybe' });

  test('a "may be" line comes from low-confidence kept findings the note does not already cover', () => {
    expect(textFor({ technicianNote: 'Applied Merit.', findings: [LOW('pest_activity'), LOW('leaf_color_vigor')] }, [])).toBe(
      'There may be early signs of pest activity and leaf color changes; we will keep an eye on it. Today we applied Merit 2F and Palm Gro 8-2-12.',
    );
    // The note covers pest activity (even negated: the note wins), so only the other stays.
    expect(textFor({ technicianNote: 'No scale seen.', findings: [LOW('pest_activity'), LOW('foliage_fullness')] }, [])).toBe(
      'There may be early signs of thin foliage; we will keep an eye on it. Today we applied Merit 2F and Palm Gro 8-2-12.',
    );
  });

  test('at most two "may be" labels; the combined stress category reads "stress"', () => {
    const slots = slotsFor({ technicianNote: 'Applied Merit.', products: [], findings: Object.keys(FINDING_LABELS).map(LOW) }, []);
    expect(slots.maybe).toHaveLength(2);
    expect(textFor({ technicianNote: 'Applied Merit.', products: [], findings: [LOW('water_heat_mechanical_stress')] }, [])).toBe('There may be early signs of stress; we will keep an eye on it.');
    expect(FINDING_LABELS.water_heat_mechanical_stress).toBe('stress');
  });

  test('a finding the technician confirmed gets its own line, even when the note covers it', () => {
    expect(textFor({ technicianNote: 'Scale seen.', products: [], findings: [{ key: 'pest_activity', kind: 'confirmed' }] }, [])).toBe('Our technician confirmed signs of pest activity.');
  });

  test('the products line lists display names only, up to five', () => {
    const many = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((name) => ({ name }));
    expect(textFor({ technicianNote: '', products: many }, [])).toBe('Today we applied A1, B2, C3, D4 and E5.');
    expect(textFor({ technicianNote: '', products: [{ name: 'Merit 2F' }] }, [])).toBe('Today we applied Merit 2F.');
  });

  test('all clear: only with no item, no technician note, and a rating of Excellent or Good', () => {
    const base = { technicianNote: '', products: [] };
    expect(textFor({ ...base, landscapeCondition: 'Excellent' }, [])).toBe('Your landscape looked excellent today.');
    expect(textFor({ ...base, landscapeCondition: 'Good' }, [])).toBe('Your landscape looked good today.');
    for (const rating of ['Fair', 'Poor', 'Declining', 'Recovering', null, 'Great', 'good']) expect(textFor({ ...base, landscapeCondition: rating }, [])).toBe('');
    // Any item blocks it.
    expect(textFor({ ...base, landscapeCondition: 'Good', findings: [{ key: 'pest_activity', kind: 'maybe' }] }, [])).not.toMatch(/looked good/);
    expect(textFor({ ...base, technicianNote: 'Scale on the hedges.', landscapeCondition: 'Good' }, [obs('scale', 'hedges')])).not.toMatch(/looked good/);
    expect(textFor({ ...base, landscapeCondition: 'Good', findings: [{ key: 'pest_activity', kind: 'confirmed' }] }, [])).not.toMatch(/looked good/);
    // Any note at all blocks it: no word list tells every concern from a routine
    // remark (Codex r5: "Leaves are curling on the hibiscus.").
    for (const note of ['Leaves are curling on the hibiscus.', 'Bark beetle holes in the pine.', 'Routine visit, everything looks fine.']) {
      expect(textFor({ ...base, technicianNote: note, landscapeCondition: 'Good' }, [])).toBe('');
    }
  });

  test('nothing applies: no sentence, no paragraph', () => {
    expect(textFor({ technicianNote: '', products: [], landscapeCondition: null }, [])).toBe('');
    expect(textFor({ technicianNote: 'Visited.', products: [], landscapeCondition: 'Fair' }, [])).toBe('');
  });
});

describe('Codex r10', () => {
  test('"spider mites" never prints twice, whichever id the model gave', () => {
    const note = 'Found spider mites on the hedges.';
    const out = tech.verifyObservations([obs('mites', 'hedges', true, 'spider mites on the hedges'), obs('spider_mites', 'hedges')], note);
    expect(out).toEqual([{ condition: 'spider_mites', plant: 'hedges' }]);
    expect(tech.verifyObservations([obs('mites', 'hedges', true, 'spider mites on the hedges')], note)).toEqual([{ condition: 'spider_mites', plant: 'hedges' }]);
  });

  test('the longest paragraph valid slots can render passes the read-time guard', () => {
    const longest = (map) => Object.entries(map).sort((a, b) => b[1].display.length - a[1].display.length).map(([k]) => k);
    const conditions = longest(CONDITIONS).slice(0, 3);
    const plant = longest(PLANTS)[0];
    const slots = {
      observed: conditions.map((condition) => ({ condition, plant })),
      maybe: Object.keys(FINDING_LABELS).sort((a, b) => FINDING_LABELS[b].length - FINDING_LABELS[a].length).slice(0, 2),
      confirmed: Object.keys(FINDING_LABELS),
      products: ['A', 'B', 'C', 'D', 'E'].map((c) => `${c}${'x'.repeat(79)}`),
      allClear: 'excellent',
    };
    const text = tech.render(slots);
    expect(text.length).toBeGreaterThan(700);
    expect(text.length).toBeLessThanOrEqual(tech.MAX_TEXT_CHARS);
    const entry = { v: 1, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text, slots, frozenAt: '2026-10-05T12:00:00.000Z' };
    expect(tech.readFrozenTechParagraph({ treeShrubTechParagraph: { 77: entry } }, 77)).toBe(text);
  });
});

describe('mites stay generic (Codex r8)', () => {
  const verify = (note, ...items) => tech.verifyObservations(items, note);
  test('"mites" renders "mites"; only "spider mites" in the note renders "spider mites"', () => {
    expect(verify('Found mites on the hedges.', obs('spider_mites', 'hedges'))).toEqual([]);
    expect(verify('Found mites on the hedges.', obs('mites', 'hedges'))).toEqual([{ condition: 'mites', plant: 'hedges' }]);
    expect(verify('Found spider mites on the hedges.', obs('spider_mites', 'hedges'))).toEqual([{ condition: 'spider_mites', plant: 'hedges' }]);
    expect(textFor({ technicianNote: 'Found mites on the hedges.', products: [] }, [obs('mites', 'hedges')])).toBe('Our technician saw mites on the hedges.');
  });
});

describe('every confirmed finding prints (Codex r4)', () => {
  test('all five confirmed categories appear, none dropped', () => {
    const findings = ['pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress', 'leaf_color_vigor', 'foliage_fullness'].map((key) => ({ key, kind: 'confirmed' }));
    expect(textFor({ technicianNote: '', findings, products: [] }, [])).toBe('Our technician confirmed signs of pest activity, leaf spot, stress, leaf color changes and thin foliage.');
  });
});

describe('render: guards on the one free string (a catalog product name)', () => {
  test('a product name the customer-copy screen rejects drops that sentence, never the others', () => {
    const slots = { observed: [{ condition: 'scale', plant: 'hedges' }], maybe: [], confirmed: [], products: ['Safe Eco Spray'], allClear: null };
    expect(tech.render(slots)).toBe('Our technician saw scale on the hedges.');
  });
  test('unknown ids render nothing', () => {
    expect(tech.render({ observed: [{ condition: 'made_up', plant: 'palms' }], maybe: ['x'], confirmed: ['y'], products: [], allClear: 'terrible' })).toBe('');
    expect(tech.render(null)).toBe('');
  });
});

describe('the model call (extraction only)', () => {
  beforeEach(() => dispatchWithFallback.mockReset());
  const goodAnswer = { observations: [obs('scale', 'hedges'), obs('sooty_mold')] };

  test('one call through the report policy on lane ts_tech_paragraph, schema, deadline and validator; the paragraph is rendered from slots', async () => {
    dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
      const result = { ok: true, json: goodAnswer, provider: 'openai' };
      return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
    });
    const out = await tech.generateTechParagraph(inputs());
    expect(out).toMatchObject({ ok: true, paragraph: 'Our technician saw scale on the hedges and sooty mold. Today we applied Merit 2F and Palm Gro 8-2-12.' });
    expect(out.slots.observed).toEqual([{ condition: 'scale', plant: 'hedges' }, { condition: 'sooty_mold', plant: 'none' }]);
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.report);
    expect(payload).toMatchObject({ laneId: 'ts_tech_paragraph', promptVersion: 'ts_tech_paragraph_v4', jsonMode: true, timeoutMs: 15000 });
    expect(payload.jsonSchema).toEqual(tech.extractionSchema());
    expect(options).toMatchObject({ hardDeadline: true, reserveFallbackBudget: true });
    expect(options.validate({ ok: true, json: { paragraph: 'Prune the hedge.' } })).toMatch(/no_answer/);
  });

  test('an answer whose every item fails verification is a good read: deterministic lines only (no all-clear beside a note)', async () => {
    dispatchWithFallback.mockImplementation(async (_p, _pl, options) => {
      const result = { ok: true, json: { observations: [obs('thrips', 'palms')] } };
      return options.validate(result) ? { ok: false, reason: 'x' } : result;
    });
    const out = await tech.generateTechParagraph(inputs({ technicianNote: 'Routine visit, all fine.', landscapeCondition: 'Good' }));
    expect(out).toMatchObject({ ok: true, paragraph: 'Today we applied Merit 2F and Palm Gro 8-2-12.' });
  });

  test('an item outside the schema makes the whole answer a miss, so the backup provider runs (Codex r5)', () => {
    const v = (observations) => tech.validateExtraction({ observations }, inputs({ technicianNote: 'Scale on the hedges.' }));
    expect(v([{ condition: 'made_up', plant: 'none' }])).toMatchObject({ ok: false, problems: ['malformed_item'] });
    expect(v([{}])).toMatchObject({ ok: false, problems: ['malformed_item'] });
    expect(v([{ condition: 'scale' }])).toMatchObject({ ok: false, problems: ['malformed_item'] });
    expect(v([obs('scale', 'hedges'), obs('scale', 'lawn')])).toMatchObject({ ok: false });
    expect(v([{ condition: 'scale', plant: 'hedges' }])).toMatchObject({ ok: false, problems: ['malformed_item'] });
    expect(v([obs('scale', 'hedges')])).toMatchObject({ ok: true });
  });

  test('model failure, timeout or a malformed answer: deterministic lines only, and no all-clear (the note was not read)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const i = inputs({ landscapeCondition: 'Good', findings: [{ key: 'foliage_fullness', kind: 'maybe' }] });
    const out = await tech.generateTechParagraph(i);
    expect(out.paragraph).toBe('There may be early signs of thin foliage; we will keep an eye on it. Today we applied Merit 2F and Palm Gro 8-2-12.');
    expect(out.paragraph).not.toMatch(/saw|looked/);
    dispatchWithFallback.mockRejectedValueOnce(new Error('boom'));
    expect((await tech.generateTechParagraph(inputs({ landscapeCondition: 'Good', products: [], technicianNote: 'Routine visit, all fine.' })))).toEqual({ ok: false, reason: 'nothing_to_say' });
    const malformed = await tech.generateTechParagraph(i, { callModel: async () => ({ ok: true, json: { observations: 'scale' } }) });
    expect(malformed.paragraph).toMatch(/^There may be/);
  });

  test('no technician note: no model call, deterministic lines still produce a paragraph', async () => {
    const out = await tech.generateTechParagraph(inputs({ technicianNote: '', landscapeCondition: 'Excellent' }));
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(out.paragraph).toBe('Today we applied Merit 2F and Palm Gro 8-2-12. Your landscape looked excellent today.');
  });

  test('a short note is still read: "Saw aphids." is a full observation (Codex r4)', async () => {
    const callModel = jest.fn(async () => ({ ok: true, json: { observations: [obs('aphids')] } }));
    const out = await tech.generateTechParagraph(inputs({ technicianNote: 'Saw aphids.' }), { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(out.paragraph).toMatch(/^Our technician saw aphids\./);
  });

  test('nothing to say at all: not ok', async () => {
    expect(await tech.generateTechParagraph(inputs({ technicianNote: '', products: [] }))).toEqual({ ok: false, reason: 'nothing_to_say' });
  });
});

describe('freeze and read back', () => {
  const SLOTS = { observed: [{ condition: 'scale', plant: 'hedges' }], maybe: [], confirmed: [], products: ['Merit 2F'], allClear: null };
  const TEXT = tech.render(SLOTS);
  const ENTRY = { v: 1, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text: TEXT, slots: SLOTS, frozenAt: '2026-10-05T12:00:00.000Z' };
  const notes = (entry = ENTRY) => JSON.stringify({ treeShrubTechParagraph: { 77: entry } });

  test('reads only an entry whose text equals render(slots) under the current templates', () => {
    expect(tech.FREEZE_KEY).toBe('treeShrubTechParagraph');
    expect(tech.readFrozenTechParagraph(notes(), 77)).toBe(TEXT);
    expect(tech.readFrozenTechParagraph(notes(), 78)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, v: 2 }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(JSON.stringify({ lawnTechParagraph: { 77: ENTRY } }), 77)).toBeNull();
  });

  test('a hand-edited text, missing slots, drifted slots or a changed template print nothing', () => {
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: `${TEXT} Prune the hedge.` }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, slots: undefined }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, slots: { ...SLOTS, observed: [{ condition: 'whitefly', plant: 'palms' }] } }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, slots: [] }), 77)).toBeNull();
    const saved = { ...TS_SENTENCES };
    // The constant is frozen, so a "changed template" is modelled by an old text.
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: TEXT.replace('Our technician saw', 'We observed') }), 77)).toBeNull();
    expect(saved).toEqual(TS_SENTENCES);
  });

  test('a palm-banned term in a product name is dropped at render, and a stored text holding one prints nothing', () => {
    const bad = { ...SLOTS, products: ['Conk Cleaner'] };
    expect(tech.render(bad)).toBe('Our technician saw scale on the hedges.');
    const forged = `${TEXT} Our technician saw a conk.`;
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: forged }), 77)).toBeNull();
  });

  test('the PDF signature is empty without a paragraph and follows the text', () => {
    expect(tech.techParagraphSignature('{}', 77)).toBe('');
    const a = tech.techParagraphSignature(notes(), 77);
    expect(a).toMatch(/^:tp=[0-9a-f]{8}$/);
    const other = { ...SLOTS, products: ['Merit 2F', 'Palm Gro 8-2-12'] };
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
        state.lastSql = raw.sql;
        if ((state.notes.treeShrubTechParagraph || {})[q.guardKey]) return 0;
        state.notes.treeShrubTechParagraph = { ...(state.notes.treeShrubTechParagraph || {}), ...JSON.parse(raw.bindings[0]) };
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }

  test('first writer wins under treeShrubTechParagraph and touches no other key', async () => {
    const { knex, state } = fakeKnex({ other: 'kept', lawnTechParagraph: { 77: 'lawn' } });
    expect(await tech.freezeTechParagraph('s1', ENTRY, knex)).toEqual(ENTRY);
    expect(state.lastSql).toContain("'treeShrubTechParagraph'");
    expect(state.notes.other).toBe('kept');
    expect(state.notes.lawnTechParagraph).toEqual({ 77: 'lawn' });
    const later = { ...SLOTS, products: ['Other'] };
    expect(await tech.freezeTechParagraph('s1', { ...ENTRY, text: tech.render(later), slots: later }, knex)).toEqual(ENTRY);
    expect(state.notes.treeShrubTechParagraph['77'].text).toBe(TEXT);
  });

  test('createAndFreeze stores { text, slots, version }; a rejected or already-frozen step spends nothing', async () => {
    const markerDb = fakeKnex();
    const runOn = (db) => (extra = {}) => tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: extra.structuredNotes || '{}', knex: db.knex, gatherInputs: async () => inputs(), deps: extra.deps });
    expect((await runOn(markerDb)({ deps: { generate: async () => ({ ok: false, reason: 'nothing_to_say' }) } })).status).toBe('nothing_to_say');
    // Nothing to say still writes a text-less marker (Codex r8), so a resumed
    // completion spends no second call; it never prints.
    expect(markerDb.state.updates).toBe(1);
    const { knex, state } = fakeKnex();
    const run = runOn({ knex });
    const marker = { treeShrubTechParagraph: { 77: { v: 1, assessmentId: '77', text: '', nothingToSay: true } } };
    const again = jest.fn();
    expect((await run({ structuredNotes: JSON.stringify(marker), deps: { generate: again } })).status).toBe('already_frozen');
    expect(again).not.toHaveBeenCalled();
    expect(tech.readFrozenTechParagraph(marker, 77)).toBeNull();
    expect(tech.techParagraphSignature(marker, 77)).toBe('');
    const generate = jest.fn();
    expect((await run({ structuredNotes: notes(), deps: { generate } })).status).toBe('already_frozen');
    expect(generate).not.toHaveBeenCalled();
    dispatchWithFallback.mockImplementation(async (_p, _pl, options) => {
      const result = { ok: true, json: { observations: [obs('scale', 'hedges')] } };
      return options.validate(result) ? { ok: false, reason: 'x' } : result;
    });
    const frozen = await run({ deps: { now: () => new Date('2026-10-05T12:00:00Z') } });
    expect(frozen.status).toBe('frozen');
    const entry = state.notes.treeShrubTechParagraph['77'];
    expect(entry).toMatchObject({ v: 1, promptVersion: 'ts_tech_paragraph_v4', assessmentId: '77', text: 'Our technician saw scale on the hedges. Today we applied Merit 2F and Palm Gro 8-2-12.' });
    expect(entry.slots.observed).toEqual([{ condition: 'scale', plant: 'hedges' }]);
    expect(tech.readFrozenTechParagraph(state.notes, 77)).toBe(entry.text);
  });
});
