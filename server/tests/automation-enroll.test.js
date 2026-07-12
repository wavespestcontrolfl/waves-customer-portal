jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/automation-runner', () => ({
  enrollCustomer: jest.fn(async () => ({ enrolled: true, enrollmentId: 'enr-1' })),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { enrollCustomer } = require('../services/automation-runner');
const { enrollSequenceFromEvent } = require('../services/automation-enroll');

let templateRow;
let firstStepRow;
let priorRow;
let customerRow;
let prefsRow;
let enrollmentWhereArgs;
let enrollmentWhereInArgs;

function templatesQuery() {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => templateRow) };
  return q;
}
function stepsQuery() {
  const q = { where: jest.fn(() => q), orderBy: jest.fn(() => q), first: jest.fn(async () => firstStepRow) };
  return q;
}
function enrollmentsQuery() {
  const q = {
    where: jest.fn((...args) => { enrollmentWhereArgs.push(args); return q; }),
    whereIn: jest.fn((...args) => { enrollmentWhereInArgs.push(args); return q; }),
    whereNot: jest.fn(() => q),
    orWhereNotNull: jest.fn(() => q),
    first: jest.fn(async () => priorRow),
  };
  return q;
}
function customersQuery() {
  const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => customerRow) };
  return q;
}
function prefsQuery() {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => prefsRow) };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  enrollCustomer.mockResolvedValue({ enrolled: true, enrollmentId: 'enr-1' });
  templateRow = { key: 'payment_failed', enabled: true };
  firstStepRow = { step_order: 0, enabled: true, html_body: '<p>note</p>', text_body: '' };
  priorRow = null;
  prefsRow = null;
  enrollmentWhereArgs = [];
  enrollmentWhereInArgs = [];
  customerRow = { id: 'cust-1', first_name: 'Megan', last_name: 'Example', email: 'megan@example.com', deleted_at: null };
  db.mockImplementation((table) => {
    if (table === 'automation_templates') return templatesQuery();
    if (table === 'automation_steps') return stepsQuery();
    if (table === 'automation_enrollments') return enrollmentsQuery();
    if (table === 'notification_prefs') return prefsQuery();
    return customersQuery();
  });
});

describe('enrollSequenceFromEvent', () => {
  test('happy path enrolls the primary customer email', async () => {
    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1', source: 'test' });

    expect(result).toEqual({ enrolled: true, reason: 'enrolled' });
    expect(enrollCustomer).toHaveBeenCalledWith({
      templateKey: 'payment_failed',
      customer: { id: 'cust-1', email: 'megan@example.com', first_name: 'Megan', last_name: 'Example' },
    });
  });

  test('paused template never enrolls (sendability first)', async () => {
    templateRow = { key: 'payment_failed', enabled: false };

    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1' });

    expect(result).toEqual({ enrolled: false, reason: 'not_sendable' });
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test('empty FIRST step never enrolls, even if a later step has content', async () => {
    firstStepRow = { step_order: 0, enabled: true, html_body: '  ', text_body: '' };

    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1' });

    expect(result).toEqual({ enrolled: false, reason: 'not_sendable' });
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test("dedupe 'ever': a prior delivered/deliverable row suppresses", async () => {
    priorRow = { id: 'enr-0' };

    const result = await enrollSequenceFromEvent({ templateKey: 'referral_nudge', customerId: 'cust-1', dedupe: 'ever' });

    expect(result).toEqual({ enrolled: false, reason: 'deduped' });
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test('windowed dedupe queries enrolled_at within the window and suppresses on a hit', async () => {
    priorRow = { id: 'enr-0' };

    const result = await enrollSequenceFromEvent({ templateKey: 'service_renewal', customerId: 'cust-1', dedupe: 90 });

    expect(result).toEqual({ enrolled: false, reason: 'deduped' });
    const windowArgs = enrollmentWhereArgs.find((a) => a[0] === 'enrolled_at');
    expect(windowArgs).toBeTruthy();
    expect(windowArgs[1]).toBe('>');
    // ~90 days ago (loose bound — no fake timers needed)
    const cutoff = windowArgs[2].getTime();
    const expected = Date.now() - 90 * 24 * 3600 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(60 * 1000);
  });

  test('missing or deleted customer → no_customer', async () => {
    customerRow = undefined;

    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-x' });

    expect(result).toEqual({ enrolled: false, reason: 'no_customer' });
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test('customer without a usable email → no_email', async () => {
    customerRow = { ...customerRow, email: '   ' };

    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1' });

    expect(result).toEqual({ enrolled: false, reason: 'no_email' });
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test('enrollCustomer refusal reasons pass through', async () => {
    enrollCustomer.mockResolvedValueOnce({ enrolled: false, reason: 'already enrolled' });

    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1' });

    expect(result).toEqual({ enrolled: false, reason: 'already enrolled' });
  });

  test('never throws: an enrollCustomer error returns { reason: "error" } and logs', async () => {
    enrollCustomer.mockRejectedValueOnce(new Error('boom'));

    const result = await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1', source: 'autopay_failure' });

    expect(result).toEqual({ enrolled: false, reason: 'error' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('autopay_failure'));
  });

  test('dedupeAcross suppresses via sibling template keys (one thank-you across locations)', async () => {
    priorRow = { id: 'enr-0' }; // e.g. review_thank_you_venice from an earlier review

    const result = await enrollSequenceFromEvent({
      templateKey: 'review_thank_you_parrish',
      customerId: 'cust-1',
      dedupe: 'ever',
      dedupeAcross: ['review_thank_you_lwr', 'review_thank_you_parrish', 'review_thank_you_sarasota', 'review_thank_you_venice'],
    });

    expect(result).toEqual({ enrolled: false, reason: 'deduped' });
    expect(enrollmentWhereInArgs[0][0]).toBe('template_key');
    expect(enrollmentWhereInArgs[0][1]).toEqual(expect.arrayContaining([
      'review_thank_you_lwr', 'review_thank_you_parrish', 'review_thank_you_sarasota', 'review_thank_you_venice',
    ]));
    expect(enrollCustomer).not.toHaveBeenCalled();
  });

  test("recipient: 'billing' routes to notification_prefs.billing_email like the transactional payment emails", async () => {
    prefsRow = { billing_email: 'books@hoa-example.com', billing_contact_name: 'Pat Books' };

    const result = await enrollSequenceFromEvent({
      templateKey: 'payment_failed',
      customerId: 'cust-1',
      dedupe: 14,
      recipient: 'billing',
    });

    expect(result).toEqual({ enrolled: true, reason: 'enrolled' });
    expect(enrollCustomer).toHaveBeenCalledWith({
      templateKey: 'payment_failed',
      customer: expect.objectContaining({ email: 'books@hoa-example.com', first_name: 'Pat' }),
    });
  });

  test("recipient: 'billing' falls back to the primary email when no billing contact is set", async () => {
    prefsRow = null;

    await enrollSequenceFromEvent({ templateKey: 'payment_failed', customerId: 'cust-1', recipient: 'billing' });

    expect(enrollCustomer).toHaveBeenCalledWith({
      templateKey: 'payment_failed',
      customer: expect.objectContaining({ email: 'megan@example.com' }),
    });
  });

  test('missing args → bad_args, nothing queried', async () => {
    expect(await enrollSequenceFromEvent({ templateKey: null, customerId: 'x' })).toEqual({ enrolled: false, reason: 'bad_args' });
    expect(await enrollSequenceFromEvent({ templateKey: 'x', customerId: null })).toEqual({ enrolled: false, reason: 'bad_args' });
    expect(db).not.toHaveBeenCalled();
  });
});
