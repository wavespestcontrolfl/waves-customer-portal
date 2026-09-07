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
    require: () => ({ acceptedScheduleFindings: classify, formatDateOnly: (value) => value || null,
      readActiveFamilyHolds: async () => [], readStoppedRecurringRoots: async () => new Set() }),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
  const result = await verify(database, { estimateId: estimate.id, customerId: estimate.customer_id });
  expect(classify.mock.calls[0][1].map((visit) => visit.id)).toEqual(['current', 'future']);
  expect(result.ok).toBe(false);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'recurring_schedule_missing_followups' }));
});

test.each(['2040-01-10', '2040-01-11'])('acceptance honors active family holds until resume day (%s)', async (todayET) => {
  const { readActiveFamilyHolds } = require('../services/recurring-schedule-audit');
  const estimate = { id: 'estimate-new', customer_id: 'customer-1' };
  const holdRows = [
    { customer_id: 'customer-1', family_key: 'pest', status: 'active', starts_on: '2040-01-10', resume_on: '2040-01-11' },
    { customer_id: 'customer-2', family_key: 'lawn', status: 'active', starts_on: '2040-01-01', resume_on: '2040-02-01' },
    { customer_id: 'customer-1', family_key: 'lawn', status: 'cancelled', starts_on: '2040-01-01', resume_on: '2040-02-01' },
    { customer_id: 'customer-1', family_key: 'mosquito', status: 'active', starts_on: '2040-02-01', resume_on: '2040-03-01' },
  ];
  const insert = jest.fn(async () => []);
  const database = (table) => {
    let rows = table === 'plan_holds' ? holdRows : [];
    const query = {
      whereIn: (key, values) => { rows = rows.filter((row) => values.includes(row[key])); return query; },
      where: (key, op, value) => {
        if (table === 'plan_holds') rows = rows.filter((row) => value === undefined
          ? row[key] === op : op === '<=' ? row[key] <= value : row[key] > value);
        return query;
      },
      leftJoin: () => query,
      select: () => query,
      first: async () => estimate,
      insert,
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  };
  const classify = jest.fn((_estimate, _visits, _stopped, { heldFamilies }) => heldFamilies.has('pest')
    ? [] : [{ serviceFamily: 'pest', recordedVisits: 0, expectedVisits: 12 }]);
  const verify = vm.runInNewContext(`${source.slice(start, end)}; verifyAcceptedRecurringSchedule`, {
    etDateString: () => todayET,
    require: () => ({ acceptedScheduleFindings: classify, readActiveFamilyHolds, readStoppedRecurringRoots: async () => new Set() }),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
  const result = await verify(database, { estimateId: estimate.id, customerId: estimate.customer_id });
  const held = todayET === '2040-01-10';
  expect([...classify.mock.calls[0][3].heldFamilies]).toEqual(held ? ['pest'] : []);
  expect(classify.mock.calls[0][3].todayET).toBe(todayET);
  expect(result.ok).toBe(held);
  expect(insert).toHaveBeenCalledTimes(held ? 0 : 1);
});

test.each(['let_lapse', 'cancel_series', 'extend_series'])(
  'acceptance uses the latest resolved series decision (%s)', async (action) => {
    const audit = require('../services/recurring-schedule-audit');
    const estimate = { id: 'estimate-new', customer_id: 'customer-1', accepted_at: new Date('2040-01-01T16:00:00Z'),
      accepted_service_mode: 'recurring', monthly_total: 100, annual_total: 1200,
      estimate_data: { customerSelection: { frequency: 'monthly' }, result: { recurring: {
        services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'monthly', visitsPerYear: 12 }],
      } } } };
    const root = { id: 'root', customer_id: 'customer-1', source_estimate_id: 'estimate-old',
      service_type: 'Monthly Pest Control Service', catalog_service_key: 'pest_general_monthly',
      is_recurring: true, recurring_pattern: 'monthly', scheduled_date: '2039-12-01', status: 'completed' };
    const upcoming = { ...root, id: 'child', recurring_parent_id: 'root', scheduled_date: '2040-02-01', status: 'pending' };
    const decisions = [
      { customer_id: 'customer-1', recurring_parent_id: 'root', resolved_action: 'let_lapse', resolved_at: '2039-12-01' },
      { customer_id: 'customer-1', recurring_parent_id: 'root', resolved_action: action, resolved_at: '2039-12-02' },
      { customer_id: 'customer-1', recurring_parent_id: 'root', resolved_action: 'extend_series', resolved_at: null },
      { customer_id: 'customer-2', recurring_parent_id: 'root', resolved_action: 'extend_series', resolved_at: '2039-12-03' },
    ];
    const insert = jest.fn(async () => []);
    const database = (table) => {
      let rows = table === 'recurring_plan_alerts' ? decisions : table === 'scheduled_services as s' ? [root, upcoming]
        : table === 'activity_log' ? [{ metadata: { estimateId: estimate.id, existingParentId: root.id } }] : [];
      const query = {
        where: () => query,
        whereIn: (key, values) => { rows = rows.filter((row) => values.includes(row[key])); return query; },
        whereNotNull: (key) => { rows = rows.filter((row) => row[key] != null); return query; },
        orderBy: (key) => { rows = [...rows].sort((a, b) => b[key].localeCompare(a[key])); return query; },
        leftJoin: () => query,
        select: () => query,
        first: async () => estimate,
        insert,
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    };
    const classify = jest.fn(audit.acceptedScheduleFindings);
    const verify = vm.runInNewContext(`${source.slice(start, end)}; verifyAcceptedRecurringSchedule`, {
      etDateString: (value) => value ? etDateString(value) : '2040-01-01',
      require: () => ({ ...audit, acceptedScheduleFindings: classify }),
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const result = await verify(database, { estimateId: estimate.id, customerId: estimate.customer_id });
    const stopped = action !== 'extend_series';
    expect(result.ok).toBe(stopped);
    expect(insert).toHaveBeenCalledTimes(stopped ? 0 : 1);
    expect(classify.mock.calls[0][1].map((row) => row.id)).toEqual(stopped ? ['root', 'child'] : ['child']);
    if (!stopped) expect(result.gaps[0].issues).toContain('missing_applications');
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
  const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
    && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  if (!localCI && !ownedQA) {
    throw new Error('Use disposable CI or this worktree\'s private QA database');
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
