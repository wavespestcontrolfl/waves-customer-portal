const {
  SERVICE_WORDS, CITIES, COMPETITOR_NAMES, normalizeNegative, protectedReason, competitorName,
} = require('../services/ads/negative-keywords');

describe('normalizeNegative', () => {
  test('lowercases, trims and collapses spaces', () => {
    expect(normalizeNegative('  Squirrel   REMOVAL ')).toBe('squirrel removal');
    expect(normalizeNegative('Home & Garden')).toBe('home & garden');
    expect(normalizeNegative("Lowe’s")).toBe("lowe's");
  });

  test('returns null for empty, non-string, too long, too many words or bad characters', () => {
    expect(normalizeNegative('')).toBeNull();
    expect(normalizeNegative('   ')).toBeNull();
    expect(normalizeNegative(null)).toBeNull();
    expect(normalizeNegative(42)).toBeNull();
    expect(normalizeNegative('a'.repeat(81))).toBeNull();
    expect(normalizeNegative('a'.repeat(80))).toBe('a'.repeat(80));
    expect(normalizeNegative('one two three four five')).toBeNull();
    expect(normalizeNegative('one two three four')).toBe('one two three four');
    expect(normalizeNegative('[squirrel]')).toBeNull();
    expect(normalizeNegative('"squirrel"')).toBeNull();
    expect(normalizeNegative('squirrel-removal')).toBeNull();
    expect(normalizeNegative('squirrel, raccoon')).toBeNull();
    expect(normalizeNegative('-squirrel')).toBeNull();
  });
});

describe('protectedReason', () => {
  test('blocks brand words, service words and cities as whole words or phrases', () => {
    expect(protectedReason('waves')).toMatch(/waves/);
    expect(protectedReason('Waves Pest')).toMatch(/waves/);
    expect(protectedReason('plumber near me')).toMatch(/near me/);
    expect(protectedReason('cheap termite')).toMatch(/termite/);
    expect(protectedReason('bed bugs')).toMatch(/bug/);
    expect(protectedReason('mole cricket')).toMatch(/mole cricket/);
    expect(protectedReason('free sod')).toMatch(/sod/);
    expect(protectedReason('north port')).toMatch(/north port/);
    expect(protectedReason('best of sarasota')).toMatch(/sarasota/);
    expect(protectedReason('siesta key')).toMatch(/siesta key/);
    expect(protectedReason('laurel')).toMatch(/laurel/);
  });

  test('sees through punctuation and case', () => {
    expect(protectedReason('LAWN!')).toMatch(/lawn/);
    expect(protectedReason('pest-control')).toMatch(/pest/);
  });

  test('every listed word and city is protected on its own', () => {
    for (const w of [...SERVICE_WORDS, ...CITIES]) expect(protectedReason(w)).not.toBeNull();
  });

  test('does not match inside another word, and passes junk tokens', () => {
    expect(protectedReason('squirrel')).toBeNull();
    expect(protectedReason('raccoon trapping')).toBeNull();
    expect(protectedReason('diy')).toBeNull();
    expect(protectedReason('jobs')).toBeNull();
    expect(protectedReason('antique')).toBeNull(); // contains "ant"
    expect(protectedReason('potential')).toBeNull(); // contains "tent"
    expect(protectedReason('stickers')).toBeNull(); // contains "tick"
    expect(protectedReason('')).toBeNull();
    expect(protectedReason(undefined)).toBeNull();
  });
});

describe('competitorName', () => {
  test('finds a competitor as a whole word or phrase', () => {
    expect(competitorName('orkin')).toBe('orkin');
    expect(competitorName('Home Team pest prices')).toBe('home team');
    expect(competitorName('nozzle-nolen reviews')).toBe('nozzle nolen');
  });

  test('is null for other words and inside longer words', () => {
    expect(competitorName('squirrel')).toBeNull();
    expect(competitorName('orkinator')).toBeNull();
  });

  test('a competitor name is not a protected word, so the owner may block one himself', () => {
    for (const name of ['orkin', 'terminix', 'home team', 'nozzle nolen']) expect(protectedReason(name)).toBeNull();
    // One that holds a service word stays protected like any other text.
    expect(protectedReason('lawn doctor')).toMatch(/service word/);
    expect(COMPETITOR_NAMES).toContain('lawn doctor');
  });
});
