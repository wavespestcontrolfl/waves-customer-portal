/**
 * Round 16: every function in the start_program files stays under the repository complexity limit (20), so the card
 * builder is a table of small parts, not one long function.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const FILES = [
  '../services/intelligence-bar/start-program.js',
  '../services/intelligence-bar/start-program-marker.js',
  '../services/booking-contact-state.js',
];

describe('start_program functions stay under the complexity limit', () => {
  const complexity = {};
  beforeAll(() => {
    // ESLint loads its config through a dynamic import jest cannot run in-process: lint in a child.
    for (const file of FILES) {
      const full = path.join(__dirname, file);
      const run = spawnSync(process.execPath, [
        path.join(__dirname, '../../node_modules/eslint/bin/eslint.js'), '--rule', '{"complexity":["warn",1]}', '-f', 'json', full,
      ], { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const [result] = JSON.parse(run.stdout);
      complexity[file] = {};
      for (const m of result.messages) {
        const hit = m.ruleId === 'complexity' && /(?:unction|ethod|rrow function) '?([^' ]*)'? ?has a complexity of (\d+)/.exec(m.message);
        if (hit) complexity[file][`${hit[1]}@${m.line}`] = Number(hit[2]);
      }
    }
  }, 180000);

  test.each(FILES)('%s: no function is above 20', (file) => {
    const over = Object.entries(complexity[file]).filter(([, value]) => value > 20);
    expect(over).toEqual([]);
  });

  test('the card builder is split into parts', () => {
    const src = require('fs').readFileSync(path.join(__dirname, FILES[0]), 'utf8');
    for (const part of ['seriesLines', 'consultationLines', 'overlapLines', 'billLines', 'customerLines', 'commsLines']) {
      expect(src).toContain(`function ${part}(plan, add)`);
    }
    expect(Object.keys(complexity[FILES[0]]).some((k) => k.startsWith('cardLines@'))).toBe(false);
  });
});
