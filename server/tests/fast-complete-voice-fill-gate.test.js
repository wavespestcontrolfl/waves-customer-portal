/**
 * GATE_FAST_COMPLETE_VOICE_FILL: strict `=== 'true'`, read at call time, dark in
 * every environment, registered in the header (known-gate catalog) and the gates
 * map, with its reader exported on its own line.
 */
const fs = require('fs');
const path = require('path');
const { fastCompleteVoiceFillLive, isEnabled, gates, knownGateCatalog } = require('../config/feature-gates');

describe('GATE_FAST_COMPLETE_VOICE_FILL', () => {
  const saved = process.env.GATE_FAST_COMPLETE_VOICE_FILL;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = saved;
  });

  test('ships dark: unset is off', () => {
    delete process.env.GATE_FAST_COMPLETE_VOICE_FILL;
    expect(fastCompleteVoiceFillLive()).toBe(false);
  });

  test('only an exact "true" turns it on, read at call time', () => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    expect(fastCompleteVoiceFillLive()).toBe(true);
    for (const value of ['1', 'on', 'TRUE', 'yes', 'false', '', ' true']) {
      process.env.GATE_FAST_COMPLETE_VOICE_FILL = value;
      expect(fastCompleteVoiceFillLive()).toBe(false);
    }
  });

  test('is its own switch in the gates map, off by default', () => {
    expect(Object.keys(gates)).toContain('fastCompleteVoiceFill');
    expect(isEnabled('fastCompleteVoiceFill')).toBe(false);
  });

  test('is in the known-gate catalog as a plain on/off gate with its description', () => {
    const entry = knownGateCatalog().get('GATE_FAST_COMPLETE_VOICE_FILL');
    expect(entry).toBeTruthy();
    expect(entry.kind).toBe('boolean');
    expect(entry.description).toMatch(/voice fill/i);
    expect(entry.description).toMatch(/Ships DARK/);
  });

  test('the reader is exported on its own line, never in the shared one-line export', () => {
    const source = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(source).toMatch(/^module\.exports\.fastCompleteVoiceFillLive = fastCompleteVoiceFillLive;$/m);
    const shared = source.split('\n').filter((line) => /^module\.exports = /.test(line));
    for (const line of shared) expect(line).not.toContain('fastCompleteVoiceFillLive');
  });
});
