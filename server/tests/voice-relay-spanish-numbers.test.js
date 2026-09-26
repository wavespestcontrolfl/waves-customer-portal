/**
 * Codex round-3 structural fix (PR #4946): the ONE shared Spanish spoken-
 * number normalizer, unit-tested directly against the transformations it
 * promises — cardinal number words, hour+minute phrases, and spoken phone
 * digit strings — and against the article/quantity uses it must NEVER touch.
 */

const { normalizeSpanishSpokenText, parseSpanishCardinal } = require('../services/eval/voice-relay-spanish-numbers');

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

describe('normalizeSpanishSpokenText — article/quantity uses are never converted (Codex round-2/3 collisions)', () => {
  test.each([
    'Necesito una visita más.',
    '¿Hay entre dos y cuatro habitaciones afectadas?',
    'Necesitamos entre dos y cuatro técnicos.',
    'Es una casa con dos pisos.',
  ])('%s', (input) => {
    expect(normalizeSpanishSpokenText(input)).toBe(input);
  });
});

describe('normalizeSpanishSpokenText — non-string input', () => {
  test.each([undefined, null, '', 0, 42])('passes %p through unchanged', (v) => {
    expect(normalizeSpanishSpokenText(v)).toBe(v);
  });
});
