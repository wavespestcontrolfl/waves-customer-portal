// Owner ruling 2026-09-28 (#5181): a visit's price cannot change while money
// is committed at the old price — an open invoice with a balance, a live card
// hold, or an approved appointment-card charge. Staff void / release first.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const db = require('../models/db');
db.raw = jest.fn(async () => ({ rows: [] }));
const { assertRepriceAllowed } = require('../routes/admin-schedule');

function conn({ price = 129, invoices = [], hold = null, cardLane = null } = {}) {
  return (table) => {
    const chain = {
      where() { return chain; }, whereNotIn() { return chain; },
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

  test('an approved appointment-card charge blocks a re-price', async () => {
    await expect(assertRepriceAllowed(conn({ cardLane: { id: 'a1' } }), 's1', 80))
      .rejects.toMatchObject({ statusCode: 409, code: 'REPRICE_BLOCKED_CARD_APPROVAL' });
  });

  test('nothing committed: a re-price (including to $0) passes', async () => {
    await expect(assertRepriceAllowed(conn(), 's1', 0)).resolves.toBeUndefined();
  });
});

test('update-details and the "following visits" propagation both run the guard before writing a price', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const editWrite = src.indexOf("await trx('scheduled_services').where({ id: req.params.id }).update(updates);");
  expect(src.slice(editWrite - 700, editWrite)).toContain('assertRepriceAllowed(trx, req.params.id, updates.estimated_price)');
  const siblingWrite = src.indexOf("await conn('scheduled_services').where({ id: sibling.id }).update(siblingUpdates);");
  expect(src.slice(siblingWrite - 300, siblingWrite)).toContain('assertRepriceAllowed(conn, sibling.id, siblingUpdates.estimated_price)');
});
