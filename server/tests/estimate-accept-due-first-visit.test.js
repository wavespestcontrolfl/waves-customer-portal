// GATE_ESTIMATE_DUE_FIRST_VISIT (owner 2026-11-06 "walk all"): a customer who accepted an estimate on Nov 5 and booked
// a first visit for Nov 9 saw "Due November 5" on the pay page while the success card said paying now was optional.
// With the gate on, each accept invoice is due on the ET day of the first booked visit linked to the accept, when that
// day is after today; otherwise it stays due today. The reminder side lives in invoice-followups-net-terms-start.test.js.
const fs = require('fs');
const path = require('path');
const { acceptInvoiceVisitDueDate } = require('../routes/estimate-public');

// Thursday 2026-11-05 9:00 PM EST: already Nov 6 in UTC, still Nov 5 in New York.
const NOW = new Date('2026-11-06T02:00:00Z');

// A knex-style fake transaction: trx('scheduled_services').where({ id }).first(...) resolves the matching row.
function fakeTrx(rows, { fail = false } = {}) {
  const reads = [];
  const trx = jest.fn((table) => {
    const q = {
      where(filter) { q.filter = filter; return q; },
      first(...columns) {
        reads.push({ table, filter: q.filter, columns });
        if (fail) return Promise.reject(new Error('scheduled_services read failed'));
        return Promise.resolve(rows.find((row) => String(row.id) === String(q.filter.id)) || undefined);
      },
    };
    return q;
  });
  return { trx, reads };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_ESTIMATE_DUE_FIRST_VISIT;
});

describe('acceptInvoiceVisitDueDate: the accept invoice is due on its first visit day', () => {
  test('gate off: no later due date and no read (the caller keeps today, byte-identical)', async () => {
    const { trx } = fakeTrx([{ id: 'ss-1', scheduled_date: '2026-11-09' }]);

    expect(await acceptInvoiceVisitDueDate(trx, 'ss-1')).toBeNull();
    expect(trx).not.toHaveBeenCalled();
  });

  test.each([
    ['a pg DATE string', '2026-11-09'],
    ['a pg DATE read back as a UTC-midnight Date', new Date('2026-11-09T00:00:00Z')],
  ])('gate on, a future visit as %s: due that day, read on the accept transaction', async (_label, scheduledDate) => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const { trx, reads } = fakeTrx([{ id: 'ss-1', scheduled_date: scheduledDate }]);

    expect(await acceptInvoiceVisitDueDate(trx, 'ss-1')).toBe('2026-11-09');
    expect(reads).toEqual([{ table: 'scheduled_services', filter: { id: 'ss-1' }, columns: ['scheduled_date'] }]);
  });

  test('gate on, today is the New York day: a visit on the UTC day after 7 PM ET is still a later day', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const { trx } = fakeTrx([{ id: 'ss-1', scheduled_date: '2026-11-06' }]);

    expect(await acceptInvoiceVisitDueDate(trx, 'ss-1')).toBe('2026-11-06');
  });

  test.each([
    ['a visit today', [{ id: 'ss-1', scheduled_date: '2026-11-05' }], 'ss-1'],
    ['a visit before today', [{ id: 'ss-1', scheduled_date: '2026-11-02' }], 'ss-1'],
    ['a visit row that is gone', [], 'ss-1'],
    ['a visit with no date', [{ id: 'ss-1', scheduled_date: null }], 'ss-1'],
    ['a visit date that cannot be read', [{ id: 'ss-1', scheduled_date: 'not a date' }], 'ss-1'],
  ])('gate on, %s: no later due date (the caller keeps today)', async (_label, rows, visitId) => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const { trx } = fakeTrx(rows);

    expect(await acceptInvoiceVisitDueDate(trx, visitId)).toBeNull();
  });

  test.each([null, undefined])('gate on, no linked visit (%s): no later due date and no read', async (visitId) => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const { trx } = fakeTrx([]);

    expect(await acceptInvoiceVisitDueDate(trx, visitId)).toBeNull();
    expect(trx).not.toHaveBeenCalled();
  });

  test('a gate value other than exactly "true" is off', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = '1';
    const { trx } = fakeTrx([{ id: 'ss-1', scheduled_date: '2026-11-09' }]);

    expect(await acceptInvoiceVisitDueDate(trx, 'ss-1')).toBeNull();
  });
});

// The accept handler is one large transaction; these pins hold each accept invoice to the helper, with the visit the
// invoice is linked to and the accept's own transaction.
describe('every accept invoice takes its due date from the linked visit (source pins)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');

  test('the invoice-mode accept: its linked visit, else today', () => {
    expect(src).toMatch(/scheduledServiceId: acceptLinkedSsId \} : \{\}\),[\s\S]{0,200}dueDate: \(await acceptInvoiceVisitDueDate\(trx, acceptLinkedSsId\)\) \|\| etDateString\(\),/);
  });

  test('the standard setup/first-application accept: its attached visit, else today', () => {
    expect(src).toMatch(/scheduledServiceId: attachScheduledServiceId \} : \{\}\),[\s\S]{0,200}dueDate: \(await acceptInvoiceVisitDueDate\(trx, attachScheduledServiceId\)\) \|\| etDateString\(\),/);
  });

  test('a new-slot invoice-mode accept: the visit it is attached to after conversion moves the due date in the same write', () => {
    expect(src).toMatch(/const anchorDueDate = await acceptInvoiceVisitDueDate\(trx, invoiceModeAnchorId\);\s*await trx\('invoices'\)\.where\(\{ id: invoiceIdResult \}\)\.whereNull\('scheduled_service_id'\)\s*\.update\(\{\s*scheduled_service_id: invoiceModeAnchorId,\s*\.\.\.\(anchorDueDate \? \{ due_date: anchorDueDate \} : \{\}\),/);
  });

  test('no accept invoice is still minted due today unconditionally', () => {
    const createCalls = src.split('InvoiceService.create({').slice(1).map((chunk) => chunk.slice(0, 1200));
    const acceptCreates = createCalls.filter((chunk) => /depositCredit: \{ amount: requested(Invoice|Standard)DepositCredit/.test(chunk));
    expect(acceptCreates).toHaveLength(2);
    for (const chunk of acceptCreates) expect(chunk).not.toMatch(/dueDate: etDateString\(\),/);
  });
});
