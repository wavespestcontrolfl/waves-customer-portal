// Pest Insider copy check: every lead sentence, title and "What's this?" line
// is fixed, reviewed copy, and its numbers, months and names must all come
// from its own source. Any problem fails the issue; nothing is cut or rewritten.
const { checkIssueCopy, sentenceProblem, creditProblem, quantityPairs, factSource, MIN_LEAD_SENTENCES, MAX_LEAD_SENTENCES } = require('../services/pest-insider/claim-check');
const { FACTS, factById } = require('../services/pest-insider/facts');
const { SPECIES } = require('../services/pest-insider/plan');

const FACT = factById('M01'); // mosquito eggs survive drying out for up to 8 months (CDC)
const SPECIES_ENTRY = SPECIES.find((s) => s.slug === 'aedes-mosquito');

// The pooled checks (numbers, units, months, names) on their own, without the
// word-for-word copy rule, which has its own tests below.
const loose = (fact) => ({ ...factSource(fact), units: null });
const withLead = (lead, fact = FACT) => ({ ...fact, lead });

describe('the sentence rules', () => {
  test('a number that is not in the fact fails the sentence', () => {
    expect(sentenceProblem('The CDC says eggs can survive drying out for up to 8 months.', factSource(FACT))).toBeNull();
    expect(sentenceProblem('Mosquito eggs can survive for up to 9 months.', factSource(FACT))).toMatch(/number not in the source: 9/);
  });

  test('number words and digits are the same number; a different number word fails', () => {
    expect(sentenceProblem('Eggs survive up to eight months.', loose(FACT))).toBeNull();
    expect(sentenceProblem('Eggs survive up to nine months.', loose(FACT))).toMatch(/number not in the source: 9/);
    expect(sentenceProblem('A mosquito needs 7-10 days to grow up.', loose(FACT))).toBeNull();
    expect(sentenceProblem('A mosquito needs 14 days to grow up.', loose(FACT))).toMatch(/14/);
    // past twenty and zero too, and a compound is one number (pre-push rounds 12 and 13; R02's source says 12 days)
    const roach = factById('R02');
    expect(sentenceProblem('German cockroaches can survive thirty days without water.', factSource(roach))).toMatch(/number not in the source: 30/);
    expect(sentenceProblem('German cockroaches can survive twenty-five days without water.', factSource(roach))).toMatch(/number not in the source: 25/);
    expect(sentenceProblem('German cockroaches can survive twice as long without water.', factSource(roach))).toMatch(/number not in the source: 2/);
    expect(sentenceProblem('German cockroaches can survive zero days without water.', factSource(roach))).toMatch(/number not in the source: 0/);
    expect(quantityPairs('They live twenty-five days, not 7 to 10 days.')).toEqual(new Set(['25 day', '7 day', '10 day']));
  });

  test('fractions and percents must be in the fact too', () => {
    const lawn = factById('L05'); // never lose more than one-third of the blade; quote says 1/3
    expect(sentenceProblem('Never cut more than 1/3 of the blade.', loose(lawn))).toBeNull();
    expect(sentenceProblem('Never cut more than one-third of the blade.', loose(lawn))).toBeNull();
    expect(sentenceProblem('Never cut more than half of the blade.', loose(lawn))).toMatch(/1\/2/);
    expect(sentenceProblem('About 50 percent of the blade can go.', loose(lawn))).toMatch(/number not in the source/);
  });

  test('a month that is not in the fact fails the sentence; "may" the verb does not count', () => {
    expect(sentenceProblem('The rains in June hatch them.', factSource(FACT))).toMatch(/month or season not in the source: june/);
    expect(sentenceProblem('Eggs may survive a dry spell.', loose(FACT))).toBeNull();
    expect(sentenceProblem('Watch for them in May.', loose(FACT))).toMatch(/may/);
    const oct = factById('T02'); // April through June, peaking in May
    expect(sentenceProblem('They swarm from April through June.', loose(oct))).toBeNull();
    expect(sentenceProblem('Swarms peak in May.', loose(oct))).toBeNull();
    expect(sentenceProblem('Swarms peak in October.', loose(oct))).toMatch(/october/);
    // a possessive, a dash or lowercase does not hide a month; lowercase "march" and "may" stay words (pre-push round 14)
    expect(sentenceProblem("Eggs hatch with June's rain.", factSource(FACT))).toMatch(/month or season not in the source: june/);
    expect(sentenceProblem('Eggs hatch with the june rain.', factSource(FACT))).toMatch(/june/);
    expect(sentenceProblem('They swarm October-November.', loose(oct))).toMatch(/october/);
    expect(sentenceProblem('Swarmers march toward lights.', loose(oct))).toBeNull();
  });

  test('a season word that is not in the fact fails', () => {
    expect(sentenceProblem('This matters most in winter.', factSource(FACT))).toMatch(/winter/);
  });

  test('a name that is not in the fact fails, including a brand', () => {
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

  test('dollar signs, "safe", guarantees, promises and pesticide names fail', () => {
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

  test('the shared register the send validator runs applies here', () => {
    expect(sentenceProblem('A technician can eliminate them for good.', factSource(FACT))).toMatch(/tripwire/);
    const formosan = factById('T02');
    expect(sentenceProblem(formosan.statement, factSource(formosan))).toBeNull();
    expect(sentenceProblem(formosan.quotes[0].split('. ')[0] + '.', factSource(formosan))).toBeNull();
    expect(sentenceProblem('Formosan termites swarm again after storms in June.', factSource(formosan))).toMatch(/tripwire|month/);
    expect(sentenceProblem('Formosan termites swarm again in June.', loose(formosan))).toMatch(/tripwire: termite_second_swarm/);
  });

  test('a number must keep its own unit: a source number moved to another claim fails', () => {
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
    // the reviewed statement, whole or by its ", but" parts
    expect(sentenceProblem(R02.statement, src)).toBeNull();
    expect(sentenceProblem('A German roach can survive only 12 days with food but no water.', src)).toBeNull();
    expect(sentenceProblem('A German roach can survive only 42 days with food but no water.', src)).toMatch(/word for word/);
    // a sentence with no number or month may use its own words
    expect(sentenceProblem('Water matters more than food to a roach.', src)).toBeNull();
    // a scale word alone is a count, bound to its own claim (pre-push round 14; A01's million counts ants in one colony)
    const A01 = factById('A01');
    expect(sentenceProblem('There are millions of colonies in your yard.', factSource(A01))).toMatch(/word for word/);
    // months are bound the same way (T03: R. hageni December to February, R. flavipes January to April)
    const T03 = factById('T03');
    expect(sentenceProblem('Native termites fly from December to April.', factSource(T03))).toMatch(/word for word/);
  });

  test('every amount or time word counts, not only digits and number words (pre-push round 15)', () => {
    // a frequency: "once a day" against the CDC's "once a week" (M01)
    const weekly = 'Once a week, empty and scrub, turn over, cover, or throw out any items that hold water.';
    expect(sentenceProblem(weekly, factSource(FACT))).toBeNull();
    expect(sentenceProblem(weekly.replace('Once a week', 'Once a day'), factSource(FACT))).toMatch(/number not in the source: per:day/);
    expect(sentenceProblem(weekly.replace('Once a week', 'Every other week'), factSource(FACT))).toMatch(/word for word/);
    expect(sentenceProblem('Empty and scrub them weekly.', factSource(FACT))).toMatch(/word for word/);
    // "once" in front of anything but a period is not a count (P04: once a palm is infected)
    expect(sentenceProblem('Nothing cures it once a palm is infected.', loose(factById('P04')))).toBeNull();
    // a measure word with no number (M02: a few blocks), in a lead line and in a title
    const M02 = factById('M02');
    expect(sentenceProblem('In their lifetime, these mosquitoes will only fly a few miles.', factSource(M02))).toMatch(/unit:mile/);
    expect(checkIssueCopy({ leadFact: { ...M02, title: 'Aedes mosquitoes stay within a few miles' }, species: SPECIES_ENTRY }).problems)
      .toEqual([expect.objectContaining({ part: 'title', reason: expect.stringMatching(/unit:mile/) })]);
    // an ordinal (P05: the first symptom)
    const P05 = factById('P05');
    expect(sentenceProblem('UF/IFAS says if fruit is present, the first symptom is generally premature fruit drop.', factSource(P05))).toBeNull();
    expect(sentenceProblem('UF/IFAS says if fruit is present, the second symptom is generally premature fruit drop.', factSource(P05))).toMatch(/ord:2/);
    // a time of day: both words are in L04's source, so only the copy rule catches the swap
    const L04 = factById('L04');
    const swapped = 'UF/IFAS says watering in the morning before dew forms, or in the evening after it dries, keeps grass wet longer.';
    expect(sentenceProblem(swapped, loose(L04))).toBeNull();
    expect(sentenceProblem(swapped, factSource(L04))).toMatch(/word for word/);
    // a season binds its sentence too (L12's source has spring)
    expect(sentenceProblem('Homeowners often apply pre-emergent too early in the spring.', factSource(factById('L12')))).toMatch(/word for word/);
    // a weekday must be in the source
    expect(sentenceProblem('Even addresses may water on Tuesday.', loose(factById('O04')))).toMatch(/tuesday/);
    // "<publisher> says to" wraps a quoted instruction, and its period still binds (M03)
    const M03 = factById('M03');
    expect(sentenceProblem('UF/IFAS says to flush the cups with a strong jet of water from a hose at least once a week.', factSource(M03))).toBeNull();
    expect(sentenceProblem('UF/IFAS says to flush the cups with a strong jet of water from a hose at least once a month.', factSource(M03))).toMatch(/per:month/);
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
    // A publisher this fact does not cite fails, the UF long form included.
    expect(creditProblem('WUSF says eggs survive drying out.', FACT)).toMatch(/credits WUSF, not a source of this fact/);
    expect(creditProblem('The University of Florida says eggs survive drying out.', FACT)).toMatch(/credits UF\/IFAS, not a source/);
    expect(creditProblem('Eggs survive drying out for up to 8 months.', FACT)).toBeNull();
  });

  test('markup characters fail', () => {
    expect(sentenceProblem('Eggs survive <b>8 months</b>.', factSource(FACT))).toBe('markup character');
  });
});

describe('checkIssueCopy', () => {
  test("the fact bank's reviewed copy passes as it is", () => {
    const r = checkIssueCopy({ leadFact: FACT, species: SPECIES_ENTRY });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lead).toEqual(FACT.lead);
    expect(r.headline).toBe(FACT.title);
    expect(r.subject).toBe(`🦟 ${FACT.title}`);
    expect(r.preview).toBe(`What's this? ${SPECIES_ENTRY.name}`);
    expect(r.idText).toBe(SPECIES_ENTRY.fact);
  });

  test('one bad lead sentence fails the issue; nothing is cut', () => {
    const bad = 'The CDC says eggs can survive drying out for up to 9 months.';
    const r = checkIssueCopy({ leadFact: withLead([FACT.lead[0], bad, FACT.lead[2]]), species: SPECIES_ENTRY });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ part: 'lead', text: bad, reason: expect.stringContaining('number not in the source: 9') }]);
    expect(r.lead).toHaveLength(3);
  });

  test('a lead sentence that credits the wrong publisher fails', () => {
    const M02 = factById('M02'); // CDC: yard mosquitoes; UF/IFAS: salt marsh mosquitoes
    const wrong = 'The CDC says salt marsh mosquitoes have a long flight range and can be found far inland.';
    const r = checkIssueCopy({ leadFact: withLead([M02.lead[0], wrong], M02), species: SPECIES_ENTRY });
    expect(r.problems).toEqual([{ part: 'lead', text: wrong, reason: expect.stringMatching(/credits CDC/) }]);
  });

  test('a lead sentence restates the source and never speaks for Waves', () => {
    const waves = 'A Waves technician can check containers during a regular visit.';
    const r = checkIssueCopy({ leadFact: withLead([...FACT.lead.slice(0, 2), waves]), species: SPECIES_ENTRY });
    expect(r.problems).toEqual([{ part: 'lead', text: waves, reason: expect.stringMatching(/does not speak for Waves/) }]);
  });

  test('needs 2 to 4 lead sentences', () => {
    expect([MIN_LEAD_SENTENCES, MAX_LEAD_SENTENCES]).toEqual([2, 4]);
    expect(checkIssueCopy({ leadFact: withLead([FACT.lead[0]]), species: SPECIES_ENTRY }).problems)
      .toEqual([{ part: 'lead', text: '', reason: 'needs 2 to 4 lead sentences, has 1' }]);
    expect(checkIssueCopy({ leadFact: withLead([...FACT.lead, ...FACT.lead.slice(0, 2)]), species: SPECIES_ENTRY }).problems[0].reason)
      .toBe('needs 2 to 4 lead sentences, has 5');
    expect(checkIssueCopy({ leadFact: withLead(undefined), species: SPECIES_ENTRY }).ok).toBe(false);
  });

  test('the title must fit the subject rules and its own source', () => {
    const titleProblems = (title) => checkIssueCopy({ leadFact: { ...FACT, title }, species: SPECIES_ENTRY }).problems;
    expect(titleProblems(FACT.title)).toEqual([]);
    expect(titleProblems('Mosquito eggs can wait 9 months dry'))
      .toEqual([{ part: 'title', text: 'Mosquito eggs can wait 9 months dry', reason: expect.stringMatching(/number not in the source: 9/) }]);
    expect(titleProblems('Mosquito eggs can wait 10 months dry')[0].reason).toMatch(/number and unit not in the source: 10 month/);
    expect(titleProblems('Eggs that cost $5')[0].reason).toBe('dollar sign');
    expect(titleProblems('Mosquito eggs '.repeat(8))).toHaveLength(1);
    // the title is never its own evidence for a name, at the start of the line or inside it (pre-push round 7)
    expect(titleProblems('Mosquito eggs can wait up to 8 months dry in Tampa')[0].reason).toBe('name not in the source: Tampa');
    expect(titleProblems('Tampa mosquito eggs can wait up to 8 months dry')[0].reason).toBe('name not in the source: Tampa');
  });

  test('a lead line may not open with a name its source lacks', () => {
    const r = checkIssueCopy({ leadFact: withLead(['Tampa yards hold mosquito eggs.', ...FACT.lead.slice(1)]), species: SPECIES_ENTRY });
    expect(r.problems).toEqual([{ part: 'lead', text: 'Tampa yards hold mosquito eggs.', reason: 'name not in the source: Tampa' }]);
  });

  test("\"What's this?\" prints the species entry's own fact; a banned word in it fails the issue", () => {
    const r = checkIssueCopy({ leadFact: FACT, species: { ...SPECIES_ENTRY, fact: `${SPECIES_ENTRY.fact} It is safe to leave alone.` } });
    expect(r.problems).toEqual([{ part: 'id_item', text: 'It is safe to leave alone.', reason: 'the word "safe"' }]);
    expect(checkIssueCopy({ leadFact: FACT, species: { ...SPECIES_ENTRY, fact: '' } }).problems)
      .toEqual([{ part: 'id_item', text: '', reason: 'empty species fact' }]);
    expect(checkIssueCopy({ leadFact: FACT, species: { ...SPECIES_ENTRY, name: 'Raid Beetle' } }).problems)
      .toEqual([{ part: 'preview', text: "What's this? Raid Beetle", reason: 'pesticide or brand name' }]);
  });
});

describe('the fact bank copy, as every issue will print it', () => {
  const main = FACTS.filter((f) => !f.reserve);

  test.each(main.map((f) => [f.id, f]))('%s: every lead sentence and the title pass', (_id, f) => {
    expect(checkIssueCopy({ leadFact: f, species: SPECIES_ENTRY }).problems).toEqual([]);
  });

  test('every identifier species entry passes, a sentence at a time', () => {
    const problems = SPECIES.flatMap((species) => checkIssueCopy({ leadFact: FACT, species }).problems.map((p) => ({ slug: species.slug, ...p })));
    expect(problems).toEqual([]);
  });

  // A lead sentence may copy its fact's reviewed statement, so a statement
  // must not add a number, month or name that its quotes lack. Each entry
  // here was checked by hand against the quote; the parser misses an inch
  // mark, a hyphenated count, the season the quoted months fall in, or a
  // plain-English name. The check reports only a statement's first problem,
  // so each entry pins the whole reviewed statement: any edit to it fails
  // until it is reviewed again (pre-push round 11). Any new entry fails too.
  const REVIEWED_STATEMENTS = {
    // quote: mowed at 3.5–4" (an inch mark, not the word)
    L05: ['Most St. Augustine should be cut at 3.5 to 4 inches, and never lose more than one-third of the blade at once.', 'number not in the source: unit:inch'],
    // quote: South Florida is south of State Road 60
    L12: ["In South Florida, which includes Manatee, Sarasota and Charlotte counties, UF's rule of thumb is to apply pre-emergent by February 1, not in spring; homeowners often wait too late in the spring.", 'name not in the source: Manatee'],
    // the source's own date: published July 23, 1997
    M04: ['In a one-night test that UF/IFAS reported in 1997, a bug zapper killed about 10,000 insects, and only eight were mosquitoes.', 'number not in the source: 1997'],
    // quotes: one-day-per-week; on days 1-30
    O04: ['The Southwest Florida Water Management District limits lawn watering to one day a week through March 31, 2027, but new lawns may be watered any day for 30 days; '
      + 'homes that water only with reclaimed water are subject only to voluntary watering hours unless the local government or utility restricts them; '
      + 'many cities and counties have different schedules or stricter hours, so check your city or county rules first.', 'number and unit not in the source: 1 day'],
    // quote: 12"-18" from the base of trees (an inch mark, not the word)
    P06: ['Mulch piled against a trunk holds extra moisture that can cause rot and insect infestations; keep mulch 12 to 18 inches back from trees.', 'number not in the source: unit:inch'],
    // quote: flights from early December
    T03: ["Florida's native subterranean termites swarm in winter and spring, December through May; check the waist and antennae to rule out ants.", 'month or season not in the source: winter'],
    // quote: often called palmetto bugs
    R01: ['The big roaches Floridians call palmetto bugs are generally found outdoors and do not survive well indoors, so removing the roach is often all that is needed.', 'name not in the source: Floridians'],
  };
  test('a statement adds no number, month or name its quotes lack, except the reviewed ones', () => {
    const found = {};
    for (const f of FACTS) {
      const quotesOnly = {
        units: null,
        facts: f.quotes.join(' '),
        names: [...f.quotes, ...f.sources.map((s) => `${s.publisher} ${s.title}`)].join(' '),
      };
      const problem = sentenceProblem(f.statement, quotesOnly);
      if (problem || REVIEWED_STATEMENTS[f.id]) found[f.id] = [f.statement, problem];
    }
    expect(found).toEqual(REVIEWED_STATEMENTS);
  });
});
