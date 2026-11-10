// The hourly follow-up check (csr-coach verifyFollowUps) on a real Postgres
// (CI's DB-gated step, DATABASE_URL): a past-deadline task closes only on the
// action it asked for or on a visit the customer booked (owner 2026-11-05,
// "fix 2"), never on an automatic text, the customer's own later call or a
// call-log note. Fixtures fictitious.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const OUR_NUMBER = '+15555550100';
const HOUR = 60 * 60 * 1000;
jest.setTimeout(60000);

maybeDescribe('follow-up tasks close only on the asked action or a booking (live Postgres)', () => {
  let db;
  let coach;
  let seq = 0;
  let callSeq = 0;
  const made = { customers: [], tasks: [], sms: [], calls: [], estimates: [], visits: [], interactions: [] };
  // Every task is made 30 h ago with a 24 h deadline, so the check takes it.
  const T0 = Date.now() - 30 * HOUR;
  const at = (hours) => new Date(T0 + hours * HOUR);

  beforeAll(() => {
    db = require('../models/db');
    coach = require('../services/csr/csr-coach');
  });
  afterAll(async () => {
    const del = async (table, ids) => { if (ids.length) await db(table).whereIn('id', ids).del(); };
    await del('ai_follow_up_tasks', made.tasks);
    await del('customer_interactions', made.interactions);
    await del('sms_log', made.sms);
    await del('call_log', made.calls);
    await del('estimates', made.estimates);
    await del('scheduled_services', made.visits);
    await del('customers', made.customers);
    await db.destroy();
  });

  async function world(taskType, { customer = true, deadline = at(24) } = {}) {
    seq += 1;
    const n = `${Date.now().toString().slice(-5)}${String(seq).padStart(3, '0')}`;
    const phone = `+1555${n.slice(-7)}`;
    let customerId = null;
    if (customer) {
      const [row] = await db('customers').insert({ first_name: `Follow${n}`, phone, email: `follow${n}@example.invalid` }).returning('id');
      customerId = row.id;
      made.customers.push(customerId);
    }
    const [task] = await db('ai_follow_up_tasks').insert({
      customer_id: customerId, task_type: taskType, recommended_action: 'Reach the customer about the open quote',
      status: 'pending', deadline, created_at: at(0),
    }).returning('id');
    made.tasks.push(task.id);
    return { n, phone, customerId, taskId: task.id };
  }
  const task = (w) => db('ai_follow_up_tasks').where({ id: w.taskId }).first();

  // A text a person wrote in the composer: 'manual' plus the human_authored stamp.
  const staffText = async (w, when, extra = {}) => {
    const [r] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: w.customerId, message_type: 'manual', status: 'delivered',
      message_body: 'Following up on your quote.', metadata: JSON.stringify({ human_authored: true }), created_at: when, ...extra,
    }).returning('id');
    made.sms.push(r.id);
  };
  // Automated senders reuse 'manual' with no stamp (staff-contact.js).
  const autoText = (w, when) => staffText(w, when, { message_body: 'Reminder: your visit is tomorrow.', metadata: JSON.stringify({}) });
  // A call placed through the staff bridge that reached the customer; it
  // ended 120 s after its row was made.
  const call = async (w, when, extra = {}) => {
    callSeq += 1;
    const [r] = await db('call_log').insert({
      twilio_call_sid: `CF${w.n}${String(callSeq).padStart(4, '0')}${'6'.repeat(24)}`.slice(0, 34), direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone,
      status: 'completed', duration_seconds: 120, customer_id: w.customerId, created_at: when, source: 'admin-click', v2_extraction_status: 'valid',
      ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }), ...extra,
    }).returning('id');
    made.calls.push(r.id);
  };
  const callEnded = (when) => new Date(when.getTime() + 120 * 1000);
  // The automatic "Inbound call" row the recording processor writes.
  const note = async (w, when, interaction_type = 'call') => {
    const [r] = await db('customer_interactions').insert({ customer_id: w.customerId, interaction_type, subject: 'Inbound call', created_at: when }).returning('id');
    made.interactions.push(r.id);
  };
  const estimate = async (w, { sentAt, deliveredAt = null }) => {
    const [r] = await db('estimates').insert({
      status: 'sent', customer_id: w.customerId, customer_phone: w.phone, sent_at: sentAt, created_at: at(1),
      estimate_data: JSON.stringify(deliveredAt ? { deliveryState: { firstDeliveredAt: deliveredAt.toISOString(), lastDeliveredAt: deliveredAt.toISOString() } } : {}),
    }).returning('id');
    made.estimates.push(r.id);
  };
  const visit = async (w, when, extra = {}) => {
    const [r] = await db('scheduled_services').insert({
      scheduled_date: '2026-12-01', service_type: 'General Pest Control', status: 'pending', customer_id: w.customerId, created_at: when, ...extra,
    }).returning('id');
    made.visits.push(r.id);
    return r;
  };
  const expectExpired = async (w) => expect(await task(w)).toMatchObject({ status: 'expired', action_verified: false });
  const expectVerified = async (w, method, completedAt) => expect(await task(w)).toMatchObject({
    status: 'verified', action_verified: true, verification_method: method, completed_at: completedAt,
  });

  test('send_sms: an automatic text, a text before the task and a call-log note do not close it; a text a person sent does', async () => {
    const auto = await world('send_sms');
    await autoText(auto, at(2));
    await staffText(auto, at(-1));
    await note(auto, at(3));
    await note(auto, at(3), 'note');
    const staff = await world('send_sms');
    await staffText(staff, at(5));
    await coach.verifyFollowUps();
    await expectExpired(auto);
    await expectVerified(staff, 'sms_log_match', at(5));
  });

  test('call_back: the customer calling in, an automatic call, a voicemail and a text do not close it; a call a person placed does', async () => {
    const inbound = await world('call_back');
    await call(inbound, at(2), { direction: 'inbound', from_phone: inbound.phone, to_phone: OUR_NUMBER, source: null, answered_by: 'human' });
    const robot = await world('call_back');
    await call(robot, at(2), { source: 'collections_voice' });
    const voicemail = await world('call_back');
    await call(voicemail, at(2), { ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) });
    const textOnly = await world('call_back');
    await staffText(textOnly, at(2));
    const staff = await world('call_back');
    await call(staff, at(4));
    await coach.verifyFollowUps();
    for (const w of [inbound, robot, voicemail, textOnly]) await expectExpired(w);
    await expectVerified(staff, 'call_log_match', callEnded(at(4)));
  });

  test('send_estimate: an estimate stamped sent that never reached the customer does not close it; one handed off does', async () => {
    const unsent = await world('send_estimate');
    await estimate(unsent, { sentAt: at(2) });
    const sent = await world('send_estimate');
    await estimate(sent, { sentAt: at(3), deliveredAt: at(3) });
    await coach.verifyFollowUps();
    await expectExpired(unsent);
    await expectVerified(sent, 'estimate_match', at(3));
  });

  test('a booking closes any type; schedule_inspection closes only on one; a series visit or a cancelled visit is no booking', async () => {
    const textOnly = await world('schedule_inspection');
    await staffText(textOnly, at(2));
    const inspection = await world('schedule_inspection');
    await visit(inspection, at(6));
    const callBack = await world('call_back');
    await visit(callBack, at(7));
    const seriesOnly = await world('send_sms');
    const parent = await visit(seriesOnly, at(-48), { status: 'completed' });
    await visit(seriesOnly, at(2), { recurring_parent_id: parent.id });
    const cancelled = await world('send_sms');
    await visit(cancelled, at(2), { status: 'cancelled' });
    await coach.verifyFollowUps();
    for (const w of [textOnly, seriesOnly, cancelled]) await expectExpired(w);
    await expectVerified(inspection, 'visit_match', at(6));
    await expectVerified(callBack, 'visit_match', at(7));
  });

  test('the earliest proof sets completed_at', async () => {
    const w = await world('escalate_to_adam');
    await call(w, at(9));
    await staffText(w, at(6));
    await visit(w, at(4));
    const later = await world('escalate_to_adam');
    await staffText(later, at(3));
    await visit(later, at(8));
    await coach.verifyFollowUps();
    await expectVerified(w, 'visit_match', at(4));
    await expectVerified(later, 'sms_log_match', at(3));
  });

  test('a task with no customer expires; one still inside its deadline is left alone', async () => {
    const unlinked = await world('call_back', { customer: false });
    const open = await world('call_back', { deadline: new Date(Date.now() + 2 * HOUR) });
    await call(open, at(2));
    await coach.verifyFollowUps();
    await expectExpired(unlinked);
    expect(await task(open)).toMatchObject({ status: 'pending', action_verified: false });
  });
});
