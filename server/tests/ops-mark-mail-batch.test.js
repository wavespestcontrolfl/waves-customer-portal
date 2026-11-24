/**
 * ops/agents/mark-mail-batch.js argument checks. They run before the database is opened, so no database is needed: an empty
 * value (a shell variable that expanded to nothing) must never read as "no filter" and widen the run to every eligible home.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'ops', 'agents', 'mark-mail-batch.js');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH }, // no DATABASE_URL: reaching the database would fail differently
});

describe('mark-mail-batch arguments', () => {
  test.each([
    [['--execute', '--batch', 'run-1', '--ids', ''], /--ids is empty/],
    [['--execute', '--batch', 'run-1', '--ids', ' , '], /--ids is empty/],
    [['--execute', '--batch', 'run-1', '--ids'], /--ids needs a value/],
    [['--execute', '--batch', ''], /--batch is empty/],
    [['--execute'], /--execute needs --batch/],
    [['--labels', ''], /--labels is empty/],
    [['--labels', '--execute'], /--labels needs a value/],
  ])('%j is refused with a usage message and nothing is run', (args, message) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mark-mail-batch failed: USAGE/);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).toBe('');
  });
});
