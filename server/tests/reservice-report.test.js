/**
 * Re-service (callback) report copy — keyed on service_records.is_callback,
 * dark behind GATE_RESERVICE_REPORT_COPY, lawn/pest lines only, and the
 * "$0 — included with WaveGuard" money claim only when the visit is PROVEN
 * free (member tier + no priced row + no collectible invoice).
 */
const {
  buildReserviceReport,
  reserviceReportPdfSignature,
  reserviceReportRenderedSignature,
} = require('../services/service-report/reservice-report');

const ORIGINAL = process.env.GATE_RESERVICE_REPORT_COPY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
  else process.env.GATE_RESERVICE_REPORT_COPY = ORIGINAL;
});

const member = { id: 'rec-1', scheduled_service_id: 'visit-1', is_callback: true, service_tier: 'Gold', service_type: 'Pest Control Re-Service' };
const nonMember = { ...member, service_tier: null, waveguard_tier: 'One-Time' };

// Minimal knex fake: `visit` = the scheduled row (or null), `invoices` = rows
// the collectible-invoice query returns. `throws` makes every query reject.
function fakeKnex({ visit = { id: 'visit-1', estimated_price: null, is_callback: true }, invoices = [], throws = false } = {}) {
  const calls = [];
  return Object.assign((table) => {
    calls.push(table);
    const chain = {
      where(arg) { if (typeof arg === 'function') arg(chain); return chain; },
      orWhere() { return chain; },
      whereNotIn() { return chain; },
      async first() {
        if (throws) throw new Error('db down');
        if (table === 'scheduled_services') return visit;
        if (table === 'invoices') return invoices[0] || null;
        return null;
      },
    };
    return chain;
  }, { calls });
}

describe('reservice-report (dark gate)', () => {
  test('gate unset: no block, empty key components, no DB query', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    const knex = fakeKnex();
    expect(await buildReserviceReport(member, { serviceLine: 'pest', knex })).toBeNull();
    expect(await reserviceReportPdfSignature(member, { knex })).toBe('');
    expect(reserviceReportRenderedSignature({ reserviceReport: { includedWithWaveGuard: true } }, member)).toBe('');
    expect(knex.calls).toEqual([]);
  });

  test('gate on: a non-callback record still gets nothing', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    const knex = fakeKnex();
    expect(await buildReserviceReport({ ...member, is_callback: false }, { serviceLine: 'pest', knex })).toBeNull();
    expect(await buildReserviceReport({ ...member, is_callback: undefined }, { serviceLine: 'pest', knex })).toBeNull();
    expect(await reserviceReportPdfSignature({ ...member, is_callback: false }, { knex })).toBe('');
    expect(knex.calls).toEqual([]);
  });
});

describe('reservice-report (gate on)', () => {
  beforeEach(() => { process.env.GATE_RESERVICE_REPORT_COPY = 'true'; });

  test('member pest callback, proven free: pest copy + the $0 WaveGuard line + member key component', async () => {
    const knex = fakeKnex();
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.serviceLine).toBe('pest');
    expect(block.result).toMatch(/re-treated the affected areas/);
    expect(block.expectation).toMatch(/two weeks/);
    expect(block.includedWithWaveGuard).toBe(true);
    expect(block.billingLine).toBe('This re-service was included with your WaveGuard Gold membership — $0.00 billed.');
    expect(block.billingReason).toBe('free');
    expect(await reserviceReportPdfSignature(member, { knex })).toBe('-rs1m');
    expect(reserviceReportRenderedSignature({ reserviceReport: block }, member)).toBe('-rs1m');
  });

  test('PAID member callback (is_callback + positive estimated_price): no money claim', async () => {
    const knex = fakeKnex({ visit: { id: 'visit-1', estimated_price: '85.00', is_callback: true } });
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.includedWithWaveGuard).toBe(false);
    expect(block.billingLine).toBeNull();
    expect(block.billingReason).toBe('priced');
    expect(await reserviceReportPdfSignature(member, { knex })).toBe('-rs1n');
  });

  test('member callback with a collectible invoice on the record: no money claim', async () => {
    const knex = fakeKnex({ invoices: [{ id: 'inv-1' }] });
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.includedWithWaveGuard).toBe(false);
    expect(block.billingReason).toBe('invoiced');
  });

  test('fails closed: missing visit row, no linked visit, or a lookup failure ⇒ no money claim', async () => {
    expect((await buildReserviceReport(member, { serviceLine: 'pest', knex: fakeKnex({ visit: null }) })).billingReason).toBe('visit_missing');
    expect((await buildReserviceReport({ ...member, scheduled_service_id: null }, { serviceLine: 'pest', knex: fakeKnex() })).billingReason).toBe('no_visit');
    const failed = await buildReserviceReport(member, { serviceLine: 'pest', knex: fakeKnex({ throws: true }) });
    expect(failed.includedWithWaveGuard).toBe(false);
    expect(failed.billingReason).toBe('lookup_failed');
    expect((await buildReserviceReport(member, { serviceLine: 'pest' })).billingReason).toBe('no_db');
  });

  test('store-side signature follows the RENDERED block, not a re-resolve (fell-closed render keys as no-claim)', () => {
    expect(reserviceReportRenderedSignature({ reserviceReport: { includedWithWaveGuard: false } }, member)).toBe('-rs1n');
    expect(reserviceReportRenderedSignature({ reserviceReport: null }, member)).toBe('');
    expect(reserviceReportRenderedSignature({}, member)).toBe('');
  });

  test('lawn callback: turf wording, never "knock activity down"', async () => {
    const block = await buildReserviceReport(member, { serviceLine: 'lawn', knex: fakeKnex() });
    expect(block.serviceLine).toBe('lawn');
    expect(block.result).toMatch(/Lawn re-service completed/);
    expect(block.result).not.toMatch(/activity/i);
    expect(block.expectation).toMatch(/weeds and disease/);
    expect(block.expectation).not.toMatch(/knock activity down/);
  });

  test('rodent (or any non-lawn/pest) callback gets NO block — the re-treatment copy would be false', async () => {
    const knex = fakeKnex();
    expect(await buildReserviceReport({ ...member, service_type: 'Rodent Trapping Follow-Up Visit Service' }, { serviceLine: 'rodent', knex })).toBeNull();
    expect(await reserviceReportPdfSignature({ ...member, service_type: 'Rodent Trapping Follow-Up Visit Service', service_line: 'rodent' }, { knex })).toBe('');
    expect(knex.calls).toEqual([]);
  });

  test('signature resolves the line from the record when the builder line is not passed', async () => {
    expect(await reserviceReportPdfSignature({ ...member, service_line: 'lawn' }, { knex: fakeKnex() })).toBe('-rs1m');
  });

  test('non-member callback (One-Time tier): no money claim, no billing lookup, distinct key component', async () => {
    const knex = fakeKnex();
    const block = await buildReserviceReport(nonMember, { serviceLine: 'pest', knex });
    expect(block.includedWithWaveGuard).toBe(false);
    expect(block.billingLine).toBeNull();
    expect(block.billingReason).toBe('non_member');
    expect(knex.calls).toEqual([]);
    expect(await reserviceReportPdfSignature(nonMember, { knex })).toBe('-rs1n');
  });

  test('ONLY the tier frozen on the record qualifies — the customer\'s current tier never rewrites an old callback as free', async () => {
    const frozen = await buildReserviceReport({ ...member, service_tier: 'Silver', waveguard_tier: null }, { serviceLine: 'pest', knex: fakeKnex() });
    expect(frozen.billingLine).toMatch(/WaveGuard Silver/);
    const knex = fakeKnex();
    const joinedLater = await buildReserviceReport({ ...member, service_tier: null, waveguard_tier: 'Gold' }, { serviceLine: 'pest', knex });
    expect(joinedLater.includedWithWaveGuard).toBe(false);
    expect(joinedLater.billingLine).toBeNull();
    expect(joinedLater.billingReason).toBe('non_member');
    expect(knex.calls).toEqual([]);
  });

  test('a pre-completion "Charge now" invoice linked only by scheduled_service_id blocks the claim', async () => {
    const seen = [];
    const knex = (table) => {
      const chain = {
        where(arg) { if (typeof arg === 'function') arg(chain); else seen.push(arg); return chain; },
        orWhere(arg) { seen.push(arg); return chain; },
        whereNotIn() { return chain; },
        async first() { return table === 'scheduled_services' ? { id: 'visit-1', estimated_price: null } : { id: 'inv-pre' }; },
      };
      return chain;
    };
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.billingReason).toBe('invoiced');
    expect(seen).toEqual(expect.arrayContaining([{ service_record_id: 'rec-1' }, { scheduled_service_id: 'visit-1' }]));
  });
});
