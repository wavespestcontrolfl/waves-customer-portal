/**
 * purchase-receipts/amazon-delivery-parser.js — pure parsing of Amazon
 * "Delivered" order-confirmation emails into { orderNumber, shipmentId,
 * shipmentKey, items }, plus the sibling Ordered:/Shipped: item lookup used
 * for the itemless "N Lawn & Garden item(s)" template.
 */
const {
  parseAmazonDeliveredEmail, parseAmazonOrderSiblingItems,
  isAmazonDeliveredEmail, isAmazonOrderSiblingEmail,
} = require('../services/purchase-receipts/amazon-delivery-parser');

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

describe('isAmazonOrderSiblingEmail', () => {
  test('true for auto-confirm@amazon.com (Ordered:) and shipment-tracking@amazon.com (Shipped:)', () => {
    expect(isAmazonOrderSiblingEmail({ from_address: 'auto-confirm@amazon.com' })).toBe(true);
    expect(isAmazonOrderSiblingEmail({ from_address: 'Shipment-Tracking@Amazon.com' })).toBe(true);
  });
  test('false for order-update@amazon.com (that is the Delivered sender, not a sibling)', () => {
    expect(isAmazonOrderSiblingEmail({ from_address: 'order-update@amazon.com' })).toBe(false);
  });
});

describe('parseAmazonDeliveredEmail — item blocks', () => {
  test('real template: title line, then quantity ALONE on the next line (Talak fixture, qty 4)', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: 4 "Atticus Talak 7.9 F..."',
      body_text: 'Order #\n114-9791349-7329852\n\n'
        + '* Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96 oz) – Indoor and Outdoor Insect Control\n'
        + '  Quantity: 4\n\n'
        + 'Track your package: https://www.amazon.com/gp/your-account/order-details?orderId=111-4379234-9209869\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    // The Order # LINE wins even though the Track URL's orderId is a different number.
    expect(parsed.orderNumber).toBe('114-9791349-7329852');
    expect(parsed.items).toEqual([{ title: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96 oz) – Indoor and Outdoor Insect Control', quantity: 4 }]);
  });

  test('real template: two items separated by blank lines, both single-line quantity blocks', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: "JoyTube..." and 1 more item',
      body_text: 'Order # 113-3148685-4885834\n\n'
        + '* JoyTube Plastic Hose Barb Fittings Assortment Kit (pack of 6)\n'
        + '  Quantity: 1\n\n\n'
        + '* Southern Ag Thuricide BT Caterpillar Control, 16oz - Pint\n'
        + '  Quantity: 1\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.orderNumber).toBe('113-3148685-4885834');
    expect(parsed.items).toEqual([
      { title: 'JoyTube Plastic Hose Barb Fittings Assortment Kit (pack of 6)', quantity: 1 },
      { title: 'Southern Ag Thuricide BT Caterpillar Control, 16oz - Pint', quantity: 1 },
    ]);
  });

  test('quantities differing per item are each read correctly (4 then 3)', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: "Product A..." and 1 more item',
      body_text: 'Order # 200-0000000-0000000\n\n'
        + '* Product A\n  Quantity: 4\n\n'
        + '* Product B\n  Quantity: 3\n',
    };
    expect(parseAmazonDeliveredEmail(email).items).toEqual([
      { title: 'Product A', quantity: 4 },
      { title: 'Product B', quantity: 3 },
    ]);
  });

  test('defensive: an inline "Quantity: N" trailing the title on the SAME line still works', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: 2 "Atticus Talak 7.9 F..."',
      body_text: 'Order # 114-9578837-7732259\n\n'
        + '* Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz) Quantity: 2\n',
    };
    expect(parseAmazonDeliveredEmail(email).items).toEqual([{ title: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)', quantity: 2 }]);
  });

  test('non-chemical personal item parses like any other line item (matching happens downstream, not here)', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: "Lenovo Chromebook Duet 11" ..."',
      body_text: 'Order # 111-0000000-0000000\n\n* Lenovo Chromebook Duet 11 inch\n  Quantity: 1\n',
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
    expect(parsed.orderNumber).toBe('114-9578837-7732259');
    expect(parsed.items).toEqual([{ title: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)', quantity: 2 }]);
  });

  test('a bad Quantity line (non-numeric or zero) falls back to quantity 1 rather than throwing', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: your order',
      body_text: 'Order # 100-0000000-0000000\n\n* Some Product\n  Quantity: 0\n',
    };
    expect(parseAmazonDeliveredEmail(email).items).toEqual([{ title: 'Some Product', quantity: 1 }]);
  });

  test('returns null for a non-Amazon-delivered email', () => {
    expect(parseAmazonDeliveredEmail({ from_address: 'someone@example.com', subject: 'Delivered: your order', body_text: '* Thing\n  Quantity: 1' })).toBeNull();
  });

  test('returns null when there is no text at all to parse', () => {
    expect(parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: '', body_html: '' })).toBeNull();
  });

  test('returns null when there is no order number AND no items (nothing usable at all)', () => {
    const email = { from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: 'No order number and no bullet lines here.' };
    expect(parseAmazonDeliveredEmail(email)).toBeNull();
  });
});

describe('parseAmazonDeliveredEmail — Order # and shipmentId extraction', () => {
  test('Order # on the SAME line', () => {
    const email = { from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: 'Order # 114-9578837-7732259\n\n* Thing\n  Quantity: 1\n' };
    expect(parseAmazonDeliveredEmail(email).orderNumber).toBe('114-9578837-7732259');
  });

  test('Order # alone on its own line, the number on the line right after', () => {
    const email = { from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: 'Order #\n114-9791349-7329852\n\n* Thing\n  Quantity: 1\n' };
    expect(parseAmazonDeliveredEmail(email).orderNumber).toBe('114-9791349-7329852');
  });

  test('the Track package URL orderId, when it differs, is NEVER used as the order number', () => {
    const email = {
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order',
      body_text: 'Order # 114-9791349-7329852\n\n* Thing\n  Quantity: 1\n\n'
        + 'Track package: https://www.amazon.com/gp/css/order-details?orderId=111-4379234-9209869&shipmentId=Ab12Cd34\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.orderNumber).toBe('114-9791349-7329852');
    expect(parsed.orderNumber).not.toBe('111-4379234-9209869');
  });

  test('shipmentId is pulled from the Track package URL and used as shipmentKey', () => {
    const email = {
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order',
      body_text: 'Order # 113-3148685-4885834\n\n* Thing\n  Quantity: 1\n\n'
        + 'Track package: https://www.amazon.com/gp/css/order-details?orderId=113-3148685-4885834&shipmentId=owFYr7fBJ\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.shipmentId).toBe('owFYr7fBJ');
    expect(parsed.shipmentKey).toBe('owFYr7fBJ');
  });

  test('two Delivered emails for the SAME order but different shipmentId get different shipmentKeys (split shipment)', () => {
    const base = 'Order # 113-3148685-4885834\n\n* Thing\n  Quantity: 1\n\nTrack package: https://www.amazon.com/x?orderId=113-3148685-4885834&shipmentId=';
    const first = parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: `${base}SHIP-ONE\n` });
    const second = parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: `${base}SHIP-TWO\n` });
    expect(first.orderNumber).toBe(second.orderNumber);
    expect(first.shipmentKey).not.toBe(second.shipmentKey);
  });

  test('no shipmentId anywhere falls back to the email\'s gmail_id, then id', () => {
    const text = 'Order # 100-0000000-0000000\n\n* Thing\n  Quantity: 1\n';
    expect(parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered:', body_text: text, gmail_id: 'gm-1', id: 'row-1' }).shipmentKey).toBe('gm-1');
    expect(parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered:', body_text: text, id: 'row-1' }).shipmentKey).toBe('row-1');
    expect(parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered:', body_text: text }).shipmentKey).toBeNull();
  });
});

describe('parseAmazonDeliveredEmail — itemless "N Lawn & Garden item(s)" template', () => {
  test('an Order # with zero item blocks returns an object (not null), items: []', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: 1 Lawn & Garden item',
      body_text: 'Order # 100-0000000-0000000\n\nTrack your package: https://www.amazon.com/x?orderId=100-0000000-0000000\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed).not.toBeNull();
    expect(parsed.orderNumber).toBe('100-0000000-0000000');
    expect(parsed.items).toEqual([]);
  });

  test('"2 Lawn & Garden items" subject variant is still a Delivered email', () => {
    expect(isAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: 2 Lawn & Garden items' })).toBe(true);
  });
});

describe('parseAmazonOrderSiblingItems', () => {
  const orderNumber = '100-0000000-0000000';
  const orderedEmail = {
    from_address: 'auto-confirm@amazon.com', subject: 'Ordered: "Bora-Care..."',
    body_text: `Order # ${orderNumber}\n\n* Bora-Care Termiticide/Insecticide, 1 Gallon\n  Quantity: 1\n`,
  };

  test('reads item blocks off a matching Ordered: sibling', () => {
    expect(parseAmazonOrderSiblingItems(orderedEmail, orderNumber)).toEqual([{ title: 'Bora-Care Termiticide/Insecticide, 1 Gallon', quantity: 1 }]);
  });

  test('reads item blocks off a matching Shipped: sibling', () => {
    const shippedEmail = { ...orderedEmail, from_address: 'shipment-tracking@amazon.com', subject: 'Shipped: "Bora-Care..."' };
    expect(parseAmazonOrderSiblingItems(shippedEmail, orderNumber)).toEqual([{ title: 'Bora-Care Termiticide/Insecticide, 1 Gallon', quantity: 1 }]);
  });

  test('never reads from the Delivered sender itself (that is not a sibling)', () => {
    const deliveredEmail = { ...orderedEmail, from_address: 'order-update@amazon.com' };
    expect(parseAmazonOrderSiblingItems(deliveredEmail, orderNumber)).toEqual([]);
  });

  test('rejects a sibling whose OWN Order # does not match the expected one (no coincidental substring trust)', () => {
    expect(parseAmazonOrderSiblingItems(orderedEmail, '999-9999999-9999999')).toEqual([]);
  });

  test('an unparseable sibling (no item blocks) gives up (empty array, never throws)', () => {
    const empty = { ...orderedEmail, body_text: `Order # ${orderNumber}\n\nNothing to parse here.\n` };
    expect(parseAmazonOrderSiblingItems(empty, orderNumber)).toEqual([]);
  });
});
