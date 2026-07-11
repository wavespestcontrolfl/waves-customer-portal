const { parseLooseJson } = require('../utils/llm-json');

describe('parseLooseJson', () => {
  test('parses a clean JSON object', () => {
    expect(parseLooseJson('{"grade":"B","wins":[]}')).toEqual({ grade: 'B', wins: [] });
  });

  test('strips markdown fences', () => {
    expect(parseLooseJson('```json\n{"grade":"A"}\n```')).toEqual({ grade: 'A' });
  });

  test('recovers an object wrapped in prose (the "Grade: ?" incident shape)', () => {
    const text = 'Here is the weekly report:\n\n{"grade":"C","overall_assessment":"ok"}\n\nLet me know if you need more.';
    expect(parseLooseJson(text)).toEqual({ grade: 'C', overall_assessment: 'ok' });
  });

  test('returns null on truncated JSON instead of throwing', () => {
    expect(parseLooseJson('{"grade":"B","recommendations":[{"action":"do th')).toBeNull();
  });

  test('returns null on empty / non-string input', () => {
    expect(parseLooseJson('')).toBeNull();
    expect(parseLooseJson(null)).toBeNull();
    expect(parseLooseJson(undefined)).toBeNull();
    expect(parseLooseJson('no json here')).toBeNull();
  });

  test('returns null for scalar JSON (must be an object)', () => {
    expect(parseLooseJson('42')).toBeNull();
    expect(parseLooseJson('"a string"')).toBeNull();
  });
});
