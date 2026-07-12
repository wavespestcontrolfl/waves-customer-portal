const { isValidBase64 } = require('../utils/base64-validate');

describe('isValidBase64 (stack-safe sliced validation)', () => {
  test('accepts real encoder output, padded and unpadded', () => {
    expect(isValidBase64(Buffer.from('fake-png-bytes').toString('base64'))).toBe(true);
    expect(isValidBase64('AAAA')).toBe(true);
    expect(isValidBase64('AB==')).toBe(true);
    expect(isValidBase64('ABC=')).toBe(true);
  });

  test('accepts a multi-megabyte payload without throwing', () => {
    // The regression this util exists for: a ~7MB subject through the old
    // whole-string regex could throw RangeError "Maximum call stack size
    // exceeded" under low stack headroom (the CI-only IB image-turn flake).
    const big = 'A'.repeat(Math.ceil(((5 * 1024 * 1024) + 1) * 4 / 3 / 4) * 4);
    expect(isValidBase64(big)).toBe(true);
    expect(isValidBase64(`${big.slice(0, -4)}AB==`)).toBe(true);
    expect(isValidBase64(`${big.slice(0, -4)}A?==`)).toBe(false);
  });

  test('rejects malformed input', () => {
    expect(isValidBase64('not-base64!!')).toBe(false); // bad charset (len % 4 === 0)
    expect(isValidBase64('not-base64!')).toBe(false); // bad length
    expect(isValidBase64('A=AA')).toBe(false); // '=' only valid as trailing padding
    expect(isValidBase64('A===')).toBe(false); // max 2 padding chars
    expect(isValidBase64('====')).toBe(false); // no payload before padding
    expect(isValidBase64('')).toBe(false);
    expect(isValidBase64(null)).toBe(false);
    expect(isValidBase64(42)).toBe(false);
  });

  test('boundary chars around each 64KB slice edge are still checked', () => {
    const slice = 65536;
    const good = 'A'.repeat(slice * 2);
    expect(isValidBase64(good)).toBe(true);
    for (const pos of [slice - 1, slice, slice + 1]) {
      const bad = `${good.slice(0, pos)}?${good.slice(pos + 1)}`;
      expect(isValidBase64(bad)).toBe(false);
    }
  });
});
