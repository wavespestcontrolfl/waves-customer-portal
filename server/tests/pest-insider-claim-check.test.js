// Pest Insider claim check: a lead sentence survives only when its numbers, months
// and names all come from the lead fact. A failing sentence is cut, never rewritten.
const { checkClaims, sentenceProblem, factSource, MIN_LEAD_SENTENCES } = require('../services/pest-insider/claim-check');
const { factById } = require('../services/pest-insider/facts');
const { SPECIES } = require('../services/pest-insider/plan');

const FACT = factById('M01'); // mosquito eggs survive drying out for up to 8 months (CDC)
const SPECIES_ENTRY = SPECIES.find((s) => s.slug === 'aedes-mosquito');
const GOOD_1 = 'The CDC says mosquito eggs can survive drying out for up to 8 months.';
const GOOD_2 = 'Adult females lay them on the inner walls of containers, above the waterline.';

const sentence = (text, fact_id = FACT.id) => ({ text, fact_id });
const run = (sentences, extra = {}) => checkClaims({
  draft: {
    subject: '🦟 Mosquito eggs wait 8 months dry',
    preview: 'Dry does not mean gone.',
    lead: { headline: 'Dry eggs, wet future', sentences },
    id_item: { text: SPECIES_ENTRY.fact },
    ...extra,
  },
  leadFact: FACT,
  idItem: SPECIES_ENTRY,
});

describe('lead sentences', () => {
  test('a sentence that restates the fact is kept', () => {
    const r = run([sentence(GOOD_1), sentence(GOOD_2)]);
    expect(r.ok).toBe(true);
    expect(r.cut).toEqual([]);
    expect(r.lead.map((s) => s.text)).toEqual([GOOD_1, GOOD_2]);
  });

  test('a number that is not in the fact cuts the sentence', () => {
    const r = run([sentence(GOOD_1), sentence(GOOD_2), sentence('Mosquito eggs can survive for up to 9 months.')]);
    expect(r.cut).toEqual([{ text: 'Mosquito eggs can survive for up to 9 months.', reason: expect.stringContaining('number not in the source: 9') }]);
    expect(r.lead).toHaveLength(2);
  });

  test('number words and digits are the same number; a different number word is cut', () => {
    expect(sentenceProblem('Eggs survive up to eight months.', factSource(FACT))).toBeNull();
    expect(sentenceProblem('Eggs survive up to nine months.', factSource(FACT))).toMatch(/number not in the source: 9/);
    expect(sentenceProblem('A mosquito needs 7-10 days to grow up.', factSource(FACT))).toBeNull();
    expect(sentenceProblem('A mosquito needs 14 days to grow up.', factSource(FACT))).toMatch(/14/);
  });

  test('fractions and percents must be in the fact too', () => {
    const lawn = factById('L05'); // never lose more than one-third of the blade; quote says 1/3
    expect(sentenceProblem('Never cut more than 1/3 of the blade.', factSource(lawn))).toBeNull();
    expect(sentenceProblem('Never cut more than one-third of the blade.', factSource(lawn))).toBeNull();
    expect(sentenceProblem('Never cut more than half of the blade.', factSource(lawn))).toMatch(/1\/2/);
    expect(sentenceProblem('About 50 percent of the blade can go.', factSource(lawn))).toMatch(/number not in the source/);
  });

  test('a month that is not in the fact cuts the sentence; "may" the verb does not count', () => {
    const r = run([sentence(GOOD_1), sentence(GOOD_2), sentence('The first rains in June hatch them.')]);
    expect(r.cut[0].reason).toMatch(/month or season not in the source: june/);
    expect(sentenceProblem('Eggs may survive a dry spell.', factSource(FACT))).toBeNull();
    expect(sentenceProblem('Watch for them in May.', factSource(FACT))).toMatch(/may/);
    const oct = factById('T02'); // April through June, peaking in May
    expect(sentenceProblem('They swarm from April through June.', factSource(oct))).toBeNull();
    expect(sentenceProblem('Swarms peak in May.', factSource(oct))).toBeNull();
    expect(sentenceProblem('Swarms peak in October.', factSource(oct))).toMatch(/october/);
  });

  test('a season word that is not in the fact is cut', () => {
    expect(sentenceProblem('This matters most in winter.', factSource(FACT))).toMatch(/winter/);
  });

  test('a name that is not in the fact is cut, including a brand', () => {
    expect(sentenceProblem('Entomologist Jane Doe found this.', factSource(FACT))).toMatch(/name not in the source/);
    expect(sentenceProblem('The Florida Medical Entomology Laboratory tested it.', factSource(FACT))).toMatch(/name not in the source/);
    expect(sentenceProblem('Termidor is what pros reach for.', factSource(FACT))).toMatch(/brand/);
    expect(sentenceProblem('Some Acme Mosquito Magnet works.', factSource(FACT))).toMatch(/name not in the source/);
    expect(sentenceProblem('A Latin name like A. aegypti is not here.', factSource(FACT))).toMatch(/name not in the source/);
  });

  test('a capital that opens a later sentence is not a name', () => {
    expect(sentenceProblem('Eggs survive 8 months. That is why scrubbing matters. Mosquitoes lay them above the waterline.', factSource(FACT))).toBeNull();
    expect(sentenceProblem('Eggs survive 8 months. Acme Corp says so.', factSource(FACT))).toMatch(/name not in the source: Acme Corp/);
  });

  test('Florida, Waves and the fact publisher are allowed names', () => {
    expect(sentenceProblem('Here in Florida, the CDC says eggs survive 8 months.', factSource(FACT))).toBeNull();
    const lawn = factById('L02');
    expect(sentenceProblem('UF/IFAS says to water when the grass shows thirst.', factSource(lawn))).toBeNull();
  });

  test('dollar signs, "safe", guarantees, promises and pesticide names are cut', () => {
    for (const text of [
      'A good fix costs $20.',
      'That makes the yard safe for kids.',
      'It is pet-safe.',
      'We guarantee it.',
      'We promise no more mosquitoes.',
      'Bifenthrin works well on eggs.',
      'Bleach kills them.',
    ]) expect({ text, reason: sentenceProblem(text, factSource(FACT)) }).toEqual({ text, reason: expect.any(String) });
  });

  test('the existing newsletter tripwires apply, but UF\'s own Formosan window is not blocked', () => {
    expect(sentenceProblem('A technician can eliminate them for good.', factSource(FACT))).toMatch(/tripwire/);
    const formosan = factById('T02');
    expect(sentenceProblem(formosan.statement, factSource(formosan))).toBeNull();
    expect(sentenceProblem('Formosan termites swarm again after storms in June.', factSource(formosan))).toMatch(/tripwire|month/);
  });

  test('fact_id must be the plan\'s lead fact', () => {
    const r = run([sentence(GOOD_1), sentence(GOOD_2), sentence(GOOD_2, 'P03')]);
    expect(r.cut).toEqual([{ text: GOOD_2, reason: expect.stringContaining('is not the lead fact M01') }]);
  });

  test('at most one Waves line, and it never sells', () => {
    const waves = 'A Waves technician can look at the spot during a regular visit.';
    const r = run([sentence(GOOD_1), sentence(GOOD_2), sentence(waves), sentence('Waves also looks at containers.')]);
    expect(r.lead.map((s) => s.text)).toContain(waves);
    expect(r.cut.map((c) => c.reason)).toEqual(['more than one Waves line']);
    const sells = run([sentence(GOOD_1), sentence(GOOD_2), sentence('Call Waves to book a visit.')]);
    expect(sells.cut[0].reason).toBe('Waves line sells');
  });

  test('keeps at most four lead sentences', () => {
    const r = run([GOOD_1, GOOD_2, 'Eggs can survive drying out.', 'Eggs stick to the walls of containers.', 'Containers can hold water.'].map((t) => sentence(t)));
    expect(r.lead).toHaveLength(4);
    expect(r.cut).toEqual([{ text: 'Containers can hold water.', reason: 'more than 4 sentences' }]);
  });
});

describe('overall verdict', () => {
  test('needs at least two kept lead sentences', () => {
    expect(MIN_LEAD_SENTENCES).toBe(2);
    const one = run([sentence(GOOD_1), sentence('Eggs last 9 months.')]);
    expect(one.lead).toHaveLength(1);
    expect(one.ok).toBe(false);
    expect(run([sentence('Eggs last 9 months.'), sentence('Eggs last 11 months.')]).ok).toBe(false);
  });

  test('a failing id_item fails the issue; its numbers must be in the species entry', () => {
    const ok = run([sentence(GOOD_1), sentence(GOOD_2)]);
    expect(ok.idItem).toEqual({ ok: true, text: SPECIES_ENTRY.fact, reason: null });
    const bad = run([sentence(GOOD_1), sentence(GOOD_2)], { id_item: { text: 'It raises a generation in about 3 days.' } });
    expect(bad.ok).toBe(false);
    expect(bad.idItem.reason).toMatch(/number not in the source: 3/);
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { id_item: { text: '' } }).ok).toBe(false);
  });

  test('a bad headline, subject or preview falls back instead of failing the issue', () => {
    const r = run([sentence(GOOD_1), sentence(GOOD_2)], {
      subject: 'No emoji and a $5 claim',
      preview: 'Termidor wins',
      lead: { headline: 'Gone by 2030', sentences: [sentence(GOOD_1), sentence(GOOD_2)] },
    });
    expect(r.ok).toBe(true);
    expect(r.headline).toBe(FACT.title);
    expect(r.subject).toBeNull();
    expect(r.preview).toBeNull();
    expect(r.fallbacks).toEqual(['headline', 'subject', 'preview']);
  });

  test('a subject needs exactly one leading emoji and the voice-profile length', () => {
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { subject: '🦟🦟 Mosquito eggs' }).subject).toBeNull();
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { subject: `🦟 ${'Mosquito eggs '.repeat(8)}` }).subject).toBeNull();
    expect(run([sentence(GOOD_1), sentence(GOOD_2)]).subject).toBe('🦟 Mosquito eggs wait 8 months dry');
  });
});
