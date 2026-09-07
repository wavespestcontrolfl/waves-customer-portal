const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { etDateString } = require('../utils/datetime-et');

// Exercise the private reader without booting the converter's external services.
const source = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
const start = source.indexOf('async function verifyAcceptedRecurringSchedule(');
const end = source.indexOf('// The pattern seedRecurringFollowUpsForParent', start);

test('retained coverage excludes prior-term visits using the selected Eastern acceptance day', async () => {
  const estimate = { id: 'estimate-new', customer_id: 'customer-1', accepted_at: new Date('2026-07-02T02:00:00Z') };
  const visits = [
    { id: 'old', recurring_parent_id: 'root', source_estimate_id: 'estimate-old', scheduled_date: '2026-06-30', status: 'completed' },
    { id: 'current', recurring_parent_id: 'root', source_estimate_id: 'estimate-old', scheduled_date: '2026-07-01', status: 'completed' },
    { id: 'future', recurring_parent_id: 'root', source_estimate_id: 'estimate-old', scheduled_date: '2026-08-01', status: 'pending' },
  ];
  const classify = jest.fn(() => [{ serviceFamily: 'pest', recordedVisits: 2, expectedVisits: 12 }]);
  const insert = jest.fn(async () => []);
  const database = (table) => {
    let columns;
    const query = {
      where: () => query,
      leftJoin: () => query,
      select: (...selected) => { columns = selected; return query; },
      first: async () => Object.fromEntries(columns.map((column) => [column, estimate[column]])),
      insert,
      then: (resolve, reject) => Promise.resolve(table === 'activity_log'
        ? [{ metadata: { estimateId: estimate.id, existingParentId: 'root' } }]
        : visits).then(resolve, reject),
    };
    return query;
  };
  const verify = vm.runInNewContext(`${source.slice(start, end)}; verifyAcceptedRecurringSchedule`, {
    etDateString,
    require: () => ({ acceptedScheduleFindings: classify, formatDateOnly: (value) => value || null }),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
  const result = await verify(database, { estimateId: estimate.id, customerId: estimate.customer_id });
  expect(classify.mock.calls[0][1].map((visit) => visit.id)).toEqual(['current', 'future']);
  expect(result.ok).toBe(false);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'recurring_schedule_missing_followups' }));
});

test('an audit exception returns an explicit failure without aborting conversion', async () => {
  const checkStart = source.indexOf('    let recurringScheduleCheck =');
  const checkEnd = source.indexOf('    logger.info(', checkStart);
  const auditTrx = {};
  const transaction = jest.fn(async (callback) => callback(auditTrx));
  const verifyAudit = jest.fn(async () => { throw new Error('query unavailable'); });
  const result = await vm.runInNewContext(`(async () => { ${source.slice(checkStart, checkEnd)} return recurringScheduleCheck; })()`, {
    verifyAcceptedRecurringSchedule: verifyAudit,
    database: { transaction },
    estimateId: 'estimate-new',
    customerId: 'customer-1',
    logger: { warn: jest.fn() },
  });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(verifyAudit).toHaveBeenCalledWith(auditTrx, { estimateId: 'estimate-new', customerId: 'customer-1' });
  expect(result).toEqual({ ok: false, gaps: [], error: 'verification_failed' });
});

const postgresTest = process.env.DATABASE_URL ? test : test.skip;
postgresTest('a PostgreSQL audit statement error rolls back its savepoint and preserves acceptance writes', async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('This regression requires disposable local CI PostgreSQL');
  }
  const db = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL });
  const checkStart = source.indexOf('    let recurringScheduleCheck =');
  const checkEnd = source.indexOf('    logger.info(', checkStart);
  try {
    await db.transaction(async (trx) => {
      await trx.raw('CREATE TEMP TABLE acceptance_audit_probe (id integer) ON COMMIT DROP');
      await trx('acceptance_audit_probe').insert({ id: 1 });
      const result = await vm.runInNewContext(`(async () => { ${source.slice(checkStart, checkEnd)} return recurringScheduleCheck; })()`, {
        verifyAcceptedRecurringSchedule: async (auditTrx) => {
          await auditTrx('acceptance_audit_probe').insert({ id: 2 });
          await auditTrx.raw('SELECT 1 / 0');
        },
        database: trx,
        estimateId: 'estimate-new',
        customerId: 'customer-1',
        logger: { warn: jest.fn() },
      });
      expect(result.error).toBe('verification_failed');
      await trx('acceptance_audit_probe').insert({ id: 3 });
      expect(await trx('acceptance_audit_probe').orderBy('id')).toEqual([{ id: 1 }, { id: 3 }]);
    });
  } finally {
    await db.destroy();
  }
});
