/**
 * purchase-receipts/amazon-delivery-parser.js — pure parsing of Amazon
 * "Delivered" order-confirmation emails into { orderNumber, items }.
 */
const { parseAmazonDeliveredEmail, isAmazonDeliveredEmail } = require('../services/purchase-receipts/amazon-delivery-parser');

describe('isAmazonDeliveredEmail', () => {
  test('true only for order-update@amazon.com with a Delivered: subject', () => {
    expect(isAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: 2 "Atticus Talak 7.9 F..."' })).toBe(true);
    expect(isAmazonDeliveredEmail({ from_address: 'Order-Update@Amazon.com', subject: 'delivered: your stuff' })).toBe(true); // case-insensitive both sides
  });
  test('false for a different sender', () => {
    expect(isAmazonDeliveredEmail({ from_address: 'shipment-tracking@amazon.com', subject: 'Delivered: your order' })).toBe(false);
  });
  test('false for a non-Delivered subject from the same sender (e.g. "Shipped:", "Out for delivery")', () => {
    expect(isAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Shipped: your order' })).toBe(false);
    expect(isAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Out for delivery: your order' })).toBe(false);
  });
});

describe('parseAmazonDeliveredEmail', () => {
  test('single item with an explicit Quantity line (Taurus SC / Talak fixture)', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: 2 "Atticus Talak 7.9 F..."',
      body_text: 'Your package was delivered.\n\nOrder # 114-9578837-7732259\n\n'
        + '* Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz) Quantity: 2\n\n'
        + 'Thank you for shopping with us.',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed).toEqual({
      orderNumber: '114-9578837-7732259',
      items: [{ title: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)', quantity: 2 }],
    });
  });

  test('multi-item delivery: a qty-1 item with no Quantity line, and a qty-3 item with one', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: "Southern Ag Thuricide BT..." and 1 more item',
      body_text: 'Order # 112-1234567-1234567\n\n'
        + '* Southern Ag Thuricide BT Concentrate 32oz\n'
        + '* Control Solutions Taurus SC Termiticide 78 oz Quantity: 3\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.orderNumber).toBe('112-1234567-1234567');
    expect(parsed.items).toEqual([
      { title: 'Southern Ag Thuricide BT Concentrate 32oz', quantity: 1 },
      { title: 'Control Solutions Taurus SC Termiticide 78 oz', quantity: 3 },
    ]);
  });

  test('non-chemical personal item parses like any other line item (matching happens downstream, not here)', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: "Lenovo Chromebook Duet 11" ..."',
      body_text: 'Order # 111-0000000-0000000\n\n* Lenovo Chromebook Duet 11 inch Quantity: 1\n',
    };
    expect(parseAmazonDeliveredEmail(email).items).toEqual([{ title: 'Lenovo Chromebook Duet 11 inch', quantity: 1 }]);
  });

  test('falls back to a stripped body_html when body_text is empty', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: 2 "Atticus Talak 7.9 F..."',
      body_text: '',
      body_html: '<html><body><p>Your package was delivered.</p><p>Order # 114-9578837-7732259</p>'
        + '<ul><li>* Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz) Quantity: 2</li></ul></body></html>',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed).toEqual({
      orderNumber: '114-9578837-7732259',
      items: [{ title: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)', quantity: 2 }],
    });
  });

  test('a bad Quantity line (non-numeric or zero) falls back to quantity 1 rather than throwing', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: your order',
      body_text: 'Order # 100-0000000-0000000\n\n* Some Product Quantity: 0\n',
    };
    expect(parseAmazonDeliveredEmail(email).items).toEqual([{ title: 'Some Product', quantity: 1 }]);
  });

  test('returns null for a non-Amazon-delivered email', () => {
    expect(parseAmazonDeliveredEmail({ from_address: 'someone@example.com', subject: 'Delivered: your order', body_text: '* Thing Quantity: 1' })).toBeNull();
  });

  test('returns null when no item lines are found at all', () => {
    const email = { from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: 'Order # 100-0000000-0000000\n\nNo bullet lines here.' };
    expect(parseAmazonDeliveredEmail(email)).toBeNull();
  });

  test('returns null when there is no text at all to parse', () => {
    expect(parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: '', body_html: '' })).toBeNull();
  });
});
