/**
 * Unit tests for pii-redactor. Heavy coverage — safety-critical.
 *
 * Bias: when ambiguous, redact. A false-positive ([address] swallowing
 * an innocent number+word pair) is cheap; a false-negative (leaking a
 * real address to a published blog post) is catastrophic.
 */

const { redact, _internals } = require('../services/content/pii-redactor');

describe('phone redaction', () => {
  test.each([
    '941-555-1234',
    '(941) 555-1234',
    '941.555.1234',
    '+1 941 555 1234',
    '9415551234',
    '1-941-555-1234',
  ])('redacts %s', (input) => {
    const { text, findings } = redact(`Call me at ${input} please`);
    expect(text).toMatch(/\[phone\]/);
    expect(text).not.toMatch(/\d{3}.{0,3}\d{3}.{0,3}\d{4}/);
    expect(findings.find((f) => f.type === 'phone').count).toBe(1);
  });
});

describe('email redaction', () => {
  test('redacts standard emails', () => {
    const { text } = redact('My email is jane.doe+spam@example.com thanks');
    expect(text).toBe('My email is [email] thanks');
  });
  test('redacts multiple', () => {
    const { findings } = redact('a@b.com c@d.org');
    expect(findings.find((f) => f.type === 'email').count).toBe(2);
  });
});

describe('SSN redaction', () => {
  test('redacts SSN-shaped strings', () => {
    expect(redact('SSN: 123-45-6789').text).toBe('SSN: [ssn]');
  });
});

describe('credit-card-shaped redaction', () => {
  test('redacts 16-digit groups', () => {
    expect(redact('Card 4111 1111 1111 1111').text).toMatch(/\[card\]/);
    expect(redact('Card 4111111111111111').text).toMatch(/\[card\]/);
  });
});

describe('address redaction', () => {
  test('redacts house number + street + suffix', () => {
    const { text } = redact('Come to 123 Main Street tomorrow');
    expect(text).toBe('Come to [address] tomorrow');
  });
  test('handles short suffix abbreviations', () => {
    expect(redact('4567 Oak Dr').text).toBe('[address]');
    expect(redact('99 Bay Ct').text).toBe('[address]');
  });
  test('confidence drops to medium when address matches', () => {
    const { confidence } = redact('99 Bay Ct');
    expect(confidence).toBe('medium');
  });
});

describe('FL ZIP redaction', () => {
  test('redacts ZIP after FL token', () => {
    expect(redact('Bradenton FL 34203').text).toBe('Bradenton [zip]');
    expect(redact('Address Florida 34203-1234').text).toMatch(/\[zip\]/);
  });
});

describe('URL redaction', () => {
  test('redacts long URLs (likely tracking params)', () => {
    const long = 'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?q=secret';
    expect(redact(`Visit ${long}`).text).toMatch(/\[url\]/);
  });
  test('leaves short URLs alone', () => {
    const short = 'https://x.io/a';
    expect(redact(short).text).toBe(short);
  });
});

describe('name heuristic (signal prefix)', () => {
  test('redacts "my name is X Y"', () => {
    const { text, confidence } = redact('Hi, my name is Tracy Smith and I have a question.');
    expect(text).toMatch(/\[name\]/);
    expect(confidence).toBe('medium');
  });
  test('does not redact owner / staff names in allowlist', () => {
    const { text } = redact('Adam came out yesterday — great service.');
    expect(text).toContain('Adam');
  });
  test('does not redact city names', () => {
    const { text } = redact('Lakewood Ranch homeowner here.');
    expect(text).toContain('Lakewood Ranch');
  });
  test('does not redact day / month names', () => {
    const { text } = redact('Saw Friday morning some ants in the kitchen.');
    expect(text).toContain('Friday');
  });
});

describe('name heuristic (single first name after signal — call transcripts)', () => {
  test('redacts a lone first name after "this is" (no last name)', () => {
    const { text, confidence } = redact('Waves Pest Control, this is Adam. Hi, this is Anthony.');
    expect(text).toContain('this is [name]');
    expect(text).toContain('Adam'); // owner stays (allowlist)
    expect(text).not.toContain('Anthony');
    expect(confidence).toBe('medium');
  });
  test('redacts "my name is X" and "it\'s X"', () => {
    expect(redact('my name is John, calling about roaches').text).toContain('my name is [name]');
    expect(redact("it's Jeff with the pool company").text).toContain("it's [name]");
  });
  test('does not redact allowlisted tokens after a signal ("this is Adam", "this is Sarasota")', () => {
    expect(redact('Hey, this is Adam').text).toContain('Adam');
    expect(redact('this is Sarasota calling').text).toContain('Sarasota');
  });
  test('does not fire on a lowercase word after the signal ("this is great")', () => {
    const { text, confidence } = redact('this is great, thanks');
    expect(text).toBe('this is great, thanks');
    expect(confidence).toBe('high');
  });
  test('a leading greeting does not consume the real intro keyword ("Hi, My name is John")', () => {
    // Greetings are excluded as triggers so "Hi" cannot grab "My" and leave
    // the real first name "John" exposed.
    const { text } = redact('Hi, My name is John, calling about roaches');
    expect(text).toContain('My name is [name]');
    expect(text).not.toContain('John');
    expect(text).not.toContain('Hi [name]');
  });
});

describe('name heuristic (standalone pair, no marker required)', () => {
  test('redacts standalone name pair after sign-off marker', () => {
    const { text } = redact('Thanks for the help — Sincerely, John Carpenter');
    expect(text).toMatch(/\[name\]/);
  });
  test('redacts standalone name pair anywhere in text', () => {
    // Real-world leak this catches: customer SMS like "...today. Kristi
    // Mohammadbhoy". Without this aggressive pass, real names leak.
    const { text } = redact('Last Tuesday Carlos Rodriguez stopped by.');
    expect(text).not.toContain('Carlos Rodriguez');
    expect(text).toMatch(/\[name\]/);
  });
  test('still respects allowlist for service / city pairs', () => {
    // "Lakewood Ranch" — both in allowlist — must NOT redact.
    expect(redact('Service in Lakewood Ranch today.').text).toContain('Lakewood Ranch');
    expect(redact('Pest Control is what we need.').text).toContain('Pest Control');
    expect(redact('Adam came out yesterday.').text).toContain('Adam');
  });
});

describe('null / empty handling', () => {
  test('null input returns empty + high confidence', () => {
    expect(redact(null)).toEqual({ text: '', confidence: 'high', findings: [] });
  });
  test('empty string returns empty + high confidence', () => {
    expect(redact('')).toEqual({ text: '', confidence: 'high', findings: [] });
  });
});

describe('mixed-content stress', () => {
  test('a realistic customer SMS — multiple PII categories', () => {
    const input = 'Hi! Jane Smith here, my number is 941-555-9876 and email j.smith@example.com. I live at 1455 Manatee Ave Bradenton FL 34205. Need pest control today.';
    const { text, confidence, findings } = redact(input);
    expect(text).not.toMatch(/\d{3}.?\d{3}.?\d{4}/);
    expect(text).not.toMatch(/@example\.com/);
    expect(text).not.toMatch(/1455 Manatee/);
    expect(text).not.toMatch(/34205/);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(['medium', 'low']).toContain(confidence);
  });
});

describe('confidence: high case', () => {
  test('clean text with no PII returns high', () => {
    const { confidence, findings } = redact('I saw a roach in the kitchen last night.');
    expect(confidence).toBe('high');
    expect(findings).toEqual([]);
  });
});

describe('confidence: low case', () => {
  test('unstructured 7+ digit run flags low', () => {
    // Long bare digit run that doesn't match phone/CC/SSN patterns.
    const input = 'Reference number: 12345678';
    const { confidence } = redact(input);
    expect(confidence).toBe('low');
  });
  test('all-caps run of 20+ flags low', () => {
    const { confidence } = redact('NOTICE: HHHHHHHHHHHHHHHHHHHHH text after.');
    expect(confidence).toBe('low');
  });
});

describe('idempotency', () => {
  test('redacting twice yields same output', () => {
    const input = 'Call 941-555-1234';
    const once = redact(input).text;
    const twice = redact(once).text;
    expect(twice).toBe(once);
  });
});

describe('internals', () => {
  test('NAME_ALLOWLIST contains canonical SWFL cities and staff', () => {
    const { NAME_ALLOWLIST } = _internals;
    for (const name of ['Bradenton', 'Sarasota', 'Adam', 'Virginia', 'Florida']) {
      expect(NAME_ALLOWLIST.has(name)).toBe(true);
    }
  });
  test('looksLikeFalsePositiveName flags allowlist + caps', () => {
    const { looksLikeFalsePositiveName } = _internals;
    expect(looksLikeFalsePositiveName('Bradenton', 'Smith')).toBe(true);
    expect(looksLikeFalsePositiveName('JANE', 'Doe')).toBe(true);
    expect(looksLikeFalsePositiveName('Tracy', 'X')).toBe(true);
    expect(looksLikeFalsePositiveName('Tracy', 'Smith')).toBe(false);
  });
});
