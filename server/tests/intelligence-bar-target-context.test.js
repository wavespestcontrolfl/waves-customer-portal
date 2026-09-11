jest.mock('../models/db', () => jest.fn());
const mockDuplicatePairEligibility = jest.fn();
jest.mock('../services/customer-dedupe', () => ({ duplicatePairEligibility: (...args) => mockDuplicatePairEligibility(...args) }));
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const REVIEW = '20000000-0000-4000-8000-000000000001';
const PROPERTY = '30000000-0000-4000-8000-000000000001';
let rows;
let lookupRows;
beforeEach(() => {
  mockDuplicatePairEligibility.mockReset().mockResolvedValue({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
  lookupRows = [];
  rows = {
    google_reviews: [{ id: REVIEW, customer_id: A, reviewer_name: 'Synthetic Reviewer' }],
    customer_properties: [{ id: PROPERTY, customer_id: B, active: true }],
    customers: [{ id: A, first_name: 'Synthetic', last_name: 'Person', version: '2026-09-01 12:00:00.123456+00' }, { id: B }],
  };
  db.mockReset().mockImplementation(table => {
    let id, ids, ownerIds, activeOnly = false, nameMatch = false, threadProjection = false;
    const q = { where: (key, value) => { if (key === 'active') activeOnly = value === true; else id = typeof key === 'object' ? key.id : value; return q; },
      first: async () => rows[table]?.find(row => row.id === id),
      whereRaw: () => { nameMatch = true; return q; }, whereNull: () => q,
      whereIn: (key, values) => { if (key === 'id') ids = values; else if (key === 'customer_id') ownerIds = values; return q; }, limit: () => q,
      distinct: () => { threadProjection = true; return q; },
      select: () => q, then: resolve => {
        const matched = ids ? (rows[table] || []).filter(row => ids.includes(row.id))
          : ownerIds ? (rows[table] || []).filter(row => ownerIds.includes(row.customer_id)) : nameMatch ? rows[table] || [] : lookupRows;
        const selected = activeOnly ? matched.filter(row => row.active === true) : matched;
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
  lookupRows = [rows.customers[0]];
  const selected = await Context.resolve({ prompt: 'Update Synthetic Person', pageData: {}, selectedTarget: { customer_id: A } });
  expect(viewed.target.version).toBe('2026-09-01 12:00:00.123456+00');
  expect(selected.target.version).toBe(viewed.target.version);
});

test('an unmatched current name refuses a stale operator selection', async () => {
  const result = await Context.resolve({ prompt: 'Update Synthetiic Person', pageData: { customer_id: A }, selectedTarget: { customer_id: A } });
  expect(result).toMatchObject({ code: 'context_mismatch' });
  lookupRows = [rows.customers[0]];
  const matching = await Context.resolve({ prompt: 'Update Synthetic Person', pageData: { customer_id: B }, selectedTarget: { customer_id: A } });
  expect(matching.target.customer_id).toBe(A);
  expect(matching.target.provenance).toBe('operator_selection');
});

test.each(['both', 'these customers', 'all of these'])('a "%s" cohort asks for clarification even when every name matches', async set => {
  lookupRows = [rows.customers[0], { id: B, first_name: 'Synthetic', last_name: 'Second' }];
  const prompt = `Update ${set} Synthetic Person and Synthetic Second to inactive`;
  expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
  expect(await Context.resolve({ prompt, pageData: { customer_id: A } })).toMatchObject({ target: null, targets: [], ambiguous: true });
  expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  // Fail closed on every set quantifier, including first-name cohorts with
  // no fresh match and sets that are not people.
  expect(await Context.resolve({ prompt: `Update ${set} the phone and email for this customer`, pageData: { customer_id: A }, selectedTarget: { customer_id: A } }))
    .toMatchObject({ code: 'context_mismatch' });
  expect(await Context.resolve({ prompt: `Text ${set} Alice and Bob`, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  expect(await Context.resolve({ prompt: `Check stock for ${set} Talstar and Bifen`, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
  const cohort = await Context.resolve({ prompt, pageData: {} });
  expect((await Context.validateRecordTarget({ customer_ids: [A, B] }, cohort, { toolName: 'move_stops_to_day' })).code).toBe('target_clarification_required');
});

test('every supported action verb supplies name evidence against a stale selection', async () => {
  for (const prompt of ['Set Synthetiic Owner inactive', 'Mark Synthetiic Owner inactive', 'Edit Synthetiic Owner', 'Make Synthetiic Owner active', 'Rename Synthetiic Owner to Alice Jones', 'Relabel Synthetiic Owner', 'Send the response to Synthetiic Owner', 'Forward the estimate to Synthetiic Owner']) {
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  }
  lookupRows = [rows.customers[0]];
  expect((await Context.resolve({ prompt: 'Set Synthetic Person inactive', pageData: {} })).target.customer_id).toBe(A);
  expect((await Context.resolve({ prompt: 'Rename Synthetic Person to Alice Jones', pageData: {} })).target.customer_id).toBe(A);
  expect((await Context.resolve({ prompt: 'Send the response to Synthetic Person', pageData: {} })).target.customer_id).toBe(A);
});

test('two distinct resolved recipients refuse a selection while duplicate rows of one name accept it', async () => {
  rows.customers[1] = { id: B, first_name: 'Second', last_name: 'Person' };
  lookupRows = [rows.customers[0], rows.customers[1]];
  const two = 'Forward the estimate to Synthetic Person and text Second Person';
  expect(await Context.resolve({ prompt: two, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
  expect(await Context.resolve({ prompt: two, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  rows.customers[1] = { id: B, first_name: 'Synthetic', last_name: 'Person' };
  lookupRows = [rows.customers[0], rows.customers[1]];
  expect(await Context.resolve({ prompt: 'Text Synthetic Person', pageData: {} })).toMatchObject({ target: null, ambiguous: true });
  expect((await Context.resolve({ prompt: 'Text Synthetic Person', pageData: {}, selectedTarget: { customer_id: B } })).target).toMatchObject({ customer_id: B, provenance: 'operator_selection' });
});

test('partly resolved compound name evidence refuses a selection and is never a target', async () => {
  lookupRows = [rows.customers[0]];
  for (const prompt of ['Update Synthetiic Person and text Synthetic Person', 'Text Synthetic Person and remind Bob', 'Update Alice Missing and also text Synthetic Person']) {
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
    expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
  }
  // A resolved clause may carry other nouns, and an evidence-free clause is not partial.
  for (const prompt of ['Schedule flea treatment for Synthetic Person', 'Invoice Synthetic Person for bed bug treatment', 'Add a note for this customer and text Synthetic Person']) {
    expect((await Context.resolve({ prompt, pageData: { customer_id: A } })).target).toMatchObject({ customer_id: A, provenance: 'current_request_lookup' });
  }
});

test('field nouns after an action are not person names', async () => {
  for (const prompt of ['Update customer status', 'Update customer billing type', 'Set autopay on', 'Change the plan frequency', 'Update customer city', 'Set waveguard tier', "Let's update this customer", 'Update customer first name', "Update this account's status", 'Update this profile', 'Send message to this customer', 'Send receipt to this customer', 'Send text to this customer', 'Text the customer about the invoice', 'What did we say to the customer on 5551234567']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect(task).toMatchObject({ candidates: [], ambiguous: false, namesRequested: false });
    expect(Context.namesRequested(prompt)).toBe(false);
  }
});

test('a selection is bound to the request\'s own fresh candidates', async () => {
  // Nothing to select from: a request that names nobody refuses any selection.
  for (const prompt of ['Update the customer', 'Update customer status', 'Update this customer']) {
    expect(await Context.resolve({ prompt, pageData: { customer_id: A }, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  }
  // Both r5 findings fail safely with and without a selection.
  for (const prompt of ['Update all accounts', 'Text every client', 'Update all of the profiles', 'Remind each active account']) {
    expect(await Context.resolve({ prompt, pageData: { customer_id: A } })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  }
  const jones = { id: B, first_name: 'Alice', last_name: 'Jones' };
  rows.customers = [rows.customers[0], jones];
  lookupRows = [jones];
  for (const prompt of ['Update Alice Missing and also text Alice Jones', 'Text Alice Jones and update Alice Missing', 'Update Alice Missing and text Alice']) {
    expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: { customer_id: B } })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: B } })).toMatchObject({ code: 'context_mismatch' });
  }
  // A whole reference equal to the customer's full name, or a bare first name, still resolves; an uppercase selection matches its lowercase candidate.
  for (const prompt of ['Text Alice Jones tomorrow and update Alice Jones', 'Update Alice Jones and text Alice']) {
    expect((await Context.resolve({ prompt, pageData: {} })).target).toMatchObject({ customer_id: B, provenance: 'current_request_lookup' });
    expect((await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: B.toUpperCase() } })).target).toMatchObject({ customer_id: B, provenance: 'operator_selection' });
  }
  // A longer reference than the stored name is unresolved, never a suffix match; an unlisted trailing word fails closed the same way.
  for (const prompt of ['Update Alice Jones Jr', 'Text Alice Jones Sr about the invoice', 'Text Alice Jones soon and update Alice Jones']) {
    expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: B } })).toMatchObject({ code: 'context_mismatch' });
  }
});

test('numeric counts and bare plural person nouns are sets', async () => {
  for (const prompt of ['Update 2 customers and this customer', 'Text three clients', 'Update customers', 'Remind a few accounts', 'Text a couple of the paused clients', 'Update 10 records']) {
    expect(await Context.resolve({ prompt, pageData: { customer_id: A } })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  }
});

test('every occurrence of a repeated name token is its own reference', async () => {
  const jones = { id: B, first_name: 'Alice', last_name: 'Jones' };
  rows.customers = [rows.customers[0], jones];
  lookupRows = [jones];
  for (const prompt of ["Forward Alice Jones's estimate to Alice Missing", 'Text Alice Jones and remind Alice Missing', 'Update Alice Missing then text Alice Jones']) {
    expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: B } })).toMatchObject({ code: 'context_mismatch' });
  }
  expect((await Context.resolve({ prompt: "Forward Alice Jones's estimate to Alice Jones", pageData: {} })).target).toMatchObject({ customer_id: B, provenance: 'current_request_lookup' });
});

test('a bare name before a function or temporal word is still a stated person', async () => {
  const jones = { id: B, first_name: 'Alice', last_name: 'Jones' };
  rows.customers = [rows.customers[0], jones];
  lookupRows = [jones];
  for (const prompt of ['Text Bob tomorrow and update Alice Jones', 'Text Bob today and update Alice Jones', 'Remind Bob next and text Alice Jones', 'Text Bob now and update Alice Jones']) {
    expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: B } })).toMatchObject({ code: 'context_mismatch' });
  }
  // A token that only modifies an object noun is not a person reference.
  expect((await Context.resolve({ prompt: 'Schedule Bermuda sod for Alice Jones', pageData: {} })).target).toMatchObject({ customer_id: B });
});

test('a surname that is also a non-name word is compared as part of the whole reference', async () => {
  const link = { id: B, first_name: 'Alice', last_name: 'Link' };
  rows.customers = [rows.customers[0], link];
  lookupRows = [link];
  for (const prompt of ['Update Alice Link Jr', 'Text Alice Link Sr about the invoice']) {
    expect(await Context.resolve({ prompt, pageData: {} })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: B } })).toMatchObject({ code: 'context_mismatch' });
  }
  for (const prompt of ['Update Alice Link', 'Text Alice Link about the invoice']) {
    expect((await Context.resolve({ prompt, pageData: {} })).target).toMatchObject({ customer_id: B, provenance: 'current_request_lookup' });
  }
});

test('a cohort noun keeps its set reading under any number of qualifiers', async () => {
  for (const prompt of ['Update all active residential lawn customers from this account', 'Text every overdue quarterly pest control client', 'Remind each of the paused monthly mosquito accounts']) {
    expect(await Context.resolve({ prompt, pageData: { customer_id: A } })).toMatchObject({ target: null, targets: [], ambiguous: true });
    expect(await Context.resolve({ prompt, pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  }
  expect((await Context.resolve({ prompt: "Update all of this customer's fields", pageData: { customer_id: A } })).target).toMatchObject({ customer_id: A });
});

test('quantifier spellings are normalized and contact literals are ignored', async () => {
  for (const prompt of ['Update all of those customers using this customer', 'Update these  customers Synthetic Person and Synthetic Second', 'Update those customers', 'Update all the customers', 'Update all of the customers', 'Text each of the customers', 'Remind every one of the customers', 'Update all active customers', 'Text each overdue customer', 'Remind all of the inactive lawn customers', 'Update all customers', 'Text each customer', 'Remind every customer']) {
    expect(await Context.resolve({ prompt, pageData: { customer_id: A } })).toMatchObject({ target: null, targets: [], ambiguous: true });
  }
  const emailed = await Context.resolve({ prompt: 'Reply to both@example.invalid', pageData: {} });
  expect(emailed).toMatchObject({ ambiguous: false, explicitEmails: ['both@example.invalid'] });
  expect(await Context.resolve({ prompt: 'Update all customers', pageData: {}, selectedTarget: { customer_id: A } })).toMatchObject({ code: 'context_mismatch' });
  lookupRows = [rows.customers[0]];
  const localPart = await Context.resolve({ prompt: 'Reply to synthetic.person@example.invalid', pageData: {} });
  expect(localPart).toMatchObject({ candidates: [], target: null, explicitEmails: ['synthetic.person@example.invalid'] });
  const nullSelection = await Context.resolve({ prompt: 'Update this customer', pageData: { customer_id: A }, selectedTarget: null });
  expect(nullSelection.target.customer_id).toBe(A);
  // A deictic qualifier names one account, not a set.
  expect((await Context.resolve({ prompt: "Update all of this customer's fields", pageData: { customer_id: A } })).target.customer_id).toBe(A);
});

test('a broken page hint fails closed for a page-referencing request even with a selection', async () => {
  expect(await Context.resolve({ prompt: 'Update this customer', pageData: { customer_id: 'not-a-uuid' }, selectedTarget: { customer_id: A } }))
    .toMatchObject({ code: 'invalid_page_context' });
});
const context = (customerId = A) => ({ targets: customerId ? [{ customer_id: customerId }] : [], page: { ids: {} } });

test('explicit child identifiers constrain same-customer choices and exclude message content', async () => {
  const one = 'abcdef01-0000-4000-8000-000000000001';
  const two = 'abcdef01-0000-4000-8000-000000000002';
  rows.estimates = [{ id: one, customer_id: A }, { id: two, customer_id: A }];
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: `Revise estimate ${one.toUpperCase()} for Synthetic Person`, pageData: { estimate_id: two } });
  expect(await Context.validateRecordTarget({ estimate_id: one }, task, { toolName: 'update_customer' })).toBeNull();
  expect(await Context.validateRecordTarget({ estimate_id: two }, task, { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
  const multiple = await Context.resolve({ prompt: `Revise estimate ${one} and estimate ${two} for Synthetic Person`, pageData: {} });
  expect(await Context.validateRecordTarget({ estimate_id: two }, multiple, { toolName: 'update_customer' })).toBeNull();
  const note = await Context.resolve({ prompt: `Add a note for Synthetic Person saying estimate ${two} needs attention`, pageData: {} });
  expect(note.requestedRecords).toEqual({});
  for (const noun of [`this estimate`, `estimate ${one}`]) {
    for (const content of ['mentioning', 'referencing', 'containing', 'with', 'reading', 'for the office about']) {
      const inline = await Context.resolve({ prompt: `Revise ${noun} for Synthetic Person and add a note ${content} estimate ${two}`, pageData: { estimate_id: one } });
      expect(await Context.validateRecordTarget({ estimate_id: one }, inline, { toolName: 'update_customer' })).toBeNull();
      expect(await Context.validateRecordTarget({ estimate_id: two }, inline, { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
    }
  }
  const conflicting = await Context.resolve({ prompt: `Revise this estimate or estimate ${two} for Synthetic Person`, pageData: { estimate_id: one } });
  expect(await Context.validateRecordTarget({ estimate_id: two }, conflicting, { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
  const attachedNote = await Context.resolve({ prompt: `Revise estimate ${one} for Synthetic Person with a note containing estimate ${two}`, pageData: {} });
  expect(await Context.validateRecordTarget({ estimate_id: one }, attachedNote, { toolName: 'update_customer' })).toBeNull();
  expect(await Context.validateRecordTarget({ estimate_id: two }, attachedNote, { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
});

test('a later that-estimate constraint survives filtering unrelated page hints', async () => {
  const id = 'abcdef01-0000-4000-8000-000000000001';
  rows.estimates = [{ id, customer_id: A }];
  const task = await Context.resolve({ prompt: 'Update this customer and revise that estimate', pageData: { customer_id: A, estimate_id: id } });
  expect(task.requestedRecords.estimate_id).toBe(id);
  expect(await Context.validateRecordTarget({ estimate_id: id }, task, { toolName: 'update_customer' })).toBeNull();
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
  expect(task.candidates).toEqual([]);
  expect(task.targets).toEqual([]);
  expect(task.ambiguous).toBe(true);
  const capped = await Context.resolve({ prompt: 'Update Synthetic', pageData: {}, selectedTarget: { customer_id: lookupRows[0].id } });
  expect(capped).toMatchObject({ code: 'context_mismatch' });
  lookupRows[9] = { id: B, first_name: 'Synthetic', last_name: 'Incidental' };
  const incomplete = await Context.resolve({ prompt: `Update both ${lookupRows.slice(0, 9).map(c => `${c.first_name} ${c.last_name}`).join(' and ')} and Synthetic MissingOne and Synthetic MissingTwo after checking with Synthetic Incidental`, pageData: {} });
  expect(incomplete.candidates).toEqual([]);
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
    expect(await Context.validateRecordTarget({ estimate_id: one }, task, { toolName: 'update_customer' })).toBeNull();
    expect(await Context.validateRecordTarget({ estimate_id: two }, task, { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
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
    expect((await Context.validateRecordTarget({ customer_id: A }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
  }
  const missing = await Context.resolve({ prompt: `Update this ${noun}`, pageData: {} });
  expect((await Context.validateRecordTarget({ [`${noun}_id`]: id }, missing, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
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
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
  expect(await Context.validateRecordTarget({ review_id: REVIEW }, context(), { toolName: 'update_customer' })).toBeNull();
});

test('read preparation checks a review with no selected customer instead of accepting a guessed ID', async () => {
  rows.google_reviews[0].customer_id = null;
  const args = { toolName: 'draft_review_reply', schema: { properties: { review_id: { type: 'string' } } } };
  expect((await Context.prepareReadInput({ review_id: REVIEW }, context(null), args)).code).toBe('target_clarification_required');
  const selected = await Context.resolve({ prompt: 'Reply to this review', pageData: { review_id: REVIEW } });
  expect(await Context.prepareReadInput({ review_id: REVIEW }, selected, args)).toEqual({ input: { review_id: REVIEW } });
  const explicit = await Context.resolve({ prompt: `Reply to review ${REVIEW}`, pageData: {} });
  expect(await Context.validateRecordTarget({ review_id: REVIEW }, explicit, { toolName: 'update_customer' })).toBeNull();
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, { ...context(), page: selected.page }, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
});

test.each(['this', 'that', 'selected'])('a deliberate %s review request uses the viewed review', async word => {
  rows.google_reviews[0].customer_id = null;
  const task = await Context.resolve({ prompt: `Reply to ${word} review`, pageData: { review_id: REVIEW } });
  expect(task.reviewReference).toBe(REVIEW);
  expect(await Context.validateRecordTarget({ review_id: REVIEW }, task, { toolName: 'update_customer' })).toBeNull();
});

test.each(['missing', 'stats', 'removed', 'dismissed'])('unavailable review (%s) cannot be drafted or posted', async kind => {
  if (kind === 'missing') rows.google_reviews = [];
  if (kind === 'dismissed') rows.google_reviews[0].dismissed = true;
  if (kind === 'stats') rows.google_reviews[0].reviewer_name = '_stats';
  if (kind === 'removed') rows.google_reviews[0].missing_since = new Date().toISOString();
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, context(), { toolName: 'update_customer' })).code).toBe('record_unavailable');
});

test('malformed identifiers refuse before a query, and child relationships are checked separately', async () => {
  expect((await Context.validateRecordTarget({ review_id: 'invalid' }, context(), { toolName: 'update_customer' })).code).toBe('invalid_target');
  expect(db).not.toHaveBeenCalled();
  expect((await Context.validateRecordTarget({ customer_id: A, property_id: PROPERTY }, context(), { toolName: 'update_customer' })).code).toBe('target_relationship_mismatch');
});

test.each([['lead', 'leads', { first_name: 'Synthetic', last_name: 'Unlinkedfixture' }],
  ['estimate', 'estimates', { customer_name: 'Synthetic Unlinkedfixture' }]])('an unlinked %s needs a deliberate target expression', async (noun, table, name) => {
  const id = '40000000-0000-4000-8000-000000000001';
  rows[table] = [{ id, customer_id: null, ...name }];
  for (const prompt of ['Look up inventory', 'Add a note: Synthetic Unlinkedfixture needs attention', 'Add a note saying Synthetic Unlinkedfixture needs attention']) {
    const task = await Context.resolve({ prompt, pageData: { [`${noun}_id`]: id } });
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: id }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
  }
  for (const prompt of [`Update this ${noun}`, `Update that ${noun}`, 'Update Synthetic Unlinkedfixture']) {
    const task = await Context.resolve({ prompt, pageData: { [`${noun}_id`]: id } });
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: id }, task, { toolName: 'update_customer' })).toBeNull();
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
  expect((await Context.validateRecordTarget({ review_id: REVIEW }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
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
      toolName = 'update_lead_status'; params = { lead_id: recordId, updates: { status: 'new' } };
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
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: id }, task, { toolName: 'update_customer' })).toBeNull();
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: sibling }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
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
  expect(await Context.validateRecordTarget({ customer_id: A }, task, { toolName: 'update_customer' })).toBeNull();
});


test('this customer resolves through a viewed property without requiring a redundant page customer ID', async () => {
  const task = await Context.resolve({ prompt: 'Text this customer', pageData: { property_id: PROPERTY } });
  expect(task.target.customer_id).toBe(B);
  expect(task.requestedRecords).toEqual({});
  expect(await Context.validateRecordTarget({ customer_id: B }, task, { toolName: 'update_customer' })).toBeNull();
});


test.each(['Text this customer', 'Email this customer', 'Send this customer a text', 'Update this customer and text them', 'Remind this customer', 'Notify this customer', 'Tell this customer'])(
  'a customer name in the body after "%s that" cannot choose the target', async prefix => {
    lookupRows = [rows.customers[0]]; // A real matching alternate name is available to the lookup.
    const task = await Context.resolve({ prompt: `${prefix} that customer Synthetic Person canceled`, pageData: { customer_id: B } });
    expect(task.target.customer_id).toBe(B);
    expect((await Context.validateRecordTarget({ customer_id: A }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
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
    // An explicitly named customer who did not resolve keeps the request customer-scoped.
    expect(await Context.validateRecordTarget(params, { targets: [], namesRequested: true }, { toolName })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.validateRecordTarget(params, { targets: [] }, { toolName })).toBeNull();
  }
});

test('payout details, payout exports and the open-closeout sweep list other customers and are refused inside a customer-scoped task', async () => {
  const schema = { properties: { payout_id: { type: 'string' } } };
  for (const toolName of ['get_payout_details', 'export_payouts', 'list_open_closeouts']) {
    expect(await Context.prepareReadInput({}, context(), { toolName, schema })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput({}, { targets: [], namesRequested: true, page: { ids: {} } }, { toolName, schema })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput({}, { targets: [], page: { ids: {} } }, { toolName, schema })).toEqual({ input: {} });
  }
});

test('keyed readers fail closed for a customer-specific request whose customer did not resolve', async () => {
  const schema = { properties: { phone: { type: 'string' }, email: { type: 'string' } } };
  for (const [toolName, params] of [['get_partner_call_history', { phone: '5550001234' }], ['check_email_suppression', { email: 'someone@example.test' }]]) {
    expect(await Context.prepareReadInput(params, { targets: [], namesRequested: true, page: { ids: {} } }, { toolName, schema })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput(params, { targets: [], contactRequested: true, page: { ids: {} } }, { toolName, schema })).toMatchObject({ code: 'customer_scope_required' });
    // A request that names nobody keeps the reader; a resolved task customer still owns the key.
    expect(await Context.prepareReadInput(params, { targets: [], page: { ids: {} } }, { toolName, schema })).toEqual({ input: params });
    expect((await Context.prepareReadInput(params, context(), { toolName, schema })).code).toBe('target_clarification_required');
  }
});

test('a name lookup at its cap is answered without selectable candidates', async () => {
  lookupRows = Array.from({ length: 10 }, (_, i) => ({ id: `50000000-0000-4000-8000-${String(i).padStart(12, '0')}`, first_name: 'Synthetic', last_name: `Cohort${i}` }));
  for (const prompt of ['Update Synthetic', 'Show Synthetic details']) {
    const capped = await Context.resolve({ prompt, pageData: {} });
    expect(capped).toMatchObject({ code: 'target_clarification_required', candidates: [], targets: [], target: null, ambiguous: false });
    expect(capped.selectable).toBeUndefined();
  }
  // One row under the cap keeps the duplicate-name choice.
  lookupRows = lookupRows.slice(0, 9);
  const open = await Context.resolve({ prompt: 'Update Synthetic', pageData: {} });
  expect(open.ambiguous).toBe(true);
  expect(open.candidates).toHaveLength(9);
  expect(open.error).toBeUndefined();
});

test('a phone or email literal keeps a request customer-specific for broad readers', async () => {
  const schema = { properties: { limit: { type: 'number' } } };
  for (const prompt of ['Show the outstanding balance for 941-555-0123', 'What does synthetic.person@example.invalid owe', 'Check the balance on (941) 555-0123']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect(task.contactRequested).toBe(true);
    expect(await Context.prepareReadInput({}, task, { toolName: 'get_outstanding_balances', schema })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput({}, task, { toolName: 'search_ib_history', schema })).toMatchObject({ code: 'customer_scope_required' });
  }
  const broad = await Context.resolve({ prompt: 'Show the outstanding balances', pageData: {} });
  expect(broad.contactRequested).toBe(false);
  expect(await Context.prepareReadInput({}, broad, { toolName: 'get_outstanding_balances', schema })).toEqual({ input: {} });
});

test('a read that names its customer through a record noun and preposition resolves', async () => {
  lookupRows = [rows.customers[0]];
  for (const prompt of ['Show me the conversation with Synthetic Person', 'Read the messages from Synthetic Person', 'Pull up the latest emails from Synthetic Person',
    'Show the full call history of Synthetic Person', 'Get the text thread between Synthetic Person and us', 'Check the balance of Synthetic Person']) {
    expect((await Context.resolve({ prompt, pageData: {} })).target).toMatchObject({ customer_id: A, provenance: 'current_request_lookup' });
  }
});

test('a sender block inside a customer-scoped task is bound to the task customer\'s own address', async () => {
  rows.customers[0].email = 'Synthetic.Person@example.invalid';
  const scoped = { targets: [{ customer_id: A }] };
  expect(await Context.validateSenderBlock({ domain: 'example.invalid' }, scoped)).toMatchObject({ code: 'target_relationship_mismatch' });
  expect(await Context.validateSenderBlock({ email_address: 'other@example.invalid' }, scoped)).toMatchObject({ code: 'target_clarification_required' });
  expect(await Context.validateSenderBlock({}, scoped)).toMatchObject({ code: 'target_clarification_required' });
  expect(await Context.validateSenderBlock({ email_address: 'synthetic.person@example.invalid' }, scoped)).toBeNull();
  expect(await Context.validateSenderBlock({ domain: 'example.invalid' }, { targets: [] })).toBeNull();
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
  // A reader that touches no customer rows (scope none) keeps its own target checks.
  expect(await Context.prepareReadInput({ date: '2026-09-09' }, unresolved, { toolName: 'get_todays_activity', schema })).toEqual({ input: { date: '2026-09-09' } });
  // A reader the catalog does not know fails closed everywhere, resolved or not.
  expect(await Context.prepareReadInput({ date: '2026-09-09' }, unresolved, { toolName: 'get_zone_capacity', schema })).toMatchObject({ code: 'scope_unclassified' });
  expect(await Context.prepareReadInput({ date: '2026-09-09' }, context(), { toolName: 'get_zone_capacity', schema })).toMatchObject({ code: 'scope_unclassified' });
  expect(await Context.prepareReadInput({ date: '2026-09-09' }, { targets: [], page: { ids: {} } }, { toolName: 'get_zone_capacity', schema })).toMatchObject({ code: 'scope_unclassified' });
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
  // The closeout readers' service_id is an appointment selector: it passes the scope guard and reaches the record proof.
  const appointment = '40000000-0000-4000-8000-000000000009';
  rows.scheduled_services = [{ id: appointment, customer_id: B }];
  const closeout = { properties: { service_id: { type: 'string' } } };
  expect((await Context.prepareReadInput({ service_id: appointment }, unresolved, { toolName: 'get_closeout_status', schema: closeout })).code).toBe('target_clarification_required');
  expect(await Context.prepareReadInput({ service_id: appointment }, context(B), { toolName: 'get_closeout_status', schema: closeout })).toEqual({ input: { service_id: appointment } });
  expect((await Context.prepareReadInput({}, unresolved, { toolName: 'get_closeout_status', schema: closeout })).code).toBe('customer_scope_required');
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
  expect(await Context.validateRecordTarget({ appointment_id: appointment }, task, { toolName: 'update_customer' })).toBeNull();
});


test('a compound communication request retains a narrowing appointment constraint after that', async () => {
  const viewed = '40000000-0000-4000-8000-000000000005', sibling = '40000000-0000-4000-8000-000000000006';
  rows.scheduled_services = [{ id: viewed, customer_id: B }, { id: sibling, customer_id: B }];
  const task = await Context.resolve({ prompt: 'Text this customer and reschedule that appointment', pageData: { appointment_id: viewed } });
  expect(await Context.validateRecordTarget({ appointment_id: viewed }, task, { toolName: 'update_customer' })).toBeNull();
  expect((await Context.validateRecordTarget({ appointment_id: sibling }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
});


test('selector-free customer reads inherit one resolved task target and never choose from a cohort', async () => {
  const args = { toolName: 'get_call_log', schema: { properties: { customer_id: { type: 'string' } } } };
  expect(await Context.prepareReadInput({ days_back: 7 }, context(), args)).toEqual({ input: { days_back: 7, customer_id: A } });
  expect(await Context.prepareReadInput({ days_back: 7 }, context(null), args)).toEqual({ input: { days_back: 7 } });
  lookupRows = [rows.customers[0], { id: B, first_name: 'Synthetic', last_name: 'Second' }];
  const cohort = await Context.resolve({ prompt: 'Show call logs for both Synthetic Person and Synthetic Second', pageData: {} });
  expect((await Context.prepareReadInput({ days_back: 7 }, cohort, args)).code).toBe('target_clarification_required');
  const firstNames = await Context.resolve({ prompt: 'Show messages for both Alice and Bob', pageData: {} });
  expect((await Context.prepareReadInput({ days_back: 7 }, firstNames, args)).code).toBe('target_clarification_required');
  lookupRows = [rows.customers[0], { id: B, first_name: 'Synthetic', last_name: 'Person' }];
  const duplicate = await Context.resolve({ prompt: 'Update Synthetic Person', pageData: {}, selectedTarget: { customer_id: B } });
  expect(duplicate.target).toMatchObject({ customer_id: B, provenance: 'operator_selection' });
  const emailed = await Context.resolve({ prompt: 'Reply to synthetic@example.invalid', pageData: {} });
  expect(emailed).toMatchObject({ ambiguous: false, explicitEmails: ['synthetic@example.invalid'], contactRequested: true });
  // An email literal that matched nobody is a scope refusal too: the selector-free read has no customer to inherit.
  expect((await Context.prepareReadInput({ days_back: 7 }, emailed, args)).code).toBe('customer_scope_required');
  const unmatched = await Context.resolve({ prompt: 'Show call logs for Synthetiic Person', pageData: { customer_id: A } });
  expect(unmatched).toMatchObject({ target: null, targets: [], ambiguous: false, namesRequested: true });
  // The unresolved explicit name is a scope refusal (r18): correct the name before reading.
  expect((await Context.prepareReadInput({ days_back: 7 }, unmatched, args)).code).toBe('customer_scope_required');
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
  expect(await Context.validateRecordTarget({ lead_ids: leads.map(row => row.id), customer_id: A }, context(), { toolName: 'update_customer' })).toBeNull();
  expect(db.mock.calls.filter(([table]) => table === 'leads')).toHaveLength(1);
  expect(db.mock.calls.filter(([table]) => table === 'customers')).toHaveLength(1);
  const params = { lead_ids: leads.map(row => row.id), customer_id: A };
  const proof = await Context.validateRecordTarget(params, context(), { toolName: 'bulk_update_leads', forApproval: true });
  rows.leads.reverse();
  expect(await Context.validateRecordTarget(params, proof, { toolName: 'bulk_update_leads' })).toBeNull();
  rows.leads.pop();
  expect((await Context.validateRecordTarget({ lead_ids: leads.map(row => row.id) }, context(), { toolName: 'update_customer' })).code).toBe('record_unavailable');
});


test('an earlier explicit target survives a later communication clause referencing the viewed customer', async () => {
  lookupRows = [rows.customers[0]];
  const task = await Context.resolve({ prompt: 'Update Synthetic Person and send a reminder to this customer', pageData: { customer_id: B } });
  expect(task.target.customer_id).toBe(A);
  expect((await Context.validateRecordTarget({ customer_id: B }, task, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
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

// ─── Scope catalog enforcement matrix (scope-policy.js) ─────────────────
// One representative per declared class, exercised for a resolved task
// customer, an explicitly named customer who did not resolve, and a request
// that names nobody. The class comes from action-policy.json, not from a
// list in task-context.js, so a reclassification changes behavior here.
test('each read scope class enforces its rule for resolved, unresolved and unnamed customers', async () => {
  const { scopeOf } = require('../services/intelligence-bar/scope-policy');
  const schema = { properties: { limit: { type: 'number' } } };
  const resolved = context();
  const unresolved = { targets: [], namesRequested: true, candidates: [], page: { ids: {} } };
  const unnamed = { targets: [], page: { ids: {} } };
  const code = async (toolName, ctx, params = {}) => (await Context.prepareReadInput(params, ctx, { toolName, schema })).code ?? 'ok';
  const matrix = [
    // [tool, scope, resolved, unresolved, unnamed]
    ['get_kpi_snapshot', 'none', 'ok', 'ok', 'ok'],
    ['get_outstanding_balances', 'broad', 'customer_scope_required', 'customer_scope_required', 'ok'],
    ['search_ib_history', 'actor_wide', 'customer_scope_required', 'customer_scope_required', 'ok'],
    ['query_customers', 'scoped', 'ok', 'customer_scope_required', 'ok'],
    ['get_service_history', 'record', 'ok', 'customer_scope_required', 'ok'],
    ['get_partner_call_history', 'phone_keyed', 'target_clarification_required', 'customer_scope_required', 'ok'],
    ['check_email_suppression', 'email_keyed', 'target_clarification_required', 'customer_scope_required', 'ok'],
  ];
  for (const [toolName, scope, whenResolved, whenUnresolved, whenUnnamed] of matrix) {
    expect({ toolName, scope: scopeOf(toolName) }).toEqual({ toolName, scope });
    expect({ toolName, resolved: await code(toolName, resolved) }).toEqual({ toolName, resolved: whenResolved });
    expect({ toolName, unresolved: await code(toolName, unresolved) }).toEqual({ toolName, unresolved: whenUnresolved });
    expect({ toolName, unnamed: await code(toolName, unnamed) }).toEqual({ toolName, unnamed: whenUnnamed });
  }
  // A record reader that carries its own selector is admitted for an unresolved name and checked against the task's authority.
  expect(await code('get_service_history', unresolved, { customer_id: A })).toBe('target_clarification_required');
  expect(await code('get_service_history', resolved, { customer_id: A })).toBe('ok');
});

test('write scope classes are enforced for resolved and unresolved customers and an unclassified writer never proposes', async () => {
  const { scopeOf } = require('../services/intelligence-bar/scope-policy');
  const unresolved = { targets: [], namesRequested: true };
  expect(scopeOf('optimize_all_routes')).toBe('route_wide');
  expect((await Context.validateRecordTarget({ date: '2026-09-09' }, context(), { toolName: 'optimize_all_routes' })).code).toBe('customer_scope_required');
  expect((await Context.validateRecordTarget({ date: '2026-09-09' }, unresolved, { toolName: 'optimize_all_routes' })).code).toBe('customer_scope_required');
  // A phone or email literal that resolved nobody keeps the task customer-specific, like the read guards.
  for (const toolName of ['optimize_all_routes', 'optimize_tech_route', 'swap_tech_assignments']) {
    expect((await Context.validateRecordTarget({ date: '2026-09-09' }, { targets: [], contactRequested: true }, { toolName })).code).toBe('customer_scope_required');
    expect((await Context.validateRecordTarget({ date: '2026-09-09' }, { targets: [], contactRequested: true }, { toolName, forApproval: true })).code).toBe('customer_scope_required');
  }
  expect(await Context.validateRecordTarget({ date: '2026-09-09' }, { targets: [] }, { toolName: 'optimize_all_routes' })).toBeNull();
  expect(scopeOf('update_customer')).toBe('record');
  expect(await Context.validateRecordTarget({ customer_id: A, updates: {} }, context(), { toolName: 'update_customer' })).toBeNull();
  expect((await Context.validateRecordTarget({ customer_id: A, updates: {} }, unresolved, { toolName: 'update_customer' })).code).toBe('target_clarification_required');
  expect(scopeOf('adjust_stock')).toBe('none');
  expect(await Context.validateRecordTarget({ quantity: 1 }, context(), { toolName: 'adjust_stock' })).toBeNull();
  for (const ctx of [context(), unresolved, { targets: [] }]) {
    expect(await Context.validateRecordTarget({ customer_id: A }, ctx, { toolName: 'update_lead' })).toMatchObject({ code: 'scope_unclassified' });
    expect(await Context.validateRecordTarget({ customer_id: A }, ctx, { toolName: 'update_lead', forApproval: true })).toMatchObject({ code: 'scope_unclassified' });
    // The two-argument form names no tool and is refused the same way, so no caller can skip the scope check.
    expect(await Context.validateRecordTarget({ customer_id: A }, ctx)).toMatchObject({ code: 'scope_unclassified' });
    expect(await Context.validateRecordTarget({ date: '2026-09-09' }, ctx, { forApproval: true })).toMatchObject({ code: 'scope_unclassified' });
  }
});

test('a phone or email literal that resolved nobody fails scoped and selector-free record readers closed', async () => {
  const schema = { properties: { customer_id: { type: 'string' }, days_back: { type: 'number' } } };
  for (const prompt of ['Show the outstanding balance for 941-555-0123', 'What does synthetic.person@example.invalid owe']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect(task).toMatchObject({ contactRequested: true, namesRequested: false, targets: [] });
    expect(await Context.prepareReadInput({}, task, { toolName: 'query_customers', schema: { properties: {} } })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput({ days_back: 7 }, task, { toolName: 'get_call_log', schema })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.prepareReadInput({ days_back: 7 }, task, { toolName: 'get_service_history', schema })).toMatchObject({ code: 'customer_scope_required' });
    // A reader that touches no customer rows is unaffected.
    expect(await Context.prepareReadInput({}, task, { toolName: 'get_kpi_snapshot', schema: { properties: {} } })).toEqual({ input: {} });
  }
});

test('a vendor, lead source or marketing channel after "for" is a filter, not an unresolved customer', async () => {
  rows.vendors = [{ name: 'SiteOne Landscape Supply' }];
  rows.lead_sources = [{ name: 'Door Hangers', channel: 'print' }];
  rows.expenses = [{ vendor_name: 'Univar' }, { vendor_name: 'Jiffy Lube' }];
  for (const prompt of ['Show expenses for SiteOne', 'Show ad attribution for Facebook', 'Show acquisition for print', 'Show expenses for Univar', 'Show attribution for Hangers', 'Show expenses for Jiffy Lube']) {
    const task = await Context.resolve({ prompt, pageData: {} });
    expect({ prompt, namesRequested: task.namesRequested, targets: task.targets }).toEqual({ prompt, namesRequested: false, targets: [] });
    expect(await Context.prepareReadInput({}, task, { toolName: 'get_expenses', schema: { properties: {} } })).toEqual({ input: {} });
  }
  // An unverified word stays a person reference and the broad reader fails closed; a vendor word that is
  // also a customer's name stays a person reference.
  const unresolved = await Context.resolve({ prompt: 'Show expenses for Jhon', pageData: {} });
  expect(unresolved.namesRequested).toBe(true);
  expect((await Context.prepareReadInput({}, unresolved, { toolName: 'get_expenses', schema: { properties: {} } })).code).toBe('customer_scope_required');
  rows.customers.push({ id: '10000000-0000-4000-8000-000000000009', first_name: 'Univar', last_name: 'Person' });
  expect((await Context.resolve({ prompt: 'Show expenses for Univar', pageData: {} })).namesRequested).toBe(true);
});

test('an explicitly addressed unlinked sender can be drafted a reply by email id even though the contact resolved no customer', async () => {
  const email = '50000000-0000-4000-8000-000000000021';
  rows.emails = [{ id: email, customer_id: null, lead_id: null, from_address: 'Vendor@Example.invalid', gmail_thread_id: null }];
  const schema = { properties: { email_id: { type: 'string' }, instructions: { type: 'string' } } };
  const params = { email_id: email, instructions: 'Thank them' };
  const addressed = { targets: [], contactRequested: true, explicitEmails: ['vendor@example.invalid'], page: { ids: {} } };
  expect(await Context.prepareReadInput(params, addressed, { toolName: 'draft_email_reply', schema })).toEqual({ input: params });
  // A different explicit address, no explicit address, or no email id at all stays closed.
  expect((await Context.prepareReadInput(params, { ...addressed, explicitEmails: ['other@example.invalid'] }, { toolName: 'draft_email_reply', schema })).code).toBe('target_clarification_required');
  expect((await Context.prepareReadInput(params, { ...addressed, explicitEmails: [] }, { toolName: 'draft_email_reply', schema })).code).toBe('target_clarification_required');
  expect((await Context.prepareReadInput({ instructions: 'Thank them' }, addressed, { toolName: 'draft_email_reply', schema })).code).toBe('customer_scope_required');
  // A name or phone selector does not reopen a scoped reader for an unresolved contact.
  expect((await Context.prepareReadInput({ phone: '5550001234' }, addressed, { toolName: 'match_existing_customer', schema: { properties: { phone: { type: 'string' } } } })).code).toBe('customer_scope_required');
});

test('an unlinked review is drafted only when the current request named it and no customer target is set', async () => {
  const unlinked = '20000000-0000-4000-8000-000000000002';
  rows.google_reviews.push({ id: unlinked, customer_id: null, reviewer_name: 'Synthetic Unlinked' });
  const schema = { properties: { review_id: { type: 'string' } } };
  const read = (params, ctx) => Context.prepareReadInput(params, ctx, { toolName: 'draft_review_reply', schema });
  // A customer-scoped task never binds an unlinked review, named or not.
  expect((await read({ review_id: unlinked }, context(A))).code).toBe('target_clarification_required');
  expect((await read({ review_id: unlinked }, { ...context(A), reviewReference: unlinked })).code).toBe('target_clarification_required');
  // Without a target the review must be the one the current request named.
  expect(await read({ review_id: unlinked }, { targets: [], reviewReference: unlinked, page: { ids: {} } })).toEqual({ input: { review_id: unlinked } });
  expect((await read({ review_id: unlinked }, { targets: [], page: { ids: {} } })).code).toBe('target_clarification_required');
  expect((await read({ review_id: unlinked }, { targets: [], reviewReference: REVIEW, page: { ids: {} } })).code).toBe('target_clarification_required');
  // A review linked to the task customer binds through its customer.
  expect(await read({ review_id: REVIEW }, context(A))).toEqual({ input: { review_id: REVIEW } });
  expect((await read({ review_id: REVIEW }, context(B))).code).toBe('target_clarification_required');
});

test('compute_estimate binds its lead to the task customer', async () => {
  const lead = '60000000-0000-4000-8000-000000000001';
  rows.leads = [{ id: lead, customer_id: B, first_name: 'Synthetic', last_name: 'Lead' }];
  const schema = { properties: { leadId: { type: 'string' }, services: { type: 'array' } } };
  const params = { leadId: lead, services: ['pest'] };
  expect((await Context.prepareReadInput(params, context(), { toolName: 'compute_estimate', schema })).code).toBe('target_clarification_required');
  expect(await Context.prepareReadInput(params, context(B), { toolName: 'compute_estimate', schema })).toEqual({ input: params });
  // Without a lead there is nothing to bind and the pricing engine stays available.
  expect(await Context.prepareReadInput({ services: ['pest'] }, context(), { toolName: 'compute_estimate', schema })).toEqual({ input: { services: ['pest'] } });
  const unresolved = { targets: [], namesRequested: true, candidates: [], page: { ids: {} } };
  expect((await Context.prepareReadInput({ services: ['pest'] }, unresolved, { toolName: 'compute_estimate', schema })).code).toBe('customer_scope_required');
});

test('address-keyed readers take only a task customer\'s own active saved address and receive the saved full address', async () => {
  Object.assign(rows.customers[0], { address_line1: '1234 Main St.', city: 'Bradenton', state: 'FL', zip: '34203' });
  rows.customers[1] = { id: B, address_line1: '40 Tower Ct', address_line2: 'Apt 12', city: 'Sarasota', state: 'FL', zip: '34236' };
  const C = '10000000-0000-4000-8000-000000000003';
  rows.customers.push({ id: C, address_line1: '123 Main St' });
  rows.customer_properties.push({ id: '30000000-0000-4000-8000-000000000006', customer_id: C, address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34205', active: true });
  rows.customer_properties.push(
    { id: '30000000-0000-4000-8000-000000000002', customer_id: A, address_line1: '99 Beach Rd', address_line2: 'Apt 4', city: 'Venice', state: 'FL', zip: '34285', active: true },
    { id: '30000000-0000-4000-8000-000000000003', customer_id: A, address_line1: '7 Old Rd', city: 'Venice', state: 'FL', zip: '34285', active: false },
  );
  const schema = { properties: { address: { type: 'string' } } };
  const read = (address, ctx) => Context.prepareReadInput({ address }, ctx, { toolName: 'lookup_property', schema });
  const main = '1234 Main St., Bradenton, FL 34203';
  const beach = '99 Beach Rd, Apt 4, Venice, FL 34285';
  // Matching addresses are rewritten to the saved full address (canonical street forms, bare street line, ZIP-only tail).
  expect(await read('1234 Main St, Bradenton FL 34203', context())).toEqual({ input: { address: main } });
  expect(await read('1234 Main Street, Bradenton FL', context())).toEqual({ input: { address: main } });
  expect(await read('1234 Main St', context())).toEqual({ input: { address: main } });
  expect(await read('1234 Main St 34203', context())).toEqual({ input: { address: main } });
  expect(await read('99 BEACH RD APT 4, Venice FL', context())).toEqual({ input: { address: beach } });
  // A unit stored on the customer row itself (no property row) is part of the saved address.
  expect(await read('40 Tower Ct Apt 12, Sarasota FL', context(B))).toEqual({ input: { address: '40 Tower Ct, Apt 12, Sarasota, FL 34236' } });
  expect((await read('40 Tower Ct, Sarasota FL', context(B))).code).toBe('target_clarification_required');
  expect((await read('40 Tower Ct Apt 13, Sarasota FL', context(B))).code).toBe('target_clarification_required');
  // A different city, state or ZIP on the same street line is a different parcel.
  expect((await read('1234 Main St, Tampa FL', context())).code).toBe('target_clarification_required');
  expect((await read('1234 Main St, Bradenton FL 34205', context())).code).toBe('target_clarification_required');
  expect((await read('99 Beach Rd Apt 4, Venice CA', context())).code).toBe('target_clarification_required');
  expect((await read('1234 Main St, Bradenton GA 34203', context())).code).toBe('target_clarification_required');
  // A state segment the parser cannot recognise is an unverifiable locality, not "no state supplied".
  expect((await read('99 Beach Rd Apt 4, Venice, ZZ 34285', context())).code).toBe('target_clarification_required');
  expect((await read('99 Beach Rd Apt 4, Venice, Ontario', context())).code).toBe('target_clarification_required');
  expect(await read('99 Beach Rd Apt 4, Venice, Florida 34285', context())).toEqual({ input: { address: beach } });
  expect(await read('99 Beach Rd Apt 4, Venice, FL 34285, USA', context())).toEqual({ input: { address: beach } });
  expect(await read('99 Beach Rd Apt 4, Venice, FL 34285, United States', context())).toEqual({ input: { address: beach } });
  expect(await read('99 Beach Rd Apt 4, Venice, FL 34285 USA', context())).toEqual({ input: { address: beach } });
  expect((await read('99 Beach Rd Apt 4, Venice, ZZ 34285 USA', context())).code).toBe('target_clarification_required');
  for (const country of ['US', 'U.S.', 'U.S.A.', 'United States of America', 'usa.']) {
    expect(await read(`99 Beach Rd Apt 4, Venice, FL 34285, ${country}`, context())).toEqual({ input: { address: beach } });
  }
  expect((await read('99 Beach Rd Apt 4, Venice, ZZ 34285, USA', context())).code).toBe('target_clarification_required');
  // A supplied component the saved row cannot verify (a ZIP against a city-only row) is refused; the row still binds
  // for the components it has, and a comma-free post-directional is not read as a city.
  rows.customer_properties.push({ id: '30000000-0000-4000-8000-000000000007', customer_id: A, address_line1: '8 Cove Way', city: 'Venice', state: 'FL', active: true },
    { id: '30000000-0000-4000-8000-000000000008', customer_id: A, address_line1: '100 53rd Ave E', city: 'Bradenton', state: 'FL', zip: '34203', active: true });
  expect(await read('8 Cove Way, Venice FL', context())).toEqual({ input: { address: '8 Cove Way, Venice, FL' } });
  expect((await read('8 Cove Way 34285', context())).code).toBe('target_clarification_required');
  expect((await read('8 Cove Way, Venice FL 34285', context())).code).toBe('target_clarification_required');
  expect(await read('100 53rd Ave E', context())).toEqual({ input: { address: '100 53rd Ave E, Bradenton, FL 34203' } });
  // The unit must match exactly: the building or another unit is not this property.
  expect((await read('99 Beach Rd, Venice FL', context())).code).toBe('target_clarification_required');
  expect((await read('99 Beach Rd Apt 5, Venice FL', context())).code).toBe('target_clarification_required');
  // A saved row with neither city nor ZIP cannot verify a locality, so it never binds; a complete row for the same
  // street still does, and only for its own locality.
  expect(await read('123 Main St, Bradenton FL 34205', context(C))).toEqual({ input: { address: '123 Main St, Bradenton, FL 34205' } });
  expect((await read('123 Main St, Tampa FL 33601', context(C))).code).toBe('target_clarification_required');
  rows.customer_properties = rows.customer_properties.filter(row => row.id !== '30000000-0000-4000-8000-000000000006');
  expect((await read('123 Main St, Tampa FL 33601', context(C))).code).toBe('target_clarification_required');
  expect((await read('123 Main St', context(C))).code).toBe('target_clarification_required');
  // A bare street line matching two different saved parcels binds neither; the locality picks one. The customer row
  // and a property row for the SAME parcel are one match.
  rows.customer_properties.push(
    { id: '30000000-0000-4000-8000-000000000011', customer_id: A, address_line1: '77 Twin St', city: 'Venice', state: 'FL', zip: '34285', active: true },
    { id: '30000000-0000-4000-8000-000000000012', customer_id: A, address_line1: '77 Twin St', city: 'Sarasota', state: 'FL', zip: '34236', active: true },
    { id: '30000000-0000-4000-8000-000000000013', customer_id: A, address_line1: '1234 Main St', city: 'Bradenton', state: 'FL', zip: '34203', active: true });
  expect((await read('77 Twin St', context())).code).toBe('target_clarification_required');
  expect(await read('77 Twin St, Sarasota', context())).toEqual({ input: { address: '77 Twin St, Sarasota, FL 34236' } });
  expect(await read('1234 Main St', context())).toEqual({ input: { address: main } });
  // An inactive property, a different house number, another customer's property and an empty address are refused.
  expect((await read('7 Old Rd, Venice FL', context())).code).toBe('target_clarification_required');
  expect((await read('12345 Main St', context())).code).toBe('target_clarification_required');
  expect((await read('1234 Main St, Bradenton FL', context(B))).code).toBe('target_clarification_required');
  expect((await read('', context())).code).toBe('target_clarification_required');
  expect((await read('1234 Main St', { targets: [], namesRequested: true, page: { ids: {} } })).code).toBe('customer_scope_required');
  expect((await read('1234 Main St', { targets: [], contactRequested: true, page: { ids: {} } })).code).toBe('customer_scope_required');
  // Outside a customer-scoped task the lookup is open (new leads have no saved address yet).
  expect(await read('500 Anywhere Ave', { targets: [], page: { ids: {} } })).toEqual({ input: { address: '500 Anywhere Ave' } });
});

test('the slot finder inside a customer-scoped task is pinned to the task customer\'s own location', async () => {
  Object.assign(rows.customers[0], { address_line1: '1234 Main St', address_line2: 'Unit 7', city: 'Bradenton', state: 'FL', zip: '34203', latitude: '27.4989000', longitude: '-82.5748000' });
  rows.customer_properties.push(
    { id: '30000000-0000-4000-8000-000000000004', customer_id: A, address_line1: '99 Beach Rd', city: 'Venice', state: 'FL', zip: '34285', latitude: '27.0998000', longitude: '-82.4543000', active: true },
    { id: '30000000-0000-4000-8000-000000000005', customer_id: A, address_line1: '5 Pier Ln', city: 'Venice', state: 'FL', zip: '34285', latitude: null, longitude: null, active: true },
  );
  const schema = { properties: { customer_id: { type: 'string' }, address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, date_from: { type: 'string' } } };
  const read = (params, ctx) => Context.prepareReadInput(params, ctx, { toolName: 'find_available_slots', schema });
  // Supplied coordinates are dropped and the destination becomes the task customer.
  expect(await read({ lat: 27.1, lng: -82.4, date_from: '2026-09-10' }, context())).toEqual({ input: { customer_id: A, date_from: '2026-09-10' } });
  expect(await read({ customer_id: A, lat: 27.1, lng: -82.4 }, context())).toEqual({ input: { customer_id: A } });
  // A supplied address must be one of the customer's saved properties (the customer row's own unit counts) and is
  // replaced by the saved full address plus that property's stored coordinates.
  expect(await read({ address: '1234 Main Street Unit 7, Bradenton' }, context()))
    .toEqual({ input: { customer_id: A, address: '1234 Main St, Unit 7, Bradenton, FL 34203', lat: 27.4989, lng: -82.5748 } });
  expect((await read({ address: '1234 Main Street, Bradenton' }, context())).code).toBe('target_clarification_required');
  // A secondary property carries ITS coordinates, and a model-supplied pair never overrides them.
  expect(await read({ address: '99 Beach Rd, Venice', lat: 27.1, lng: -82.4 }, context()))
    .toEqual({ input: { customer_id: A, address: '99 Beach Rd, Venice, FL 34285', lat: 27.0998, lng: -82.4543 } });
  // A property without stored coordinates passes only its address, which the executor geocodes instead of using the primary.
  expect(await read({ address: '5 Pier Ln, Venice FL' }, context())).toEqual({ input: { customer_id: A, address: '5 Pier Ln, Venice, FL 34285' } });
  expect((await read({ address: '500 Anywhere Ave, Tampa FL' }, context())).code).toBe('target_clarification_required');
  expect((await read({ address: '1234 Main St, Tampa FL' }, context())).code).toBe('target_clarification_required');
  // Another customer's id is still a relationship failure, and an unresolved name still fails closed.
  expect((await read({ customer_id: B, lat: 27.1, lng: -82.4 }, context())).code).toBe('target_clarification_required');
  expect((await read({ lat: 27.1, lng: -82.4 }, { targets: [], namesRequested: true, page: { ids: {} } })).code).toBe('customer_scope_required');
  // Outside a customer-scoped task the destination is whatever the operator asked about.
  expect(await read({ lat: 27.1, lng: -82.4 }, { targets: [], page: { ids: {} } })).toEqual({ input: { lat: 27.1, lng: -82.4 } });
});

test('the gap reader\'s candidate appointment is an appointment reference bound to the task customer', async () => {
  const appointment = '40000000-0000-4000-8000-000000000031';
  rows.scheduled_services = [{ id: appointment, customer_id: B }];
  const schema = { properties: { date: { type: 'string' }, candidate_service_id: { type: 'string' } } };
  const read = (params, ctx) => Context.prepareReadInput(params, ctx, { toolName: 'find_schedule_gaps', schema });
  expect(await read({ date: '2026-09-09', candidate_service_id: appointment }, context(B))).toEqual({ input: { date: '2026-09-09', candidate_service_id: appointment } });
  expect((await read({ date: '2026-09-09', candidate_service_id: appointment }, context(A))).code).toBe('target_clarification_required');
  expect((await read({ date: '2026-09-09', candidate_service_id: appointment }, { targets: [], page: { ids: {} } })).code).toBe('target_clarification_required');
  expect((await read({ date: '2026-09-09', candidate_service_id: appointment }, { targets: [], namesRequested: true, page: { ids: {} } })).code).toBe('target_clarification_required');
  // Without a candidate the reader returns minute budgets only (the executor strips stop ids), so a date-only call
  // stays open for a resolved, unnamed, or unresolved task ("gaps for Labor Day" reads "Labor" as a name).
  expect(await read({ date: '2026-09-09' }, context(A))).toEqual({ input: { date: '2026-09-09' } });
  expect(await read({ date: '2026-09-09' }, { targets: [], page: { ids: {} } })).toEqual({ input: { date: '2026-09-09' } });
  expect(await read({ date: '2026-09-09' }, { targets: [], namesRequested: true, page: { ids: {} } })).toEqual({ input: { date: '2026-09-09' } });
  expect(await read({ date: '2026-09-09' }, { targets: [], contactRequested: true, page: { ids: {} } })).toEqual({ input: { date: '2026-09-09' } });
  // A candidate with an unresolved name still has nobody to bind to.
  expect((await read({ date: '2026-09-09', candidate_service_id: appointment }, { targets: [], contactRequested: true, page: { ids: {} } })).code).toBe('target_clarification_required');
});

test('merge_customers binds both role-named ids as customer records of the task', async () => {
  const task = await Context.resolve({ prompt: 'Merge the duplicate stub into this customer', pageData: { customer_id: A } });
  expect(task.target.customer_id).toBe(A);

  // (a) Task on winner A; loser B is an ELIGIBLE duplicate-queue candidate
  // under this exact pairing — admitted, not refused.
  mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: [] } });
  const eligibleOnWinner = await Context.validateRecordTarget({ winner_customer_id: A, loser_customer_id: B }, context(A), { toolName: 'merge_customers' });
  expect(eligibleOnWinner).toBeNull();
  expect(mockDuplicatePairEligibility).toHaveBeenCalledWith(A, B);

  // (b) Same pairing, but INELIGIBLE (red/not-in-queue/address-conflict —
  // any non-eligible outcome): the loser stays outside the task's authority
  // and the request is refused like any other foreign record.
  mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'red_pair', reason: 'looks like two different people', candidate: { tier: 'red', reasons: [] } });
  const ineligibleOnWinner = await Context.validateRecordTarget({ winner_customer_id: A, loser_customer_id: B }, context(A), { toolName: 'merge_customers' });
  expect(ineligibleOnWinner.code).toBe('target_clarification_required');

  // (c) Task on the LOSER instead of the winner — the operator can be on
  // either the stub page or the real customer's page. Eligible → admitted,
  // and the winner/loser argument order to the eligibility check is still
  // exactly (winner, loser) regardless of which half the task permits.
  mockDuplicatePairEligibility.mockClear();
  mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: [] } });
  const eligibleOnLoser = await Context.validateRecordTarget({ winner_customer_id: A, loser_customer_id: B }, context(B), { toolName: 'merge_customers' });
  expect(eligibleOnLoser).toBeNull();
  expect(mockDuplicatePairEligibility).toHaveBeenCalledWith(A, B);

  // (c2) Uppercase-but-valid UUIDs (Codex #4348 r5 P2): task targets are
  // canonical lowercase, so the pair is normalized before the permitted
  // and eligibility checks — admitted, with the canonical pair passed on.
  mockDuplicatePairEligibility.mockClear();
  mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: [] } });
  const upper = await Context.validateRecordTarget({ winner_customer_id: A.toUpperCase(), loser_customer_id: B.toUpperCase() }, context(A), { toolName: 'merge_customers' });
  expect(upper).toBeNull();
  expect(mockDuplicatePairEligibility).toHaveBeenCalledWith(A, B);

  // (d) Neither id is the task's customer: refused outright, no eligibility
  // check needed (there's no established target to widen from).
  mockDuplicatePairEligibility.mockClear();
  const neitherPermitted = await Context.validateRecordTarget({ winner_customer_id: A, loser_customer_id: B }, { targets: [], page: { ids: {} } }, { toolName: 'merge_customers' });
  expect(neitherPermitted.code).toBe('target_clarification_required');
  expect(mockDuplicatePairEligibility).not.toHaveBeenCalled();

  // The ids are read as records: a vanished loser is a record_unavailable, not a pass.
  rows.customers = rows.customers.filter(row => row.id !== B);
  const vanished = await Context.validateRecordTarget({ winner_customer_id: A, loser_customer_id: B }, task, { toolName: 'merge_customers' });
  expect(vanished.code).toBe('record_unavailable');
});
