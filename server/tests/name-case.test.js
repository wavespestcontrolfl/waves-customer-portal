/**
 * Unit tests for server/utils/name-case.js — the title-casing function
 * the AI call-triage pipeline uses for caller first/last names before
 * they're staged in customer_field_candidates. Catches regressions on
 * the Mc/Mac/O'/D'/hyphen/particle handling that distinguishes this
 * util from the inline capitalizeName() variants it replaces.
 *
 * False-positive notes are in the source docstring; tests below assert
 * the documented behavior, including the known-acceptable false
 * positives like "MacArena" for "macarena".
 */

const { properCase } = require('../utils/name-case');

describe('properCase — basic title-casing', () => {
  test('lowercase input', () => {
    expect(properCase('jane doe')).toBe('Jane Doe');
  });
  test('uppercase input', () => {
    expect(properCase('JANE DOE')).toBe('Jane Doe');
  });
  test('mixed case input', () => {
    expect(properCase('jANe DoE')).toBe('Jane Doe');
  });
  test('single token', () => {
    expect(properCase('jane')).toBe('Jane');
  });
});

describe('properCase — empty / null / weird input', () => {
  test('null', () => { expect(properCase(null)).toBe(''); });
  test('undefined', () => { expect(properCase(undefined)).toBe(''); });
  test('empty string', () => { expect(properCase('')).toBe(''); });
  test('whitespace only', () => { expect(properCase('   ')).toBe(''); });
  test('non-string input', () => { expect(properCase(42)).toBe(''); });
  test('trims surrounding whitespace', () => {
    expect(properCase('  jane doe  ')).toBe('Jane Doe');
  });
  test('collapses internal whitespace', () => {
    expect(properCase('jane    doe')).toBe('Jane Doe');
  });
});

describe('properCase — Mc prefix', () => {
  test('lowercase mcgowan', () => {
    expect(properCase('mcgowan')).toBe('McGowan');
  });
  test('uppercase MCGOWAN', () => {
    expect(properCase('MCGOWAN')).toBe('McGowan');
  });
  test('full name with Mc', () => {
    expect(properCase('john mcgowan')).toBe('John McGowan');
  });
  test('Mc with single trailing letter still capitalizes', () => {
    expect(properCase('mca')).toBe('McA');
  });
});

describe('properCase — Mac prefix', () => {
  test('macdonald', () => {
    expect(properCase('macdonald')).toBe('MacDonald');
  });
  test('mackenzie', () => {
    expect(properCase('mackenzie')).toBe('MacKenzie');
  });
  test('macintosh', () => {
    expect(properCase('macintosh')).toBe('MacIntosh');
  });
  test('mac (3 letters) stays plain', () => {
    expect(properCase('mac')).toBe('Mac');
  });
  test('macy (4 letters) stays plain', () => {
    expect(properCase('macy')).toBe('Macy');
  });
  test('macro (5 letters) stays plain', () => {
    expect(properCase('macro')).toBe('Macro');
  });
  // Documented false positives — assert the known behavior so a fix
  // becomes a deliberate change, not an accidental regression.
  test('macarena (8 letters, FALSE POSITIVE) → MacArena', () => {
    expect(properCase('macarena')).toBe('MacArena');
  });
  test('mackey (6 letters, FALSE POSITIVE) → MacKey', () => {
    expect(properCase('mackey')).toBe('MacKey');
  });
});

describe("properCase — O' and D' apostrophe prefixes", () => {
  test("o'brien", () => {
    expect(properCase("o'brien")).toBe("O'Brien");
  });
  test("O'BRIEN", () => {
    expect(properCase("O'BRIEN")).toBe("O'Brien");
  });
  test("d'angelo", () => {
    expect(properCase("d'angelo")).toBe("D'Angelo");
  });
  test("d'amico", () => {
    expect(properCase("d'amico")).toBe("D'Amico");
  });
});

describe('properCase — hyphenated names', () => {
  test('smith-jones', () => {
    expect(properCase('smith-jones')).toBe('Smith-Jones');
  });
  test("o'brien-smith (apostrophe + hyphen)", () => {
    expect(properCase("o'brien-smith")).toBe("O'Brien-Smith");
  });
  test('mary-jane', () => {
    expect(properCase('mary-jane')).toBe('Mary-Jane');
  });
  test('multi-segment hyphen with Mc', () => {
    expect(properCase('mcgowan-smith')).toBe('McGowan-Smith');
  });
});

describe('properCase — particles', () => {
  test('particle in middle stays lowercase', () => {
    expect(properCase('ludwig van beethoven')).toBe('Ludwig van Beethoven');
  });
  test('first-word particle gets capitalized', () => {
    expect(properCase('van buren')).toBe('Van Buren');
  });
  test('multiple particles in middle', () => {
    expect(properCase('jose de la cruz')).toBe('Jose de la Cruz');
  });
  test('all-caps particle phrase, first word capitalized', () => {
    expect(properCase('DE LA CRUZ')).toBe('De la Cruz');
  });
  test('von particle (German)', () => {
    expect(properCase('otto von bismarck')).toBe('Otto von Bismarck');
  });
  test('del particle (Spanish)', () => {
    expect(properCase('maria del rio')).toBe('Maria del Rio');
  });
});

describe('properCase — combination cases', () => {
  test('full name with apostrophe and particle', () => {
    expect(properCase("sean o'connor de la torre")).toBe("Sean O'Connor de la Torre");
  });
  test('full name with Mc and hyphen', () => {
    expect(properCase('mary mcgrath-jones')).toBe('Mary McGrath-Jones');
  });
});
