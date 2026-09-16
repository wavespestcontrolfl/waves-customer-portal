const { normalizeEmailReplyCopy: normalize, COPY_LIMITS } = require('../services/email/email-reply-copy-normalizer');

describe('bounded email copy normalization', () => {
  test.each([
    ['USD **98** per visit', 'USD 98 per visit'],
    ['**USD *98* per application**', 'USD 98 per application'],
    ['__Each visit costs **98 dollars**__', 'Each visit costs 98 dollars'],
    ['USD `98` per visit', 'USD 98 per visit'],
    ['USD ``98`` per visit', 'USD 98 per visit'],
    ['USD ``98` per visit', 'USD ``98` per visit'],
    ['USD `98\r\n` per application', 'USD 98  per application'],
    ['USD **98\nper visit**', 'USD 98 per visit'],
    ['$98 per\\-visit', '$98 per-visit'],
    ['Billing is\\\nper visit', 'Billing is per visit'],
    ['$98\\\r\nfor each visit', '$98 for each visit'],
    ['USD 98 per&#32;visit', 'USD 98 per visit'],
    ['ＵＳＤ ９８ per‑visit', 'USD 98 per-visit'],
    ['Your visit’s price is $98.', "Your visit's price is $98."],
    ['A stray * or ` and a \\q remain.', 'A stray * or ` and a \\q remain.'],
    ['The amount is $98.\nFor each visit, send a reminder.', 'The amount is $98. For each visit, send a reminder.'],
  ])('normalizes %s', (input, output) => {
    expect(normalize(input)).toEqual({ ok: true, text: output });
  });

  test('accepts an empty draft without claiming it is a complete reply', () => {
    expect(normalize()).toEqual({ ok: true, text: '' });
  });

  test('rejects nonstrings without invoking user-controlled coercion', () => {
    const toString = jest.fn(() => { throw new Error('must not coerce'); });
    expect(normalize({ toString })).toEqual({ ok: false, text: null, reason: 'copy_type' });
    expect(toString).not.toHaveBeenCalled();
    expect(normalize(null).ok).toBe(false);
  });

  test('bounds raw UTF-8 bytes, including a single giant token', () => {
    expect(normalize('a'.repeat(COPY_LIMITS.bytes)).ok).toBe(true);
    expect(normalize('a'.repeat(COPY_LIMITS.bytes + 1))).toEqual({ ok: false, text: null, reason: 'copy_size' });
    expect(normalize('é'.repeat(COPY_LIMITS.bytes / 2)).ok).toBe(true);
    expect(normalize('é'.repeat(COPY_LIMITS.bytes / 2 + 1)).reason).toBe('copy_size');
    expect(normalize('$' + '1,'.repeat(50000) + 'x').reason).toBe('copy_size');
  });

  test('checks expanded compatibility characters before formatting', () => {
    expect(normalize('\uFDFA'.repeat(300)).reason).toBe('copy_size');
  });

  test('bounds raw and decoded token counts', () => {
    expect(normalize('a '.repeat(COPY_LIMITS.tokens)).ok).toBe(true);
    expect(normalize('a '.repeat(COPY_LIMITS.tokens + 1)).reason).toBe('copy_tokens');
    expect(normalize('a&#32;'.repeat(COPY_LIMITS.tokens + 1)).reason).toBe('copy_tokens');
  });

  test('fails closed on deeply nested formatting within the byte limit', () => {
    const wrap = Array.from({ length: 80 }, (_, i) => (i % 2 ? '_' : '*'));
    const input = wrap.join('') + 'USD 98 per visit' + [...wrap].reverse().join('');
    expect(normalize(input)).toEqual({ ok: false, text: null, reason: 'copy_format_depth' });
  });

  test('rejects the reported large nesting attack before regex work', () => {
    const wrap = '*_'.repeat(20000);
    expect(normalize(wrap + 'USD 98 per visit' + [...wrap].reverse().join('')).reason).toBe('copy_size');
  });
});
