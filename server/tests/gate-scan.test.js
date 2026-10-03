// The index itself is enforced by `npm run check:domain-rules` (rule 7).
const { gatesInSource } = require('../../scripts/lib/gate-scan');

const names = (src) => [...gatesInSource(src)].sort();

describe('gate scan: what counts as a gate the code reads', () => {
  test('reads through process.env, a bracket lookup and the gate helpers', () => {
    expect(names(`
      const a = process.env.GATE_ALPHA === 'true';
      const b = process.env['GATE_BRAVO'];
      const c = gateEnvValue('GATE_CHARLIE');
      const d = featureGates.gateEnvTimestamp("GATE_DELTA_SINCE");
      const SUMMARY_GATE = 'GATE_ECHO';
      const on = process.env[SUMMARY_GATE] === 'true';
    `)).toEqual(['GATE_ALPHA', 'GATE_BRAVO', 'GATE_CHARLIE', 'GATE_DELTA_SINCE', 'GATE_ECHO']);
  });

  test('reads destructured from process.env, with an alias or a default', () => {
    expect(names(`
      const { GATE_ALPHA, GATE_BRAVO: bravo = 'off', NODE_ENV } = process.env;
      const { GATE_NOT_ENV } = options;
    `)).toEqual(['GATE_ALPHA', 'GATE_BRAVO']);
  });

  test('a gate named only in a comment is not a read', () => {
    expect(names(`
      // set GATE_LINE_COMMENT=true to turn this on
      /* reads gateEnvValue('GATE_BLOCK_COMMENT')
         at call time */
      const url = 'https://example.com/a'; const on = process.env.GATE_AFTER_URL;
    `)).toEqual(['GATE_AFTER_URL']);
  });

  test('a retired-name list and a message are not reads', () => {
    expect(names(`
      const RETIRED = new Set(['GATE_OLD_GLASS', 'GATE_OLDER_GLASS']);
      res.json({ error: 'GATE_NOT_A_GATE' });
    `)).toEqual([]);
  });

  test('a name prefix and an error code are not gates', () => {
    expect(names(`
      const key = \`GATE_BOOK_\${suffix}\`;
      const other = process.env['GATE_CARD_HOLD_PARK_ON_' + kind];
      throw Object.assign(new Error('failed'), { code: 'GATE_CODE_BELLS_FAILED' });
    `)).toEqual([]);
  });
});
