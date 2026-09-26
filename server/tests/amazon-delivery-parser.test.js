/**
 * purchase-receipts/amazon-delivery-parser.js — pure parsing of Amazon
 * "Delivered" order-confirmation emails into { orderNumber, shipmentId,
 * shipmentKey, items }. (No sibling Ordered:/Shipped: lookup any more —
 * removed; see the module header and sweep.js for why.)
 */
const { parseAmazonDeliveredEmail, parseAmazonShippedEmail, isAmazonDeliveredEmail } = require('../services/purchase-receipts/amazon-delivery-parser');

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

describe('parseAmazonDeliveredEmail — item blocks', () => {
  test('real template: title line, then quantity ALONE on the next line (Talak fixture, qty 4)', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: 4 "Atticus Talak 7.9 F..."',
      body_text: 'Order #\n900-2000002-2000002\n\n'
        + '* Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96 oz) – Indoor and Outdoor Insect Control\n'
        + '  Quantity: 4\n\n'
        + 'Track your package: https://www.amazon.com/gp/your-account/order-details?orderId=900-3000003-3000003\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    // The Order # LINE wins even though the Track URL's orderId is a different number.
    expect(parsed.orderNumber).toBe('900-2000002-2000002');
    expect(parsed.items).toEqual([{ title: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96 oz) – Indoor and Outdoor Insect Control', quantity: 4 }]);
  });

  test('real template: two items separated by blank lines, both single-line quantity blocks', () => {
    const email = {
      from_address: 'order-update@amazon.com',
      subject: 'Delivered: "JoyTube..." and 1 more item',
      body_text: 'Order # 900-4000004-4000004\n\n'
        + '* JoyTube Plastic Hose Barb Fittings Assortment Kit (pack of 6)\n'
        + '  Quantity: 1\n\n\n'
        + '* Southern Ag Thuricide BT Caterpillar Control, 16oz - Pint\n'
        + '  Quantity: 1\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.orderNumber).toBe('900-4000004-4000004');
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
      body_text: 'Order # 900-1000001-1000001\n\n'
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
      body_html: '<html><body><p>Your package was delivered.</p><p>Order # 900-1000001-1000001</p>'
        + '<ul><li>* Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz) Quantity: 2</li></ul></body></html>',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.orderNumber).toBe('900-1000001-1000001');
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

  // An unreadable Delivered email still yields a result, so the caller holds
  // a line for review instead of the delivery vanishing.
  test.each([
    ['no text at all', { body_text: '', body_html: '' }],
    ['no order number and no items', { body_text: 'No order number and no bullet lines here.' }],
  ])('a Delivered email with %s still returns an object (orderNumber null, items [])', (_label, body) => {
    const parsed = parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: your order', gmail_id: 'gm-1', ...body });
    expect(parsed).toEqual({ orderNumber: null, shipmentId: null, shipmentKey: 'gm-1', items: [] });
  });

  test('items with no readable Order # keep their items; orderNumber is null', () => {
    const parsed = parseAmazonDeliveredEmail({ from_address: 'order-update@amazon.com', subject: 'Delivered: 1 item', gmail_id: 'gm-2', body_text: '* Taurus SC 78 oz\n  Quantity: 1\n' });
    expect(parsed).toMatchObject({ orderNumber: null, shipmentKey: 'gm-2', items: [{ title: 'Taurus SC 78 oz', quantity: 1 }] });
  });
});

describe('parseAmazonDeliveredEmail — Order # and shipmentId extraction', () => {
  test('Order # on the SAME line', () => {
    const email = { from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: 'Order # 900-1000001-1000001\n\n* Thing\n  Quantity: 1\n' };
    expect(parseAmazonDeliveredEmail(email).orderNumber).toBe('900-1000001-1000001');
  });

  test('Order # alone on its own line, the number on the line right after', () => {
    const email = { from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: 'Order #\n900-2000002-2000002\n\n* Thing\n  Quantity: 1\n' };
    expect(parseAmazonDeliveredEmail(email).orderNumber).toBe('900-2000002-2000002');
  });

  test('the Track package URL orderId, when it differs, is NEVER used as the order number', () => {
    const email = {
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order',
      body_text: 'Order # 900-2000002-2000002\n\n* Thing\n  Quantity: 1\n\n'
        + 'Track package: https://www.amazon.com/gp/css/order-details?orderId=900-3000003-3000003&shipmentId=Ab12Cd34\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.orderNumber).toBe('900-2000002-2000002');
    expect(parsed.orderNumber).not.toBe('900-3000003-3000003');
  });

  test('shipmentId is pulled from the Track package URL and used as shipmentKey', () => {
    const email = {
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order',
      body_text: 'Order # 900-4000004-4000004\n\n* Thing\n  Quantity: 1\n\n'
        + 'Track package: https://www.amazon.com/gp/css/order-details?orderId=900-4000004-4000004&shipmentId=SHIPTEST01\n',
    };
    const parsed = parseAmazonDeliveredEmail(email);
    expect(parsed.shipmentId).toBe('SHIPTEST01');
    expect(parsed.shipmentKey).toBe('SHIPTEST01');
  });

  test('an HTML-only email reads shipmentId from the raw link (hrefs are gone after stripping), in both encodings', () => {
    const html = (href) => ({
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order', body_text: '', gmail_id: 'gm-html',
      body_html: `<p>Order # 900-4000004-4000004</p><ul><li>* Thing Quantity: 1</li></ul><a href="${href}">Track package</a>`,
    });
    // Amazon's redirect link, URL-encoded — the form real deliveries carry.
    const encoded = parseAmazonDeliveredEmail(html('https://www.amazon.com/gp/r.html?C=X&amp;U=https%3A%2F%2Fwww.amazon.com%2Fprogress-tracker%2Fpackage%3FitemIndex%3D0%26shipmentId%3DSHIPTEST01%26x%3D1'));
    const plain = parseAmazonDeliveredEmail(html('https://www.amazon.com/gp/css/order-details?orderId=900-4000004-4000004&amp;shipmentId=SHIPTEST01'));
    expect(encoded.shipmentKey).toBe('SHIPTEST01');
    expect(plain.shipmentKey).toBe('SHIPTEST01');
  });

  test('the same shipment gets the same key whether its email arrives with body_text or HTML only', () => {
    const withText = parseAmazonDeliveredEmail({
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order', gmail_id: 'gm-a',
      body_text: 'Order # 900-4000004-4000004\n\n* Thing\n  Quantity: 1\n\nTrack package: https://www.amazon.com/x?orderId=900-4000004-4000004&shipmentId=SHIPTEST01\n',
    });
    const htmlOnly = parseAmazonDeliveredEmail({
      from_address: 'order-update@amazon.com', subject: 'Delivered: your order', gmail_id: 'gm-b', body_text: '',
      body_html: '<p>Order # 900-4000004-4000004</p><li>* Thing Quantity: 1</li><a href="https://www.amazon.com/gp/r.html?U=x%3FitemIndex%3D0%26shipmentId%3DSHIPTEST01">Track</a>',
    });
    expect(htmlOnly.shipmentKey).toBe(withText.shipmentKey);
  });

  test('two Delivered emails for the SAME order but different shipmentId get different shipmentKeys (split shipment)', () => {
    const base = 'Order # 900-4000004-4000004\n\n* Thing\n  Quantity: 1\n\nTrack package: https://www.amazon.com/x?orderId=900-4000004-4000004&shipmentId=';
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

describe('parseAmazonShippedEmail', () => {
  // The real "Shipped:" template: same Order #, item blocks and Track-link
  // shipmentId as the Delivered email for that shipment.
  const shipped = {
    from_address: 'shipment-tracking@amazon.com', subject: 'Shipped: "ZOECON 10578 Gentrol..."', gmail_id: 'gm-s',
    body_text: 'Arriving today 10 AM – 3 PM\nOrder #\n900-9000009-9000009\nTrack package: https://www.amazon.com/x?orderId=900-9000009-9000009&shipmentId=SHIPTEST02\n\n'
      + '* ZOECON 10578 Gentrol Complete EC3 Insecticide and Growth Regulator, Orange\n  Quantity: 1\n',
  };

  test('reads a shipment-tracking@amazon.com "Shipped:" email the same way as a Delivered one', () => {
    expect(parseAmazonShippedEmail(shipped)).toEqual({
      orderNumber: '900-9000009-9000009', shipmentId: 'SHIPTEST02', shipmentKey: 'SHIPTEST02',
      items: [{ title: 'ZOECON 10578 Gentrol Complete EC3 Insecticide and Growth Regulator, Orange', quantity: 1 }],
    });
  });

  test.each([
    ['a Delivered email', { from_address: 'order-update@amazon.com', subject: 'Delivered: "ZOECON..."' }],
    ['another sender', { from_address: 'order-update@amazon.com' }],
    ['another subject', { subject: 'Out for delivery: "ZOECON..."' }],
  ])('null for %s', (_label, overrides) => {
    expect(parseAmazonShippedEmail({ ...shipped, ...overrides })).toBeNull();
  });
});
