/**
 * Codex round-3 structural fix (PR #4946): the ONE shared Spanish spoken-
 * number normalizer, unit-tested directly against the transformations it
 * promises — cardinal number words, hour+minute phrases, and spoken phone
 * digit strings — and against the article/quantity uses it must NEVER touch.
 */

const { normalizeSpanishSpokenText, parseSpanishCardinal, isBareAnnualCount } = require('../services/eval/voice-relay-spanish-numbers');

describe('parseSpanishCardinal', () => {
  test.each([
    ['cero', 0],
    ['una', 1],
    ['dos', 2],
    ['doce', 12],
    ['diecinueve', 19],
    ['veinte', 20],
    ['veintinueve', 29],
    ['treinta', 30],
    ['treinta y cinco', 35],
    ['noventa y nueve', 99],
    ['cien', 100],
    ['ciento diecinueve', 119],
    ['doscientos cuarenta y nueve', 249],
    ['doscientas cuarenta y nueve', 249],
    ['novecientos noventa y nueve', 999],
    ['mil', 1000],
    ['mil doscientos', 1200],
    ['dos mil', 2000],
    ['no es un número', NaN],
    ['', NaN],
  ])('%s -> %s', (words, expected) => {
    const got = parseSpanishCardinal(words);
    if (Number.isNaN(expected)) expect(Number.isNaN(got)).toBe(true);
    else expect(got).toBe(expected);
  });
});

describe('normalizeSpanishSpokenText — prices (a number-word run immediately before dólares/pesos)', () => {
  test.each([
    ['ciento diecinueve dólares por aplicación', '119 dólares por aplicación'],
    ['noventa y nueve dólares', '99 dólares'],
    ['doscientos cuarenta y nueve dólares', '249 dólares'],
    ['mil doscientos dólares', '1200 dólares'],
    ['cien pesos', '100 pesos'],
    // Already digits: inert, never re-touched.
    ['$119 por aplicación', '$119 por aplicación'],
    ['119 dólares por aplicación', '119 dólares por aplicación'],
    // Codex round-6 P1: a spelled number immediately before a PRICING-UNIT
    // phrase ("por aplicación"/"cada aplicación"), with no currency word at
    // all, must convert too — the pricing unit alone names it as a price.
    ['ciento diecinueve por aplicación', '119 por aplicación'],
    ['noventa y nueve cada aplicación', '99 cada aplicación'],
    ['cuesta ciento diecinueve por aplicación y el premium noventa y nueve por aplicación', 'cuesta 119 por aplicación y el premium 99 por aplicación'],
    // A number before an UNRELATED "por" phrase (not the pricing unit) is
    // still left alone — "por ciento" is a percentage, not a price.
    ['cuarenta y nueve por ciento', 'cuarenta y nueve por ciento'],
    ['cuarenta y nueve por hora', 'cuarenta y nueve por hora'],
    // r13: before YEAR a figure under 25 is an application count and stays
    // words; every other unit converts from 10 (PR review: "veinte al mes").
    ['noventa y nueve por aplicación, doce por año', '99 por aplicación, doce por año'],
    ['doce con noventa y nueve al año', '12.99 al año'],
    ['veinte al mes', '20 al mes'],
    ['treinta al año', '30 al año'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });
});

describe('normalizeSpanishSpokenText — hour + minute phrases -> digital time', () => {
  test.each([
    ['de la una a las tres y veinte de la tarde', 'de la una a las 3:20 de la tarde'],
    // A minute modifier on the FIRST endpoint converts too — 20 is
    // unambiguously a minute count wherever it sits.
    ['de la una y veinte a las tres de la tarde', 'de la 1:20 a las tres de la tarde'],
    ['de la una a las tres y media de la tarde', 'de la una a las 3:30 de la tarde'],
    ['de la una a las tres y cuarto de la tarde', 'de la una a las 3:15 de la tarde'],
    ['el técnico llega a las tres menos cuarto', 'el técnico llega a las 2:45'],
    ['la una menos cuarto', 'la 12:45'],
    ['el técnico llega a las tres en punto', 'el técnico llega a las 3:00'],
    ['de la una a las tres y treinta y cinco de la tarde', 'de la una a las 3:35 de la tarde'],
    ['llega a las tres y veintitrés', 'llega a las 3:23'],
    // The minute side is enumerated (13–59, media, cuarto), so a 1–12 range
    // connector never matches and never CONSUMES the second endpoint: the
    // minute modifier on "cuatro" is still found (PR #4946 review).
    ['la ventana es entre dos y cuatro y media de la tarde', 'la ventana es entre dos y 4:30 de la tarde'],
    // ...and "tres y veinte" is a 3:20 endpoint, never a 23-minute count
    // hung off "una" ("1:23").
    ['la ventana es entre una y tres y veinte', 'la ventana es entre una y 3:20'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });

  // The genuinely ambiguous band: a minute count of 1–12 is the exact shape
  // a real "entre X y Y" / "de X a Y" range also takes. Left unconverted so
  // a real range is never turned into a fabricated time.
  test.each([
    'la ventana es entre una y tres de la tarde',
    'el técnico llega entre dos y cuatro',
    'la ventana es de dos a cuatro',
    'la una y tres',
  ])('leaves a 1-12 "hour y N" span untouched (range-ambiguous): %s', (input) => {
    expect(normalizeSpanishSpokenText(input)).toBe(input);
  });
});

// Codex pre-push on #4946: a spelled price reaches the price checks in every
// price context — any billing unit ("al año", "por tratamiento") or a price
// verb ("cuesta") — but only as a two-digit-or-more amount, so counts stay words.
describe('normalizeSpanishSpokenText — spelled prices in every price context', () => {
  test.each([
    ['el premium cuesta noventa y nueve al año', 'el premium cuesta 99 al año'],
    ['el premium cuesta noventa y nueve.', 'el premium cuesta 99.'],
    ['son noventa y nueve por tratamiento', 'son 99 por tratamiento'],
    ['vale ciento diecinueve', 'vale 119'],
    ['cobramos ciento cincuenta', 'cobramos 150'],
    ['cobro ciento cincuenta', 'cobro 150'],
    ['por aplicación pagará ciento diecinueve', 'por aplicación pagará 119'],
    ['por aplicación pagaríamos ciento diecinueve', 'por aplicación pagaríamos 119'],
    ['por aplicación pagaré ciento diecinueve', 'por aplicación pagaré 119'],
    ['tendrá que pagar ciento cincuenta', 'tendrá que pagar 150'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });
  test.each([
    'Hacemos dos por mes.',
    'Son nueve aplicaciones al año.',
    '¿Cuánto cuesta una casa de dos mil pies?',
    'El plan incluye doce aplicaciones al año.',
  ])('leaves counts and non-prices alone: %s', (input) => {
    expect(normalizeSpanishSpokenText(input)).toBe(input);
  });
});

describe('isBareAnnualCount', () => {
  test.each([[0, true], [12, true], [24, true], [12.99, false], [24.5, false], [25, false], [NaN, false]])('%s -> %s', (amount, expected) => {
    expect(isBareAnnualCount(amount)).toBe(expected);
  });
});

// Codex pre-push on #4946: dollars-and-cents is ONE amount — grading only
// the integer prefix would read $119.99 as the returned $119.
describe('normalizeSpanishSpokenText — cents merge into one amount', () => {
  test.each([
    ['Ciento diecinueve dólares con noventa y nueve centavos por aplicación.', '119.99 dólares por aplicación.'],
    ['El mejorado cuesta ciento diecinueve con noventa y nueve por aplicación.', 'El mejorado cuesta 119.99 por aplicación.'],
    ['El mejorado cuesta 119 dólares con 99 centavos por aplicación.', 'El mejorado cuesta 119.99 dólares por aplicación.'],
    // Codex r10: no currency word, no price verb — still one amount.
    ['El mejorado es ciento diecinueve con noventa y nueve por aplicación.', 'El mejorado es 119.99 por aplicación.'],
    ['Ciento diecinueve con noventa y nueve dólares por aplicación.', '119.99 dólares por aplicación.'],
    ['Ciento diecinueve coma noventa y nueve por aplicación.', '119.99 por aplicación.'],
    ['Ciento diecinueve punto nueve nueve por aplicación.', '119.99 por aplicación.'],
    ['Ciento diecinueve coma cinco por aplicación.', '119.5 por aplicación.'],
    ['Ciento diecinueve coma cero cinco por aplicación.', '119.05 por aplicación.'],
    ['Ciento diecinueve con cinco centavos por aplicación.', '119.05 por aplicación.'],
    // A digit-led whole keeps its fraction's digit words as digits, not a sum.
    ['119 punto nueve nueve por aplicación.', '119.99 por aplicación.'],
    ['119 coma dos nueve por aplicación.', '119.29 por aplicación.'],
    ['119 coma nueve nueve dólares.', '119.99 dólares.'],
    ['119 con noventa y nueve por aplicación.', '119.99 por aplicación.'],
    // An explicit decimal separator makes a whole below 10 a price too.
    ['Son nueve punto noventa y nueve por aplicación.', 'Son 9.99 por aplicación.'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });
  test.each([
    'Cuesta 119 dólares por aplicación.',
    'Cuesta 119 dólares con la aplicación incluida.',
    'Viene con dos técnicos.',
  ])('leaves a non-cents "con" alone: %s', (input) => {
    expect(normalizeSpanishSpokenText(input)).toBe(input);
  });
});

describe('normalizeSpanishSpokenText — written meridiems', () => {
  test.each([
    ['llega de 1 p. m. a 3 p. m. Gracias.', 'llega de 1 pm a 3 pm Gracias.'],
    ['a las 9 a.m.', 'a las 9 am'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });
});

describe('normalizeSpanishSpokenText — spoken phone digit strings', () => {
  test.each([
    ['Nueve, cuatro, uno, cinco, cinco, cinco, cero, dos, cuatro, seis.', '9, 4, 1, 5, 5, 5, 0, 2, 4, 6.'],
    ['El número es nueve cuatro uno, triple cinco, cero dos cuatro seis.', 'El número es 9 4 1, 555, 0 2 4 6.'],
    ['nueve cuatro uno cinco cinco cinco cero dos cuatro seis', '9 4 1 5 5 5 0 2 4 6'],
    // Already digits, or too short a run to be a phone number: untouched.
    ['941-555-0246, ¿correcto?', '941-555-0246, ¿correcto?'],
    ['Necesito una visita más.', 'Necesito una visita más.'],
    ['tengo dos perros', 'tengo dos perros'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });
});

describe('normalizeSpanishSpokenText — grouped Spanish CARDINALS, phone-number style (Codex round-6 P1)', () => {
  test.each([
    // The real gap: compound tens/hundreds words (Pass 2's digit-word pass
    // never touches these), chunked and concatenated into the 10-digit
    // number they read back.
    ['El número es novecientos cuarenta y uno, quinientos cincuenta y cinco, cero dos cuarenta y seis.', 'El número es 941 555 0 2 46.'],
    // A 7-digit local number (no area code) still qualifies.
    ['El número es quinientos cincuenta y cinco, cero dos cuarenta y seis.', 'El número es 555 0 2 46.'],
    // Mixed: some groups spelled as bare digits, one as a compound.
    ['nueve, cuatro, uno, quinientos cincuenta y cinco, cero, dos, cuatro, seis', '9 4 1 555 0 2 4 6'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });

  // Guards: every one of these has fewer than 3 chunks, or is walled off by
  // grammar — exactly the shapes a quantity or an hour range actually take.
  test.each([
    'la ventana es entre dos y cuatro',
    'necesitamos entre dos y cuatro técnicos',
    '¿Hay entre dos y cuatro habitaciones afectadas?',
    'la ventana es entre una y tres de la tarde',
    'el número es cuarenta y uno, cincuenta y cinco',
    'tengo dos perros',
    'Necesito una visita más.',
  ])('leaves a non-phone-shaped cardinal run untouched: %s', (input) => {
    expect(normalizeSpanishSpokenText(input)).toBe(input);
  });

  // A price is walled off from Pass 4 in practice, but by Pass 3 (the price
  // pass) converting the number immediately before "dólares" FIRST, not by
  // Pass 4's own guards — a single price is only 1 chunk either way, so
  // this documents the actual mechanism rather than assuming Pass 4 alone.
  test.each([
    ['cuesta noventa y nueve dólares', 'cuesta 99 dólares'],
    ['el precio es ciento diecinueve dólares por aplicación', 'el precio es 119 dólares por aplicación'],
  ])('a single spelled-out price converts via the price pass, never the phone-group pass: %s -> %s', (input, expected) => {
    expect(normalizeSpanishSpokenText(input)).toBe(expected);
  });

  // The residual case Pass 3 does NOT wall off: three or more spelled-out
  // amounts in a row with only the LAST one immediately followed by a
  // currency word (Pass 3 still converts that last one first, but the
  // remaining word-only amounts can still total >=3 chunks and 7-11 digits
  // if there are enough of them) is a real, if unlikely, phrasing this pass
  // does not distinguish from a phone number — not exercised by any fixture
  // scenario in this repo, which always states each price's own unit
  // immediately ("por aplicación") rather than listing bare amounts.
  test('two spelled-out amounts followed by one with an immediate currency word do not collide (below the chunk floor)', () => {
    // The price verb converts the first figure too since the #4946 pre-push
    // fix ("cuesta noventa y nueve" is a price) — still never a phone number.
    expect(normalizeSpanishSpokenText('cuesta noventa y nueve, ciento diecinueve, ciento veintinueve dólares'))
      .toBe('cuesta 99, ciento diecinueve, 129 dólares');
  });
});

describe('chunkPhoneCardinals (Codex round-6 P1)', () => {
  const { chunkPhoneCardinals } = require('../services/eval/voice-relay-spanish-numbers')._internals;
  const chunk = (s) => chunkPhoneCardinals(s.split(/[\s,]+/).filter(Boolean));
  test.each([
    ['novecientos cuarenta y uno', [941]],
    ['ciento diecinueve', [119]],
    ['quinientos cincuenta y cinco', [555]],
    ['cero dos cuarenta y seis', [0, 2, 46]],
    ['cuarenta y seis', [46]],
    ['cero', [0]],
    ['dos', [2]],
    ['cero cuarenta y seis', [0, 46]],
    ['novecientos cuarenta y uno quinientos cincuenta y cinco cero dos cuarenta y seis', [941, 555, 0, 2, 46]],
  ])('%s -> %j', (input, expected) => {
    expect(chunk(input)).toEqual(expected);
  });

  // A units word directly after a completed units chunk starts a NEW chunk
  // ("cero dos" is 0, 2 — never a compound "02").
  test('a bare unit followed by another bare unit is two separate chunks', () => {
    expect(chunk('dos tres')).toEqual([2, 3]);
  });

  // "y" only glues a completed tens word to its trailing unit. Anywhere else
  // (a range connector, a trailing "y" with nothing after) this is not a
  // phone-cardinal run at all, and the whole thing is rejected.
  test.each([
    'dos y cuatro',
    'cuarenta y',
    'mil doscientos',
  ])('rejects a non-phone-cardinal shape: %s', (input) => {
    expect(chunk(input)).toBeNull();
  });
});

describe('normalizeSpanishSpokenText — article/quantity uses are never converted (Codex round-2/3 collisions)', () => {
  test.each([
    // "hour y minute"-shaped spans followed by a unit noun are durations or
    // amounts, not clock times — including a compound whose full form was
    // refused, which must not backtrack onto its bare tens word.
    'La visita dura entre dos y veinte minutos.',
    'Tarda entre tres y treinta y cinco minutos.',
    'Sube dos y quince por ciento.',
    'Necesito una visita más.',
    '¿Hay entre dos y cuatro habitaciones afectadas?',
    'Necesitamos entre dos y cuatro técnicos.',
    'Es una casa con dos pisos.',
    'La propiedad tiene dos y media acres.',
    'La propiedad tiene dos y media hectáreas.',
  ])('%s', (input) => {
    expect(normalizeSpanishSpokenText(input)).toBe(input);
  });
});

describe('normalizeSpanishSpokenText — non-string input', () => {
  test.each([undefined, null, '', 0, 42])('passes %p through unchanged', (v) => {
    expect(normalizeSpanishSpokenText(v)).toBe(v);
  });
});
