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

const member = { id: 'rec-1', customer_id: 'cust-1', scheduled_service_id: 'visit-1', is_callback: true, service_tier: 'Gold', service_tier_source: 'manual', service_type: 'Pest Control Re-Service' };
const nonMember = { ...member, service_tier: null, waveguard_tier: 'One-Time' };

// Minimal knex fake: `visit` = the scheduled row (or null), `invoices` = rows
// the collectible-invoice query returns. `throws` makes every query reject.
function fakeKnex({
  visit = { id: 'visit-1', estimated_price: null, is_callback: true },
  invoices = [],
  customer = { id: 'cust-1', waveguard_tier: 'Gold', waveguard_tier_source: 'manual', monthly_rate: 120, billing_mode: null },
  customerColumns = { waveguard_tier_source: {} },
  throws = false,
} = {}) {
  const calls = [];
  return Object.assign((table) => {
    calls.push(table);
    const chain = {
      where(arg) { if (typeof arg === 'function') arg(chain); return chain; },
      orWhere() { return chain; },
      whereNull() { return chain; },
      orWhereNotIn() { return chain; },
      whereNotIn() { return chain; },
      async columnInfo() {
        if (throws) throw new Error('db down');
        return table === 'customers' ? customerColumns : {};
      },
      async first() {
        if (throws) throw new Error('db down');
        if (table === 'scheduled_services') return visit;
        if (table === 'invoices') return invoices[0] || null;
        if (table === 'customers') return customer;
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
    expect(await reserviceReportPdfSignature(member, { knex })).toBe('-rs2mt');
    expect(reserviceReportRenderedSignature({ reserviceReport: block }, member)).toBe('-rs2mt');
  });

  test('PAID member callback (is_callback + positive estimated_price): no money claim', async () => {
    const knex = fakeKnex({ visit: { id: 'visit-1', estimated_price: '85.00', is_callback: true } });
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.includedWithWaveGuard).toBe(false);
    expect(block.billingLine).toBeNull();
    expect(block.billingReason).toBe('priced');
    expect(await reserviceReportPdfSignature(member, { knex })).toBe('-rs2nt');
  });

  test('PREPAID member callback (prepaid_amount, no invoice): no money claim', async () => {
    const knex = fakeKnex({ visit: { id: 'visit-1', estimated_price: null, prepaid_amount: '45.00', is_callback: true } });
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.includedWithWaveGuard).toBe(false);
    expect(block.billingLine).toBeNull();
    expect(block.billingReason).toBe('prepaid');
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
    expect(reserviceReportRenderedSignature({ reserviceReport: { includedWithWaveGuard: false } }, member)).toBe('-rs2nt');
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
    expect(await reserviceReportPdfSignature({ ...member, service_line: 'lawn' }, { knex: fakeKnex() })).toBe('-rs2mt');
  });

  test('non-member callback (One-Time tier): no money claim, no billing lookup, distinct key component', async () => {
    const knex = fakeKnex();
    const block = await buildReserviceReport(nonMember, { serviceLine: 'pest', knex });
    expect(block.includedWithWaveGuard).toBe(false);
    expect(block.billingLine).toBeNull();
    expect(block.billingReason).toBe('non_member');
    expect(knex.calls).toEqual([]);
    expect(await reserviceReportPdfSignature(nonMember, { knex })).toBe('-rs2nt');
  });

  test('incomplete outcome: claims neither treatment NOR "no application" (partial applications exist), distinct cache key', async () => {
    const knex = fakeKnex();
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex, visitOutcome: 'incomplete' });
    expect(block.outcome).toBe('incomplete');
    expect(block.result).toMatch(/could not be completed/);
    expect(`${block.result} ${block.completedFallback}`).not.toMatch(/re-?treated/i);
    expect(`${block.result} ${block.completedFallback} ${block.expectation}`).not.toMatch(/no application/i);
    expect(reserviceReportRenderedSignature({ reserviceReport: block }, member)).toBe('-rs2mx');
  });

  test('frozen provenance rules the claim: auto label and pre-freeze NULL both refuse; current row cannot rewrite history', async () => {
    const knex = fakeKnex();
    const labelEra = await buildReserviceReport({ ...member, service_tier_source: 'auto' }, { serviceLine: 'pest', knex });
    expect(labelEra.includedWithWaveGuard).toBe(false);
    expect(labelEra.billingReason).toBe('tier_label');
    const preFreeze = await buildReserviceReport({ ...member, service_tier_source: null }, { serviceLine: 'pest', knex });
    expect(preFreeze.includedWithWaveGuard).toBe(false);
    expect(preFreeze.billingReason).toBe('tier_provenance_unfrozen');
    const missing = await buildReserviceReport({ ...member, service_tier_source: undefined }, { serviceLine: 'pest', knex });
    expect(missing.includedWithWaveGuard).toBe(false);
  });

  test('the frozen snapshot is the sole authority — current customer state never rewrites history in either direction', async () => {
    // Visit frozen as a real membership; customer LATER becomes a label —
    // the historic claim stands.
    const nowLabelKnex = fakeKnex({ customer: { id: 'cust-1', waveguard_tier: 'Gold', waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: null } });
    const stands = await buildReserviceReport(member, { serviceLine: 'pest', knex: nowLabelKnex });
    expect(stands.includedWithWaveGuard).toBe(true);
    // Visit frozen as a label; customer LATER becomes a paying member —
    // the old callback never gains the claim.
    const nowMemberKnex = fakeKnex();
    const refused = await buildReserviceReport({ ...member, service_tier_source: 'auto' }, { serviceLine: 'pest', knex: nowMemberKnex });
    expect(refused.includedWithWaveGuard).toBe(false);
    expect(refused.billingReason).toBe('tier_label');
    // No customers-table read happens at all.
    expect(nowLabelKnex.calls).not.toContain('customers');
  });

  test('inspection_only / customer_declined outcomes never claim re-treatment, and key the cache distinctly', async () => {
    const knex = fakeKnex();
    const inspect = await buildReserviceReport(member, { serviceLine: 'pest', knex, visitOutcome: 'inspection_only' });
    expect(inspect.outcome).toBe('inspection_only');
    expect(inspect.result).toMatch(/inspected the areas you reported/);
    expect(`${inspect.result} ${inspect.completedFallback} ${inspect.expectation}`).not.toMatch(/re-?treated/i);
    expect(reserviceReportRenderedSignature({ reserviceReport: inspect }, member)).toBe('-rs2mi');
    const declined = await buildReserviceReport(member, { serviceLine: 'lawn', knex, visitOutcome: 'customer_declined' });
    expect(declined.result).toMatch(/treatment was not performed/);
    expect(`${declined.result} ${declined.completedFallback}`).not.toMatch(/re-?treated/i);
    expect(reserviceReportRenderedSignature({ reserviceReport: declined }, member)).toBe('-rs2md');
    // Pre-render signature path reads the outcome frozen in service_data.
    const frozen = { ...member, service_data: JSON.stringify({ protocol: { visitOutcome: 'inspection_only' } }) };
    expect(await reserviceReportPdfSignature(frozen, { knex })).toBe('-rs2mi');
    // Same fallback chain as buildProtocolPayload: a repaired record with
    // ONLY structured_notes.visitOutcome keys identically to what the
    // render stored — never the treated suffix (codex r2 P2).
    const structuredOnly = { ...member, structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }) };
    expect(await reserviceReportPdfSignature(structuredOnly, { knex })).toBe('-rs2md');
    // protocol may itself be a JSON string inside service_data.
    const doubleEncoded = { ...member, service_data: JSON.stringify({ protocol: JSON.stringify({ visitOutcome: 'inspection_only' }) }) };
    expect(await reserviceReportPdfSignature(doubleEncoded, { knex })).toBe('-rs2mi');
    // Durable record status: no outcome snapshot anywhere but the row says
    // incomplete — never the treated copy (codex GH-r4 P1).
    const statusOnly = { ...member, status: 'incomplete' };
    const block = await buildReserviceReport(statusOnly, { serviceLine: 'pest', knex });
    expect(block.outcome).toBe('incomplete');
    expect(await reserviceReportPdfSignature(statusOnly, { knex })).toBe('-rs2mx');
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

  test('a pre-completion "Charge now" invoice linked only by scheduled_service_id blocks the claim; NULL status counts as collectible', async () => {
    const seen = [];
    const knex = (table) => {
      const chain = {
        where(arg) { if (typeof arg === 'function') arg(chain); else seen.push(arg); return chain; },
        orWhere(arg) { seen.push(arg); return chain; },
        whereNull(col) { seen.push({ whereNull: col }); return chain; },
        orWhereNotIn(col, vals) { seen.push({ orWhereNotIn: [col, vals] }); return chain; },
        whereNotIn(col) { seen.push({ whereNotIn: col }); return chain; },
        async first() { return table === 'scheduled_services' ? { id: 'visit-1', estimated_price: null } : { id: 'inv-pre' }; },
      };
      return chain;
    };
    const block = await buildReserviceReport(member, { serviceLine: 'pest', knex });
    expect(block.billingReason).toBe('invoiced');
    expect(seen).toEqual(expect.arrayContaining([{ service_record_id: 'rec-1' }, { scheduled_service_id: 'visit-1' }]));
    // NOT IN never matches NULL, so the status filter must be
    // whereNull(status) OR whereNotIn(status, void-ish) — never a bare NOT IN.
    expect(seen).toEqual(expect.arrayContaining([{ whereNull: 'status' }, { orWhereNotIn: ['status', ['void', 'cancelled', 'canceled']] }]));
    expect(seen.find((entry) => entry.whereNotIn)).toBeUndefined();
  });
});
