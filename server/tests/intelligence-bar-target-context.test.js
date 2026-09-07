jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const REVIEW = '20000000-0000-4000-8000-000000000001';
const PROPERTY = '30000000-0000-4000-8000-000000000001';
let rows;
let lookupRows;
beforeEach(() => {
  lookupRows = [];
  rows = {
    google_reviews: [{ id: REVIEW, customer_id: A, reviewer_name: 'Synthetic Reviewer' }],
    customer_properties: [{ id: PROPERTY, customer_id: B, active: true }],
    customers: [{ id: A, first_name: 'Synthetic', last_name: 'Person', version: '2026-09-01 12:00:00.123456+00' }, { id: B }],
  };
  db.mockReset().mockImplementation(table => {
    let id;
    const q = { where: (key, value) => { id = typeof key === 'object' ? key.id : value; return q; },
      first: async () => rows[table]?.find(row => row.id === id),
      whereNull: () => q, whereIn: () => q, limit: () => q, select: async () => lookupRows };
    return q;
  });
  db.raw = text => ({ text });
});

const selectors = ['Reschedule', 'Reschedule for', 'Move', 'Move for', 'Call', 'Remind', 'Cancel', 'Book', 'Archive', 'Delete', 'Merge', 'Pause', 'Reactivate', 'Restore', 'Refund', 'Charge', 'Invoice', 'Credit', 'Assign', 'Unassign', 'Send to', 'Email to', 'Text to', 'Message to', 'Notify to', 'Quote for', 'Schedule for', 'Reply to', 'Respond to', 'Send a message to', 'Send an SMS to', 'Send a reminder to', 'Update customer'];
test.each(selectors)(
  'an unresolved person after "%s" cannot fall back to the viewed customer', async selector => {
    const task = await Context.resolve({ prompt: `${selector} Jhon using this customer`, pageData: { customer_id: A } });
    expect(task.page.customer.customer_id).toBe(A);
    expect(task.target).toBeNull();
    expect(task.targets).toEqual([]);
    expect((await Context.validateRecordTarget({ customer_id: A }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
  });

test.each(selectors)('a matching full name after "%s" still resolves through fresh lookup', async selector => {
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: `${selector} Synthetic Person using this customer`, pageData: {} });
  expect(task.target.customer_id).toBe(A);
  expect(task.target.provenance).toBe('current_request_lookup');
  expect(task.target.version).toBe(rows.customers[0].version);
});

test('viewed and selected targets retain the database text version without Date conversion', async () => {
  const viewed = await Context.resolve({ prompt: 'Update this customer', pageData: { customer_id: A } });
  const selected = await Context.resolve({ prompt: 'Update the customer', pageData: {}, selectedTarget: { customer_id: A } });
  expect(viewed.target.version).toBe('2026-09-01 12:00:00.123456+00');
  expect(selected.target.version).toBe(viewed.target.version);
});
const context = (customerId = A) => ({ targets: customerId ? [{ customer_id: customerId }] : [], page: { ids: {} } });

test('the native review deep link and explicit review IDs enter the same whitelist', () => {
  expect(Context.pageIds({ search: `?review=${REVIEW}` })).toEqual({ review_id: REVIEW });
  expect(Context.pageIds({ reviewId: REVIEW })).toEqual({ review_id: REVIEW });
  expect(Context.pageIds({ search: '?review=invalid' }).code).toBe('invalid_page_context');
});

test('a review cannot cross the named customer even when the viewed customer differs', async () => {
  const task = { ...context(B), page: { ids: { customer_id: A, review_id: REVIEW } } };
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, task)).code).toBe('target_clarification_required');
  expect(await Context.validateRecordTarget({ review_id: REVIEW }, context())).toBeNull();
});

test('read preparation checks a review with no selected customer instead of accepting a guessed ID', async () => {
  rows.google_reviews[0].customer_id = null;
  const args = { toolName: 'draft_review_reply', schema: { properties: { review_id: { type: 'string' } } } };
  expect((await Context.prepareReadInput({ review_id: REVIEW }, context(null), args)).code).toBe('target_clarification_required');
  const selected = await Context.resolve({ prompt: 'Reply to this review', pageData: { review_id: REVIEW } });
  expect(await Context.prepareReadInput({ review_id: REVIEW }, selected, args)).toEqual({ input: { review_id: REVIEW } });
  const explicit = await Context.resolve({ prompt: `Reply to review ${REVIEW}`, pageData: {} });
  expect(await Context.validateRecordTarget({ review_id: REVIEW }, explicit)).toBeNull();
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, { ...context(), page: selected.page })).code).toBe('target_clarification_required');
});

test.each(['this', 'that', 'selected'])('a deliberate %s review request uses the viewed review', async word => {
  rows.google_reviews[0].customer_id = null;
  const task = await Context.resolve({ prompt: `Reply to ${word} review`, pageData: { review_id: REVIEW } });
  expect(task.reviewReference).toBe(REVIEW);
  expect(await Context.validateRecordTarget({ review_id: REVIEW }, task)).toBeNull();
});

test.each(['missing', 'stats', 'removed'])('unavailable review (%s) cannot be drafted or posted', async kind => {
  if (kind === 'missing') rows.google_reviews = [];
  if (kind === 'stats') rows.google_reviews[0].reviewer_name = '_stats';
  if (kind === 'removed') rows.google_reviews[0].missing_since = new Date().toISOString();
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, context())).code).toBe('record_unavailable');
});

test('malformed identifiers refuse before a query, and child relationships are checked separately', async () => {
  expect((await Context.validateRecordTarget({ review_id: 'invalid' }, context())).code).toBe('invalid_target');
  expect(db).not.toHaveBeenCalled();
  expect((await Context.validateRecordTarget({ customer_id: A, property_id: PROPERTY }, context())).code).toBe('target_relationship_mismatch');
});

 test.each([
  'Reply to the review for Another Person',
  `Add a note: reply to review ${REVIEW}`,
  'Add a note: reply to this review',
  `Add a note that review ${REVIEW} needs a response`,
  `Send a message saying reply to review ${REVIEW}`,
  'Look up inventory',
])('an unrelated page/body reference grants no review authority: %s', async prompt => {
  rows.google_reviews[0].customer_id = null;
  const task = await Context.resolve({ prompt, pageData: { review_id: REVIEW } });
  expect(task.reviewReference).toBeNull();
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, task)).code).toBe('target_clarification_required');
});


test.each([
  ['property', 'customer_properties'], ['appointment', 'scheduled_services'], ['estimate', 'estimates'],
  ['invoice', 'invoices'], ['review', 'google_reviews'], ['email', 'emails'], ['call', 'call_log'], ['lead', 'leads'],
])('a selected %s cannot be replaced by a sibling belonging to the same customer', async (noun, table) => {
  const id = '40000000-0000-4000-8000-000000000001', sibling = '40000000-0000-4000-8000-000000000002';
  rows[table] = [{ id, customer_id: A }, { id: sibling, customer_id: A }];
  for (const reference of ['this', 'that', 'selected']) {
    const task = await Context.resolve({ prompt: `Update ${reference} ${noun}`, pageData: { [`${noun}_id`]: id } });
    // Customer resolution is independent of the exact child-record binding.
    task.targets = [{ customer_id: A }];
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: id }, task)).toBeNull();
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: sibling }, task)).code).toBe('target_clarification_required');
  }
});

test('a record reference inside message content does not constrain an unrelated named target', async () => {
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: 'Update Synthetic Person notes to this property needs a label', pageData: { property_id: PROPERTY } });
  expect(task.requestedRecords).toEqual({});
  expect(task.target.customer_id).toBe(A);
});


test('an explicit named customer supersedes the viewed account without inheriting its ID pin', async () => {
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: 'Update Synthetic Person using this customer', pageData: { customer_id: B } });
  expect(task.target.customer_id).toBe(A);
  expect(task.requestedRecords).toEqual({});
  expect(await Context.validateRecordTarget({ customer_id: A }, task)).toBeNull();
});


test('this customer resolves through a viewed property without requiring a redundant page customer ID', async () => {
  const task = await Context.resolve({ prompt: 'Text this customer', pageData: { property_id: PROPERTY } });
  expect(task.target.customer_id).toBe(B);
  expect(task.requestedRecords).toEqual({});
  expect(await Context.validateRecordTarget({ customer_id: B }, task)).toBeNull();
});
