jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  rescheduleSeries: jest.fn().mockResolvedValue({ rescheduledOccurrences: [] }),
  findRescheduleOptions: jest.fn().mockResolvedValue([]),
}));
jest.mock('../routes/admin-dispatch', () => ({
  applySeriesMoveEffects: jest.fn().mockResolvedValue({ notificationSent: false, notificationError: null, conflicts: [], seriesMoveId: 'sm-1' }),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue(undefined),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
}));
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(undefined),
  flushDispatchQualityDates: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn().mockResolvedValue('rendered body'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  // A real provider send always carries a Twilio sid — sent:true with a
  // sentinel/absent providerMessageId is an upstream suppression, which
  // sendMovedSms must report as NOT sent.
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true, providerMessageId: 'SMtest' }),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlook: jest.fn().mockResolvedValue(null),
  getHourlyRainOutlook: jest.fn().mockResolvedValue(null),
  forecastLinkForZip: jest.fn((zip) => (zip ? `https://forecast.weather.gov/zipcity.php?inputstring=${zip}` : null)),
}));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn().mockResolvedValue({
    url: 'https://waves.test/r/tok123',
    line: 'Need a different time? Reschedule online: https://waves.test/r/tok123\n\n',
  }),
}));
jest.mock('../services/workflows/missed-appointment', () => ({
  evaluateThreshold: jest.fn().mockResolvedValue(null),
}));
// Overlap advisory probe (conflictsForTarget) — mocked conflict-free by
// default so getOptions' same-day annotation is inert in unrelated tests;
// the overlap-advisory describe drives it per test.
jest.mock('../services/scheduling/occupancy', () => ({
  // windowsOverlap is pure interval math and IS the predicate under test —
  // requireActual it so a mock can never disagree with the SQL semantics.
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
  listOccupiedWindows: jest.fn().mockResolvedValue([]),
}));

const db = require('../models/db');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const RainOut = require('../services/rain-out');

const SERVICE = {
  id: 'svc-1',
  customer_id: 'cust-1',
  cust_id: 'cust-1',
  technician_id: 'tech-1',
  service_type: 'Quarterly Pest Control',
  status: 'on_site',
  scheduled_date: '2026-06-11',
  window_start: '09:00',
  window_end: '11:00',
  first_name: 'Pat',
  phone: '+19415551234',
  zip: '34202',
  customer_latitude: 27.4,
  customer_longitude: -82.4,
};

// Knex-ish builder: chainable methods return `this`, and the builder is
// thenable so `await query.select(...)` resolves `rows` while
// `.select(...).first()` still works.
function chain({ rows = [], ...terminal } = {}) {
  const builder = {
    where: jest.fn(function where(arg) { if (typeof arg === 'function') arg.call(builder, builder); return builder; }),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    orWhereNotIn: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orWhere: jest.fn(function orWhere(arg) { if (typeof arg === 'function') arg.call(builder, builder); return builder; }),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    ...terminal,
  };
  return builder;
}

// db(table) dispatcher backed by per-table FIFO queues.
function wireDb(queues) {
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return queue.shift();
  });
}


const dayMove = require('../services/day-only-move-notice');

describe('GATE_DAY_ONLY_PROMISE part B2: a rain move names only the day when the visit is far out', () => {
  const FAR = '2099-01-12';
  const wireSingle = () => wireDb({ scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE, scheduled_date: '2099-01-05', status: 'confirmed' }) })] });
  const commit = (over = {}) => RainOut.commit({
    serviceId: 'svc-1', technicianId: 'tech-1', reasonCode: 'weather_rain', scope: 'job',
    target: { date: FAR, window: { start: '13:00', end: '14:00' } }, notifyCustomer: true, ...over,
  });
  let decide;

  beforeEach(() => {
    jest.clearAllMocks();
    decide = jest.spyOn(dayMove, 'moveNoticeDayOnly').mockResolvedValue(true);
    renderSmsTemplate.mockResolvedValue('rendered body');
  });
  afterEach(() => { decide.mockRestore(); });

  test('far move, day-only decision: the day row, the day in {new_option} (no hour), the marker, no recorded slot', async () => {
    wireSingle();
    const result = await commit();
    expect(result.ok).toBe(true);
    const [key, vars, context] = renderSmsTemplate.mock.calls[0];
    expect(key).toBe('rain_out_moved_day_v1');
    expect(vars.new_option).toBe('Mon, Jan 12');
    expect(vars.new_option).not.toMatch(/AM|PM|:/);
    expect(vars).toEqual(expect.objectContaining({ first_name: 'Pat', service_type: 'quarterly pest control', weather_lead: expect.any(String), link_clause: expect.stringContaining('tok123') }));
    expect(context).toMatchObject({ workflow: 'tech_rain_out', entity_id: 'svc-1' });
    expect(renderSmsTemplate.mock.calls.map((c) => c[0])).toEqual(['rain_out_moved_day_v1']);
    const sent = sendCustomerMessage.mock.calls[0][0];
    expect(sent.promisedWindowUnknown).toBe(true);
    expect(sent.renderedSlotMs).toBe(Date.parse('2099-01-12T18:00:00.000Z')); // the guard still gets the slot
    expect(sent.metadata).toMatchObject({
      original_message_type: 'rain_out_moved_day_v1', templateKey: 'rain_out_moved_day_v1', promise_level: 'day', window_unknown: true,
      guard_slot_ms: Date.parse('2099-01-12T18:00:00.000Z'), promised_date: FAR,
    });
  });

  test('the decision gets the old date, the new date and the new start; no intent is named (the recorded intent decides)', async () => {
    wireSingle();
    await commit();
    const arg = decide.mock.calls[0][0];
    expect(arg).toMatchObject({ serviceId: 'svc-1', customerId: 'cust-1', oldDate: '2099-01-05', newDate: FAR });
    expect(arg.newStartAt.toISOString()).toBe('2099-01-12T18:00:00.000Z');
    expect(arg).not.toHaveProperty('intent');
  });

  test('a near move (the decision is false): today\'s v2 copy and metadata, byte for byte', async () => {
    decide.mockResolvedValue(false);
    wireSingle();
    await commit();
    expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v2');
    expect(renderSmsTemplate.mock.calls[0][1].new_option).toMatch(/PM/);
    const sent = sendCustomerMessage.mock.calls[0][0];
    expect(sent).not.toHaveProperty('promisedWindowUnknown');
    expect(Object.keys(sent.metadata).sort()).toEqual(['original_message_type', 'reason_code', 'templateKey']);
    expect(sent.renderedSlotMs).toBe(Date.parse('2099-01-12T18:00:00.000Z'));
  });

  test('a dispatcher note keeps today\'s copy and never asks the decision', async () => {
    wireSingle();
    await commit({ customerNote: 'Gate code is on file.' });
    expect(decide).not.toHaveBeenCalled();
    expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v2');
  });

  test('the day row missing or disabled: today\'s ladder renders instead, with today\'s metadata', async () => {
    renderSmsTemplate.mockImplementation(async (key) => (key === 'rain_out_moved_day_v1' ? undefined : 'rendered body'));
    wireSingle();
    await commit();
    expect(renderSmsTemplate.mock.calls.map((c) => c[0])).toEqual(['rain_out_moved_day_v1', 'rain_out_moved_v2']);
    const sent = sendCustomerMessage.mock.calls[0][0];
    expect(sent).not.toHaveProperty('promisedWindowUnknown');
    expect(sent.metadata).not.toHaveProperty('promise_level');
    expect(sent.metadata.original_message_type).toBe('rain_out_moved_v2');
  });

  test('a rain move never writes customer_asked_time', async () => {
    const writes = [];
    const row = chain({ first: jest.fn().mockResolvedValue({ ...SERVICE, scheduled_date: '2099-01-05', status: 'confirmed' }) });
    row.update = jest.fn(async (patch) => { writes.push(patch); return 1; });
    wireDb({ scheduled_services: [row] });
    await commit();
    expect(writes.filter((p) => 'customer_asked_time' in p)).toEqual([]);
  });

  test('the day-only text is listed as a proactive notice, never a human reply', () => {
    expect(require('../services/reply-training-capture').NON_HUMAN_REPLY_MESSAGE_TYPES).toContain('rain_out_moved_day_v1');
  });
});
