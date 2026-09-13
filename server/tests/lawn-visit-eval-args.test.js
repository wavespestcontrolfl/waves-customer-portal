const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, '../../ops/agents/lawn-visit-assessment-eval.js');
const { _internals: { parseArgs } } = require(scriptPath);

describe('lawn visit eval --ids parsing', () => {
  let exit;
  let error;

  beforeEach(() => {
    exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exit.mockRestore();
    error.mockRestore();
  });

  test.each([
    ['missing', []],
    ['empty', ['']],
    ['whitespace-only', ['   ']],
    ['comma-only', [', ,,,  ']],
    ['the next flag', ['--limit', '1']],
  ])('rejects an explicitly supplied --ids value that is %s', (_label, tail) => {
    expect(() => parseArgs(['node', 'eval', '--run', 'fixture.json', '--ids', ...tail])).toThrow('exit 2');
    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--ids needs at least one comma-separated id'));
  });

  test('keeps omission unfiltered and preserves valid comma-list normalization', () => {
    expect(parseArgs(['node', 'eval', '--run', 'fixture.json']).ids).toEqual([]);
    expect(parseArgs(['node', 'eval', '--run', 'fixture.json', '--ids', ' first, second ,, third ']).ids)
      .toEqual(['first', 'second', 'third']);
  });
});

describe('lawn visit eval invalid --ids CLI ordering', () => {
  test.each([
    ['replay file', ['--run', '/definitely/missing/lawn-eval-fixture.json', '--ids', '--json']],
    ['export environment', ['--export', '--ids', ', ,']],
  ])('fails before %s I/O', (_label, args) => {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_PUBLIC_URL: '' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--ids needs at least one comma-separated id');
    expect(result.stderr).not.toMatch(/ENOENT|DATABASE_PUBLIC_URL not set|eval failed/);
  });
});
