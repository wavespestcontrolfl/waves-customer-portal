// Lawn report "From your technician" paragraph (GATE_LAWN_TECH_PARAGRAPH): the
// prompt and schema as text, the code-side validator, the one model call (never
// a real one: every call is injected or mocked), and the first-writer-wins
// freeze. Synthetic data only; the fixture is the owner's 2026-10-05 chinch bug
// case with an invented first name and address.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const tech = require('../services/service-report/lawn-tech-paragraph');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/fixtures/lawn-tech-paragraph/chinch-bug-arena.json'), 'utf8'));

const sources = (text, from) => {
  const sentences = text.match(/[^.!?]+[.!?]/g).map((s) => s.trim());
  return sentences.map((sentence, i) => ({ sentence, from: from[i] || from[from.length - 1] }));
};
const answer = (paragraph, from = [['note']]) => ({ paragraph, sources: sources(paragraph, from) });

const GOOD_1 = answer(
  'Our technician found chinch bugs in the trouble spot, and the damage you see in that photo is from them. We treated the front and side yards with Arena 50 WDG to go after them. We also fed the whole lawn with LESCO 24-0-11 granular fertilizer, and we are keeping an eye on a few thin areas.',
  [['note'], ['note', 'product'], ['note', 'product', 'finding']],
);
const GOOD_2 = answer(
  'Our technician saw chinch bugs at the trouble spot, which explains the damaged turf in the photo. Arena 50 WDG went on the front and side yards to treat them. LESCO 24-0-11 granular fertilizer went down across the entire lawn to feed the grass.',
  [['note'], ['note', 'product'], ['note', 'product']],
);
const BAD_UNAPPLIED_PRODUCT = answer(
  'We applied Celsius WG to the weeds along the fence. Chinch bugs were confirmed by the photos from the trouble spot.',
  [['product'], ['finding']],
);

const check = (a, inputs = FIXTURE) => tech.validateParagraph(a, inputs);
const problemsOf = (a, inputs) => check(a, inputs).problems;

describe('prompt and schema', () => {
  const prompt = tech.buildPrompt(tech.normalizeInputs(FIXTURE));

  test('the user message carries the note verbatim and every labeled input, and nothing private', () => {
    expect(prompt.text).toContain(FIXTURE.technicianNote);
    for (const label of ['PRODUCTS APPLIED TODAY', "TODAY'S CONFIRMED SCORES", 'PHOTO FINDINGS THE TECHNICIAN KEPT', 'LAST VISIT', 'PROGRESS', 'WHAT THE REPORT ALREADY SAYS']) {
      expect(prompt.text).toContain(label);
    }
    expect(prompt.text).toContain('Arena 50 WDG');
    expect(prompt.text).toContain('Southern chinch bugs');
    expect(prompt.text).toContain('thinning turf (low confidence)');
    // No address, no customer name, no catalog defense list, no raw observations, no price.
    expect(prompt.text).not.toMatch(/Example Street|34205|Bradenton|Sam\b/);
    expect(prompt.text).not.toContain('Celsius WG');
    expect(prompt.text).not.toMatch(/\$\d|observations/i);
  });

  test('the system prompt carries the owner rules the code then enforces', () => {
    for (const phrase of ['the note wins', 'never as something the photos showed', 'targets list', 'No numbers of any kind', 'never "will"', 'Never compare color between visits', 'HUMAN PROSE RULES']) {
      expect(prompt.system.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(prompt.system).toContain('Waves Pest Control');
    expect(prompt.promptVersion).toBe(tech.PROMPT_VERSION);
  });

  test('the schema has one string field plus sources, closed sets, and no numeric bounds', () => {
    const schema = prompt.jsonSchema;
    expect(schema.required).toEqual(['paragraph', 'sources']);
    expect(schema.properties.paragraph).toEqual({ type: 'string' });
    expect(schema.properties.sources.items.properties.from.items.enum).toEqual(['note', 'product', 'finding', 'prior', 'progress', 'fact']);
    expect(Object.keys(schema.properties)).not.toContain('suggestedTipId');
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems|exclusiveMinimum|exclusiveMaximum)"/);
  });

  test('normalizeInputs ignores underscore keys, caps the note, and is idempotent', () => {
    const once = tech.normalizeInputs({ ...FIXTURE, technicianNote: 'x'.repeat(5000) });
    expect(once.technicianNote.length).toBe(1500);
    expect(once).not.toHaveProperty('_meta');
    expect(tech.normalizeInputs(once)).toEqual(once);
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

  test('a restated progress line is allowed when the sentence names progress as its source', () => {
    const inputs = { ...FIXTURE, progressLines: ['Weed pressure is holding steady.'] };
    const a = answer(
      'Our technician saw chinch bugs at the trouble spot. Arena 50 WDG went on the front and side yards to treat them. Weeds are holding steady compared with our last visit.',
      [['note'], ['note', 'product'], ['progress', 'prior']],
    );
    expect(check(a, inputs).problems).toEqual([]);
    // The same sentence without that source, or with no progress line, is a guess.
    const unsourced = { ...a, sources: sources(a.paragraph, [['note'], ['note', 'product'], ['prior']]) };
    expect(check(unsourced, inputs).problems).toContain('unsupported_comparison');
  });

  test('a product target may be named as protection only when the product is the source', () => {
    const a = answer(
      'Our technician found chinch bugs in the trouble spot. Arena 50 WDG also protects against white grubs.',
      [['note'], ['product']],
    );
    expect(check(a).problems).toEqual([]);
  });
});

describe('validator: rejects', () => {
  test('a product that was not applied (the required rejection)', () => {
    const verdict = check(BAD_UNAPPLIED_PRODUCT);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('product_not_applied:celsius');
    // And the second sentence says the photos confirmed a cause.
    expect(verdict.problems).toContain('photo_confirms_cause');
  });

  test('a product from the last visit is not named as today\'s work', () => {
    const a = answer('Our technician found chinch bugs in the trouble spot. We applied Prior Fertilizer to the whole yard.', [['note'], ['prior']]);
    expect(problemsOf(a).join(' ')).toMatch(/product_not_applied:prior|unrecognized_name/);
  });

  test('a name nothing carries, even when the catalog does not know it', () => {
    const a = answer('Our technician found chinch bugs in the trouble spot. We used Zorbex on the front yard.', [['note'], ['note']]);
    expect(problemsOf(a)).toContain('unrecognized_name:Zorbex');
  });

  test.each([
    ['a condition no input carries', 'Our technician found chinch bugs in the trouble spot. We also noticed grubs in the back yard.', 'target_stated_as_found:grub'],
    ['a fungus nobody named', 'Our technician found chinch bugs in the trouble spot. We also saw signs of large patch near the fence.', 'condition_not_in_inputs:large_patch'],
    ['a target stated as found', 'Our technician found chinch bugs in the trouble spot. We saw mole crickets along the edge.', 'target_stated_as_found:mole_cricket'],
    ['a low-confidence finding stated as fact', 'Our technician found chinch bugs in the trouble spot. The lawn has thinning turf in the front.', 'low_confidence_stated_as_fact:thin'],
    ['a number', 'Our technician found chinch bugs in the trouble spot. We used 16.6 grams on the front yard.', 'number:16.6'],
    ['a score', 'Our technician found chinch bugs in the trouble spot. Your lawn scored 94 today.', 'number:94'],
    ['a unit', 'Our technician found chinch bugs in the trouble spot. We used a few grams on the front yard.', 'measurement'],
    ['a promise', 'Our technician found chinch bugs in the trouble spot. The lawn will recover on its own.', 'promise:will'],
    ['a next visit', 'Our technician found chinch bugs in the trouble spot. We are checking the spot again next visit.', 'promise:next visit'],
    ['result timing', 'Our technician found chinch bugs in the trouble spot. You should see improvement within two weeks.', 'timing'],
    ['a date', 'Our technician found chinch bugs in the trouble spot. Our last visit was in August.', 'date_or_season'],
    ['an absence claim', 'Our technician found chinch bugs in the trouble spot. There are no other issues on the lawn.', 'absence_claim'],
    ['a watering instruction', 'Our technician found chinch bugs in the trouble spot. Please water the front yard daily.', 'watering_or_mowing'],
    ['a greeting', 'Hi Sam, our technician found chinch bugs in the trouble spot. Thank you for choosing us.', 'greeting_or_ask'],
    ['first person singular', 'Our technician found chinch bugs in the trouble spot. I treated the front yard.', 'first_person_singular'],
    ['a price', 'Our technician found chinch bugs in the trouble spot. That treatment cost extra today.', 'money_or_registration'],
    ['a banned word', 'Our technician found chinch bugs in the trouble spot. The treatment is safe for pets.', 'banned_word:safe'],
    ['an overclaim', 'Our technician found chinch bugs in the trouble spot. The treatment eliminated them.', 'copy:eliminated'],
  ])('%s', (_name, text, expected) => {
    const a = answer(text, [['note']]);
    expect(problemsOf(a)).toContain(expected);
  });

  test('a color comparison between visits, even with a progress source', () => {
    const inputs = { ...FIXTURE, progressLines: ['Thickness is on track.'] };
    const a = answer('Our technician found chinch bugs in the trouble spot. The lawn looks greener than at our last visit.', [['note'], ['progress', 'prior']]);
    expect(check(a, inputs).problems).toContain('color_comparison');
  });

  test('a comparison with the last visit that restates no progress line', () => {
    const a = answer('Our technician found chinch bugs in the trouble spot. The turf looks thicker than at our last visit.', [['note'], ['prior']]);
    expect(problemsOf(a)).toContain('unsupported_comparison');
  });

  test('"the photos confirmed" a cause, in any wording', () => {
    for (const text of [
      'The photos confirm chinch bugs in the trouble spot. Arena 50 WDG went on the front and side yards.',
      'Our photo read showed chinch bugs in the trouble spot. Arena 50 WDG went on the front and side yards.',
    ]) {
      expect(problemsOf(answer(text, [['finding'], ['product']]))).toContain('photo_confirms_cause');
    }
  });

  test('shape: one sentence, five sentences, over 70 words, markup, newline, empty', () => {
    expect(problemsOf(answer('Our technician found chinch bugs in the trouble spot.'))).toContain('sentence_count:1');
    const five = answer('Our technician found chinch bugs. We treated the front yard with Arena 50 WDG. We fed the lawn with LESCO 24-0-11. The back yard looks fine. The side yard got the same.', [['note']]);
    expect(problemsOf(five)).toContain('sentence_count:5');
    const long = answer(`Our technician found chinch bugs in the trouble spot ${'near the front edge of the yard '.repeat(10)}today. We treated them with Arena 50 WDG.`, [['note']]);
    expect(problemsOf(long).join(' ')).toMatch(/too_long/);
    expect(problemsOf(answer('Our technician found **chinch bugs** in the trouble spot. We treated them with Arena 50 WDG.'))).toContain('markup');
    expect(problemsOf(answer('Our technician found chinch bugs in the trouble spot.\nWe treated them with Arena 50 WDG.'))).toContain('markup');
    expect(check({ paragraph: '   ', sources: [] }).problems).toEqual(['empty']);
    expect(check(null).problems).toEqual(['no_answer']);
  });

  test('sources: missing, mismatched, unknown key, wrong count', () => {
    const text = 'Our technician found chinch bugs in the trouble spot. Arena 50 WDG went on the front and side yards to treat them.';
    expect(check({ paragraph: text }).problems).toContain('sources_count');
    expect(check({ paragraph: text, sources: sources(text, [['note']]).map((s, i) => (i ? { ...s, sentence: 'something else entirely' } : s)) }).problems).toContain('sources_mismatch');
    expect(check({ paragraph: text, sources: sources(text, [['note'], ['rumor']]) }).problems).toContain('sources_invalid');
    expect(check({ paragraph: text, sources: sources(text, [['note'], []]) }).problems).toContain('sources_invalid');
    expect(check({ paragraph: text, sources: sources(text, [['product'], ['product']]) }).problems).toContain('cause_unsourced:chinch');
  });

  test('a product named in a sentence whose sources are neither product nor note', () => {
    const a = answer('Our technician found chinch bugs in the trouble spot. Arena 50 WDG went on the front and side yards.', [['note'], ['fact']]);
    expect(problemsOf(a)).toContain('product_unsourced');
  });

  test('a cause only the last visit carries is not today\'s finding', () => {
    const inputs = { ...FIXTURE, technicianNote: 'Applied Arena to the front yard and fertilizer to the whole yard today.', prior: { ...FIXTURE.prior, watched: ['chinch bug damage'] } };
    const a = answer('We found chinch bugs in the front yard. Arena 50 WDG went on to treat them.', [['prior'], ['product']]);
    expect(problemsOf(a, inputs).join(' ')).toMatch(/condition_from_prior_only:chinch/);
  });
});

describe('the one model call', () => {
  beforeEach(() => dispatchWithFallback.mockReset());

  test('goes through the report policy, lane lawn_tech_paragraph, schema, deadline and a validator', async () => {
    dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
      const result = { ok: true, json: { paragraph: GOOD_1.paragraph, sources: GOOD_1.sources }, provider: 'openai' };
      return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
    });
    const out = await tech.generateTechParagraph(FIXTURE);
    expect(out).toMatchObject({ ok: true, paragraph: GOOD_1.paragraph });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.report);
    expect(payload).toMatchObject({ laneId: 'lawn_tech_paragraph', promptVersion: tech.PROMPT_VERSION, jsonMode: true, timeoutMs: 15000 });
    expect(payload.jsonSchema).toEqual(tech.techParagraphSchema());
    expect(payload.text).toContain(FIXTURE.technicianNote);
    expect(options).toMatchObject({ hardDeadline: true, reserveFallbackBudget: true });
    expect(typeof options.validate).toBe('function');
    expect(options.validate({ ok: true, json: BAD_UNAPPLIED_PRODUCT })).toMatch(/^tech_paragraph:.*product_not_applied:celsius/);
  });

  test('a rejected answer stores nothing and says why; an unavailable provider is a quiet miss', async () => {
    dispatchWithFallback.mockImplementationOnce(async (_p, _pl, options) => {
      const result = { ok: true, json: { paragraph: BAD_UNAPPLIED_PRODUCT.paragraph, sources: BAD_UNAPPLIED_PRODUCT.sources } };
      const rejection = options.validate(result);
      return rejection ? { ok: false, reason: 'all_providers_failed' } : result;
    });
    expect(await tech.generateTechParagraph(FIXTURE)).toMatchObject({ ok: false, reason: 'rejected', problems: expect.arrayContaining(['product_not_applied:celsius']) });
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_providers_failed' });
    expect(await tech.generateTechParagraph(FIXTURE)).toMatchObject({ ok: false, reason: 'all_providers_failed' });
    dispatchWithFallback.mockRejectedValueOnce(new Error('boom'));
    expect(await tech.generateTechParagraph(FIXTURE)).toEqual({ ok: false, reason: 'error' });
  });

  describe('the 15 second ceiling (the technician is holding the phone at Complete)', () => {
    afterEach(() => jest.useRealTimers());
    const settled = (promise) => { const state = { done: false, value: null }; promise.then((v) => { state.done = true; state.value = v; }); return state; };

    test('the budget is 15 s and the dispatcher is told to split it across both legs', async () => {
      expect(tech.BUDGET_MS).toBe(15000);
      dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_providers_failed' });
      await tech.generateTechParagraph(FIXTURE);
      expect(dispatchWithFallback.mock.calls[0][1].timeoutMs).toBe(15000);
      expect(dispatchWithFallback.mock.calls[0][2]).toMatchObject({ hardDeadline: true, reserveFallbackBudget: true });
    });

    test('a dispatcher that never answers cannot hold the step past 15 s: nothing is returned as a paragraph', async () => {
      jest.useFakeTimers();
      dispatchWithFallback.mockImplementation(() => new Promise(() => {}));
      const out = settled(tech.generateTechParagraph(FIXTURE));
      await jest.advanceTimersByTimeAsync(14999);
      expect(out.done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(out.done).toBe(true);
      expect(out.value).toMatchObject({ ok: false, reason: 'timeout' });
    });

    test('an injected model that answers too late is dropped, even though it later validates', async () => {
      jest.useFakeTimers();
      const callModel = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: { paragraph: GOOD_2.paragraph, sources: GOOD_2.sources } }), 20000));
      const out = settled(tech.generateTechParagraph(FIXTURE, { callModel }));
      await jest.advanceTimersByTimeAsync(15000);
      expect(out.value).toMatchObject({ ok: false, reason: 'timeout' });
      await jest.advanceTimersByTimeAsync(10000);
      expect(out.value.ok).toBe(false);
    });

    test('the whole completion step (read, call, freeze) stores nothing and returns at 15 s', async () => {
      jest.useFakeTimers();
      dispatchWithFallback.mockImplementation(() => new Promise(() => {}));
      const knex = jest.fn();
      const out = settled(tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: '{}', knex, gatherInputs: async () => FIXTURE }));
      await jest.advanceTimersByTimeAsync(15000);
      expect(out.value).toMatchObject({ status: 'timeout' });
      expect(knex).not.toHaveBeenCalled();
    });
  });

  test('no note or no product: no call at all', async () => {
    expect(await tech.generateTechParagraph({ ...FIXTURE, technicianNote: '' })).toEqual({ ok: false, reason: 'no_note' });
    expect(await tech.generateTechParagraph({ ...FIXTURE, products: [] })).toEqual({ ok: false, reason: 'no_products' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('an injected model (the replay path) is held to the same validator', async () => {
    const callModel = jest.fn(async () => ({ ok: true, json: { paragraph: GOOD_2.paragraph, sources: GOOD_2.sources } }));
    expect(await tech.generateTechParagraph(FIXTURE, { callModel })).toMatchObject({ ok: true, paragraph: GOOD_2.paragraph });
    const bad = jest.fn(async () => ({ ok: true, json: { paragraph: BAD_UNAPPLIED_PRODUCT.paragraph, sources: BAD_UNAPPLIED_PRODUCT.sources } }));
    expect(await tech.generateTechParagraph(FIXTURE, { callModel: bad })).toMatchObject({ ok: false, reason: 'rejected' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('freeze and read', () => {
  const ENTRY = { v: 1, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text: GOOD_2.paragraph, sources: GOOD_2.sources, frozenAt: '2026-10-05T12:00:00.000Z' };
  const notes = (entry = ENTRY) => JSON.stringify({ lawnTechParagraph: { 77: entry } });

  test('reads only a whole entry for its own assessment', () => {
    expect(tech.readFrozenTechParagraph(notes(), 77)).toBe(GOOD_2.paragraph);
    expect(tech.readFrozenTechParagraph(notes(), 78)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, v: 2 }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, assessmentId: '5' }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph('not json', 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(null, 77)).toBeNull();
  });

  test('a frozen text that no longer passes the read-time screens prints nothing', () => {
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: 'We will be back soon to make sure the lawn recovers.' }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: 'Our treatment is safe for pets and kids.' }), 77)).toBeNull();
    expect(tech.readFrozenTechParagraph(notes({ ...ENTRY, text: 'word '.repeat(80) }), 77)).toBeNull();
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

  test('first writer wins; a lost race adopts the winner and overwrites nothing', async () => {
    const { knex, state } = fakeKnex({ other: 'kept' });
    expect(await tech.freezeTechParagraph('s1', ENTRY, knex)).toEqual(ENTRY);
    expect(state.notes.other).toBe('kept');
    const later = { ...ENTRY, text: GOOD_1.paragraph };
    expect(await tech.freezeTechParagraph('s1', later, knex)).toEqual(ENTRY);
    expect(state.notes.lawnTechParagraph['77'].text).toBe(GOOD_2.paragraph);
    expect(await tech.freezeTechParagraph('s1', null, knex)).toBeNull();
  });

  test('a failed write is a null, never a throw', async () => {
    const knex = () => ({ where() { return this; }, whereRaw() { return this; }, update: async () => { throw new Error('db down'); } });
    knex.raw = () => ({});
    expect(await tech.freezeTechParagraph('s1', ENTRY, knex)).toBeNull();
  });

  describe('createAndFreezeTechParagraph', () => {
    const run = (extra = {}) => tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: '{}', knex: extra.knex, gatherInputs: extra.gatherInputs || (async () => FIXTURE), deps: extra.deps });

    test('writes once: already frozen means no gather and no model call', async () => {
      const gatherInputs = jest.fn();
      const generate = jest.fn();
      const out = await tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: notes(), knex: null, gatherInputs, deps: { generate } });
      expect(out.status).toBe('already_frozen');
      expect(gatherInputs).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    });

    test('a read failure is no paragraph and no model call', async () => {
      const generate = jest.fn();
      const out = await run({ gatherInputs: async () => { throw new Error('read failed'); }, deps: { generate } });
      expect(out.status).toBe('read_failed');
      expect(generate).not.toHaveBeenCalled();
    });

    test('a degraded build (no inputs) writes nothing', async () => {
      const generate = jest.fn();
      expect((await run({ gatherInputs: async () => null, deps: { generate } })).status).toBe('no_inputs');
      expect(generate).not.toHaveBeenCalled();
    });

    test('a rejected or missing paragraph freezes nothing', async () => {
      const { knex, state } = fakeKnex();
      const out = await run({ knex, deps: { generate: async () => ({ ok: false, reason: 'rejected', problems: ['product_not_applied:celsius'] }) } });
      expect(out).toMatchObject({ status: 'rejected', problems: ['product_not_applied:celsius'] });
      expect(state.updates).toBe(0);
    });

    test('a good paragraph freezes with its sources and prompt version', async () => {
      const { knex, state } = fakeKnex();
      const out = await run({
        knex,
        deps: { generate: async () => ({ ok: true, paragraph: GOOD_1.paragraph, sources: GOOD_1.sources, inputsHash: 'abc' }), now: () => new Date('2026-10-05T12:00:00Z') },
      });
      expect(out.status).toBe('frozen');
      expect(state.notes.lawnTechParagraph['77']).toMatchObject({ v: 1, promptVersion: tech.PROMPT_VERSION, assessmentId: '77', text: GOOD_1.paragraph, frozenAt: '2026-10-05T12:00:00.000Z' });
      expect(tech.readFrozenTechParagraph(state.notes, 77)).toBe(GOOD_1.paragraph);
    });
  });
});
