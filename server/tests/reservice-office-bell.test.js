// The re-service office bell (step S3b, GATE_RESERVICE_ASKS, services/reservice-office-bell.js). The split of a frozen
// block into "office only" and "not today" is pure. The bell goes through the REAL raiseAdminAlert, which throws under
// test on any rule break in the headline, why, link, subject or done-when, so a passing raise proves the spec is valid.
// Only the final write (NotificationService.notifyAdmin) is stubbed. Synthetic names only.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));

const logger = require('../services/logger');
const { reserviceOfficeItems, raiseReserviceOfficeBell } = require('../services/reservice-office-bell');

const VISIT_ID = '00000000-0000-4000-8000-000000000801';
const RECORD_ID = '00000000-0000-4000-8000-000000000802';
const CUSTOMER = { id: '00000000-0000-4000-8000-000000000803', first_name: 'Dana', last_name: 'Q' };
// Nov 2, midday ET.
const AT = '2026-11-02T17:00:00.000Z';

const item = (id, over = {}) => ({ id, source: 'text', at: AT, text: 'Ants in the kitchen', quoted: true, lead: null, kind: 'pest', pests: [], printable: true, ...over });
const freezeOf = (items, answers = {}, officeNotes = {}) => ({ version: 1, gatheredAt: AT, lane: 'pest', items, answers, officeNotes });

describe('reserviceOfficeItems', () => {
  test('an office-only item is listed whatever its answer, even none or hidden', () => {
    const freeze = freezeOf(
      [item('a', { officeOnly: 'damage' }), item('b', { officeOnly: 'billing' }), item('c', { officeOnly: 'complaint' })],
      { b: { answer: 'hidden' }, c: { answer: 'not_today' } },
      { c: 'Customer upset' },
    );

    const { officeOnly, notToday } = reserviceOfficeItems(freeze);

    expect(officeOnly.map((e) => e.itemId)).toEqual(['a', 'b', 'c']);
    expect(officeOnly.map((e) => e.reason)).toEqual(['damage', 'billing', 'complaint']);
    // Office-only beats not-today: c is not listed twice.
    expect(notToday).toEqual([]);
  });

  test('a not-today item carries the tech\'s reason; other answers and unanswered items are left out', () => {
    const freeze = freezeOf(
      [item('a'), item('b', { source: 'call' }), item('c'), item('d'), item('e')],
      { a: { answer: 'not_today' }, b: { answer: 'not_today' }, c: { answer: 'treated', productIds: ['p1'] }, d: { answer: 'hidden' } },
      { a: 'Dog in the yard' },
    );

    const { officeOnly, notToday } = reserviceOfficeItems(freeze);

    expect(officeOnly).toEqual([]);
    expect(notToday).toEqual([
      { itemId: 'a', source: 'text', at: AT, words: 'Ants in the kitchen', reason: 'Dog in the yard' },
      { itemId: 'b', source: 'call', at: AT, words: 'Ants in the kitchen', reason: null },
    ]);
  });

  test.each([
    ['a version 2 block', { ...freezeOf([item('a', { officeOnly: 'damage' })]), version: 2 }],
    ['no freeze', null],
    ['a block with no items', { version: 1 }],
    ['a string', 'x'],
  ])('%s: nothing', (_name, freeze) => {
    expect(reserviceOfficeItems(freeze)).toEqual({ officeOnly: [], notToday: [] });
  });
});

describe('raiseReserviceOfficeBell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyAdmin.mockResolvedValue({ id: 'n1' });
  });
  const raise = (freeze, over = {}) => raiseReserviceOfficeBell({
    freeze, customer: CUSTOMER, scheduledServiceId: VISIT_ID, serviceRecordId: RECORD_ID, scheduledDate: '2026-11-02', ...over,
  });
  const sent = () => {
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockNotifyAdmin.mock.calls[0];
    return { category, headline, why, opts };
  };

  test('a not-today item: Schedule, quotes the words and the reason, one sentence inside 110 characters', async () => {
    await raise(freezeOf([item('a')], { a: { answer: 'not_today' } }, { a: 'Dog in the yard' }));

    const { category, headline, why, opts } = sent();
    expect(category).toBe('customer');
    expect(headline).toBe('Schedule — follow up on Dana Q\'s re-service');
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(why).toBe('Not done today: “Ants in the kitchen” — Dog in the yard');
    expect(why.length).toBeLessThanOrEqual(110);
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: `reservice-office:${VISIT_ID}`,
      link: `/admin/dispatch?tab=schedule&date=2026-11-02&appointment=${VISIT_ID}`,
      metadata: expect.objectContaining({
        area: 'Schedule', severity: 'needs-you', doneWhen: 'visit_checked', who: 'person',
        subject: { type: 'visit', id: VISIT_ID },
        customerId: CUSTOMER.id, scheduledServiceId: VISIT_ID, serviceRecordId: RECORD_ID, itemIds: ['a'],
      }),
    });
    expect(opts.detail).toBe('Not done today: a text on Nov 2 “Ants in the kitchen”. Tech\'s reason: Dog in the yard.');
  });

  test('a long quote and reason still fit the why, cut at a word', async () => {
    const words = 'The ants are all over the kitchen counters and the pantry shelves and the dog bowl every single morning';
    await raise(freezeOf([item('a', { text: words })], { a: { answer: 'not_today' } }, { a: 'Gate was locked and the dog was out in the yard all morning long' }));

    const { why } = sent();
    expect(why.length).toBeLessThanOrEqual(110);
    expect(why.startsWith('Not done today: “The ants are all')).toBe(true);
    expect(mockNotifyAdmin.mock.calls[0][3].detail).toContain(words);
  });

  test('an office-only message alone: Customers, names the channel, day and subject, says to read it in full', async () => {
    await raise(freezeOf([item('a', { source: 'call', officeOnly: 'damage', text: '' })]));

    const { headline, why, opts } = sent();
    expect(headline).toBe('Customers — read Dana Q\'s re-service message');
    expect(why).toBe('Their call on Nov 2 is about damage to their things; read it in full.');
    expect(opts.metadata.area).toBe('Customers');
    expect(opts.detail).toBe('Office only: a call on Nov 2 about damage to their things. Read the whole message; it is not on the report.');
    expect(opts.metadata.itemIds).toEqual(['a']);
  });

  test.each([
    ['billing', 'money (a charge or refund)'],
    ['complaint', 'a complaint'],
    ['schedule', 'the visit time'],
  ])('an office-only %s message says what it is about', async (reason, topic) => {
    await raise(freezeOf([item('a', { source: 'email', officeOnly: reason })]));

    expect(sent().why).toBe(`Their email on Nov 2 is about ${topic}; read it in full.`);
  });

  test('a hidden office-only item is still raised, and the pest part of it rides in the detail', async () => {
    await raise(freezeOf([item('a', { officeOnly: 'complaint', text: 'Ants again' })], { a: { answer: 'hidden' } }));

    const { opts } = sent();
    expect(opts.detail).toContain('The pest part: “Ants again”.');
  });

  test('several items: one bell, the why covers the first and counts the rest, the detail lists every item', async () => {
    await raise(freezeOf(
      [item('a', { officeOnly: 'billing', source: 'text' }), item('b', { text: 'Roaches in the garage', source: 'request_form' }), item('c', { text: 'Wasps by the door', source: 'call' })],
      { b: { answer: 'not_today' }, c: { answer: 'not_today' } },
      { b: 'Out of product', c: 'Needs a ladder' },
    ));

    const { headline, why, opts } = sent();
    expect(headline).toBe('Schedule — follow up on Dana Q\'s re-service');
    expect(why).toBe('Their text on Nov 2 is about money (a charge or refund); read it in full (+2 more).');
    const lines = opts.detail.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Office only: a text on Nov 2 about money/);
    expect(lines[1]).toBe('Not done today: a request form on Nov 2 “Roaches in the garage”. Tech\'s reason: Out of product.');
    expect(lines[2]).toBe('Not done today: a call on Nov 2 “Wasps by the door”. Tech\'s reason: Needs a ladder.');
    expect(opts.metadata.itemIds).toEqual(['a', 'b', 'c']);
  });

  test('the words are redacted like every bell body: a phone number is masked', async () => {
    await raise(freezeOf([item('a', { text: 'Call me at 941-555-0142 about the ants' })], { a: { answer: 'not_today' } }, { a: 'Will call' }));

    const { why, opts } = sent();
    expect(why).not.toContain('555-0142');
    expect(opts.detail).not.toContain('555-0142');
  });

  test('a long name still fits the 60-character headline', async () => {
    await raise(freezeOf([item('a')], { a: { answer: 'not_today' } }, { a: 'Dog' }), {
      customer: { id: CUSTOMER.id, first_name: 'Alexandria-Marguerite', last_name: 'Featherstonehaugh-Villeneuve' },
    });

    const { headline } = sent();
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(headline.startsWith('Schedule — follow up on ')).toBe(true);
  });

  test('no name on file: the headline stays valid without one', async () => {
    await raise(freezeOf([item('a')], { a: { answer: 'not_today' } }, { a: 'Dog' }), { customer: { id: CUSTOMER.id } });

    expect(sent().headline).toBe('Schedule — follow up on a re-service');
  });

  test('no date given: the link still opens the visit', async () => {
    await raise(freezeOf([item('a')], { a: { answer: 'not_today' } }, { a: 'Dog' }), { scheduledDate: null });

    expect(sent().opts.link).toBe(`/admin/dispatch?tab=schedule&appointment=${VISIT_ID}`);
  });

  test.each([
    ['only answered-and-done items', freezeOf([item('a'), item('b')], { a: { answer: 'treated', productIds: ['p'] }, b: { answer: 'noted' } })],
    ['a version 2 block', { ...freezeOf([item('a', { officeOnly: 'damage' })]), version: 2 }],
    ['no freeze', null],
  ])('%s: nothing raised, nothing written', async (_name, freeze) => {
    expect(await raise(freeze)).toBeNull();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a failure is caught and logged by code only, never the text', async () => {
    const failure = Object.assign(new Error('boom: Dana Q ants in the kitchen'), { code: 'SYNTHETIC_FAILURE' });
    mockNotifyAdmin.mockRejectedValueOnce(failure);

    const result = await raise(freezeOf([item('a')], { a: { answer: 'not_today' } }, { a: 'Dog in the yard' }));

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain('SYNTHETIC_FAILURE');
    expect(line).not.toMatch(/Dana|ants|kitchen|Dog/i);
  });

  test('a reason that breaks an alert rule is caught the same way (under test the composer throws)', async () => {
    const result = await raise(freezeOf([item('a')], { a: { answer: 'not_today' } }, { a: 'Moved to 2026-11-09!' }));

    expect(result).toBeNull();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toContain('2026-11-09');
  });
});
