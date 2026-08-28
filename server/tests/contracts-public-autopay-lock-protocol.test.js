// Contract signing is an Auto Pay ENROLLMENT writer, so it follows the
// shared lock protocol (#3556): customer row FOR UPDATE first, then the
// method row re-verified FOR UPDATE immediately before enabling — a portal
// removal holding customer + card across its Stripe detach can therefore
// never be followed by a signing that points Auto Pay at a deleted row.
// Source-pattern test (the route is token + transaction heavy).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/contracts-public.js'), 'utf8');
const signStart = src.indexOf("router.post('/:token/sign'");
const signEnd = src.indexOf('router.', signStart + 10) === -1 ? src.length : src.indexOf('\nrouter.', signStart + 10);
const sign = src.slice(signStart, signEnd);

test('the sign route exists and runs inside one transaction', () => {
  expect(signStart).toBeGreaterThan(-1);
  expect(sign).toMatch(/await db\.transaction\(async \(trx\) => \{/);
});

test('customer lock precedes the contract/method read; the method row is re-verified FOR UPDATE before the enable', () => {
  const customerLock = sign.indexOf("trx('customers').where({ id: contractPeek.customer_id }).forUpdate()");
  const contractRead = sign.indexOf("contractQuery(trx).where('cc.id', locked.id).first()");
  const methodLock = sign.indexOf(".where({ id: contract.payment_method_id, customer_id: contract.customer_id })\n          .forUpdate()");
  const enable = sign.indexOf("autopay_enabled: true,\n          autopay_payment_method_id: contract.payment_method_id");
  expect(customerLock).toBeGreaterThan(-1);
  expect(contractRead).toBeGreaterThan(customerLock);
  expect(methodLock).toBeGreaterThan(contractRead);
  expect(enable).toBeGreaterThan(methodLock);
});

test('a vanished method rolls the signing back with a 409 payment_method_removed', () => {
  expect(sign).toMatch(/if \(!methodLocked\) \{\s*throw Object\.assign\(new Error\('payment_method_removed'\)/);
  expect(sign).toMatch(/code: 'payment_method_removed'/);
  expect(sign).toMatch(/if \(err\?\.signResponse\) return res\.status\(err\.signResponse\.status\)\.json\(err\.signResponse\.body\)/);
});

// Admin cancellation writes customers.autopay_* too — same customer-first
// order (pre-push codex on #3556: contract-first cycled with the method
// FK's ON DELETE SET NULL during a portal removal).
test('admin cancel locks the customer row before the contract row', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../routes/admin-contracts.js'), 'utf8');
  const start = admin.indexOf("router.post('/:id/cancel'");
  const end = admin.indexOf('\nrouter.', start + 10);
  const cancel = admin.slice(start, end === -1 ? admin.length : end);
  const peek = cancel.indexOf(".first('id', 'customer_id')");
  const customerLock = cancel.indexOf("trx('customers').where({ id: peek.customer_id }).forUpdate().first('id')");
  const contractLock = cancel.indexOf(".forUpdate()\n        .first();");
  const customerWrite = cancel.indexOf("trx('customers').where({ id: contract.customer_id }).update({");
  expect(peek).toBeGreaterThan(-1);
  expect(customerLock).toBeGreaterThan(peek);
  expect(contractLock).toBeGreaterThan(customerLock);
  expect(customerWrite).toBeGreaterThan(contractLock);
  expect(cancel).toMatch(/String\(contract\.customer_id \|\| ''\) !== String\(peek\.customer_id \|\| ''\)/);
});
