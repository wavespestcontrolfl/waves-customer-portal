// Pest Insider claim check: a lead sentence survives only when its numbers, months
// and names all come from the lead fact. A failing sentence is cut, never rewritten.
const { checkClaims, sentenceProblem, creditProblem, quantityPairs, factSource, MIN_LEAD_SENTENCES } = require('../services/pest-insider/claim-check');
const { factById } = require('../services/pest-insider/facts');
const { SPECIES } = require('../services/pest-insider/plan');

const FACT = factById('M01'); // mosquito eggs survive drying out for up to 8 months (CDC)
const SPECIES_ENTRY = SPECIES.find((s) => s.slug === 'aedes-mosquito');
const GOOD_1 = 'The CDC says eggs can survive drying out for up to 8 months.'; // a word-for-word copy of a CDC quote
const GOOD_2 = 'Adult females lay them on the inner walls of containers, above the waterline.';

const sentence = (text, fact_id = FACT.id) => ({ text, fact_id });
// The pooled checks (numbers, units, months, names) on their own, without the
// word-for-word copy rule, which has its own tests below.
const loose = (fact) => ({ ...factSource(fact), units: null });
const run = (sentences, extra = {}) => checkClaims({
  draft: {
    subject: '🦟 Dry does not mean gone for mosquito eggs',
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
    expect(sentenceProblem('Eggs survive up to eight months.', loose(FACT))).toBeNull();
    expect(sentenceProblem('Eggs survive up to nine months.', loose(FACT))).toMatch(/number not in the source: 9/);
    expect(sentenceProblem('A mosquito needs 7-10 days to grow up.', loose(FACT))).toBeNull();
    expect(sentenceProblem('A mosquito needs 14 days to grow up.', loose(FACT))).toMatch(/14/);
  });

  test('fractions and percents must be in the fact too', () => {
    const lawn = factById('L05'); // never lose more than one-third of the blade; quote says 1/3
    expect(sentenceProblem('Never cut more than 1/3 of the blade.', loose(lawn))).toBeNull();
    expect(sentenceProblem('Never cut more than one-third of the blade.', loose(lawn))).toBeNull();
    expect(sentenceProblem('Never cut more than half of the blade.', loose(lawn))).toMatch(/1\/2/);
    expect(sentenceProblem('About 50 percent of the blade can go.', loose(lawn))).toMatch(/number not in the source/);
  });

  test('a month that is not in the fact cuts the sentence; "may" the verb does not count', () => {
    const r = run([sentence(GOOD_1), sentence(GOOD_2), sentence('The first rains in June hatch them.')]);
    expect(r.cut[0].reason).toMatch(/month or season not in the source: june/);
    expect(sentenceProblem('Eggs may survive a dry spell.', loose(FACT))).toBeNull();
    expect(sentenceProblem('Watch for them in May.', loose(FACT))).toMatch(/may/);
    const oct = factById('T02'); // April through June, peaking in May
    expect(sentenceProblem('They swarm from April through June.', loose(oct))).toBeNull();
    expect(sentenceProblem('Swarms peak in May.', loose(oct))).toBeNull();
    expect(sentenceProblem('Swarms peak in October.', loose(oct))).toMatch(/october/);
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
    expect(sentenceProblem('Eggs survive 8 months. That is why scrubbing matters. Mosquitoes lay them above the waterline.', loose(FACT))).toBeNull();
    expect(sentenceProblem('Eggs survive 8 months. Acme Corp says so.', loose(FACT))).toMatch(/name not in the source: Acme Corp/);
  });

  test('Florida, Waves and the fact publisher are allowed names', () => {
    expect(sentenceProblem('Here in Florida, the CDC says eggs survive 8 months.', loose(FACT))).toBeNull();
    const lawn = factById('L02');
    expect(sentenceProblem('UF/IFAS says to water when the grass shows thirst.', loose(lawn))).toBeNull();
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

  test('the shared register the send validator runs applies here, with its Formosan window', () => {
    expect(sentenceProblem('A technician can eliminate them for good.', factSource(FACT))).toMatch(/tripwire/);
    const formosan = factById('T02');
    expect(sentenceProblem(formosan.statement, factSource(formosan))).toBeNull();
    expect(sentenceProblem(formosan.quotes[0].split('. ')[0] + '.', factSource(formosan))).toBeNull();
    expect(sentenceProblem('Formosan termites swarm again after storms in June.', factSource(formosan))).toMatch(/tripwire|month/);
    expect(sentenceProblem('Formosan termites swarm again in June.', loose(formosan))).toMatch(/tripwire: termite_second_swarm/);
  });

  test('a number must keep its own unit: a source number moved to another claim is cut', () => {
    const src = loose(FACT); // "up to 8 months" (dry eggs) and "7-10 days" (egg to adult)
    expect([...quantityPairs(src.facts)].sort()).toEqual(['10 day', '7 day', '8 month']);
    expect(sentenceProblem('Eggs survive dry for 10 months.', src)).toMatch(/number and unit not in the source: 10 month/);
    expect(sentenceProblem('An egg becomes an adult in 8 days.', src)).toMatch(/number and unit not in the source: 8 day/);
    expect(sentenceProblem('An egg takes 7 to 10 days to become an adult.', src)).toBeNull();
    expect(sentenceProblem('Eggs last 8-month dry spells.', src)).toBeNull();
  });

  test('a number or month sentence must copy one source sentence word for word', () => {
    const R02 = factById('R02'); // 12 days with food but no water; about 42 days with water but no food
    const src = factSource(R02);
    // Both numbers and both conditions are in the source, so only the copy rule catches the swap.
    expect(sentenceProblem('With food but no water, German roaches survive for 42 days.', loose(R02))).toBeNull();
    expect(sentenceProblem('With food but no water, German roaches survive for 42 days.', src)).toMatch(/copy that source sentence word for word/);
    expect(sentenceProblem('UF/IFAS says German cockroaches can survive only 12 days with food but no water.', src)).toBeNull();
    expect(sentenceProblem('If only water is present with no food, cockroaches can survive for about 42 days.', src)).toBeNull();
    expect(sentenceProblem('According to UF/IFAS, German cockroaches can survive only twelve days with food but no water.', src)).toBeNull();
    // the reviewed statement, whole or by its ", and" parts
    expect(sentenceProblem(R02.statement, src)).toBeNull();
    expect(sentenceProblem('A German roach lives 12 days with food but no water.', src)).toBeNull();
    // a sentence with no number or month may use its own words
    expect(sentenceProblem('Water matters more than food to a roach.', src)).toBeNull();
    // months are bound the same way (T03: R. hageni December to February, R. flavipes January to April)
    const T03 = factById('T03');
    expect(sentenceProblem('Native termites fly from December to April.', factSource(T03))).toMatch(/word for word/);
  });

  test('a copied number sentence credits only the publisher of that quote', () => {
    const D02 = factById('D02'); // CDC: mice and a pencil-width hole; UF/IFAS Charlotte: rats and half-inch cracks
    const src = factSource(D02);
    expect(sentenceProblem('The CDC says mice can fit through a hole the width of a pencil (1/4 inch or 6 millimeters in diameter).', src)).toBeNull();
    expect(sentenceProblem('UF/IFAS says mice can fit through a hole the width of a pencil (1/4 inch or 6 millimeters in diameter).', src)).toMatch(/credits UF\/IFAS for another source/);
    expect(sentenceProblem('The CDC says rats can squeeze through cracks one-half of an inch wide.', src)).toMatch(/credits CDC for another source/);
  });

  test('a sentence credits only the publisher whose quote it restates', () => {
    const M02 = factById('M02'); // CDC: yard mosquitoes fly a few blocks; UF/IFAS IN1035: salt marsh long flight range
    expect(creditProblem('CDC says salt marsh mosquitoes have a long flight range and can be found far inland.', M02)).toMatch(/credits CDC for another source/);
    expect(creditProblem('UF/IFAS says salt marsh mosquitoes have a long flight range and can be found far inland.', M02)).toBeNull();
    expect(creditProblem('The CDC says these mosquitoes only fly a few blocks in their lifetime.', M02)).toBeNull();
    expect(creditProblem('UF/IFAS says these mosquitoes only fly a few blocks in their lifetime.', M02)).toMatch(/credits UF\/IFAS for another source/);
    // A publisher this fact does not cite is cut, the UF long form included.
    expect(creditProblem('WUSF says eggs survive drying out.', FACT)).toMatch(/credits WUSF, not a source of this fact/);
    expect(creditProblem('The University of Florida says eggs survive drying out.', FACT)).toMatch(/credits UF\/IFAS, not a source/);
    expect(creditProblem('Eggs survive drying out for up to 8 months.', FACT)).toBeNull();
  });

  test('a lead sentence that credits the wrong publisher is cut', () => {
    const M02 = factById('M02');
    const r = checkClaims({
      draft: {
        subject: '🦟 Some mosquitoes stay close to home',
        preview: 'Not all biters travel.',
        lead: {
          headline: 'Two kinds of travelers',
          sentences: [
            { text: 'The CDC says these mosquitoes only fly a few blocks in their lifetime.', fact_id: 'M02' },
            { text: 'UF/IFAS says salt marsh mosquitoes have a long flight range and can be found far inland.', fact_id: 'M02' },
            { text: 'The CDC says salt marsh mosquitoes can be found far inland.', fact_id: 'M02' },
          ],
        },
        id_item: { text: SPECIES_ENTRY.fact },
      },
      leadFact: M02,
      idItem: SPECIES_ENTRY,
    });
    expect(r.lead).toHaveLength(2);
    expect(r.cut).toEqual([{ text: 'The CDC says salt marsh mosquitoes can be found far inland.', reason: expect.stringMatching(/credits CDC/) }]);
  });

  test('markup characters are cut', () => {
    expect(sentenceProblem('Eggs survive <b>8 months</b>.', factSource(FACT))).toBe('markup character');
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

  test('"What\'s this?" is checked a sentence at a time; it fails only when no sentence is left', () => {
    const ok = run([sentence(GOOD_1), sentence(GOOD_2)]);
    expect(ok.idItem).toEqual({ ok: true, text: SPECIES_ENTRY.fact, reason: null });
    const partly = run([sentence(GOOD_1), sentence(GOOD_2)], { id_item: { text: `${SPECIES_ENTRY.fact} It raises a generation in about 3 days.` } });
    expect(partly.ok).toBe(true);
    expect(partly.idItem.text).toBe(SPECIES_ENTRY.fact);
    expect(partly.cut).toEqual([{ text: 'It raises a generation in about 3 days.', reason: expect.stringMatching(/^id_item: number not in the source: 3/) }]);
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

  test('the subject speaks for the lead fact alone; the preview may use the species', () => {
    // "Yellow Fever Mosquito" and "150 feet" come from the species entry, not from M01.
    const fromSpecies = run([sentence(GOOD_1), sentence(GOOD_2)], { subject: '🦟 Meet the Yellow Fever Mosquito', preview: 'Meet the Yellow Fever Mosquito.' });
    expect(fromSpecies.subject).toBeNull();
    expect(fromSpecies.preview).toBe('Meet the Yellow Fever Mosquito.');
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { subject: '🦟 Breeding within 150 feet' }).subject).toBeNull();
    // a number in a subject is never a word-for-word copy, so it falls back to the fact title
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { subject: '🦟 Eggs wait 10 months dry' }).subject).toBeNull();
  });

  test('a subject needs exactly one leading emoji and the voice-profile length', () => {
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { subject: '🦟🦟 Mosquito eggs' }).subject).toBeNull();
    expect(run([sentence(GOOD_1), sentence(GOOD_2)], { subject: `🦟 ${'Mosquito eggs '.repeat(8)}` }).subject).toBeNull();
    expect(run([sentence(GOOD_1), sentence(GOOD_2)]).subject).toBe('🦟 Dry does not mean gone for mosquito eggs');
  });
});
