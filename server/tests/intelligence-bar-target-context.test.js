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
    let id, ids, nameMatch = false, threadProjection = false;
    const q = { where: (key, value) => { id = typeof key === 'object' ? key.id : value; return q; },
      first: async () => rows[table]?.find(row => row.id === id),
      whereRaw: () => { nameMatch = true; return q; }, whereNull: () => q, whereIn: (key, values) => { if (key === 'id') ids = values; return q; }, limit: () => q,
      distinct: () => { threadProjection = true; return q; },
      select: () => q, then: resolve => {
        const selected = ids ? (rows[table] || []).filter(row => ids.includes(row.id)) : nameMatch ? rows[table] || [] : lookupRows;
        return Promise.resolve(threadProjection ? [...new Set(selected.map(row => row.gmail_thread_id || row.id))].map(thread_key => ({ thread_key })) : selected).then(resolve);
      } };
    return q;
  });
  db.raw = text => ({ text });
});

const selectors = ['Reschedule', 'Reschedule for', 'Move', 'Move for', 'Call', 'Remind', 'Cancel', 'Book', 'Archive', 'Delete', 'Merge', 'Pause', 'Reactivate', 'Restore', 'Refund', 'Charge', 'Invoice', 'Credit', 'Send to', 'Email to', 'Text to', 'Message to', 'Notify to', 'Quote for', 'Schedule for', 'Reply to', 'Respond to', 'Send a message to', 'Send an SMS to', 'Send a reminder to', 'Update customer'];
test.each(selectors)(
  'an unresolved person after "%s" cannot fall back to the viewed customer', async selector => {
    const task = await Context.resolve({ prompt: `${selector} Jhon using this customer`, pageData: { customer_id: A } });
    expect(task.page.customer.customer_id).toBe(A);
    expect(task.target).toBeNull();
    expect(task.targets).toEqual([]);
    expect((await Context.validateRecordTarget({ customer_id: A }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
  });

test('direct read verbs resolve an exact full name without becoming refusal hints', async () => {
  lookupRows = [rows.customers[0]];
  for (const prompt of ['Show Synthetic Person details', 'Find Synthetic Person', 'Get Synthetic Person details', 'Look up Synthetic Person', 'Show me Synthetic Person']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect(task.target).toMatchObject({ customer_id: A, provenance: 'current_request_lookup' });
  }
  lookupRows = [];
  // A read that names nobody keeps the viewed customer instead of refusing it.
  const viewed = await Context.resolve({ prompt: 'Show open invoices for this customer', pageData: { customer_id: A } });
  expect(viewed.target.customer_id).toBe(A);
  expect(Context.namesRequested('Show open invoices for this customer')).toBe(false);
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

test('an unmatched current name refuses a stale operator selection', async () => {
  const result = await Context.resolve({ prompt: 'Update Synthetiic Person', pageData: { customer_id: A }, selectedTarget: { customer_id: A } });
  expect(result).toMatchObject({ code: 'context_mismatch' });
  lookupRows = [rows.customers[0]];
  const matching = await Context.resolve({ prompt: 'Update Synthetic Person', pageData: { customer_id: B }, selectedTarget: { customer_id: A } });
  expect(matching.target.customer_id).toBe(A);
});

test.each(['both', 'these customers', 'all of these'])('a partially resolved %s set never authorizes its matching subset', async set => {
  lookupRows = [rows.customers[0]];
  const prompt = `Update ${set} Synthetic Person and Missing Customer`;
  const result = await Context.resolve({ prompt, pageData: { customer_id: A } });
  expect(result).toMatchObject({ targets: [], ambiguous: true });
  expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
});

test('both requested fields are not mistaken for a customer set', async () => {
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: 'Update both the phone and email for Synthetic Person', pageData: {} });
  expect(task.target.customer_id).toBe(A);
  expect(task.ambiguous).toBe(false);
});
const context = (customerId = A) => ({ targets: customerId ? [{ customer_id: customerId }] : [], page: { ids: {} } });

test('explicit child identifiers constrain same-customer choices and exclude message content', async () => {
  const one = 'abcdef01-0000-4000-8000-000000000001';
  const two = 'abcdef01-0000-4000-8000-000000000002';
  rows.estimates = [{ id: one, customer_id: A }, { id: two, customer_id: A }];
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: `Revise estimate ${one.toUpperCase()} for Synthetic Person`, pageData: { estimate_id: two } });
  expect(await Context.validateRecordTarget({ estimate_id: one }, task)).toBeNull();
  expect(await Context.validateRecordTarget({ estimate_id: two }, task)).toMatchObject({ code: 'target_clarification_required' });
  const multiple = await Context.resolve({ prompt: `Revise estimate ${one} and estimate ${two} for Synthetic Person`, pageData: {} });
  expect(await Context.validateRecordTarget({ estimate_id: two }, multiple)).toBeNull();
  const note = await Context.resolve({ prompt: `Add a note for Synthetic Person saying estimate ${two} needs attention`, pageData: {} });
  expect(note.requestedRecords).toEqual({});
  for (const noun of [`this estimate`, `estimate ${one}`]) {
    for (const content of ['mentioning', 'referencing', 'containing', 'with', 'reading', 'for the office about']) {
      const inline = await Context.resolve({ prompt: `Revise ${noun} for Synthetic Person and add a note ${content} estimate ${two}`, pageData: { estimate_id: one } });
      expect(await Context.validateRecordTarget({ estimate_id: one }, inline)).toBeNull();
      expect(await Context.validateRecordTarget({ estimate_id: two }, inline)).toMatchObject({ code: 'target_clarification_required' });
    }
  }
  const conflicting = await Context.resolve({ prompt: `Revise this estimate or estimate ${two} for Synthetic Person`, pageData: { estimate_id: one } });
  expect(await Context.validateRecordTarget({ estimate_id: two }, conflicting)).toMatchObject({ code: 'target_clarification_required' });
  const attachedNote = await Context.resolve({ prompt: `Revise estimate ${one} for Synthetic Person with a note containing estimate ${two}`, pageData: {} });
  expect(await Context.validateRecordTarget({ estimate_id: one }, attachedNote)).toBeNull();
  expect(await Context.validateRecordTarget({ estimate_id: two }, attachedNote)).toMatchObject({ code: 'target_clarification_required' });
});

test('a later that-estimate constraint survives filtering unrelated page hints', async () => {
  const id = 'abcdef01-0000-4000-8000-000000000001';
  rows.estimates = [{ id, customer_id: A }];
  const task = await Context.resolve({ prompt: 'Update this customer and revise that estimate', pageData: { customer_id: A, estimate_id: id } });
  expect(task.requestedRecords.estimate_id).toBe(id);
  expect(await Context.validateRecordTarget({ estimate_id: id }, task)).toBeNull();
});

test.each(['reschedule_appointment', 'move_stops_to_day'])('%s cannot attach a customerless reservation to a customer task', async toolName => {
  const hold = '40000000-0000-4000-8000-000000000001';
  const owned = '40000000-0000-4000-8000-000000000002';
  rows.scheduled_services = [{ id: hold, customer_id: null }, { id: owned, customer_id: A }];
  const params = id => toolName === 'move_stops_to_day' ? { service_ids: [id] } : { appointment_id: id };
  expect(await Context.validateRecordTarget(params(hold), context(), { toolName })).toMatchObject({ code: 'target_clarification_required' });
  expect(await Context.validateRecordTarget(params(owned), context(), { toolName })).toBeNull();
  expect(await Context.validateRecordTarget(params(hold), context(null), { toolName })).toMatchObject({ code: 'target_clarification_required' });
  for (const prompt of ['Move this appointment', `Move appointment ${hold}`]) {
    const selected = await Context.resolve({ prompt, pageData: { appointment_id: hold } });
    expect(await Context.validateRecordTarget(params(hold), selected, { toolName })).toBeNull();
    expect(await Context.validateRecordTarget(params(hold), { ...selected, targets: context().targets }, { toolName })).toMatchObject({ code: 'target_clarification_required' });
  }
});

test('a name-only lead write cannot bypass current-request identity validation', async () => {
  expect(await Context.validateRecordTarget({ lead_name: 'Synthetic Person' }, context(), { toolName: 'update_lead_status' }))
    .toMatchObject({ code: 'target_clarification_required' });
  expect(await Context.validateRecordTarget({ lead_name: 'Synthetic Person', leadId: A }, context(), { toolName: 'update_lead_status' }))
    .toMatchObject({ code: 'target_clarification_required' });
  expect(db).not.toHaveBeenCalled();
});

test('a name lookup at its cap cannot authorize a truncated bulk cohort', async () => {
  lookupRows = Array.from({ length: 10 }, (_, i) => ({ id: `50000000-0000-4000-8000-${String(i).padStart(12, '0')}`, first_name: 'Synthetic', last_name: `Cohort${i}` }));
  const task = await Context.resolve({ prompt: `Update both ${lookupRows.map(c => `${c.first_name} ${c.last_name}`).join(' and ')}`, pageData: {} });
  expect(task.candidates).toHaveLength(10);
  expect(task.targets).toEqual([]);
  expect(task.ambiguous).toBe(true);
  lookupRows[9] = { id: B, first_name: 'Synthetic', last_name: 'Incidental' };
  const incomplete = await Context.resolve({ prompt: `Update both ${lookupRows.slice(0, 9).map(c => `${c.first_name} ${c.last_name}`).join(' and ')} and Synthetic MissingOne and Synthetic MissingTwo after checking with Synthetic Incidental`, pageData: {} });
  expect(incomplete.candidates).toHaveLength(9);
  expect(incomplete.targets).toEqual([]);
  expect(incomplete.ambiguous).toBe(true);
});

test.each(['with the text', 'with the following body', 'with a message', 'saying', 'with instructions'])(
  'a command after the message-content boundary "%s" never selects an unlinked appointment', async content => {
    const id = '40000000-0000-4000-8000-000000000008';
    rows.scheduled_services = [{ id, customer_id: null }];
    const task = await Context.resolve({ prompt: `Send a message to +15550101234 ${content} check inventory and move appointment ${id}`, pageData: {} });
    expect(task.requestedRecords).toEqual({});
    expect(await Context.validateRecordTarget({ appointment_id: id }, task, { toolName: 'reschedule_appointment' }))
      .toMatchObject({ code: 'target_clarification_required' });
  });

test('a message step retains explicit estimate constraints from a later independent action', async () => {
  const one = 'abcdef01-0000-4000-8000-000000000001', two = 'abcdef01-0000-4000-8000-000000000002';
  rows.estimates = [{ id: one, customer_id: A }, { id: two, customer_id: A }];
  lookupRows = [rows.customers[0]];
  for (const join of ['and', 'then']) {
    const task = await Context.resolve({ prompt: `Send a message to Synthetic Person ${join} revise estimate ${one}`, pageData: { estimate_id: two } });
    expect(task.target.customer_id).toBe(A);
    expect(await Context.validateRecordTarget({ estimate_id: one }, task)).toBeNull();
    expect(await Context.validateRecordTarget({ estimate_id: two }, task)).toMatchObject({ code: 'target_clarification_required' });
  }
});

test.each(['Synthetic Person', 'Another Person', 'Unresolved'])('SMS recipient name %s requires a canonical customer ID', async customer_name => {
  expect((await Context.validateRecordTarget({ customer_name }, context(), { toolName: 'send_sms' })).code).toBe('target_clarification_required');
  expect((await Context.validateRecordTarget({ customer_name, customerId: A }, context(), { toolName: 'send_sms' })).code).toBe('target_clarification_required');
  expect(db).not.toHaveBeenCalled();
  rows.customers[0].phone = '+15550101234';
  expect(await Context.validateRecordTarget({ customer_id: A, customer_name, phone: '5550101234' }, context(), { toolName: 'send_sms' })).toBeNull();
  expect((await Context.validateRecordTarget({ customer_id: B, customer_name }, context(), { toolName: 'send_sms' })).code).toBe('target_clarification_required');
  expect((await Context.validateRecordTarget({ customer_id: A, customer_name, phone: '5550104321' }, context(), { toolName: 'send_sms' })).code).toBe('target_relationship_mismatch');
});

test.each(['trigger_review_request', 'reply_via_sms'])('%s requires a canonical current-task customer before proposal', async toolName => {
  for (const customer_name of ['Synthetic Person', 'Another Person', 'Unresolved']) {
    expect(await Context.validateRecordTarget({ customer_name }, context(), { toolName })).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.validateRecordTarget({ customer_name, customer_id: A }, context(), { toolName })).toBeNull();
    expect(await Context.validateRecordTarget({ customer_name, customer_id: B }, context(), { toolName })).toMatchObject({ code: 'target_clarification_required' });
  }
});

test.each([['email', 'emails'], ['call', 'call_log'], ['lead', 'leads']])('a %s mentioned only in content gives no customer authority', async (noun, table) => {
  const id = '40000000-0000-4000-8000-000000000001';
  rows[table] = [{ id, customer_id: A }];
  for (const prompt of [`Add a note: this ${noun} needs attention`, `Add a note saying this ${noun} needs attention`, `Add a note that this ${noun} needs attention`]) {
    const task = await Context.resolve({ prompt, pageData: { [`${noun}_id`]: id } });
    expect(task.targets).toEqual([]);
    expect((await Context.validateRecordTarget({ customer_id: A }, task)).code).toBe('target_clarification_required');
  }
  const missing = await Context.resolve({ prompt: `Update this ${noun}`, pageData: {} });
  expect((await Context.validateRecordTarget({ [`${noun}_id`]: id }, missing)).code).toBe('target_clarification_required');
  rows[table] = [];
  expect((await Context.resolve({ prompt: `Update this ${noun}`, pageData: { [`${noun}_id`]: id } })).code).toBe('record_unavailable');
});

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

test.each(['missing', 'stats', 'removed', 'dismissed'])('unavailable review (%s) cannot be drafted or posted', async kind => {
  if (kind === 'missing') rows.google_reviews = [];
  if (kind === 'dismissed') rows.google_reviews[0].dismissed = true;
  if (kind === 'stats') rows.google_reviews[0].reviewer_name = '_stats';
  if (kind === 'removed') rows.google_reviews[0].missing_since = new Date().toISOString();
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, context())).code).toBe('record_unavailable');
});

test('malformed identifiers refuse before a query, and child relationships are checked separately', async () => {
  expect((await Context.validateRecordTarget({ review_id: 'invalid' }, context())).code).toBe('invalid_target');
  expect(db).not.toHaveBeenCalled();
  expect((await Context.validateRecordTarget({ customer_id: A, property_id: PROPERTY }, context())).code).toBe('target_relationship_mismatch');
});

test.each([['lead', 'leads', { first_name: 'Synthetic', last_name: 'Unlinkedfixture' }],
  ['estimate', 'estimates', { customer_name: 'Synthetic Unlinkedfixture' }]])('an unlinked %s needs a deliberate target expression', async (noun, table, name) => {
  const id = '40000000-0000-4000-8000-000000000001';
  rows[table] = [{ id, customer_id: null, ...name }];
  for (const prompt of ['Look up inventory', 'Add a note: Synthetic Unlinkedfixture needs attention', 'Add a note saying Synthetic Unlinkedfixture needs attention']) {
    const task = await Context.resolve({ prompt, pageData: { [`${noun}_id`]: id } });
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: id }, task)).code).toBe('target_clarification_required');
  }
  for (const prompt of [`Update this ${noun}`, `Update that ${noun}`, 'Update Synthetic Unlinkedfixture']) {
    const task = await Context.resolve({ prompt, pageData: { [`${noun}_id`]: id } });
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: id }, task)).toBeNull();
  }
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

test.each([
  ['property', 'customer_properties'], ['appointment', 'scheduled_services'], ['estimate', 'estimates'],
  ['invoice', 'invoices'], ['review', 'google_reviews'], ['email', 'emails'], ['call', 'call_log'], ['lead', 'leads'],
])('a selected %s cannot be replaced by a sibling belonging to the same customer', async (noun, table) => {
  const id = '40000000-0000-4000-8000-000000000001', sibling = '40000000-0000-4000-8000-000000000002';
  rows[table] = [{ id, customer_id: A }, { id: sibling, customer_id: A }];
  for (const reference of ['this', 'that', 'selected']) {
    const task = await Context.resolve({ prompt: `Update ${reference} ${noun}`, pageData: { [`${noun}_id`]: id } });
    expect(task.target.customer_id).toBe(A);
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


test.each(['Text this customer', 'Email this customer', 'Send this customer a text', 'Update this customer and text them', 'Remind this customer', 'Notify this customer', 'Tell this customer'])(
  'a customer name in the body after "%s that" cannot choose the target', async prefix => {
    lookupRows = [rows.customers[0]]; // A real matching alternate name is available to the lookup.
    const task = await Context.resolve({ prompt: `${prefix} that customer Synthetic Person canceled`, pageData: { customer_id: B } });
    expect(task.target.customer_id).toBe(B);
    expect((await Context.validateRecordTarget({ customer_id: A }, task)).code).toBe('target_clarification_required');
  });

test('"this stop" and "this visit" on a schedule panel resolve the appointment and its customer', async () => {
  const appointment = '40000000-0000-4000-8000-000000000014';
  rows.scheduled_services = [{ id: appointment, customer_id: B }];
  for (const prompt of ["Show this stop's notes", 'Summarize this visit']) {
    const task = await Context.resolve({ prompt, pageData: { appointment_id: appointment, customer_id: B } });
    expect(task.target.customer_id).toBe(B);
    expect(task.requestedRecords.appointment_id).toBe(appointment);
    expect(await Context.validateRecordTarget({ service_id: appointment }, task, { toolName: 'get_stop_details' })).toBeNull();
  }
});

test('check and summarize are direct-read verbs that select an exact full name', async () => {
  lookupRows = [rows.customers[0]];
  for (const prompt of ['Check Synthetic Person details', 'Summarize Synthetic Person', 'Read Synthetic Person details']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect(task.target?.customer_id).toBe(A);
  }
});

test('route-wide writers are refused inside a customer-scoped task', async () => {
  for (const [toolName, params] of [['optimize_all_routes', { date: '2026-09-09' }], ['optimize_tech_route', { date: '2026-09-09', technician_name: 'Synthetic Tech' }],
    ['swap_tech_assignments', { date: '2026-09-09', tech_a_name: 'A', tech_b_name: 'B' }]]) {
    expect(await Context.validateRecordTarget(params, context(), { toolName })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.validateRecordTarget(params, { targets: [] }, { toolName })).toBeNull();
  }
});

test('scoped customer-row readers fail closed for an explicitly named customer who did not resolve', async () => {
  const unresolved = { targets: [], namesRequested: true, candidates: [], page: { ids: {} } };
  const schema = { properties: {} };
  for (const [toolName, params] of [['get_schedule_view', { date: '2026-09-09' }], ['query_customers', { search: 'Jhon' }], ['query_leads', { search: 'Jhon' }],
    ['get_stale_leads', { days: 14 }], ['search_emails', { search: 'Jhon' }], ['get_email_thread', { subject_search: 'quote' }],
    ['draft_email_reply', { instructions: 'Reply politely' }], ['match_existing_customer', { phone: '5550001234' }]]) {
    expect(await Context.prepareReadInput(params, unresolved, { toolName, schema })).toMatchObject({ code: 'customer_scope_required' });
    // The same reader stays open for a request that names nobody, and scoped for a resolved task customer.
    expect(await Context.prepareReadInput(params, { ...unresolved, namesRequested: false }, { toolName, schema })).toEqual({ input: params });
    expect(await Context.prepareReadInput(params, { ...context(), namesRequested: true }, { toolName, schema })).toEqual({ input: params });
  }
  // Readers outside the scoped list keep their own target checks.
  expect(await Context.prepareReadInput({ date: '2026-09-09' }, unresolved, { toolName: 'get_zone_capacity', schema })).toEqual({ input: { date: '2026-09-09' } });
  // Readers with an optional customer selector are broad only when the model supplies no selector or record id.
  const optional = { properties: { customer_id: { type: 'string' }, call_id: { type: 'string' }, days_back: { type: 'number' } } };
  for (const [toolName, params] of [['get_call_log', { days_back: 1 }], ['search_messages', { search: 'estimate' }], ['get_open_commitments', {}]]) {
    expect(await Context.prepareReadInput(params, unresolved, { toolName, schema: optional })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput(params, { ...unresolved, namesRequested: false }, { toolName, schema: optional })).toEqual({ input: params });
    expect(await Context.prepareReadInput(params, { ...context(), namesRequested: true }, { toolName, schema: optional })).toEqual({ input: { ...params, customer_id: A } });
  }
  const call = '50000000-0000-4000-8000-000000000001';
  rows.call_log = [{ id: call, customer_id: B }];
  expect((await Context.prepareReadInput({ call_id: call }, unresolved, { toolName: 'get_call_log', schema: optional })).code).toBe('target_clarification_required');
});

test('calendar words after a selector are date filters, not customer names', async () => {
  for (const prompt of ['Show the day summary for Monday', 'Show overdue customers for September', 'Reschedule this stop for May 12',
    'Move this appointment to June 2026', 'Cancel this visit for Friday', "Show Monday's route", 'Schedule for tonight']) {
    expect(Context.namesRequested(prompt)).toBe(false);
  }
  const appointment = '40000000-0000-4000-8000-000000000007';
  rows.scheduled_services = [{ id: appointment, customer_id: B }];
  const task = await Context.resolve({ prompt: 'Reschedule this stop for May 12', pageData: { appointment_id: appointment } });
  expect(task.target.customer_id).toBe(B);
  // Months that are also given names stay person evidence without a day or year after them.
  for (const prompt of ['Text May her invoice', 'Send a reminder to June', "Show April's schedule", 'Email August the estimate']) {
    expect(Context.namesRequested(prompt)).toBe(true);
  }
  const named = await Context.resolve({ prompt: 'Text May her invoice', pageData: { customer_id: A } });
  expect(named.target).toBeNull();
  expect(named.targets).toEqual([]);
});

test('a technician name in assignment is not an explicit customer selector', async () => {
  lookupRows = [rows.customers[0]];
  const appointment = '40000000-0000-4000-8000-000000000004';
  rows.scheduled_services = [{ id: appointment, customer_id: B }];
  const task = await Context.resolve({ prompt: 'Assign Synthetic Person to this appointment', pageData: { appointment_id: appointment } });
  expect(task.target.customer_id).toBe(B);
  expect(await Context.validateRecordTarget({ appointment_id: appointment }, task)).toBeNull();
});


test('a compound communication request retains a narrowing appointment constraint after that', async () => {
  const viewed = '40000000-0000-4000-8000-000000000005', sibling = '40000000-0000-4000-8000-000000000006';
  rows.scheduled_services = [{ id: viewed, customer_id: B }, { id: sibling, customer_id: B }];
  const task = await Context.resolve({ prompt: 'Text this customer and reschedule that appointment', pageData: { appointment_id: viewed } });
  expect(await Context.validateRecordTarget({ appointment_id: viewed }, task)).toBeNull();
  expect((await Context.validateRecordTarget({ appointment_id: sibling }, task)).code).toBe('target_clarification_required');
});


test('selector-free customer reads inherit one resolved task target and never choose from a cohort', async () => {
  const args = { toolName: 'get_call_log', schema: { properties: { customer_id: { type: 'string' } } } };
  expect(await Context.prepareReadInput({ days_back: 7 }, context(), args)).toEqual({ input: { days_back: 7, customer_id: A } });
  expect(await Context.prepareReadInput({ days_back: 7 }, context(null), args)).toEqual({ input: { days_back: 7 } });
  const multiple = { ...context(), targets: [{ customer_id: A }, { customer_id: B }] };
  expect((await Context.prepareReadInput({}, multiple, args)).code).toBe('target_clarification_required');
  expect(await Context.prepareReadInput({ customer_id: B }, multiple, args)).toEqual({ input: { customer_id: B } });
  expect((await Context.prepareReadInput({ customer_id: B }, context(), args)).code).toBe('target_clarification_required');
  rows.customers[0].deleted_at = new Date();
  expect((await Context.prepareReadInput({}, context(), args)).code).toBe('record_unavailable');
});

test('bulk references use one query per table while preserving absent-record rejection', async () => {
  const leads = Array.from({ length: 500 }, (_, index) => ({ id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`, customer_id: A }));
  rows.leads = leads.slice().reverse();
  expect(await Context.validateRecordTarget({ lead_ids: leads.map(row => row.id), customer_id: A }, context())).toBeNull();
  expect(db.mock.calls.filter(([table]) => table === 'leads')).toHaveLength(1);
  expect(db.mock.calls.filter(([table]) => table === 'customers')).toHaveLength(1);
  const params = { lead_ids: leads.map(row => row.id), customer_id: A };
  const proof = await Context.validateRecordTarget(params, context(), { toolName: 'bulk_update_leads', forApproval: true });
  rows.leads.reverse();
  expect(await Context.validateRecordTarget(params, proof, { toolName: 'bulk_update_leads' })).toBeNull();
  rows.leads.pop();
  expect((await Context.validateRecordTarget({ lead_ids: leads.map(row => row.id) }, context())).code).toBe('record_unavailable');
});


test('an earlier explicit target survives a later communication clause referencing the viewed customer', async () => {
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: 'Update Synthetic Person and send a reminder to this customer', pageData: { customer_id: B } });
  expect(task.target.customer_id).toBe(A);
  expect((await Context.validateRecordTarget({ customer_id: B }, task)).code).toBe('target_clarification_required');
});

test('verified city and technician words after "for" are filters, not customer names', async () => {
  rows.customers = [{ id: A, first_name: 'Synthetic', last_name: 'Person', city: 'Sarasota' }];
  rows.technicians = [{ name: 'Synthetic Tech' }];
  for (const prompt of ['Show the schedule for Sarasota', 'Show the route for Tech', 'Show the day summary for sarasota tomorrow']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect(task.namesRequested).toBe(false);
    expect(task.target).toBeNull();
    expect(await Context.prepareReadInput({ date: '2026-09-09' }, task, { toolName: 'get_schedule_view', schema: { properties: {} } })).toEqual({ input: { date: '2026-09-09' } });
  }
  // An unverified word after "for" stays a person: a misspelled name never becomes a broad read.
  expect((await Context.resolve({ prompt: 'Show the schedule for Jhon', pageData: {} })).namesRequested).toBe(true);
  // A verified word that is also a customer's name stays a person.
  rows.customers.push({ id: B, first_name: 'Sarasota', last_name: 'Family', city: 'Venice' });
  expect((await Context.resolve({ prompt: 'Show the schedule for Sarasota', pageData: {} })).namesRequested).toBe(true);
  rows.customers.pop();
  // Any selector other than "for" keeps the word a person.
  for (const prompt of ['Text Sarasota the invoice', "Show Sarasota's schedule", 'Update customer Tech', 'Tech needs a reminder']) {
    expect((await Context.resolve({ prompt, pageData: {} })).namesRequested).toBe(true);
  }
  // The synchronous hint never verifies filters on its own.
  expect(Context.namesRequested('Show the schedule for Sarasota')).toBe(true);
});

test('the operator-wide conversation search is refused inside a customer-scoped task', async () => {
  const schema = { properties: { query: { type: 'string' } } };
  const params = { query: 'refund' };
  expect(await Context.prepareReadInput(params, context(), { toolName: 'search_ib_history', schema })).toMatchObject({ code: 'customer_scope_required' });
  expect(await Context.prepareReadInput(params, { targets: [], namesRequested: true, page: { ids: {} } }, { toolName: 'search_ib_history', schema })).toMatchObject({ code: 'customer_scope_required' });
  expect(await Context.prepareReadInput(params, { targets: [], page: { ids: {} } }, { toolName: 'search_ib_history', schema })).toEqual({ input: params });
});
