/**
 * siteone-deals-digest — weekly SiteOne deals bell.
 * Fakes only: no network, no database, no model. The alert spec goes through the
 * real composeAdminAlert rules (headline 60, why 110 / one sentence, forbidden
 * tokens), so copy that breaks docs/admin-notifications.md fails here. All
 * names and addresses are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const {
  runSiteOneDealsDigest, isDealEmail, extractDeadline, matchProducts, isDealSenderDomain,
} = require('../services/procurement/siteone-deals-digest');

const email = (over = {}) => ({
  id: 1,
  from_address: 'srep@siteone.com',
  from_name: 'Sam Rep',
  subject: 'Pest Specials',
  body_text: '',
  body_html: null,
  has_attachments: false,
  received_at: new Date('2026-10-28T14:00:00Z'),
  classification: null,
  ...over,
});

describe('isDealEmail', () => {
  test.each([
    ['FW: BASF Promo with attachment', { subject: 'FW: BASF Promo', has_attachments: true, body_text: 'Please see attached. Last week for it!' }],
    ['Pest Specials with attachment', { subject: 'Pest Specials', has_attachments: true }],
    ['Controller trade in and Agronomic EOP', { subject: 'Controller trade in and Agronomic EOP' }],
    ['Price increase with attachment', { subject: 'Price increase', has_attachments: true, body_text: 'See the Early Order Program with cash discounts.' }],
    ['price-match reply with attachment', { subject: 'RE: Price-match request: 3 items (up to 16% per unit)', has_attachments: true }],
    ['maker domain subdomain', { from_address: 'news@mail.basf.com', subject: 'Fall rebate is open' }],
  ])('deal: %s', (_label, over) => {
    expect(isDealEmail(email(over))).toBe(true);
  });

  test.each([
    ['invoice mail', { subject: 'Acct No. 1234567: Your Invoice From SiteOne Landscape Supply, LLC is Attached', classification: 'vendor_invoice', has_attachments: true }],
    ['invoice confirmation', { subject: 'SiteOne Confirmation : Invoice #1234-001' }],
    ['order submitted', { subject: 'Your order has been submitted.', body_text: 'Thanks for the order. Savings applied.' }],
    ['shopping cart', { subject: 'Your SiteOne shopping cart is ready to go.' }],
    ['eWallet', { subject: 'Important: A credit card has been deleted from your eWallet.' }],
    ['automatic reply', { subject: 'Automatic reply: SDS request' }],
    ['order is ready', { subject: 'Order 55555 is ready for pickup', body_text: 'promo special' }],
    ['deal words from an unlisted domain', { from_address: 'sales@example.com', subject: 'Big promo and rebate sale' }],
    ['lookalike domain', { from_address: 'srep@siteone.com.evil.example', subject: 'Pest Specials' }],
    ['lookalike prefix', { from_address: 'srep@notsiteone.com', subject: 'Pest Specials' }],
    ['no deal word', { subject: 'Meeting next week', body_text: 'Lunch?' }],
    ['one body word and no attachment', { subject: 'Hello', body_text: 'Ask about our promo.' }],
  ])('not a deal: %s', (_label, over) => {
    expect(isDealEmail(email(over))).toBe(false);
  });

  test('a body deal word counts with an attachment, or when two different ones appear', () => {
    expect(isDealEmail(email({ subject: 'Hello', body_text: 'Ask about our rebate.', has_attachments: true }))).toBe(true);
    expect(isDealEmail(email({ subject: 'Hello', body_text: 'A rebate and a flyer are inside.' }))).toBe(true);
    // The same word twice is one word.
    expect(isDealEmail(email({ subject: 'Hello', body_text: 'Rebate here, rebates there.' }))).toBe(false);
    // "cash discount" is one idea, not two.
    expect(isDealEmail(email({ subject: 'Hello', body_text: 'A cash discount applies.' }))).toBe(false);
  });

  test('reads body_html when body_text is empty', () => {
    expect(isDealEmail(email({ subject: 'Hello', body_text: '', body_html: '<p>Early order <b>program</b></p><p>Rebate &amp; flyer</p>' }))).toBe(true);
  });

  test('sender must be the domain or a subdomain, case-insensitive, names and brackets allowed', () => {
    expect(isDealSenderDomain('Sam Rep <SREP@EC.SiteOne.com>')).toBe(true);
    expect(isDealSenderDomain('a@lesco.com')).toBe(true);
    expect(isDealSenderDomain('a@siteone.com.evil.example')).toBe(false);
    expect(isDealSenderDomain('a@evilsiteone.com')).toBe(false);
    expect(isDealSenderDomain('siteone.com')).toBe(false);
    expect(isDealSenderDomain('')).toBe(false);
  });
});

describe('extractDeadline', () => {
  const received = new Date('2026-10-28T14:00:00Z');

  test('month name and day, long, short, ordinal, "by"', () => {
    expect(extractDeadline('Order by November 20th to qualify.', received)).toBe('2026-11-20');
    expect(extractDeadline('Ends Nov 20', received)).toBe('2026-11-20');
    expect(extractDeadline('Lock it in by Dec 31.', received)).toBe('2026-12-31');
    expect(extractDeadline('Sept. 3 is the cutoff', new Date('2026-08-30T14:00:00Z'))).toBe('2026-09-03');
  });

  test('numeric m/d, m/d/yy and m/d/yyyy', () => {
    expect(extractDeadline('Deadline 11/20', received)).toBe('2026-11-20');
    expect(extractDeadline('Deadline 11/20/26', received)).toBe('2026-11-20');
    expect(extractDeadline('Deadline 12/1/2026', received)).toBe('2026-12-01');
  });

  test('picks the earliest date on or after the received day', () => {
    expect(extractDeadline('Program runs Dec 15 - Jan 10, final orders Nov 20', received)).toBe('2026-11-20');
    expect(extractDeadline('Ends today, Oct 28, or later Nov 5', received)).toBe('2026-10-28');
    // A date before the received day is a year away, past the 180-day window.
    expect(extractDeadline('Started Oct 1', received)).toBeNull();
  });

  test('rolls the year when the date is before the received day', () => {
    const december = new Date('2026-12-20T15:00:00Z');
    expect(extractDeadline('Offer ends Jan 15', december)).toBe('2027-01-15');
    expect(extractDeadline('Offer ends 2/1', december)).toBe('2027-02-01');
  });

  test('ignores quoted reply history', () => {
    const forms = [
      'Thanks, ordering now.\n\nFrom: Sam Rep <srep@siteone.com>\nSent: Monday\nProgram ends Nov 20',
      'Thanks, ordering now.\n\n-----Original Message-----\nProgram ends Nov 20',
      'Thanks, ordering now.\n\nOn Mon, Oct 26, 2026 at 3:00 PM Sam Rep <srep@siteone.com> wrote:\n> Program ends Nov 20',
    ];
    for (const text of forms) expect(extractDeadline(text, received)).toBeNull();
    expect(extractDeadline('Ends Nov 20.\n\nFrom: Sam Rep\nOld note: Nov 2', received)).toBe('2026-11-20');
  });

  test('weekday-only phrases, far dates and fractions give null', () => {
    expect(extractDeadline('Ending Thursday, act fast', received)).toBeNull();
    expect(extractDeadline('Offer ends Apr 30', received)).toBeNull(); // 184 days out
    expect(extractDeadline('Offer ends Apr 25', received)).toBe('2027-04-25'); // 179 days out
    expect(extractDeadline('Mix 1/2 gal per acre', received)).toBeNull();
    expect(extractDeadline('Invalid date Feb 30', received)).toBeNull();
    expect(extractDeadline('', received)).toBeNull();
  });
});

describe('matchProducts', () => {
  const names = ['Taurus SC 1 gal', 'Demand CS', 'Celsius WG', 'Alpine WSG', 'Gel', 'Bifen I/T', 'Taurus SC 1 gal'];

  test('whole-word, case-insensitive, by full name or first two words', () => {
    expect(matchProducts('New promo on TAURUS sc and demand cs this fall', names)).toEqual(['Taurus SC 1 gal', 'Demand CS']);
    expect(matchProducts('Bifen I/T rebate', names)).toEqual(['Bifen I/T']);
  });

  test('no partial words, no short names, unique, none', () => {
    expect(matchProducts('Demand CSX and gelato; Celsius WGX', names)).toEqual([]);
    expect(matchProducts('gel gel gel', names)).toEqual([]);
    expect(matchProducts('Taurus SC, Taurus SC 1 gal', names)).toEqual(['Taurus SC 1 gal']);
    expect(matchProducts('', names)).toEqual([]);
    expect(matchProducts('Taurus SC', null)).toEqual([]);
  });

  test('at most six', () => {
    const many = ['Alpha One', 'Bravo Two', 'Charlie Three', 'Delta Four', 'Echo Five', 'Foxtrot Six', 'Golf Seven'];
    expect(matchProducts(many.join(' '), many)).toEqual(many.slice(0, 6));
  });
});

describe('runSiteOneDealsDigest', () => {
  const now = new Date('2026-11-02T13:00:00Z'); // Monday 8:00 AM ET

  function fakeDb({ emails, products = [{ name: 'Taurus SC 1 gal' }, { name: 'Demand CS' }], productsFail = false }) {
    const calls = { wheres: [], tables: [] };
    const db = (table) => {
      calls.tables.push(table);
      const preds = [];
      const chain = {
        select() { return chain; },
        where(a, b, c) {
          calls.wheres.push([table, a, b, c]);
          if (typeof a === 'object') preds.push((row) => Object.entries(a).every(([k, v]) => row[k] === v));
          else if (c !== undefined) preds.push((row) => (b === '>=' ? row[a] >= c : row[a] < c));
          return chain;
        },
        orderBy() { return chain; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (table === 'products_catalog') {
              if (productsFail) throw new Error('boom');
              return products;
            }
            return emails.filter((row) => preds.every((p) => p(row)));
          }).then(resolve, reject);
        },
      };
      return chain;
    };
    return { db, calls };
  }

  const weekEmails = () => [
    email({ id: 10, subject: 'Pest Specials', has_attachments: true, received_at: new Date('2026-10-29T15:00:00Z'), body_text: 'Taurus SC is on special through Nov 20.' }),
    email({ id: 11, from_name: '', from_address: 'news@ec.siteone.com', subject: 'Controller trade in and Agronomic EOP', received_at: new Date('2026-10-31T15:00:00Z'), body_text: 'Ends soon.' }),
    email({ id: 12, subject: 'Your SiteOne shopping cart is ready to go.', received_at: new Date('2026-10-30T15:00:00Z') }),
    email({ id: 13, from_address: 'sales@example.com', subject: 'Big promo sale', received_at: new Date('2026-10-30T16:00:00Z') }),
    email({ id: 14, subject: 'Old promo', received_at: new Date('2026-10-20T15:00:00Z') }), // outside the 7 days
    email({ id: 15, subject: 'Promo from the future', received_at: new Date('2026-11-02T14:00:00Z') }), // after now
  ];

  test('two deals -> one notify with the bell policy fields and one line per deal, newest first', async () => {
    const { db, calls } = fakeDb({ emails: weekEmails() });
    const notify = jest.fn().mockResolvedValue({ id: 99 });
    const result = await runSiteOneDealsDigest({ now, db, notify });

    expect(result).toEqual({ scanned: 4, deals: 2, notified: true });
    expect(notify).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = notify.mock.calls[0];
    expect(category).toBe('system');
    expect(spec).toMatchObject({
      area: 'Inventory', action: 'review 2 SiteOne deals this week', severity: 'needs-you', link: '/admin/communications#tab=email', who: 'person',
    });
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(composeAdminAlert(spec).headline).toBe('Inventory — review 2 SiteOne deals this week');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'siteone-deals:2026-11-02', refreshOnDedupe: true });
    expect(opts.detail.split('\n')).toEqual([
      'Oct 31 · news@ec.siteone.com · Controller trade in and Agronomic EOP · deadline not stated · your products: none named',
      'Oct 29 · Sam Rep · Pest Specials · deadline 2026-11-20 · your products: Taurus SC 1 gal',
    ]);
    expect(opts.metadata).toMatchObject({ dealCount: 2, emailIds: [11, 10] });
    // The query asks for the 7 days before now, and only active products.
    expect(calls.wheres).toContainEqual(['emails', 'received_at', '>=', new Date('2026-10-26T13:00:00Z')]);
    expect(calls.wheres).toContainEqual(['emails', 'received_at', '<', now]);
    expect(calls.wheres).toContainEqual(['products_catalog', { active: true }, undefined, undefined]);
  });

  test('the dedupe key is the Monday of the ET week, from any day in it', async () => {
    const { db } = fakeDb({ emails: [email({ id: 1, received_at: new Date('2026-11-04T10:00:00Z') })] });
    const notify = jest.fn().mockResolvedValue({ id: 1 });
    await runSiteOneDealsDigest({ now: new Date('2026-11-04T18:00:00Z'), db, notify }); // Wednesday
    expect(notify.mock.calls[0][2].dedupeKey).toBe('siteone-deals:2026-11-02');
    expect(notify.mock.calls[0][1].action).toBe('review 1 SiteOne deal this week');
  });

  test('zero deals -> no notify, one info line', async () => {
    const { db } = fakeDb({ emails: weekEmails().filter((e) => ![10, 11].includes(e.id)) });
    const notify = jest.fn();
    logger.info.mockClear();
    const result = await runSiteOneDealsDigest({ now, db, notify });
    expect(result).toEqual({ scanned: 2, deals: 0, notified: false });
    expect(notify).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test('a product-name read failure still sends the bell, with none named', async () => {
    const { db } = fakeDb({ emails: weekEmails(), productsFail: true });
    const notify = jest.fn().mockResolvedValue({ id: 1 });
    await runSiteOneDealsDigest({ now, db, notify });
    expect(notify.mock.calls[0][2].detail).toContain('your products: none named');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a bell that was not saved fails the run so job health goes red', async () => {
    const { db } = fakeDb({ emails: weekEmails() });
    await expect(runSiteOneDealsDigest({ now, db, notify: jest.fn().mockResolvedValue(null) })).rejects.toThrow(/not saved/);
  });
});
