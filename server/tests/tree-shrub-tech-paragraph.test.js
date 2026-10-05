// Tree & shrub report "From your technician" paragraph (GATE_TS_TECH_PARAGRAPH):
// the prompt as text, the tree & shrub profile of the shared validator, the one
// model call (never a real one: every call is injected or mocked) and the
// first-writer-wins freeze. The plumbing (deadline, freeze race) is the lawn
// paragraph's engine and is pinned by lawn-tech-paragraph.test.js; this file
// pins what differs by service line. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const tech = require('../services/service-report/tree-shrub-tech-paragraph');
const lawn = require('../services/service-report/lawn-tech-paragraph');

const INPUTS = {
  technicianNote: 'Found scale on the hedge along the back fence and heavy sooty mold on a few leaves. Treated the hedges with Merit and fed the palms with the palm fertilizer.',
  products: [
    { name: 'Merit 2F', activeIngredient: 'imidacloprid', kind: 'systemic', method: 'drench', targets: ['scale', 'whitefly', 'aphids'] },
    { name: 'Palm Gro 8-2-12', activeIngredient: null, kind: 'fertilizer', method: 'broadcast', targets: [] },
  ],
  findings: [
    { label: 'pest pressure signals', confidence: 'low' },
  ],
  knownProductNames: ['Merit 2F', 'Palm Gro 8-2-12', 'Safari 20 SG', 'Celsius WG'],
};

const sources = (text, from) => {
  const sentences = text.match(/[^.!?]+[.!?]/g).map((s) => s.trim());
  return sentences.map((sentence, i) => ({ sentence, from: from[i] || from[from.length - 1] }));
};
const answer = (paragraph, from = [['note']]) => ({ paragraph, sources: sources(paragraph, from) });
const check = (a, inputs = INPUTS) => tech.validateParagraph(a, inputs);
const problemsOf = (a, inputs) => check(a, inputs).problems;

const GOOD_1 = answer(
  'Our technician found scale on the hedge along the back fence, with some sooty mold on a few leaves. We applied Merit 2F to protect against scale. We also applied Palm Gro 8-2-12.',
  [['note'], ['note', 'product'], ['note', 'product']],
);
const GOOD_2 = answer(
  'Our technician found scale on the hedge along the back fence. We applied Merit 2F and Palm Gro 8-2-12. We are keeping an eye on possible pest pressure.',
  [['note'], ['note', 'product'], ['finding']],
);

describe('prompt and schema', () => {
  const prompt = tech.buildPrompt(tech.normalizeInputs(INPUTS));

  test('the user message carries the note verbatim and every labeled input, and nothing private', () => {
    expect(prompt.text).toContain(INPUTS.technicianNote);
    for (const label of ['PRODUCTS APPLIED TODAY', 'PHOTO FINDINGS THE TECHNICIAN KEPT']) {
      expect(prompt.text).toContain(label);
    }
    expect(prompt.text).toContain('Merit 2F');
    expect(prompt.text).toContain('pest pressure signals (low confidence)');
    // The watch list, the last visit, the headline, scores, progress lines, the
    // catalog defense list and active ingredients never reach the model.
    for (const absent of ['SEEN BY OUR TECHNICIAN', 'LAST VISIT', 'WHAT THE REPORT ALREADY SAYS', 'Safari 20 SG', 'Celsius WG', 'imidacloprid', 'active:']) {
      expect(prompt.text).not.toContain(absent);
    }
    expect(prompt.text).not.toMatch(/SCORES|PROGRESS|\$\d/);
  });

  test('the system prompt carries the owner rules the code then enforces', () => {
    for (const phrase of ['the note wins', 'never as something the photos showed', 'targets list', 'No numbers of any kind', 'never "will"', 'no better, worse', 'HUMAN PROSE RULES', 'PHOTO REACH', 'never where it went', 'No instructions to the customer']) {
      expect(prompt.system.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(prompt.system).not.toMatch(/SEEN BY OUR TECHNICIAN|watch list|headline/i);
    expect(prompt.system).toContain('Waves Pest Control');
    expect(prompt.promptVersion).toBe(tech.PROMPT_VERSION);
    expect(prompt.promptVersion).toBe('ts_tech_paragraph_v1');
  });

  test('the prompt never names a diagnosis-only palm problem (owner 2026-10-03)', () => {
    expect(`${prompt.system}\n${prompt.text}`).not.toMatch(/ganoderma|\bconks?\b|lethal\s+bronzing|fusarium/i);
  });

  test('the schema is the lawn paragraph\'s: one string plus sources, closed sets, no numeric bounds', () => {
    expect(prompt.jsonSchema).toEqual(lawn.techParagraphSchema());
    expect(JSON.stringify(prompt.jsonSchema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
  });

  test('normalizeInputs folds product kinds, drops the last visit, headline and lawn-only fields, and is idempotent', () => {
    const once = tech.normalizeInputs({
      ...INPUTS,
      scores: { overall: 90 },
      progressLines: ['Thickness is on track.'],
      prior: { date: '2026-08-12', products: [{ name: 'Safari 20 SG' }], watched: ['whitefly'], findings: [] },
      facts: { headline: 'Healthy — monitoring pest pressure', watering: 'Water the lawn.' },
    });
    expect(once.products.map((p) => p.kind)).toEqual(['insecticide', 'fertilizer']);
    expect(once.findings).toEqual([{ label: 'pest pressure signals', confidence: 'low' }]);
    expect(once.prior).toBeNull();
    expect(once.facts).toEqual({ headline: null, watering: null });
    expect(once.progressLines).toEqual([]);
    expect(once.scores).toEqual({ overall: null, rows: [] });
    expect(once.facts.watering).toBeNull();
    expect(once.technicianNote.length).toBeLessThanOrEqual(1500);
    expect(tech.normalizeInputs(once)).toEqual(once);
    // A miticide is an insect product to the validator too.
    expect(tech.normalizeInputs({ ...INPUTS, products: [{ name: 'Floramite SC', kind: 'miticide', targets: [] }] }).products[0].kind).toBe('insecticide');
  });
});

describe('validator: accepts', () => {
  test.each([['good example 1', GOOD_1], ['good example 2', GOOD_2]])('%s', (_name, a) => {
    const verdict = check(a);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.paragraph).toBe(a.paragraph);
    expect(verdict.paragraph.split(/\s+/).length).toBeLessThanOrEqual(70);
  });

  test('a sentence may name a plant group or the finding when no product is named in it', () => {
    const a = answer('Our technician saw scale on the hedges. We applied Merit 2F.', [['note'], ['note', 'product']]);
    expect(problemsOf(a)).toEqual([]);
  });
});

describe('validator: rejects', () => {
  test('a product that was not applied, including last visit\'s', () => {
    const a = answer('Our technician found scale on the hedge. We used Safari 20 SG on the hedges.', [['note'], ['product']]);
    expect(problemsOf(a)).toEqual(expect.arrayContaining(['product_not_applied:safari']));
    const b = answer('Our technician found scale on the hedge. We used Celsius WG on the hedges.', [['note'], ['product']]);
    expect(problemsOf(b)).toEqual(expect.arrayContaining(['product_not_applied:celsius']));
  });

  test('a pest the record does not carry (the closed condition vocabulary)', () => {
    const a = answer('Our technician found scale on the hedge. We also saw thrips on the new leaves.', [['note'], ['note']]);
    expect(problemsOf(a)).toContain('condition_not_in_inputs:thrips');
  });

  test('a plant name or any word outside the closed vocabulary', () => {
    const a = answer('Our technician found scale on the hibiscus hedge. We treated it with Merit 2F.', [['note'], ['product']]);
    expect(problemsOf(a)).toContain('word_not_in_inputs');
  });

  test('any reference to an earlier visit or comparison with one (no prior visit is an input)', () => {
    const a = answer('Our technician found scale on the hedge. The hedge looks healthier than at our last visit.', [['note'], ['prior']]);
    expect(problemsOf(a)).toEqual(expect.arrayContaining(['prior_visit', 'comparison_without_progress']));
    const b = answer('Our technician found scale on the hedge. At our last visit we treated for whitefly.', [['note'], ['prior']]);
    expect(problemsOf(b)).toContain('prior_visit');
    const withLine = { ...INPUTS, progressLines: ['Thickness is on track.'] };
    expect(problemsOf(answer('Our technician found scale on the hedge. Thickness is on track since our last visit.', [['note'], ['prior']]), withLine)).toContain('comparison_without_progress');
  });

  test('a promise, a number, a date, a watering word', () => {
    expect(problemsOf(answer('Our technician found scale on the hedge. We will recheck the hedges next visit.', [['note'], ['note']]))).toEqual(expect.arrayContaining(['promise:will']));
    expect(problemsOf(answer('Our technician found scale on the hedge. We used 4 ounces of Merit 2F on the hedges.', [['note'], ['product']]))).toEqual(expect.arrayContaining(['number']));
    expect(problemsOf(answer('Our technician found scale on the hedge. We treated the hedges with Merit 2F on Tuesday.', [['note'], ['product']]))).toContain('date_or_season');
    expect(problemsOf(answer('Our technician found scale on the hedge. Keep the hedges watered after we treated them with Merit 2F.', [['note'], ['product']]))).toContain('watering_or_mowing');
  });

  test('the photos confirming a cause', () => {
    const a = answer('Our technician found scale on the hedge. The photos confirmed scale on the leaves.', [['note'], ['finding']]);
    expect(problemsOf(a)).toContain('photo_confirms_cause');
  });

  test('a low-confidence photo finding stated as fact, and the same finding hedged', () => {
    const inputs = { ...INPUTS, technicianNote: 'Treated the hedges with Merit and fed the palms with the palm fertilizer.', findings: [{ label: 'leaf spot signals', confidence: 'low', source: 'photo' }] };
    const stated = answer('We applied Merit 2F. We found leaf spot on the leaves.', [['product'], ['finding']]);
    expect(problemsOf(stated, inputs)).toContain('low_confidence_stated_as_fact:leaf_spot');
    const hedged = answer('We applied Merit 2F. We are keeping an eye on possible leaf spot on the leaves.', [['product'], ['finding']]);
    expect(problemsOf(hedged, inputs)).toEqual([]);
  });

  test('a condition the note says was not found (the note wins)', () => {
    const inputs = { ...INPUTS, technicianNote: 'No scale or whitefly on the hedges. Treated the hedges with Merit and fed the palms.', findings: [] };
    const a = answer('Our technician found scale on the hedges. We treated the hedges with Merit 2F.', [['note'], ['product']]);
    expect(problemsOf(a, inputs).some((p) => /^negated_in_note_stated_as_found:scale$/.test(p))).toBe(true);
  });

  test('a target stated as found, not as protection', () => {
    const inputs = { ...INPUTS, technicianNote: 'Treated the hedges with Merit and fed the palms with the palm fertilizer.', findings: [], prior: null };
    const a = answer('Our technician found whitefly on the hedges. We treated the hedges with Merit 2F.', [['note'], ['product']]);
    expect(problemsOf(a, inputs)).toContain('target_stated_as_found:whitefly');
  });
});

describe('Codex round 1 on #5968', () => {
  const NOTE_ONLY = { ...INPUTS, technicianNote: 'Treated the hedges with Merit and fed the palms with the palm fertilizer.' };

  test('an active ingredient the model supplies from memory is rejected; the listed product name is not', () => {
    const named = answer('We applied imidacloprid.', [['product']]);
    // Two sentences are required, so pair it with a clean one.
    const a = answer('We applied Merit 2F. We applied imidacloprid.', [['product'], ['product']]);
    expect(named.paragraph).toContain('imidacloprid');
    expect(problemsOf(a, NOTE_ONLY)).toContain('active_ingredient');
    expect(problemsOf(answer('We applied Merit 2F. We applied Palm Gro 8-2-12.', [['product'], ['product']]), NOTE_ONLY)).toEqual([]);
    // An ingredient word that IS part of a listed product name stays allowed.
    const inName = { ...NOTE_ONLY, products: [{ name: 'Imidacloprid 75 WSP', activeIngredient: 'imidacloprid', kind: 'systemic', targets: [] }], knownProductNames: [] };
    expect(problemsOf(answer('We applied Imidacloprid 75 WSP. Our technician saw scale on the hedge.', [['product'], ['note']]), { ...inName, technicianNote: 'Saw scale on the hedge.' })).not.toContain('active_ingredient');
  });

  test('the report headline is not a fact: a low-confidence finding stated unhedged is rejected even when the headline carries it', () => {
    const inputs = {
      technicianNote: 'Treated the hedges with Merit and fed the palms with the palm fertilizer.',
      products: INPUTS.products,
      findings: [{ label: 'pest pressure signals', confidence: 'low' }],
      facts: { headline: 'Healthy — monitoring pest pressure' },
      knownProductNames: INPUTS.knownProductNames,
    };
    expect(tech.normalizeInputs(inputs).facts.headline).toBeNull();
    const stated = answer('Our technician found pest pressure. We applied Merit 2F.', [['fact', 'finding'], ['product']]);
    expect(problemsOf(stated, inputs)).toContain('low_confidence_stated_as_fact:insect');
    const hedged = answer('We are keeping an eye on possible pest pressure. We applied Merit 2F.', [['finding'], ['product']]);
    expect(problemsOf(hedged, inputs)).toEqual([]);
  });

  test('care advice to the customer is rejected; a finding about pruning stress is not', () => {
    const bad = [
      'Prune the hedge.', 'Trim back the hedges.', 'Cut back the dead fronds.', 'Water the beds deeply.', 'Fertilize the palms in spring.',
      'You should prune the hedge.', 'You need to thin the canopy.', 'Please keep the hedge trimmed.',
      'We applied Merit 2F, and trim the hedge.',
    ];
    for (const sentence of bad) {
      expect(problemsOf(answer(`Our technician found scale on the hedge. ${sentence}`, [['note'], ['note']]), INPUTS)).toContain('care_instruction');
    }
    expect(problemsOf(answer('Our technician found pruning stress on the hedge. We applied Merit 2F.', [['note'], ['product']]), { ...INPUTS, technicianNote: 'Found pruning stress on the hedge. Applied Merit.', findings: [] })).toEqual([]);
  });

  test('a sentence that names an applied product may not name a plant group or place', () => {
    const run = (text) => problemsOf(answer(text, [['note'], ['note', 'product']]), INPUTS);
    const lead = 'Our technician saw scale on the hedges. ';
    expect(run(`${lead}We put Merit 2F on the palms.`)).toContain('product_placement');
    expect(run(`${lead}We treated the hedges with Merit 2F.`)).toContain('product_placement');
    expect(run(`${lead}Merit 2F went on the front and back.`)).toContain('product_placement');
    expect(run(`${lead}Merit 2F went around the whole property.`)).toContain('product_placement');
    expect(run(`${lead}We applied Merit 2F.`)).toEqual([]);
    expect(run(`${lead}We applied Merit 2F to protect against scale.`)).toEqual([]);
    // A product whose own name holds a place noun is cut out first, not flagged.
    expect(run(`${lead}We applied Palm Gro 8-2-12.`)).toEqual([]);
    // No product named: a plant group in the sentence is fine.
    expect(problemsOf(answer('Our technician saw scale on the hedges. We also saw sooty mold on a few leaves.', [['note'], ['note']]), INPUTS)).toEqual([]);
  });
});

describe('palm rules (owner 2026-10-01, 2026-10-03)', () => {
  test.each([
    ['a crown', 'Our technician found scale on the hedge. The palm crown looks good, and we fed the palms with Palm Gro 8-2-12.', 'palm_crown'],
    ['a spear leaf', 'Our technician found scale on the hedge. The spear leaf on the palms looks fine.', 'palm_crown'],
    ['the newest fronds', 'Our technician found scale on the hedge. The newest fronds on the palms look strong.', 'palm_crown'],
    ['a conk', 'Our technician found scale on the hedge. We noticed a conk on one palm trunk.', 'palm_disease_name'],
    ['Ganoderma', 'Our technician found scale on the hedge. One palm may have Ganoderma.', 'palm_disease_name'],
  ])('rejects %s, even when the technician note carries the word', (_name, text, code) => {
    const inputs = { ...INPUTS, technicianNote: `${INPUTS.technicianNote} Palm crown looks fine. Conk at the base of one palm. Possible Ganoderma.` };
    expect(problemsOf(answer(text, [['note'], ['note']]), inputs)).toContain(code);
  });

  test('the codes carry no token (the offending word may be copied from the note)', () => {
    const inputs = { ...INPUTS, technicianNote: `${INPUTS.technicianNote} Conk at the base.` };
    const problems = problemsOf(answer('Our technician found scale on the hedge. We noticed a conk on one palm trunk.', [['note'], ['note']]), inputs);
    expect(JSON.stringify(problems)).not.toMatch(/conk/i);
  });

  test('a frozen text that names a conk or a crown prints nothing', () => {
    const entry = (text) => JSON.stringify({ treeShrubTechParagraph: { 9: { v: 1, assessmentId: '9', text } } });
    expect(tech.readFrozenTechParagraph(entry(GOOD_1.paragraph), 9)).toBe(GOOD_1.paragraph);
    expect(tech.readFrozenTechParagraph(entry('Our technician found scale on the hedge. We noticed a conk on one palm trunk.'), 9)).toBeNull();
    expect(tech.readFrozenTechParagraph(entry('Our technician found scale on the hedge. The palm crown looks good.'), 9)).toBeNull();
  });
});

describe('the one model call', () => {
  beforeEach(() => dispatchWithFallback.mockReset());

  test('goes through the report policy on lane ts_tech_paragraph, with the schema, the deadline and the validator', async () => {
    dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
      const result = { ok: true, json: { paragraph: GOOD_1.paragraph, sources: GOOD_1.sources }, provider: 'openai' };
      return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
    });
    const out = await tech.generateTechParagraph(INPUTS);
    expect(out).toMatchObject({ ok: true, paragraph: GOOD_1.paragraph });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.report);
    expect(payload).toMatchObject({ laneId: 'ts_tech_paragraph', promptVersion: 'ts_tech_paragraph_v1', jsonMode: true, timeoutMs: 15000 });
    expect(payload.text).toContain(INPUTS.technicianNote);
    expect(options).toMatchObject({ hardDeadline: true, reserveFallbackBudget: true });
    // The validator the dispatcher runs is the tree & shrub one.
    expect(options.validate({ ok: true, json: answer('Our technician found scale on the hedge. The palm crown looks good.', [['note'], ['note']]) })).toMatch(/palm_crown/);
  });

  test('a rejected answer stores nothing and says why; no note or no product makes no call', async () => {
    const bad = answer('Our technician found scale on the hedge. We noticed a conk on one palm trunk.', [['note'], ['note']]);
    const out = await tech.generateTechParagraph(INPUTS, { callModel: async () => ({ ok: true, json: bad }) });
    expect(out).toMatchObject({ ok: false, reason: 'rejected', problems: expect.arrayContaining(['palm_disease_name']) });
    expect(await tech.generateTechParagraph({ ...INPUTS, technicianNote: '' })).toEqual({ ok: false, reason: 'no_note' });
    expect(await tech.generateTechParagraph({ ...INPUTS, products: [] })).toEqual({ ok: false, reason: 'no_products' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('freeze and read', () => {
  const ENTRY = { v: 1, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text: GOOD_2.paragraph, sources: GOOD_2.sources, frozenAt: '2026-10-05T12:00:00.000Z' };
  const notes = (entry = ENTRY) => JSON.stringify({ treeShrubTechParagraph: { 77: entry } });

  test('reads only a whole entry for its own assessment, under its own key', () => {
    expect(tech.FREEZE_KEY).toBe('treeShrubTechParagraph');
    expect(tech.readFrozenTechParagraph(notes(), 77)).toBe(GOOD_2.paragraph);
    expect(tech.readFrozenTechParagraph(notes(), 78)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, v: 2 }), 77)).toBeNull();
    // The lawn paragraph's key is never read here.
    expect(tech.readFrozenTechParagraph(JSON.stringify({ lawnTechParagraph: { 77: ENTRY } }), 77)).toBeNull();
  });

  test('the PDF signature is empty without a paragraph and follows the text', () => {
    expect(tech.techParagraphSignature('{}', 77)).toBe('');
    const a = tech.techParagraphSignature(notes(), 77);
    expect(a).toMatch(/^:tp=[0-9a-f]{8}$/);
    expect(tech.techParagraphSignature(notes({ ...ENTRY, text: GOOD_1.paragraph }), 77)).not.toBe(a);
  });

  // The freeze statement the way Postgres applies it (the guard is the key's absence).
  function fakeKnex(initial = {}) {
    const state = { notes: JSON.parse(JSON.stringify(initial)), updates: 0 };
    const knex = () => {
      const q = { guardKey: null };
      q.where = () => q;
      q.whereRaw = (sql, bindings) => { q.guardSql = sql; q.guardKey = bindings[0]; return q; };
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
    expect(await tech.freezeTechParagraph('s1', { ...ENTRY, text: GOOD_1.paragraph }, knex)).toEqual(ENTRY);
    expect(state.notes.treeShrubTechParagraph['77'].text).toBe(GOOD_2.paragraph);
  });

  test('createAndFreeze: a good paragraph freezes; a rejected or already-frozen one spends nothing', async () => {
    const { knex, state } = fakeKnex();
    const run = (extra = {}) => tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: extra.structuredNotes || '{}', knex, gatherInputs: async () => INPUTS, deps: extra.deps });
    const rejected = await run({ deps: { generate: async () => ({ ok: false, reason: 'rejected', problems: ['palm_crown'] }) } });
    expect(rejected).toMatchObject({ status: 'rejected', problems: ['palm_crown'] });
    expect(state.updates).toBe(0);
    const generate = jest.fn();
    expect((await run({ structuredNotes: notes(), deps: { generate } })).status).toBe('already_frozen');
    expect(generate).not.toHaveBeenCalled();
    const frozen = await run({ deps: { generate: async () => ({ ok: true, paragraph: GOOD_1.paragraph, sources: GOOD_1.sources }), now: () => new Date('2026-10-05T12:00:00Z') } });
    expect(frozen.status).toBe('frozen');
    expect(state.notes.treeShrubTechParagraph['77']).toMatchObject({ v: 1, promptVersion: 'ts_tech_paragraph_v1', assessmentId: '77', text: GOOD_1.paragraph });
    expect(tech.readFrozenTechParagraph(state.notes, 77)).toBe(GOOD_1.paragraph);
  });
});
