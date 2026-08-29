// payment_method.detached — a Stripe-dashboard removal gets the same
// customer lifecycle notice as a portal removal (owner ruling 2026-08-27),
// AFTER the reconciliation transaction commits, with autopayDisabled
// derived from whether the cleanup actually turned Auto Pay off. Source-
// pattern test (same style as estimate-card-holds' detached checks — the
// webhook module is not unit-mountable).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/stripe-webhook.js'), 'utf8');
const handlerStart = src.indexOf('async function handlePaymentMethodDetached');
const handlerEnd = src.indexOf('async function handleSetupIntentSucceeded');
const handler = src.slice(handlerStart, handlerEnd);

test('removed rows are captured with the label fields the email needs', () => {
  expect(handler).toMatch(/'method_type', 'card_brand', 'last_four', 'bank_name', 'bank_last_four'/);
  expect(handler).toMatch(/removedRows\.push\(\.\.\.rows\)/);
});

test('in-charge identity comes from getAutopaySelectedMethodIds, resolved under CUSTOMER-then-rows locks and BEFORE the delete (pre-push r1 P1, r2 P0/P1)', () => {
  const customerLockAt = handler.indexOf("await trx('customers').where({ id: customerId }).forUpdate().first('id')");
  const rowsLockAt = handler.indexOf(".forUpdate()\n      .select('id', 'customer_id'");
  const resolveAt = handler.indexOf('getAutopaySelectedMethodIds({ id: customerId }, trx, { rethrow: true })');
  const deleteAt = handler.indexOf(".del();");
  expect(customerLockAt).toBeGreaterThan(-1);
  expect(rowsLockAt).toBeGreaterThan(customerLockAt);
  expect(resolveAt).toBeGreaterThan(rowsLockAt);
  expect(resolveAt).toBeLessThan(deleteAt);
  expect(handler).toMatch(/if \(!inChargeRowIds\.has\(String\(row\.id\)\)\) continue;/);
  // The old pointer-only predicate is gone.
  expect(handler).not.toMatch(/wasInCharge/);
});

test('the notice fires AFTER the transaction, once per removed row, with autopayDisabled from the cleanup set', () => {
  const trxEnd = handler.indexOf('});\n\n  for (const row of disabledCustomers)');
  const sendAt = handler.indexOf('sendPaymentMethodRemoved(');
  expect(trxEnd).toBeGreaterThan(-1);
  expect(sendAt).toBeGreaterThan(trxEnd);
  expect(handler).toMatch(/for \(const row of removedRows\)/);
  expect(handler).toMatch(/const autopayDisabled = disabledCustomers\.some\(\(d\) => d\.id === row\.id\)/);
  expect(handler).toMatch(/autopayDisabled,\s*removedAt: new Date\(\)/);
  // Fire-and-forget: a mail failure can never fail the webhook ack.
  expect(handler).toMatch(/\.catch\(\(emailErr\) => \{/);
});
