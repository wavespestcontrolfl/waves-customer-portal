jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const REVIEW = '20000000-0000-4000-8000-000000000001';
const PROPERTY = '30000000-0000-4000-8000-000000000001';
let rows;
beforeEach(() => {
  rows = {
    google_reviews: [{ id: REVIEW, customer_id: A, reviewer_name: 'Synthetic Reviewer' }],
    customer_properties: [{ id: PROPERTY, customer_id: B, active: true }],
    customers: [{ id: A }, { id: B }],
  };
  db.mockReset().mockImplementation(table => {
    let id;
    const q = { where: (_key, value) => { id = value; return q; },
      first: async () => rows[table]?.find(row => row.id === id),
      whereNull: () => q, whereIn: () => q, limit: () => q, select: async () => [] };
    return q;
  });
  db.raw = text => ({ text });
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

test.each(['customer', 'raw_sms', 'vendor_email', 'unlinked_lead', 'unlinked_estimate', 'unlinked_review', 'bulk_leads'])(
  'approval projection preserves %s authority without retaining resolution text', async kind => {
    const recordId = '40000000-0000-4000-8000-000000000001';
    const task = { ...context(null), requestPhrase: 'synthetic person', explicitEmails: ['fixture@example.invalid'],
      explicitPhones: ['5550101234'], candidates: [{ label: 'Private synthetic candidate', address: 'Private address' }],
      page: { ids: {}, records: { customer_id: { first_name: 'Private page name' } } } };
    let toolName = 'update_customer', params = { customer_id: A, updates: { notes: 'Approved note' } };
    if (kind === 'customer') task.targets = [{ customer_id: A, label: 'Private name', address: 'Private address' }];
    if (kind === 'raw_sms') { toolName = 'send_sms'; params = { phone: '+15550101234', message: 'Approved message' }; }
    if (kind === 'vendor_email') {
      toolName = 'send_email_reply'; params = { email_id: recordId, body: 'Approved reply' };
      rows.emails = [{ id: recordId, customer_id: A, from_address: 'fixture@example.invalid' }];
    }
    if (kind === 'unlinked_lead' || kind === 'bulk_leads') {
      toolName = 'update_lead'; params = { lead_id: recordId, updates: { status: 'new' } };
      rows.leads = [{ id: recordId, first_name: 'Synthetic', last_name: 'Person', customer_id: null }];
    }
    if (kind === 'unlinked_estimate') {
      toolName = 'set_estimate_presentation'; params = { estimate_id: recordId, show_savings: true };
      rows.estimates = [{ id: recordId, customer_name: 'Synthetic Person', customer_id: null }];
    }
    if (kind === 'unlinked_review') {
      toolName = 'submit_review_reply'; params = { review_id: REVIEW, reply_text: 'Approved reply' };
      rows.google_reviews[0].customer_id = null; task.reviewReference = REVIEW;
    }
    if (kind === 'bulk_leads') {
      toolName = 'bulk_update_leads'; params = { lead_ids: [recordId], current_status: 'new', _expect_full_set: true };
      task.bulkLeadRequest = true;
      task.bulkLeadSelection = Context.bulkLeadSelection(toolName, [{ kind: 'lead_id', id: recordId }], params);
      task.requestPhrase = 'all leads';
    }
    const proof = await Context.validateRecordTarget(params, task, { toolName, forApproval: true });
    expect(proof.error).toBeUndefined();
    expect(Object.keys(proof).sort()).toEqual(['actionBinding', 'recordsBinding', 'references', 'targets']);
    expect(JSON.stringify(proof)).not.toMatch(/Private|Synthetic|synthetic|fixture@|5550101234/);
    expect(await Context.validateRecordTarget({ ...params, _ib_task_context: proof }, proof, { toolName })).toBeNull();
    expect((await Context.validateRecordTarget({ ...params, unexpected: 'changed' }, proof, { toolName })).code).toBe('target_changed');
    if (kind === 'vendor_email') {
      rows.emails[0].from_address = 'changed@example.invalid';
      expect((await Context.validateRecordTarget(params, proof, { toolName })).code).toBe('target_changed');
    }
  },
);
