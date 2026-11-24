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
    [['--execute', '--batch', 'run-1', '--ids=8dbfaef8-a0a9-4d52-b6b0-e8c97318dd09'], /unknown argument "--ids"/],
    [['--execute', '--batch=run-1'], /unknown argument "--batch"/],
    [['--execute', '--batch', 'run-1', '--id', '8dbfaef8-a0a9-4d52-b6b0-e8c97318dd09'], /unknown argument "--id"/],
    [['--execute', '--batch', 'run-1', 'stray'], /unknown argument "stray"/],
    [['--execute', '--batch', 'run-1', '--ids', 'a', '--ids', 'b'], /--ids is given twice/],
    [['--dry-run'], /unknown argument "--dry-run"/],
    [['--labels', 'out.json'], /--labels needs --batch/],
  ])('%j is refused with a usage message and nothing is run', (args, message) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mark-mail-batch failed: USAGE/);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).toBe('');
  });

  test.each([
    ['unset', {}],
    ['whitespace', { DATABASE_URL: '   ' }],
    ['the literal undefined', { DATABASE_URL: 'undefined' }],
    ['not PostgreSQL', { DATABASE_URL: 'mysql://u:p@host/db' }],
    ['no database name', { DATABASE_URL: 'postgres://u:p@host' }],
    ['only DATABASE_PUBLIC_URL, even inside a Postgres service shell', { DATABASE_PUBLIC_URL: 'postgres://prod:prod@prod-db.invalid:5432/railway', RAILWAY_SERVICE_NAME: 'Postgres' }],
    ['the private Railway host', { DATABASE_URL: 'postgres://u:p@postgres.railway.internal:5432/railway' }],
  ])('a DATABASE_URL that is %s is refused before any database is opened', (_label, extra) => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...extra } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mark-mail-batch failed: DB_URL/);
    expect(result.stderr).not.toMatch(/ENOTFOUND/);
  });

  test('an explicit DATABASE_URL is used as given, never replaced by an inherited public URL', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        PATH: process.env.PATH,
        RAILWAY_SERVICE_NAME: 'Postgres',
        DATABASE_URL: 'postgres://qa:qa@127.0.0.1:1/waves_qa', // a closed local port: refused at once
        DATABASE_PUBLIC_URL: 'postgres://prod:prod@prod-db.invalid:5432/railway', // would fail ENOTFOUND if chosen
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ECONNREFUSED/);
    expect(result.stderr).not.toMatch(/ENOTFOUND/);
  });
});
