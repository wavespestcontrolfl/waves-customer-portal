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

  test('a comparison is accepted only when a fixed progress line has the same metric and direction', () => {
    const inputs = { ...FIXTURE, progressLines: ['Weed pressure is holding steady.', 'Thickness is on track.'] };
    const base = 'Our technician saw chinch bugs at the trouble spot. Arena 50 WDG went on the front and side yards to treat them.';
    const withThird = (third, from = ['progress', 'prior']) => answer(`${base} ${third}`, [['note'], ['note', 'product'], from]);
    expect(check(withThird('Weeds are holding steady compared with our last visit.'), inputs).problems).toEqual([]);
    expect(check(withThird('Thickness is on track since our last visit.'), inputs).problems).toEqual([]);
    // Right metric, wrong direction; wrong metric; no metric: all rejected.
    expect(check(withThird('Weeds are ahead of schedule compared with our last visit.'), inputs).problems).toContain('comparison_without_progress');
    expect(check(withThird('Weeds are behind where we hoped compared with our last visit.'), inputs).problems).toContain('comparison_without_progress');
    expect(check(withThird('Stressed areas are holding steady compared with our last visit.'), inputs).problems).toContain('comparison_without_progress');
    expect(check(withThird('The lawn is better than at our last visit.'), inputs).problems).toContain('comparison_without_progress');
  });

  test('every clause of a compound comparison needs its own progress line', () => {
    const weedsOnly = { ...FIXTURE, progressLines: ['Weed pressure is holding steady.'] };
    const both = { ...FIXTURE, progressLines: ['Weed pressure is holding steady.', 'Turf repair is behind where we expected.'] };
    const base = 'Our technician saw chinch bugs at the trouble spot. Arena 50 WDG went on the front and side yards to treat them.';
    const a = answer(`${base} Weeds are holding steady, but stressed areas are worse than at our last visit.`, [['note'], ['note', 'product'], ['progress', 'prior']]);
    expect(check(a, weedsOnly).problems).toContain('comparison_without_progress');
    expect(check(a, both).problems).toEqual([]);
    // A clause naming two metrics or two directions is never supported.
    const two = answer(`${base} Weeds and thin areas are holding steady since our last visit.`, [['note'], ['note', 'product'], ['progress', 'prior']]);
    expect(check(two, both).problems).toContain('comparison_without_progress');
  });

  test('naming "progress" as the source is not enough: with no progress line every comparison is rejected', () => {
    for (const progressLines of [[], undefined]) {
      const a = answer('Our technician found chinch bugs in the trouble spot. The turf looks thicker than at our last visit.', [['note'], ['progress', 'prior']]);
      expect(check(a, { ...FIXTURE, progressLines }).problems).toContain('comparison_without_progress');
    }
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
    expect(problemsOf(a)).toContain('unrecognized_name');
    // The code never carries the token: the write gate logs these codes.
    expect(problemsOf(a).join(' ')).not.toMatch(/Zorbex/);
  });

  test.each([
    ['a condition no input carries', 'Our technician found chinch bugs in the trouble spot. We also noticed grubs in the back yard.', 'target_stated_as_found:grub'],
    ['a fungus nobody named', 'Our technician found chinch bugs in the trouble spot. We also saw signs of large patch near the fence.', 'condition_not_in_inputs:large_patch'],
    ['a target stated as found', 'Our technician found chinch bugs in the trouble spot. We saw mole crickets along the edge.', 'target_stated_as_found:mole_cricket'],
    ['a low-confidence finding stated as fact', 'Our technician found chinch bugs in the trouble spot. The lawn has thinning turf in the front.', 'low_confidence_stated_as_fact:thin'],
    ['a number', 'Our technician found chinch bugs in the trouble spot. We used 16.6 grams on the front yard.', 'number'],
    ['a score', 'Our technician found chinch bugs in the trouble spot. Your lawn scored 94 today.', 'number'],
    ['a unit', 'Our technician found chinch bugs in the trouble spot. We used a few grams on the front yard.', 'measurement'],
    ['a product-name number used elsewhere', 'Our technician found chinch bugs in the trouble spot. Arena 50 WDG went on, and the lawn is 50 recovered.', 'number'],
    ['a condition the vocabulary does not know', 'Our technician found nematodes in the lawn. Arena 50 WDG went on the front yard to treat them.', 'observed_unrecognized'],
    ['a found claim with no condition at all', 'Our technician found the lawn in good shape. Arena 50 WDG went on the front yard.', 'observed_unrecognized'],
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
    expect(problemsOf(a)).toContain('comparison_without_progress');
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

describe('validator: negation and uncertainty in the technician note', () => {
  const noted = (technicianNote) => ({ ...FIXTURE, technicianNote });
  const NONE = noted('Applied Arena to the front and side yards. No chinch bugs found today, this was a preventive treatment. Also applied LESCO 24-0-11 to the whole yard.');
  const MAYBE = noted('Applied Arena to the front and side yards. May be chinch bugs in the trouble spot, not sure. Also applied LESCO 24-0-11 to the whole yard.');
  const sentenceOf = (second, from) => answer(`Arena 50 WDG went on the front and side yards. ${second}`, [['note', 'product'], from]);

  test('note says "no chinch bugs found" + Arena: "found chinch bugs" is rejected', () => {
    const a = sentenceOf('Our technician found chinch bugs in the trouble spot.', ['note']);
    expect(check(a, NONE).problems).toContain('negated_in_note_stated_as_found:chinch');
  });

  test('the note wins over a high-confidence photo finding and a fixed line', () => {
    const thinNote = noted('Applied Arena to the front and side yards. No thinning turf found today. Also applied LESCO 24-0-11 to the whole yard.');
    const highThin = { ...thinNote, findings: [{ label: 'thinning turf', confidence: 'high' }] };
    expect(check(sentenceOf('Our technician found thinning turf near the driveway.', ['note', 'finding']), highThin).problems)
      .toContain('negated_in_note_stated_as_found:thin');
    // Doubt in the note still needs a hedge, even with a high finding behind it.
    const maybeThin = { ...noted('Applied Arena to the front and side yards. Might be some thinning turf near the driveway. Also applied LESCO 24-0-11 to the whole yard.'), findings: [{ label: 'thinning turf', confidence: 'high' }] };
    expect(check(sentenceOf('Our technician found thinning turf near the driveway.', ['note', 'finding']), maybeThin).problems)
      .toContain('uncertain_stated_as_fact:thin');
    expect(check(sentenceOf('Our technician may have seen some thinning turf near the driveway.', ['note', 'finding']), maybeThin).problems).toEqual([]);
  });

  test('...but a treatment-purpose claim is accepted', () => {
    for (const second of ['We treated the whole lawn to protect against chinch bugs.', 'The treatment is there to go after chinch bugs.']) {
      expect(check(sentenceOf(second, ['product']), NONE).problems).toEqual([]);
    }
    // A purpose claim still needs the product source.
    expect(check(sentenceOf('We treated the whole lawn to protect against chinch bugs.', ['note']), NONE).problems).toContain('purpose_without_product_source:chinch');
  });

  test('...and "found no chinch bugs" is accepted, with a note source; without one it is not', () => {
    expect(check(sentenceOf('Our technician found no chinch bugs today.', ['note']), NONE).problems).toEqual([]);
    expect(check(sentenceOf('Our technician found no chinch bugs today.', ['fact']), NONE).problems).toContain('negation_unsourced:chinch');
  });

  test('"no chinch bugs" when the record never says so, or says the opposite, is rejected', () => {
    expect(check(sentenceOf('Our technician found no chinch bugs today.', ['note']), FIXTURE).problems).toContain('negation_contradicts_record:chinch');
    expect(check(sentenceOf('Our technician found no grubs today.', ['note']), FIXTURE).problems).toContain('absence_not_in_record:grub');
  });

  test('note says "may be chinch bugs": unhedged "found chinch bugs" is rejected; hedged is accepted', () => {
    expect(check(sentenceOf('Our technician found chinch bugs in the trouble spot.', ['note']), MAYBE).problems).toContain('uncertain_stated_as_fact:chinch');
    expect(check(sentenceOf('Our technician thinks chinch bugs may be in the trouble spot.', ['note']), MAYBE).problems).toEqual([]);
  });

  test('negation reaches a whole list, and a "but" ends it', () => {
    const list = noted('Applied Arena. No chinch bugs, grubs or webworms seen. Applied LESCO 24-0-11 to the whole yard.');
    expect(check(sentenceOf('Our technician saw grubs near the fence.', ['note']), list).problems).toContain('negated_in_note_stated_as_found:grub');
    const but = noted('Applied Arena. Did not see grubs, but there are chinch bugs at the trouble spot. Applied LESCO 24-0-11 to the whole yard.');
    expect(check(sentenceOf('Our technician found chinch bugs in the trouble spot.', ['note']), but).problems).toEqual([]);
    expect(check(sentenceOf('Our technician saw grubs near the fence.', ['note']), but).problems).toContain('negated_in_note_stated_as_found:grub');
  });

  test('a product role or target never makes a "found" claim: "We found insects" on a preventive Arena visit', () => {
    const preventive = noted('Applied Arena to the front and side yards as a preventive treatment. Applied LESCO 24-0-11 to the whole yard.');
    for (const second of ['We found insects in the front yard.', 'We saw white grubs along the edge.', 'There are billbugs in the lawn.']) {
      const verdict = check(sentenceOf(second, ['note', 'product']), preventive);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/target_stated_as_found|condition_not_in_inputs/);
    }
    expect(check(sentenceOf('Arena protects against white grubs.', ['product']), preventive).problems).toEqual([]);
  });

  test('a conflict in the note (affirmed and negated for the same term) reads as uncertain', () => {
    const conflict = noted('Applied Arena. There are chinch bugs in the front. No chinch bugs in the back. Applied LESCO 24-0-11.');
    expect(check(sentenceOf('Our technician found chinch bugs in the trouble spot.', ['note']), conflict).problems).toContain('uncertain_stated_as_fact:chinch');
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

    test('a slow record read, a slow gather or a late model makes the WHOLE step time out at 15 s with no write', async () => {
      jest.useFakeTimers();
      const never = () => new Promise(() => {});
      const cases = [
        { name: 'record read', args: { getStructuredNotes: never, gatherInputs: async () => FIXTURE } },
        { name: 'gather', args: { structuredNotes: '{}', gatherInputs: never } },
        { name: 'gather finishing late', args: { structuredNotes: '{}', gatherInputs: () => new Promise((r) => setTimeout(() => r(FIXTURE), 20000)) } },
      ];
      for (const { args } of cases) {
        dispatchWithFallback.mockReset();
        const knex = jest.fn();
        const out = settled(tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, knex, ...args }));
        await jest.advanceTimersByTimeAsync(14999);
        expect(out.done).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(out.value).toEqual({ status: 'timeout' });
        await jest.advanceTimersByTimeAsync(10000); // the straggler lands: still nothing
        expect(knex).not.toHaveBeenCalled();
        expect(dispatchWithFallback).not.toHaveBeenCalled();
      }
    });

    test('time spent reading and gathering is taken off the model call, and a validated paragraph that lands after the deadline is not frozen', async () => {
      jest.useFakeTimers();
      const knex = jest.fn();
      // Gather takes 9 s: the model gets only the remaining ~6 s.
      const seen = [];
      const generate = jest.fn(async (_inputs, deps) => { seen.push(deps.budgetMs); await new Promise((r) => setTimeout(r, 7000)); return { ok: true, paragraph: GOOD_2.paragraph, sources: GOOD_2.sources }; });
      const out = settled(tech.createAndFreezeTechParagraph({
        serviceRecordId: 's1', assessmentId: 77, structuredNotes: '{}', knex, deps: { generate },
        gatherInputs: () => new Promise((r) => setTimeout(() => r(FIXTURE), 9000)),
      }));
      await jest.advanceTimersByTimeAsync(15000);
      expect(seen[0]).toBeLessThanOrEqual(6000);
      expect(seen[0]).toBeGreaterThan(5000);
      expect(out.value).toEqual({ status: 'timeout' });
      await jest.advanceTimersByTimeAsync(5000);
      expect(knex).not.toHaveBeenCalled();
    });

    test('the freeze already issued before the deadline finishes whole (one atomic statement); none is issued after it', async () => {
      jest.useFakeTimers();
      let issued = 0;
      let finished = 0;
      const knex = () => ({ where() { return this; }, whereRaw() { return this; }, update: async () => { issued += 1; await new Promise((r) => setTimeout(r, 3000)); finished += 1; return 1; } });
      knex.raw = () => ({});
      const generate = async () => ({ ok: true, paragraph: GOOD_2.paragraph, sources: GOOD_2.sources });
      const out = settled(tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: '{}', knex, deps: { generate }, gatherInputs: () => new Promise((r) => setTimeout(() => r(FIXTURE), 13000)) }));
      await jest.advanceTimersByTimeAsync(13000);
      expect(issued).toBe(1); // started at 13 s, past the model call
      await jest.advanceTimersByTimeAsync(2000);
      expect(out.value).toEqual({ status: 'timeout' }); // the caller is released at 15 s
      await jest.advanceTimersByTimeAsync(2000);
      expect(finished).toBe(1);
      // A freeze that would START after the deadline never does.
      issued = 0;
      const late = settled(tech.createAndFreezeTechParagraph({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: '{}', knex, deps: { generate: () => new Promise((r) => setTimeout(() => r({ ok: true, paragraph: GOOD_2.paragraph, sources: GOOD_2.sources }), 16000)) }, gatherInputs: async () => FIXTURE }));
      await jest.advanceTimersByTimeAsync(20000);
      expect(late.value).toEqual({ status: 'timeout' });
      expect(issued).toBe(0);
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
