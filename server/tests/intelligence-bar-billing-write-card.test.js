/**
 * The cards for remove_saved_payment_method and correct_invoice_address show
 * names, methods, addresses and ordered steps — never raw ids (the card hides
 * raw params once a contract exists).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const CUST = '00000000-0000-0000-0000-00000000a001';
const PM = '00000000-0000-0000-0000-00000000b001';
const INV = '00000000-0000-0000-0000-00000000c001';

const removal = {
  preview: true, customer_id: CUST, customer_name: 'Card Fixture',
  method: { id: PM, label: 'Visa ending 4242' },
  autopay: { state: 'on', uses_this_method: true, method_ids: [PM] },
  steps: [
    { position: 1, step: 'turn_off_autopay', kind: 'billing', effect: 'Step 1 of 2: Turn Auto Pay OFF for the whole account' },
    { position: 2, step: 'remove_payment_method', kind: 'billing', effect: 'Step 2 of 2: Remove Visa ending 4242' },
  ],
  disclosures: { bank_note: null, holds_appointment: null, hold_lookup_failed: false },
  customer_emails: { summary: 'Customer will be emailed (c***@example.com), through the portal\'s own notices: "Auto Pay turned off", then "Payment method removed"' },
  notifies_customer: true,
};
const address = {
  preview: true, invoice_id: INV, invoice_number: 'WPC-2099-0001', invoice_status: 'paid', customer_name: 'Card Fixture',
  printed_now_text: '1 Old Street Sarasota, FL 34201', after_correction_text: '9 New Street Bradenton, FL 34203',
  does: "Rewrites only this invoice's address snapshot.", does_not: 'Nothing is re-sent.',
};

test('the removal card names the customer, the method and Auto Pay — no ids', () => {
  const shown = confirmationDisplayParams('remove_saved_payment_method', { customer_id: CUST, payment_method_id: PM, turn_off_autopay: true }, removal);
  expect(shown).toEqual({ customer: 'Card Fixture', method: 'Visa ending 4242', auto_pay: 'on, using this method' });
  const contract = buildContract({ toolName: 'remove_saved_payment_method', params: {}, displayParams: shown, preview: removal, summary: 's' });
  const text = JSON.stringify(contract.effects);
  expect(text).not.toContain(CUST);
  expect(text).not.toContain(PM);
});

test('the address card shows the invoice, customer, and the before and after text', () => {
  const shown = confirmationDisplayParams('correct_invoice_address', { invoice_id: INV, address_line1: '9 New Street' }, address);
  expect(shown).toEqual({
    invoice: 'WPC-2099-0001 (paid)', customer: 'Card Fixture',
    printed_now: '1 Old Street Sarasota, FL 34201', corrected_to: '9 New Street Bradenton, FL 34203',
  });
  const contract = buildContract({ toolName: 'correct_invoice_address', params: {}, displayParams: shown, preview: address, summary: 's' });
  expect(JSON.stringify(contract.effects)).not.toContain(INV);
  expect(contract.effects).toContainEqual(expect.objectContaining({ label: expect.stringContaining('9 New Street Bradenton') }));
});

test('a refusal or ask (no preview) falls back to the raw params — it never reaches a card anyway', () => {
  expect(confirmationDisplayParams('remove_saved_payment_method', { customer_id: CUST }, { error: 'x' })).toEqual({ customer_id: CUST });
});
