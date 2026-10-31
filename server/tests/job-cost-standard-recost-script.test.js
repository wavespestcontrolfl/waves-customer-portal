// server/scripts/job-cost-standard-recost.js: needs GATE_JOB_COST_STANDARD_MINUTES (dry run too); a dry run
// rolls every visit back; --write commits; the report names service types, never customers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, parseArgs, costedRecord } = require('../scripts/job-cost-standard-recost');

const RECORDS = {
  a: { revenue: '100.00', material_cost: '5.00', labor_cost: '40.00', drive_cost: '6.00', gross_profit: '49.00' },
  b: { revenue: '0.00', material_cost: '0.00', labor_cost: '35.00', drive_cost: '6.00', gross_profit: '-41.00' },
  c: null, // no service record
};
const JOB_COSTS = { a: { scheduled_service_id: 'a', labor_cost: '40.00', drive_cost: '6.00' } };
const RESULTS = {
  a: { service_type: 'Lawn Care Service', revenue: 100, products_cost: 5, labor_cost: 11.67, drive_cost: 11.67, gross_profit: 71.66 },
  b: { service_type: 'Lawn Care Service', revenue: 89, products_cost: 0, labor_cost: 11.67, drive_cost: 11.67, gross_profit: 65.66 },
  c: { service_type: 'Lawn Care Service', revenue: 1, products_cost: 0, labor_cost: 1, drive_cost: 1, gross_profit: -1 },
};

function fakeConn(ids) {
  const trxs = [];
  const list = { where: () => list, orderBy: () => list, pluck: () => Promise.resolve(ids) };
  const conn = () => list;
  conn.trxs = trxs;
  conn.transaction = async () => {
    const trx = (table) => {
      const rows = table === 'job_costs' ? JOB_COSTS : RECORDS;
      const chain = { where: (w) => { chain.id = w.scheduled_service_id; return chain; }, orderBy: () => chain, first: () => Promise.resolve(rows[chain.id]) };
      return chain;
    };
    trx.commit = jest.fn().mockResolvedValue();
    trx.rollback = jest.fn().mockResolvedValue();
    trxs.push(trx);
    return trx;
  };
  return conn;
}

const calc = (failId) => jest.fn(async (id) => {
  if (id === failId) throw new Error('boom');
  return RESULTS[id];
});
const ARGS = ['--from', '2026-08-01', '--to', '2026-10-30'];
// The price settings load and each visit's record comes from the injected stand-ins.
const BASE = { gateOn: () => true, syncPricing: async () => true, loadRecord: async (trx, id) => RECORDS[id] };

describe('job-cost-standard-recost script', () => {
  test('refuses, dry run included, when the gate is off', async () => {
    const conn = fakeConn(['a']);
    await expect(run(ARGS, { conn, log: jest.fn(), gateOn: () => false, calculateJobCost: calc() }))
      .rejects.toThrow('GATE_JOB_COST_STANDARD_MINUTES is not "true"');
    expect(conn.trxs).toHaveLength(0);
  });

  test('dry run rolls every visit back and prints before and after by service type', async () => {
    const conn = fakeConn(['a', 'b', 'c']);
    const log = jest.fn();
    const calculateJobCost = calc();
    const out = await run(ARGS, { conn, log, ...BASE, calculateJobCost });
    expect(calculateJobCost).toHaveBeenCalledWith('a', expect.any(Function), { keepRecordedRevenue: true });
    expect(conn.trxs).toHaveLength(3);
    for (const trx of conn.trxs) {
      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(trx.commit).not.toHaveBeenCalled();
    }
    expect(out).toMatchObject({ visits: 3, counted: 2, noRecord: 1, failed: 0 });
    expect(out.types['Lawn Care Service'].before).toEqual({ revenue: 100, material: 5, labor: 75, drive: 12, margin: 8 });
    expect(out.types['Lawn Care Service'].after).toEqual({ revenue: 189, material: 5, labor: 23.34, drive: 23.34, margin: 137.32 });
    const text = log.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toMatch(/DRY RUN \(nothing written\) 3 completed visit/);
    expect(text).toMatch(/Lawn Care Service: 2 visit\(s\)/);
    expect(text).toMatch(/1 without a service record/);
  });

  test('--write keeps each visit\'s figures before its commit, then commits it', async () => {
    const conn = fakeConn(['a', 'b']);
    const keepBefore = jest.fn();
    const snapshot = path.join(os.tmpdir(), `recost-snapshot-${process.pid}-${Date.now()}.jsonl`);
    await run([...ARGS, '--write', '--snapshot', snapshot], { conn, log: jest.fn(), ...BASE, calculateJobCost: calc(), keepBefore });
    for (const trx of conn.trxs) {
      expect(trx.commit).toHaveBeenCalledTimes(1);
      expect(trx.rollback).not.toHaveBeenCalled();
    }
    expect(keepBefore).toHaveBeenNthCalledWith(1, {
      scheduled_service_id: 'a',
      service_record: { revenue: '100.00', material_cost: '5.00', labor_cost: '40.00', drive_cost: '6.00', gross_profit: '49.00' },
      job_cost: JOB_COSTS.a,
    });
    expect(keepBefore).toHaveBeenNthCalledWith(2, expect.objectContaining({ scheduled_service_id: 'b', job_cost: null }));
    expect(keepBefore.mock.invocationCallOrder[0]).toBeLessThan(conn.trxs[0].commit.mock.invocationCallOrder[0]);
  });

  test('--write is refused without a new snapshot file, before any visit is costed', async () => {
    const conn = fakeConn(['a']);
    const deps = { conn, log: jest.fn(), ...BASE, calculateJobCost: calc() };
    await expect(run([...ARGS, '--write'], deps)).rejects.toThrow('--write needs --snapshot');
    const existing = path.join(os.tmpdir(), `recost-snapshot-existing-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(existing, '');
    try {
      await expect(run([...ARGS, '--write', '--snapshot', existing], deps)).rejects.toThrow('already exists');
    } finally {
      fs.unlinkSync(existing);
    }
    expect(conn.trxs).toHaveLength(0);
  });

  test('a failed visit is rolled back and makes the run fail', async () => {
    const conn = fakeConn(['a', 'b']);
    await expect(run(ARGS, { conn, log: jest.fn(), ...BASE, calculateJobCost: calc('b') })).rejects.toThrow('1 visit(s) failed');
    expect(conn.trxs[1].rollback).toHaveBeenCalled();
    expect(conn.trxs[1].commit).not.toHaveBeenCalled();
  });

  test('stops before any visit when the price settings do not load', async () => {
    const conn = fakeConn(['a']);
    const syncPricing = jest.fn().mockResolvedValue(false);
    await expect(run(ARGS, { ...BASE, conn, log: jest.fn(), calculateJobCost: calc(), syncPricing }))
      .rejects.toThrow('price settings (pricing_config) did not load');
    expect(syncPricing).toHaveBeenCalledWith(conn);
    expect(conn.trxs).toHaveLength(0);
  });

  test('costedRecord is the record costing resolves; an ambiguous legacy match has none', async () => {
    const svc = { id: 'a', customer_id: 'c-1' };
    const cols = { scheduled_service_id: {} };
    const trx = (table) => ({
      where: () => ({ first: () => Promise.resolve(table === 'scheduled_services' ? svc : null) }),
      columnInfo: () => Promise.resolve(cols),
    });
    const legacy = { id: 'rec-legacy', revenue: '0.00' };
    const resolve = jest.fn().mockResolvedValueOnce({ record: legacy, ambiguous: false }).mockResolvedValueOnce({ record: legacy, ambiguous: true });
    expect(await costedRecord(trx, 'a', resolve)).toBe(legacy);
    expect(resolve).toHaveBeenCalledWith(trx, svc, cols);
    expect(await costedRecord(trx, 'a', resolve)).toBeNull();
  });

  test('an unknown flag is refused', () => {
    expect(() => parseArgs([...ARGS, '--force'])).toThrow('Unknown argument: --force');
  });
});
