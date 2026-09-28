// Owner ruling 2026-09-28 (#5181): a visit's price cannot change while money
// is committed at the old price — an open invoice with a balance, a live card
// hold, or an approved appointment-card charge. Staff void / release first.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const db = require('../models/db');
db.raw = jest.fn(async () => ({ rows: [] }));
const { assertRepriceAllowed } = require('../routes/admin-schedule');

function conn({ price = 129, invoices = [], hold = null, cardLane = null } = {}) {
  const fn = (table) => {
    const chain = {
      where(arg) { if (typeof arg === 'function') arg.call(chain); return chain; },
      whereNotIn() { return chain; }, whereIn() { return chain; }, orWhereIn() { return chain; }, whereNotNull() { return chain; }, forShare() { return chain; },
      select: async () => invoices,
      first: async () => {
        if (table === 'scheduled_services') return { estimated_price: price };
        if (table === 'estimate_card_holds') return hold;
        if (table === 'appointment_card_requests') return cardLane;
        return null;
      },
    };
    return chain;
  };
  fn.schema = { hasTable: async () => true };
  return fn;
}

describe('assertRepriceAllowed', () => {
  test('an unchanged price always passes, even with an open invoice', async () => {
    await expect(assertRepriceAllowed(conn({ invoices: [{ status: 'sent', total: 129 }] }), 's1', '129.00')).resolves.toBeUndefined();
  });

  test('a re-price with an open invoice balance is refused', async () => {
    await expect(assertRepriceAllowed(conn({ invoices: [{ status: 'sent', total: 129 }] }), 's1', 0))
      .rejects.toMatchObject({ statusCode: 409, code: 'REPRICE_BLOCKED_OPEN_INVOICE' });
  });

  test('a fully credited invoice (nothing due) does not block', async () => {
    await expect(assertRepriceAllowed(conn({ invoices: [{ status: 'sent', total: 129, credit_applied: 129 }] }), 's1', 80)).resolves.toBeUndefined();
  });

  test('a live card hold blocks a re-price', async () => {
    await expect(assertRepriceAllowed(conn({ hold: { id: 'h1' } }), 's1', 0))
      .rejects.toMatchObject({ statusCode: 409, code: 'REPRICE_BLOCKED_CARD_HOLD' });
  });

  test('a card approval does not block a re-price (the card lane re-checks the live price at charge time)', async () => {
    await expect(assertRepriceAllowed(conn({ cardLane: { id: 'a1' } }), 's1', 80)).resolves.toBeUndefined();
  });

  test('nothing committed: a re-price (including to $0) passes', async () => {
    await expect(assertRepriceAllowed(conn(), 's1', 0)).resolves.toBeUndefined();
  });
});

test('update-details and the "following visits" propagation both run the guard before writing a price', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  // Decided before the first Stripe cancel in update-details (a cancelled
  // payment session does not roll back with the transaction).
  const guardAt = src.indexOf('assertRepriceAllowed(trx, req.params.id, updates.estimated_price)');
  const stripeCancelNote = src.indexOf('EVERY refusal is decided BEFORE the first Stripe cancel');
  const editWrite = src.indexOf("await trx('scheduled_services').where({ id: req.params.id }).update(updates);");
  expect(guardAt).toBeGreaterThan(-1);
  expect(guardAt).toBeLessThan(stripeCancelNote);
  expect(guardAt).toBeLessThan(editWrite);
  const siblingWrite = src.indexOf("await conn('scheduled_services').where({ id: sibling.id }).update(siblingUpdates);");
  expect(src.slice(siblingWrite - 300, siblingWrite)).toContain('assertRepriceAllowed(conn, sibling.id, siblingUpdates.estimated_price)');
});

test('a shared combined-visit (packet) invoice the visit belongs to is part of the check', async () => {
  const calls = [];
  const c = conn({ invoices: [{ status: 'sent', total: 200 }] });
  const wrapped = (table) => {
    const ch = c(table);
    const orig = ch.orWhereIn;
    ch.orWhereIn = (...args) => { calls.push({ table, col: args[0] }); return orig.apply(ch, args); };
    return ch;
  };
  wrapped.schema = c.schema;
  await expect(assertRepriceAllowed(wrapped, 's1', 0)).rejects.toMatchObject({ code: 'REPRICE_BLOCKED_OPEN_INVOICE' });
  expect(calls).toContainEqual({ table: 'invoices', col: 'id' });
});

test('an invoice linked only through the visit\'s service record is part of the check', async () => {
  const calls = [];
  const c = conn({ invoices: [{ status: 'sent', total: 90 }] });
  const wrapped = (table) => {
    const ch = c(table);
    const orig = ch.orWhereIn;
    ch.orWhereIn = (...args) => { calls.push(args[0]); return orig.apply(ch, args); };
    return ch;
  };
  wrapped.schema = c.schema;
  await expect(assertRepriceAllowed(wrapped, 's1', 0)).rejects.toMatchObject({ code: 'REPRICE_BLOCKED_OPEN_INVOICE' });
  expect(calls).toContain('service_record_id');
});
