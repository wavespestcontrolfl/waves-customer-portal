/**
 * projects.invoice_id has ONE writer (admin-projects.js persistProjectInvoiceLink). The Intelligence Bar's apply_invoice_credit
 * refuses an invoice linked to any project, reading projects.invoice_id under the invoice row's FOR UPDATE; so the link must take
 * that invoice row (FOR SHARE) in the same transaction before it writes (after the project row: lock order is project -> invoice), and a new link then waits for the credit transaction to commit instead
 * of appearing between the credit's read and its commit. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => Object.assign(jest.fn(), { fn: { now: () => 'NOW()' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const { persistProjectInvoiceLink } = require('../routes/admin-projects');

// A recorder: every statement appended to `log` in order; forShare() can be held behind a gate (a concurrent FOR UPDATE).
function makeRunner({ gate = null, failLock = false } = {}) {
  const log = [];
  const runner = (table) => {
    const q = { table, locked: null };
    const b = {
      where: () => b,
      forShare: () => { q.locked = 'share'; return b; },
      forUpdate: () => { q.locked = 'update'; return b; },
      first: async () => {
        log.push(`${table}:${q.locked ? `lock ${q.locked}` : 'read'}`);
        if (q.locked === 'share' && failLock) throw new Error('deadlock detected');
        if (q.locked === 'share' && gate) await gate;
        return { id: 'inv-1' };
      },
      update: async (values) => { log.push(`${table}:update ${JSON.stringify(Object.keys(values))}`); return 1; },
    };
    return b;
  };
  runner.fn = { now: () => 'NOW()' };
  runner.log = log;
  runner.transaction = jest.fn(async (fn) => fn(runner));
  return runner;
}

beforeEach(() => jest.clearAllMocks());

describe('persistProjectInvoiceLink takes the project row, then the invoice row', () => {
  test('the project is locked, then the invoice FOR SHARE, then the project is linked, in one transaction (a savepoint when the caller already holds one)', async () => {
    const runner = makeRunner();
    const project = { id: 'proj-1', invoice_id: null };
    await persistProjectInvoiceLink(project, 'inv-1', runner);
    expect(runner.transaction).toHaveBeenCalledTimes(1);
    expect(runner.log).toEqual(['projects:lock update', 'invoices:lock share', 'projects:update ["invoice_id","updated_at"]']);
    expect(project.invoice_id).toBe('inv-1');
  });

  test('a link made while the credit transaction holds the invoice FOR UPDATE waits for it: the project is not linked until the lock is released', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runner = makeRunner({ gate });
    const project = { id: 'proj-1', invoice_id: null };
    const pending = persistProjectInvoiceLink(project, 'inv-1', runner);
    await new Promise((r) => setImmediate(r));
    expect(runner.log).toEqual(['projects:lock update', 'invoices:lock share']);
    expect(project.invoice_id).toBeNull();
    release();
    await pending;
    expect(runner.log).toEqual(['projects:lock update', 'invoices:lock share', 'projects:update ["invoice_id","updated_at"]']);
    expect(project.invoice_id).toBe('inv-1');
  });

  test('a runner that is a plain handle (no transaction method) still locks the project, then the invoice', async () => {
    const runner = makeRunner();
    delete runner.transaction;
    await persistProjectInvoiceLink({ id: 'proj-1', invoice_id: null }, 'inv-1', runner);
    expect(runner.log).toEqual(['projects:lock update', 'invoices:lock share', 'projects:update ["invoice_id","updated_at"]']);
  });

  test('a failed lock (deadlock victim) links nothing and is logged, never thrown; an already-linked project is a no-op', async () => {
    const failing = makeRunner({ failLock: true });
    const project = { id: 'proj-1', invoice_id: null };
    await expect(persistProjectInvoiceLink(project, 'inv-1', failing)).resolves.toBeUndefined();
    expect(failing.log).toEqual(['projects:lock update', 'invoices:lock share']);
    expect(project.invoice_id).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not persist invoice link for proj-1/));
    const idle = makeRunner();
    await persistProjectInvoiceLink({ id: 'proj-1', invoice_id: 'inv-1' }, 'inv-1', idle);
    await persistProjectInvoiceLink({ id: 'proj-1', invoice_id: null }, null, idle);
    expect(idle.log).toEqual([]);
  });
});

describe('persistProjectInvoiceLink is the only writer of projects.invoice_id (source contract)', () => {
  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return ['tests', 'migrations', 'node_modules', 'contract-tests'].includes(entry.name) ? [] : sourceFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  test('no other server code updates or inserts a projects row with invoice_id', () => {
    const offenders = [];
    for (const file of sourceFiles(path.join(__dirname, '..'))) {
      const text = fs.readFileSync(file, 'utf8');
      // `projects` table handle followed (within the statement) by an update/insert object naming invoice_id.
      const re = /\(\s*['"`]projects['"`]\s*\)[^;]*?\.(?:update|insert)\(\s*\{[^}]*\binvoice_id\b/gs;
      let m;
      while ((m = re.exec(text))) offenders.push(`${path.relative(path.join(__dirname, '..'), file)}: ${m[0].slice(0, 90).replace(/\s+/g, ' ')}`);
    }
    // The one writer is persistProjectInvoiceLink's own update, inside admin-projects.js; nothing else may appear.
    expect(offenders).toEqual([expect.stringMatching(/^routes\/admin-projects\.js: .*update\(\{ invoice_id/)]);
    const writer = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-projects.js'), 'utf8');
    expect(writer.match(/\.update\(\{ invoice_id: invoiceId/g)).toHaveLength(1);
  });
});
