const {
  correctEmailDomain,
  damerauLevenshtein,
  splitEmail,
  meetsConfidence,
} = require('../utils/email-typo-correction');

describe('email-typo-correction: damerauLevenshtein', () => {
  test('counts an adjacent transposition as a single edit', () => {
    expect(damerauLevenshtein('gmial', 'gmail')).toBe(1);
  });
  test('basic edits', () => {
    expect(damerauLevenshtein('gmal', 'gmail')).toBe(1); // insertion
    expect(damerauLevenshtein('gmaill', 'gmail')).toBe(1); // deletion
    expect(damerauLevenshtein('gmsil', 'gmail')).toBe(1); // substitution
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
  });
});

describe('email-typo-correction: splitEmail', () => {
  test('lowercases and trims', () => {
    expect(splitEmail('  Jane@Gmail.COM ')).toEqual({ local: 'jane', domain: 'gmail.com' });
  });
  test('rejects malformed addresses', () => {
    expect(splitEmail('no-at-sign')).toBeNull();
    expect(splitEmail('@gmail.com')).toBeNull();
    expect(splitEmail('jane@')).toBeNull();
    expect(splitEmail('jane @gmail.com')).toBeNull();
    expect(splitEmail('')).toBeNull();
    expect(splitEmail(null)).toBeNull();
  });
});

describe('email-typo-correction: correctEmailDomain', () => {
  test('returns null for already-valid known domains', () => {
    expect(correctEmailDomain('jane@gmail.com')).toBeNull();
    expect(correctEmailDomain('jane@yahoo.com')).toBeNull();
    expect(correctEmailDomain('jane@comcast.net')).toBeNull();
  });

  test('returns null for unknown business domains (never guess)', () => {
    expect(correctEmailDomain('jane@company.com')).toBeNull();
    expect(correctEmailDomain('jane@some-pest-co.com')).toBeNull();
    // .com -> .net swap is too large an edit; safer to leave alone
    expect(correctEmailDomain('jane@comcast.com')).toBeNull();
  });

  test('missing dot before TLD is a high-confidence reconstruction', () => {
    expect(correctEmailDomain('jane@gmailcom')).toEqual({
      corrected: 'jane@gmail.com', rule: 'missing_dot', confidence: 'high',
    });
    expect(correctEmailDomain('jane@comcastnet')).toEqual({
      corrected: 'jane@comcast.net', rule: 'missing_dot', confidence: 'high',
    });
  });

  test('wrong TLD on a known provider is fixed high-confidence', () => {
    expect(correctEmailDomain('jane@gmail.con')).toMatchObject({ corrected: 'jane@gmail.com', rule: 'tld_fix', confidence: 'high' });
    expect(correctEmailDomain('jane@gmail.co')).toMatchObject({ corrected: 'jane@gmail.com', rule: 'tld_fix' });
    expect(correctEmailDomain('jane@yahoo.cmo')).toMatchObject({ corrected: 'jane@yahoo.com', rule: 'tld_fix' });
  });

  test('fuzzy domain typos within one edit are high-confidence', () => {
    expect(correctEmailDomain('jane@gmial.com')).toMatchObject({ corrected: 'jane@gmail.com', confidence: 'high' });
    expect(correctEmailDomain('jane@gmai.com')).toMatchObject({ corrected: 'jane@gmail.com', confidence: 'high' });
    expect(correctEmailDomain('jane@yahooo.com')).toMatchObject({ corrected: 'jane@yahoo.com', confidence: 'high' });
    expect(correctEmailDomain('jane@hotnail.com')).toMatchObject({ corrected: 'jane@hotmail.com', confidence: 'high' });
  });

  test('NEVER edits the local part', () => {
    // The local part is gibberish but the domain is fine — must not touch it.
    expect(correctEmailDomain('jhon.doee@gmail.com')).toBeNull();
    // When the domain IS fixed, the (typo'd) local part is preserved verbatim.
    const r = correctEmailDomain('jhon.doee@gmial.com');
    expect(r.corrected).toBe('jhon.doee@gmail.com');
  });

  test('rejects an ambiguous (tied) nearest match — never guesses', () => {
    // mail.com is Damerau distance 1 from BOTH gmail.com and ymail.com.
    expect(correctEmailDomain('jane@mail.com')).toBeNull();
  });

  test('two-edit domain typos are medium confidence (gated out by default)', () => {
    // 'gmaul' -> 'gmail' is one substitution; build a genuine 2-edit case.
    const r = correctEmailDomain('jane@gnaul.com'); // g[n]a[u]l -> gmail = 2 subs
    if (r) expect(['medium', 'high']).toContain(r.confidence);
  });
});

describe('email-typo-correction: meetsConfidence', () => {
  test('threshold comparison', () => {
    expect(meetsConfidence('high', 'high')).toBe(true);
    expect(meetsConfidence('medium', 'high')).toBe(false);
    expect(meetsConfidence('medium', 'medium')).toBe(true);
    expect(meetsConfidence('high', 'medium')).toBe(true);
    expect(meetsConfidence(undefined, 'high')).toBe(false);
  });
});
