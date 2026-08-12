jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  rescheduleSeries: jest.fn().mockResolvedValue({ rescheduledOccurrences: [] }),
  findRescheduleOptions: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(undefined),
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

const db = require('../models/db');
const MissedAppointment = require('../services/workflows/missed-appointment');
const SmartRebooker = require('../services/rebooker');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { getDailyRainOutlook, getHourlyRainOutlook } = require('../services/weather-forecast');
const { buildRescheduleLink } = require('../services/reschedule-link');
const { etDateString } = require('../utils/datetime-et');
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
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
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

describe('rain-out service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('weather lead composition', () => {
    const lead = RainOut._test.composeWeatherLead;

    test('same-day push speaks present tense with part of day', () => {
      expect(lead({ reasonCode: 'weather_rain', isSameDay: true, hour: 9, todayChance: 85 }))
        .toBe('rain is moving through your area this morning');
      expect(lead({ reasonCode: 'weather_rain', isSameDay: true, hour: 14, todayChance: null }))
        .toBe('rain is moving through your area this afternoon');
    });

    test('day move quotes the NWS chance when meaningful', () => {
      expect(lead({ reasonCode: 'weather_rain', isSameDay: false, hour: 9, todayChance: 85 }))
        .toBe('storms are likely today (85% chance)');
      expect(lead({ reasonCode: 'weather_rain', isSameDay: false, hour: 9, todayChance: 45 }))
        .toBe("rain is in today's forecast (45% chance)");
    });

    test('no forecast degrades to an honest generic, never a weather claim', () => {
      expect(lead({ reasonCode: 'weather_rain', isSameDay: false, hour: 9, todayChance: null }))
        .toBe("the weather isn't cooperating today");
      expect(lead({ reasonCode: 'weather_rain', isSameDay: false, hour: 9, todayChance: 10 }))
        .toBe("the weather isn't cooperating today");
    });

    test('non-rain reasons state the operational constraint', () => {
      expect(lead({ reasonCode: 'weather_wind', isSameDay: true, hour: 9 }))
        .toBe('winds are too high to spray safely today');
      expect(lead({ reasonCode: 'weather_lightning', isSameDay: false, hour: 9 }))
        .toBe("there's lightning in the area");
      expect(lead({ reasonCode: 'weather_heat', isSameDay: false, hour: 9 }))
        .toBe("today's heat is too extreme to treat safely");
    });
  });

  describe('better-day clause', () => {
    const clause = RainOut._test.composeBetterDayClause;
    const base = {
      reasonCode: 'weather_rain', isSameDay: false, todayStr: '2026-06-11', chosenDate: '2026-06-13',
    };

    test('fires only when the forecast supports it, with tiered wording', () => {
      expect(clause({ ...base, todayChance: 85, newChance: 20 }))
        .toBe(' Saturday looks a lot better - just a 20% chance of rain.');
      expect(clause({ ...base, todayChance: 85, newChance: 35 }))
        .toBe(' Saturday looks better - a 35% chance of rain.');
      // Unknown today still allows a low-chance claim about the new day.
      expect(clause({ ...base, todayChance: null, newChance: 15 }))
        .toBe(' Saturday looks a lot better - just a 15% chance of rain.');
    });

    test('tomorrow is called Tomorrow', () => {
      expect(clause({ ...base, chosenDate: '2026-06-12', todayChance: 85, newChance: 10 }))
        .toBe(' Tomorrow looks a lot better - just a 10% chance of rain.');
    });

    test('stays silent on weak or unsupported forecasts', () => {
      expect(clause({ ...base, todayChance: 85, newChance: 45 })).toBe('');        // new day not good enough
      expect(clause({ ...base, todayChance: 50, newChance: 35 })).toBe('');        // delta too small
      expect(clause({ ...base, todayChance: 85, newChance: null })).toBe('');      // no data
      expect(clause({ ...base, isSameDay: true, todayChance: 85, newChance: 10 })).toBe('');
      expect(clause({ ...base, reasonCode: 'weather_heat', todayChance: 85, newChance: 10 })).toBe('');
    });

    test('hourly window chance upgrades the claim to morning/afternoon specificity', () => {
      expect(clause({ ...base, todayChance: 85, windowChance: 10, windowStart: '08:00' }))
        .toBe(' Saturday morning looks a lot better - just a 10% chance of rain around your new time.');
      expect(clause({ ...base, todayChance: 85, windowChance: 35, windowStart: '13:00' }))
        .toBe(' Saturday afternoon looks better - a 35% chance of rain around your new time.');
      expect(clause({ ...base, chosenDate: '2026-06-12', todayChance: 85, windowChance: 15, windowStart: '15:00' }))
        .toBe(' Tomorrow afternoon looks a lot better - just a 15% chance of rain around your new time.');
    });

    test('same-day push can promise later today, with a tighter cap', () => {
      const sameDay = { ...base, isSameDay: true, chosenDate: '2026-06-11' };
      expect(clause({ ...sameDay, todayChance: 85, windowChance: 15, windowStart: '15:00' }))
        .toBe(' Later today looks a lot better - just a 15% chance of rain around your new time.');
      // Same storm system: window claims over 30% stay silent on same-day moves.
      expect(clause({ ...sameDay, todayChance: 85, windowChance: 35, windowStart: '15:00' })).toBe('');
    });

    test('window claims still respect the today-delta rule and fall back to day-level without hourly data', () => {
      expect(clause({ ...base, todayChance: 45, windowChance: 30, windowStart: '08:00' })).toBe(''); // delta < 20
      expect(clause({ ...base, todayChance: 85, windowChance: null, newChance: 20 }))
        .toBe(' Saturday looks a lot better - just a 20% chance of rain.'); // day-level fallback
    });
  });

  describe('windowRainChance', () => {
    const windowChance = RainOut._test.windowRainChance;
    const HOURS = [
      { startTime: '2026-06-13T07:00:00-04:00', rainChance: 60 },
      { startTime: '2026-06-13T08:00:00-04:00', rainChance: 10 },
      { startTime: '2026-06-13T09:00:00-04:00', rainChance: 25 },
      { startTime: '2026-06-13T10:00:00-04:00', rainChance: 70 },
      { startTime: '2026-06-14T08:00:00-04:00', rainChance: 5 },
    ];

    test('takes the max over the 2-hour arrival window on the right date', () => {
      expect(windowChance(HOURS, '2026-06-13', '08:00')).toBe(25); // hours 8+9
      expect(windowChance(HOURS, '2026-06-13', '09:00')).toBe(70); // hours 9+10
      expect(windowChance(HOURS, '2026-06-14', '08:00')).toBe(5);  // other date's periods ignored
    });

    test('a half-hour start samples every hour the window touches', () => {
      // 08:30 arrival window runs 08:30-10:30 → hours 8, 9 AND 10; missing
      // hour 10 (70%) would have understated the claim.
      expect(windowChance(HOURS, '2026-06-13', '08:30')).toBe(70);
    });

    test('null on missing coverage or bad input', () => {
      expect(windowChance(HOURS, '2026-06-13', '14:00')).toBeNull(); // no periods for that window
      expect(windowChance(null, '2026-06-13', '08:00')).toBeNull();
      expect(windowChance(HOURS, '2026-06-13', 'garbage')).toBeNull();
    });
  });

  describe('efficacy clause (GATE_RAINOUT_EFFICACY_NOTE)', () => {
    const clause = RainOut._test.composeEfficacyClause;
    afterEach(() => { delete process.env.GATE_RAINOUT_EFFICACY_NOTE; });

    test('dark by default', () => {
      expect(clause({ reasonCode: 'weather_rain', serviceType: 'Quarterly Pest Control' })).toBe('');
    });

    test('gated on: rain + spray service gets the why-note; exempt work and non-rain do not', () => {
      process.env.GATE_RAINOUT_EFFICACY_NOTE = 'true';
      expect(clause({ reasonCode: 'weather_rain', serviceType: 'Quarterly Pest Control' }))
        .toContain('rain-free hours to bond');
      expect(clause({ reasonCode: 'weather_rain', serviceType: 'Termite Bait Check' })).toBe('');
      expect(clause({ reasonCode: 'weather_rain', serviceType: 'Interior Flea Treatment' })).toBe('');
      expect(clause({ reasonCode: 'weather_wind', serviceType: 'Quarterly Pest Control' })).toBe('');
    });
  });

  describe('rain_out_moved_v2 template migration', () => {
    const { transformBody } = require('../models/migrations/20260719000010_rain_out_moved_v2_template')._test;
    // Verbatim prod body of the LEGACY row (read-only prod query, 2026-07-18)
    // — the v2 body is derived from it so admin copy edits carry over.
    const PROD_BODY = 'Hello {first_name} — {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.\n\nReply STOP to opt out.';

    test('derives the v2 body from the live legacy body, preserving surrounding copy', () => {
      const next = transformBody(PROD_BODY);
      expect(next).toBe('Hello {first_name} — {weather_lead}, so we moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.\n\nReply STOP to opt out.');
      expect(transformBody(next)).toBe(next); // idempotent
    });

    test('a diverged legacy body passes through untouched', () => {
      const custom = 'Totally rewritten by the admin.';
      expect(transformBody(custom)).toBe(custom);
    });
  });

  describe('sameDayOptions', () => {
    test('mid-morning offers +2h and +4h on-the-hour 1-hour windows', () => {
      // 14:10Z = 10:10 ET → +2h = 12:10 → nearest hour 12:00; +4h = 14:10 → 14:00.
      // Windows are 1 hour, on the hour (matches how appointments are booked).
      const options = RainOut._test.sameDayOptions(new Date('2026-06-11T14:10:00Z'));
      expect(options).toHaveLength(2);
      expect(options[0].window).toEqual({ start: '12:00', end: '13:00' });
      expect(options[1].window).toEqual({ start: '14:00', end: '15:00' });
      expect(options[0].date).toBe('2026-06-11');
    });

    test('late afternoon stops offering same-day starts after 5 PM ET', () => {
      // 20:40Z = 16:40 ET → +2h = 18:40 > 17:00 → nothing
      const options = RainOut._test.sameDayOptions(new Date('2026-06-11T20:40:00Z'));
      expect(options).toHaveLength(0);
    });
  });

  describe('commit — single job', () => {
    function wireSingle() {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });
    }

    test('books the tight 1-hour slot but texts the 2-hour arrival window, passes allowLive, reschedule + forecast links', async () => {
      wireSingle();
      // Day move (2026-06-11 is not the real today): the lead should quote
      // today's chance and the better-day clause should sell the booked
      // window specifically (hourly beats the day-level 20%).
      getDailyRainOutlook.mockResolvedValueOnce({
        [etDateString()]: { rainChance: 85, shortForecast: 'Thunderstorms' },
        '2026-06-11': { rainChance: 20, shortForecast: 'Mostly Sunny' },
      });
      getHourlyRainOutlook.mockResolvedValueOnce([
        { startTime: '2026-06-11T13:00:00-04:00', rainChance: 10 },
        { startTime: '2026-06-11T14:00:00-04:00', rainChance: 5 },
      ]);

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        // On-the-hour 1-hour internal slots (what the dispatcher picked).
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
      });

      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(1);

      // The appointment is BOOKED as the tight 1-hour slot the dispatcher saw.
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-11', { start: '13:00', end: '14:00' }, 'weather_rain', 'tech',
        // excludeServiceIds = the row being moved ONLY, so the rebooker's
        // tech-blind occupancy check never clashes a move against the row's
        // own pre-move position — and sees every OTHER committed row.
        { allowLive: true, excludeServiceIds: ['svc-1'] },
      );

      // ...but the CUSTOMER is quoted the usual 2-hour arrival window from the
      // start (13:00 → 1:00-3:00 PM), never the internal 1-hour end.
      // Renders the forecast-grounded v2 template seeded by this PR's
      // migration; the untouched legacy row is only a fallback.
      expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v2');
      const vars = renderSmsTemplate.mock.calls[0][1];
      expect(vars.weather_lead).toBe('storms are likely today (85% chance)');
      expect(vars.better_day_clause).toBe(' Thursday afternoon looks a lot better - just a 10% chance of rain around your new time.');
      expect(vars.efficacy_clause).toBe(''); // gate dark
      expect(getDailyRainOutlook).toHaveBeenCalledWith(27.4, -82.4);
      expect(getHourlyRainOutlook).toHaveBeenCalledWith(27.4, -82.4);
      expect(vars.new_option).toContain('1:00 PM - 3:00 PM');
      // Moved-first: nothing to confirm by reply — the message carries only
      // the same tokenized self-serve link the 72h/24h reminders send.
      expect(vars.alt_clause).toBe(' Need a different time? Reschedule online: https://waves.test/r/tok123');
      expect(buildRescheduleLink).toHaveBeenCalledWith('svc-1', { customerId: 'cust-1' });
      expect(vars.forecast_clause).toContain('forecast.weather.gov/zipcity.php?inputstring=34202');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('an ABSENT v2 template row falls back to the legacy row with legacy variables', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        // v2 render nulls and the row is truly gone (rolled-back migration).
        sms_templates: [chain({ first: jest.fn().mockResolvedValue(undefined) })],
      });
      renderSmsTemplate.mockResolvedValueOnce(null);

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
      });

      expect(result.results[0].smsSent).toBe(true);
      expect(renderSmsTemplate).toHaveBeenCalledTimes(2);
      expect(renderSmsTemplate.mock.calls[1][0]).toBe('rain_out_moved');
      const legacyVars = renderSmsTemplate.mock.calls[1][1];
      expect(legacyVars.weather_phrase).toBe('heavy rain');
      expect(legacyVars.weather_lead).toBeUndefined();
    });

    test('a DISABLED v2 template row is the kill switch — no legacy reroute, no SMS', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        // v2 render nulls but the row EXISTS (admin disabled it).
        sms_templates: [chain({ first: jest.fn().mockResolvedValue({ id: 'tpl-v2' }) })],
      });
      renderSmsTemplate.mockResolvedValueOnce(null);

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
      });

      // The move still commits; the send is stopped, not rerouted.
      expect(result.results[0]).toMatchObject({ ok: true, smsSent: false, smsReason: 'missing_template' });
      expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('stamps the v2 key as the per-template kill-switch messageType, never the retired legacy key', async () => {
      wireSingle();

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
      });

      // twilio.js isTemplateActive keys on original_message_type. The legacy
      // rain_out_moved row is retired (is_active=false), so stamping the
      // legacy key suppresses every send as a sentinel "success" — the
      // 2026-07-19 incident where the first real rain-out never texted.
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
        original_message_type: 'rain_out_moved_v2',
        reason_code: 'weather_rain',
      });
    });

    test('a suppression sentinel provider id reports smsSent:false, not a phantom send', async () => {
      wireSingle();
      sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'template-disabled' });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
      });

      // The move still commits; the sheet must show the customer was NOT told.
      expect(result.results[0]).toMatchObject({ ok: true, smsSent: false, smsReason: 'template-disabled' });
    });

    test('no reschedule token falls back to a reply-to-adjust clause', async () => {
      wireSingle();
      buildRescheduleLink.mockResolvedValueOnce({ url: null, line: '' });

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
      });

      const vars = renderSmsTemplate.mock.calls[0][1];
      expect(vars.alt_clause).toBe(' Need a different time? Reply to this message.');
    });

    test('same-day route push shifts siblings by the anchor window delta', async () => {
      const logRow = chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) });
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [
            { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30', window_end: '13:30', customer_id: 'cust-2', service_type: 'Lawn Care' },
          ] }),
        ],
        customers: [
          chain({ first: jest.fn().mockResolvedValue({ id: 'cust-2', phone: '+19415550002', first_name: 'Sam', zip: '34203' }) }),
        ],
        reschedule_log: [logRow, chain()],
      });

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-11', window: { start: '13:00', end: '15:00' } },
        notifyCustomer: true,
      });

      // Anchor 09:00→13:00 = +4h delta; sibling 11:30-13:30 → 15:30-17:30.
      // Tail-first: the later sibling moves BEFORE the anchor so the anchor's
      // new 13:00-15:00 slot isn't blocked by the not-yet-moved sibling.
      // Exclusion = the current row ONLY, every move: the moved sibling's
      // committed 15:30 position stays visible to the anchor's probe (real
      // occupancy — the tail-first target math is what guarantees the
      // anchor's 13:00 target clears it, not an exclusion).
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-2', '2026-06-11', { start: '15:30', end: '17:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-1', '2026-06-11', { start: '13:00', end: '15:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
    });

    test('same-day BACKWARD pull (custom time earlier than anchor) moves head-first', async () => {
      const logRow = chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) });
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [
            { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30', window_end: '13:30', customer_id: 'cust-2', service_type: 'Lawn Care' },
          ] }),
        ],
        customers: [
          chain({ first: jest.fn().mockResolvedValue({ id: 'cust-2', phone: '+19415550002', first_name: 'Sam', zip: '34203' }) }),
        ],
        reschedule_log: [logRow, chain()],
      });

      // Anchor 09:00 → 07:00 = -2h delta; sibling 11:30-13:30 → 09:30-11:30.
      // A custom time can pull a route EARLIER (negative delta). Order must flip
      // to head-first: the anchor vacates 09:00 BEFORE the sibling shifts down,
      // otherwise the anchor's old slot would SLOT_TAKEN the sibling (the
      // forward flow's tail-first ordering would break here).
      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-11', window: { start: '07:00', end: '08:00' } },
        notifyCustomer: false,
      });

      // Head-first exclusion mirror: the anchor moves first excluding just
      // itself (the not-yet-moved sibling's old 11:30 row stays visible —
      // the pull shifts the anchor AWAY from it); the sibling then also
      // excludes only ITSELF — the anchor's committed 07:00 position stays
      // visible, and the head-first target math keeps the sibling's 09:30
      // target clear of it.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-11', { start: '07:00', end: '08:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-11', { start: '09:30', end: '11:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
    });

    test('notifyCustomer=false moves without texting', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        reschedule_log: [],
      });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_lightning',
        scope: 'job',
        target: { date: '2026-06-12', window: { start: '08:00', end: '10:00' } },
        notifyCustomer: false,
      });

      expect(result.ok).toBe(true);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(renderSmsTemplate).not.toHaveBeenCalled();
    });

    test('initiatedBy is recorded on the reschedule (admin attribution)', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        reschedule_log: [],
      });

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: false,
        initiatedBy: 'admin',
      });

      // The dispatch path must log moves as admin-initiated, not 'tech'.
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
    });

    test('an SMS exception after the move reports moved-but-not-notified, not failure', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        reschedule_log: [],
      });
      sendCustomerMessage.mockRejectedValueOnce(new Error('provider exploded'));

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-12', window: { start: '08:00', end: '10:00' } },
        notifyCustomer: true,
      });

      // The move committed — the job is OK; only the notification failed.
      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.results[0]).toMatchObject({
        id: 'svc-1',
        ok: true,
        smsSent: false,
        smsReason: 'provider exploded',
      });
      expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    });

    test('unknown reason code is rejected before any reschedule', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'totally_bogus',
        scope: 'job',
        target: { date: '2026-06-12', window: { start: '08:00', end: '10:00' } },
      });

      expect(result).toMatchObject({ ok: false, reason: 'bad_reason' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    });
  });

  describe('rain_out_moved_v3 (GATE_RAINOUT_MOVE_BANNER)', () => {
    afterEach(() => { delete process.env.GATE_RAINOUT_MOVE_BANNER; });

    function wireSingle() {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });
    }

    const COMMIT_ARGS = {
      serviceId: 'svc-1',
      technicianId: 'tech-1',
      reasonCode: 'weather_rain',
      scope: 'job',
      target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
      notifyCustomer: true,
    };

    test('gate on: renders the short v3 template with the link clause and stamps the v3 kill-switch key', async () => {
      process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
      wireSingle();

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.ok).toBe(true);
      expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
      expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v3');
      const vars = renderSmsTemplate.mock.calls[0][1];
      // Short copy: the detail moved onto the /reschedule banner — no
      // better-day / efficacy / forecast clauses in the SMS anymore.
      expect(vars.link_clause).toBe(' New time, forecast & other options: https://waves.test/r/tok123');
      expect(vars.weather_lead).toBeDefined();
      expect(vars.new_option).toContain('1:00 PM - 3:00 PM');
      expect(vars.better_day_clause).toBeUndefined();
      expect(vars.efficacy_clause).toBeUndefined();
      expect(vars.forecast_clause).toBeUndefined();
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
        original_message_type: 'rain_out_moved_v3',
      });
    });

    test('gate on, no reschedule link: the clause degrades to reply-to-this-message', async () => {
      process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
      wireSingle();
      buildRescheduleLink.mockResolvedValueOnce({ url: null });

      await RainOut.commit(COMMIT_ARGS);

      expect(renderSmsTemplate.mock.calls[0][1].link_clause)
        .toBe(' Need a different time? Reply to this message.');
    });

    test('gate on, ABSENT v3 row: falls back to the v2 render and stamps the v2 key', async () => {
      process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        // v3 render nulls and the row is truly gone (rolled-back migration).
        sms_templates: [chain({ first: jest.fn().mockResolvedValue(undefined) })],
      });
      renderSmsTemplate.mockResolvedValueOnce(null);

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.results[0].smsSent).toBe(true);
      expect(renderSmsTemplate).toHaveBeenCalledTimes(2);
      expect(renderSmsTemplate.mock.calls[1][0]).toBe('rain_out_moved_v2');
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
        original_message_type: 'rain_out_moved_v2',
      });
    });

    test('gate on, DISABLED v3 row is the kill switch — no v2 reroute, no SMS', async () => {
      process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        // v3 render nulls but the row EXISTS (admin disabled it).
        sms_templates: [chain({ first: jest.fn().mockResolvedValue({ id: 'tpl-v3' }) })],
      });
      renderSmsTemplate.mockResolvedValueOnce(null);

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.results[0]).toMatchObject({ ok: true, smsSent: false, smsReason: 'missing_template' });
      expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('v3 template body stays GSM-7 and a representative render fits 2 segments', () => {
      const { BODY } = require('../models/migrations/20260730600000_rain_out_moved_v3_template')._test;
      const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
      // The template literal itself must be GSM-7 — one stray em dash flips
      // every send to UCS-2 and doubles the segment bill (codex P1).
      expect(detectEncoding(BODY).encoding).toBe('GSM_7');
      const rendered = BODY
        .replace('{first_name}', 'Riley')
        .replace('{weather_lead}', 'rain is moving through your area this afternoon')
        .replace('{service_type}', 'quarterly pest control')
        .replace('{new_option}', 'Sun, Aug 2, 9:00 AM - 11:00 AM')
        .replace('{link_clause}', ' New time, forecast & other options: https://wavespestcontrol.com/l/t42w2x');
      expect(detectEncoding(rendered).encoding).toBe('GSM_7');
      expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
    });

    test('gate off: v3 is never rendered — v2 stays the default', async () => {
      wireSingle();

      await RainOut.commit(COMMIT_ARGS);

      expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v2');
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
        original_message_type: 'rain_out_moved_v2',
      });
    });
  });

  describe('collective series anchoring (GATE_COLLECTIVE_SERIES_ANCHOR)', () => {
    const NotificationService = require('../services/notification-service');
    const AppointmentReminders = require('../services/appointment-reminders');

    afterEach(() => { delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR; });

    const RECURRING_SERVICE = { ...SERVICE, is_recurring: true, recurring_parent_id: 'parent-1' };

    function wireRecurring(row = RECURRING_SERVICE) {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...row }) })],
      });
    }

    const DAY_MOVE_ARGS = {
      serviceId: 'svc-1',
      technicianId: 'tech-1',
      reasonCode: 'weather_rain',
      scope: 'job',
      // SERVICE sits on 2026-06-11 — a +1 day rain push.
      target: { date: '2026-06-12', window: { start: '13:00', end: '14:00' } },
      notifyCustomer: false,
    };

    test('gate on: a day move of a series child shifts the whole series, re-arms siblings silently, parks conflicted ones', async () => {
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireRecurring();
      SmartRebooker.rescheduleSeries.mockResolvedValueOnce({
        rescheduledOccurrences: [
          { id: 'svc-1', date: '2026-06-12', windowStart: '13:00' },
          { id: 'sib-1', date: '2026-09-12', windowStart: '09:00' },
          { id: 'sib-2', date: '2026-12-12', windowStart: '09:00', conflicted: true },
        ],
      });

      const result = await RainOut.commit(DAY_MOVE_ARGS);

      expect(result.ok).toBe(true);
      expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledWith(
        'svc-1', '2026-06-12', { start: '13:00', end: '14:00' }, 'weather_rain', 'tech',
        {
          allowLive: true,
          expectAnchor: { scheduled_date: '2026-06-11', window_start: '09:00' },
        },
      );
      // Series path replaces the single move entirely.
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
      // Siblings re-arm silently; the anchor is left to the calling route.
      expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(2);
      expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith(
        'sib-1', '2026-09-12T09:00',
        {
          sendNotification: false,
          expectSchedule: { date: '2026-09-12', windowStart: '09:00' },
        },
      );
      // The kept-tech double-book parked for reassignment.
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('schedule_conflict');
      expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('2026-12-12');
      // Live boards get a job_update per shifted SIBLING (the calling
      // routes broadcast only their own loop ids) — never the anchor twice.
      const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
      expect(emitDispatchJobUpdate.mock.calls.map((c) => c[0].jobId).sort()).toEqual(['sib-1', 'sib-2']);
    });

    test('gate on: a rejected series shift falls back WITH the anchor CAS — a concurrent move is never overwritten', async () => {
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireRecurring();
      SmartRebooker.rescheduleSeries.mockRejectedValueOnce(
        Object.assign(new Error('Cannot reschedule — appointment changed concurrently'), { statusCode: 409, code: 'SLOT_TAKEN' }),
      );

      await RainOut.commit(DAY_MOVE_ARGS);

      // The single fallback carries the same expected-state predicate the
      // series call pinned — the rebooker 409s on a stale anchor instead of
      // overwriting the newer choice (codex P1).
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-12', { start: '13:00', end: '14:00' }, 'weather_rain', 'tech',
        {
          allowLive: true,
          excludeServiceIds: ['svc-1'],
          expect: { scheduled_date: '2026-06-11', window_start: '09:00' },
        },
      );
    });

    test('gate on: an off-hour tech-supplied target is normalized on-the-hour before the series mints it (codex P1)', async () => {
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireRecurring();

      await RainOut.commit({
        ...DAY_MOVE_ARGS,
        target: { date: '2026-06-12', window: { start: '09:30', end: '10:30' } },
      });

      expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledTimes(1);
      expect(SmartRebooker.rescheduleSeries.mock.calls[0][2]).toEqual({ start: '09:00', end: '10:00' });
    });

    test('route scope: recurring SIBLINGS series-shift too — the route query carries is_recurring (codex P1)', async () => {
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [{
            id: 'svc-2', status: 'pending', scheduled_date: '2026-06-11',
            window_start: '11:00', window_end: '12:00', customer_id: 'cust-2',
            service_type: 'Quarterly Pest Control', route_order: 2, is_recurring: true,
          }] }),
        ],
      });

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '10:00' } },
        notifyCustomer: false,
      });

      // Non-recurring anchor takes the single path; the recurring route
      // sibling series-shifts with its own window kept.
      expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledTimes(1);
      expect(SmartRebooker.rescheduleSeries.mock.calls[0][0]).toBe('svc-2');
      expect(SmartRebooker.rescheduleSeries.mock.calls[0][2]).toEqual({ start: '11:00', end: '12:00' });
      expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
      expect(SmartRebooker.reschedule.mock.calls[0][0]).toBe('svc-1');
    });

    test('gate on: an un-shiftable series never fails the rain-out — the visit moves alone and the series parks', async () => {
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireRecurring();
      SmartRebooker.rescheduleSeries.mockRejectedValueOnce(
        Object.assign(new Error('That window conflicts'), { statusCode: 409, code: 'SLOT_TAKEN' }),
      );

      const result = await RainOut.commit(DAY_MOVE_ARGS);

      expect(result.ok).toBe(true);
      expect(result.results[0].ok).toBe(true);
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-12', { start: '13:00', end: '14:00' }, 'weather_rain', 'tech',
        {
          allowLive: true,
          excludeServiceIds: ['svc-1'],
          // Fallback keeps the anchor CAS the series call pinned.
          expect: { scheduled_date: '2026-06-11', window_start: '09:00' },
        },
      );
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('could not shift');
    });

    test('same-day pushes have no date delta and never touch the series', async () => {
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireRecurring();

      await RainOut.commit({
        ...DAY_MOVE_ARGS,
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
      });

      expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
      expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    });

    test('gate off, and boosters (is_recurring=false), stay on the single-visit path', async () => {
      // Gate off + recurring row.
      wireRecurring();
      await RainOut.commit(DAY_MOVE_ARGS);
      expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();

      // Gate on + booster row (shares a parent but is_recurring=false).
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      wireRecurring({ ...SERVICE, is_recurring: false, recurring_parent_id: 'parent-1' });
      await RainOut.commit(DAY_MOVE_ARGS);
      expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
    });
  });

  describe('extra reasons (GATE_QUICKMOVE_EXTRA_REASONS)', () => {
    afterEach(() => {
      delete process.env.GATE_QUICKMOVE_EXTRA_REASONS;
      delete process.env.GATE_RAINOUT_MOVE_BANNER;
    });

    function wireSingle() {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });
    }

    const COMMIT_ARGS = {
      serviceId: 'svc-1',
      technicianId: 'tech-1',
      reasonCode: 'running_late',
      scope: 'job',
      target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
      notifyCustomer: true,
    };

    test('gate off: every extra reason is rejected before any reschedule (fail closed)', async () => {
      for (const reasonCode of ['running_late', 'equipment_issue', 'tech_emergency', 'customer_noshow']) {
        wireSingle();
        const result = await RainOut.commit({ ...COMMIT_ARGS, reasonCode });
        expect(result).toMatchObject({ ok: false, reason: 'bad_reason' });
      }
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    });

    test('gate on: moves and texts the schedule lead with ZERO weather claims (v2 rung)', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      wireSingle();

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.ok).toBe(true);
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-11', { start: '13:00', end: '14:00' }, 'running_late', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] },
      );
      const vars = renderSmsTemplate.mock.calls[0][1];
      expect(vars.weather_lead).toBe("we're running behind schedule today");
      // No weather claims anywhere in a running-late text: no forecast link,
      // no better-day clause, and the NWS decoration fetches never even run.
      expect(vars.forecast_clause).toBe('');
      expect(vars.better_day_clause).toBe('');
      expect(getDailyRainOutlook).not.toHaveBeenCalled();
      expect(getHourlyRainOutlook).not.toHaveBeenCalled();
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
        original_message_type: 'rain_out_moved_v2',
        reason_code: 'running_late',
      });
    });

    test('gate on: customer_noshow REJECTS route scope — a no-show is about one customer, never the whole route', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      wireSingle();

      const result = await RainOut.commit({ ...COMMIT_ARGS, reasonCode: 'customer_noshow', scope: 'route' });

      expect(result).toMatchObject({ ok: false, reason: 'noshow_route_scope' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('gate on: running_late rejects same-day targets at/before the current window, allows later + day moves', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';

      // SERVICE sits on 2026-06-11 at 09:00. Earlier same-day → reject.
      wireSingle();
      let result = await RainOut.commit({
        ...COMMIT_ARGS,
        target: { date: '2026-06-11', window: { start: '08:00', end: '09:00' } },
      });
      expect(result).toMatchObject({ ok: false, reason: 'target_not_later' });

      // Equal start is a no-op "move" — reject too.
      wireSingle();
      result = await RainOut.commit({
        ...COMMIT_ARGS,
        target: { date: '2026-06-11', window: { start: '09:00', end: '10:00' } },
      });
      expect(result).toMatchObject({ ok: false, reason: 'target_not_later' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();

      // An earlier clock time on a DIFFERENT day contradicts nothing.
      wireSingle();
      result = await RainOut.commit({
        ...COMMIT_ARGS,
        target: { date: '2026-06-12', window: { start: '08:00', end: '09:00' } },
      });
      expect(result.ok).toBe(true);
    });

    test('gate on: customer_noshow is the SOFT no-show — rebooker logs the missed-outreach reason and the SMS says we missed you', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      wireSingle();

      const result = await RainOut.commit({ ...COMMIT_ARGS, reasonCode: 'customer_noshow' });

      expect(result.ok).toBe(true);
      // reason_code customer_noshow on the reschedule_log row is what feeds
      // the 2-in-90-days missed-appointment outreach counter.
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-11', { start: '13:00', end: '14:00' }, 'customer_noshow', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] },
      );
      expect(renderSmsTemplate.mock.calls[0][1].weather_lead).toBe('we missed you today');
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ reason_code: 'customer_noshow' });
      // The rebooker logged the occurrence; the outreach THRESHOLD must
      // still run (codex r2) — evaluate-only, never a second onSkip insert.
      expect(MissedAppointment.evaluateThreshold).toHaveBeenCalledTimes(1);
      expect(MissedAppointment.evaluateThreshold).toHaveBeenCalledWith('cust-1', 'quick_move_no_show');
    });

    test('gate on: non-noshow reasons never run the missed-appointment threshold', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      wireSingle();

      await RainOut.commit(COMMIT_ARGS);

      expect(MissedAppointment.evaluateThreshold).not.toHaveBeenCalled();
    });

    test('gate on + banner gate: the v3 link clause drops the forecast word', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
      wireSingle();

      await RainOut.commit(COMMIT_ARGS);

      expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v3');
      expect(renderSmsTemplate.mock.calls[0][1].link_clause)
        .toBe(' New time & other options: https://waves.test/r/tok123');
      expect(getDailyRainOutlook).not.toHaveBeenCalled();
      expect(getHourlyRainOutlook).not.toHaveBeenCalled();
    });

    test('gate on, ABSENT v2 row: NO legacy reroute — the legacy grammar is weather-only, so the send stops', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        // v2 render nulls and the row is truly gone (rolled-back migration).
        sms_templates: [chain({ first: jest.fn().mockResolvedValue(undefined) })],
      });
      renderSmsTemplate.mockResolvedValueOnce(null);

      const result = await RainOut.commit(COMMIT_ARGS);

      // The move still commits; "{weather_phrase} rolled through your area"
      // can't state a schedule delay, so the operator sees not-texted
      // instead of the customer getting a false weather story.
      expect(result.results[0]).toMatchObject({ ok: true, smsSent: false, smsReason: 'missing_template' });
      expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('lead composition is the fixed operational phrase regardless of day/forecast', () => {
      const lead = RainOut._test.composeWeatherLead;
      expect(lead({ reasonCode: 'running_late', isSameDay: true, hour: 9, todayChance: 85 }))
        .toBe("we're running behind schedule today");
      expect(lead({ reasonCode: 'running_late', isSameDay: false, hour: 15, todayChance: null }))
        .toBe("we're running behind schedule today");
      expect(lead({ reasonCode: 'equipment_issue', isSameDay: true, hour: 9 }))
        .toBe('we had equipment trouble today');
      expect(lead({ reasonCode: 'tech_emergency', isSameDay: false, hour: 9 }))
        .toBe('an emergency came up on our end');
      expect(lead({ reasonCode: 'customer_noshow', isSameDay: true, hour: 16 }))
        .toBe('we missed you today');
    });

    test('isValidReason: weather codes always, extra reasons only behind the gate', () => {
      const { isValidReason, EXTRA_REASON_LEADS } = RainOut._test;
      expect(isValidReason('weather_rain')).toBe(true);
      for (const code of Object.keys(EXTRA_REASON_LEADS)) expect(isValidReason(code)).toBe(false);
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      for (const code of Object.keys(EXTRA_REASON_LEADS)) expect(isValidReason(code)).toBe(true);
      expect(isValidReason('totally_bogus')).toBe(false);
    });
  });

  describe('commit — route scope', () => {
    const ROUTE_JOBS = [
      { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30', window_end: '13:30', customer_id: 'cust-2', service_type: 'Lawn Care' },
      { id: 'svc-3', status: 'pending', scheduled_date: '2026-06-11', window_start: '14:00', window_end: '16:00', customer_id: 'cust-3', service_type: 'Mosquito' },
    ];

    function wireRoute() {
      const logRow = chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) });
      const routeChain = chain({ rows: ROUTE_JOBS });
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          routeChain,
        ],
        customers: [
          chain({ first: jest.fn().mockResolvedValue({ id: 'cust-2', phone: '+19415550002', first_name: 'Sam', zip: '34203' }) }),
          chain({ first: jest.fn().mockResolvedValue({ id: 'cust-3', phone: null, first_name: 'Lee', zip: null }) }),
        ],
        reschedule_log: [logRow, chain()],
      });
      return { routeChain };
    }

    test('day move shifts all stops to the new date keeping each window; every texted stop gets the link', async () => {
      wireRoute();

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: true,
      });

      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(3);

      // Cross-day exclusion: unmoved siblings still sit on the OLD date —
      // date-scoped probes can't see them — and members already landed on
      // the target date are REAL committed occupancy that must stay
      // visible. Exclusion never grows past the row being moved.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      // Route siblings keep their own windows on the new date.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(3,
        'svc-3', '2026-06-12', { start: '14:00', end: '16:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-3'] });

      // Anchor and sibling both get the self-serve link — no reply ask;
      // no-phone sibling skipped.
      expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
      expect(renderSmsTemplate.mock.calls[0][1].alt_clause).toContain('Reschedule online:');
      expect(renderSmsTemplate.mock.calls[0][1].alt_clause).not.toContain('Reply 1');
      expect(renderSmsTemplate.mock.calls[1][1].alt_clause).toContain('Reschedule online:');
      const noPhone = result.results.find((r) => r.id === 'svc-3');
      expect(noPhone.smsSent).toBe(false);
      expect(noPhone.smsReason).toBe('no_phone');
    });

    test('a slow NWS pair degrades forecast decoration for the rest of the rain-out', async () => {
      wireRoute();
      // NWS hangs: the anchor's decoration attempt burns the 1.5s budget,
      // then every remaining stop skips the lookup entirely — texts still
      // go out, with the generic lead.
      getDailyRainOutlook.mockImplementation(() => new Promise(() => {}));
      getHourlyRainOutlook.mockImplementation(() => new Promise(() => {}));

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: true,
      });

      expect(result.ok).toBe(true);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
      expect(renderSmsTemplate.mock.calls[0][1].weather_lead).toBe("the weather isn't cooperating today");
      expect(getDailyRainOutlook).toHaveBeenCalledTimes(1); // sibling skipped after degradation

      getDailyRainOutlook.mockResolvedValue(null);
      getHourlyRainOutlook.mockResolvedValue(null);
    });

    test('route scope is bounded to the anchor route position — earlier stops are never swept', async () => {
      const { routeChain } = wireRoute();

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: false,
      });

      // SERVICE has no route_order (→ 999) and window_start 09:00; the
      // "rest of route" query must be bounded by (route_order, window_start)
      // so a dispatcher rain-out of a mid-route stop can't move/text
      // appointments ordered before the one they picked.
      expect(routeChain.whereRaw).toHaveBeenCalledWith(
        expect.stringContaining('route_order'),
        [999, '09:00'],
      );
    });

    test('day-move siblings with HH:MM:SS DB windows are trimmed to HH:MM', async () => {
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [
            { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30:00', window_end: '13:30:00', customer_id: 'cust-2', service_type: 'Lawn Care' },
          ] }),
        ],
      });

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: false,
      });

      // DB TIME comes back 'HH:MM:SS'; it must be trimmed so the strict
      // reminder helper re-arms the sibling onto its real window, not 08:00.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
    });

    test('one stop racing to terminal does not strand the rest', async () => {
      wireRoute();
      SmartRebooker.reschedule
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a completed job'), { statusCode: 409 }))
        .mockResolvedValueOnce({ success: true });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: false,
      });

      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(2);
      expect(result.failedCount).toBe(1);
      const failed = result.results.find((r) => !r.ok);
      expect(failed.id).toBe('svc-2');
      expect(failed.statusCode).toBe(409);
    });

    test('exclusion = the CURRENT row only; no member — moved or failed — ever leaves the conflict domain', async () => {
      wireRoute();
      SmartRebooker.reschedule
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a completed job'), { statusCode: 409 }))
        .mockResolvedValueOnce({ success: true });

      await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: false,
      });

      // Every move excludes ONLY itself. A moved member's committed new
      // position is real occupancy another actor can re-move; a failed
      // member's row is still live at its OLD position. Both must stay
      // visible to every later member's probe — the exclusion set never
      // accumulates, success or failure.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
      // svc-2 FAILED mid-batch — svc-3's probe keeps seeing the stranded
      // row (and can block on it) instead of silently double-booking on
      // top of it, exactly like it keeps seeing the successfully-moved
      // anchor's new position.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(3,
        'svc-3', '2026-06-12', { start: '14:00', end: '16:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-3'] });
    });

    test('a batch member RE-MOVED by another actor into a later target BLOCKS that later move (no moved-ids exclusion)', async () => {
      // Same-day forward push, tail-first: the sibling (svc-2) moves first
      // and COMMITS at 15:30-17:30. While the anchor is still unprocessed,
      // another actor (customer /reschedule link, dispatch board) RE-MOVES
      // the committed svc-2 row into the anchor's 13:00-15:00 target and
      // commits. Under the old exclusion the anchor's probe carried
      // ['svc-1', 'svc-2'] — svc-2's freshly committed position was
      // invisible purely because its id sat in the moved set, and the
      // anchor silently double-booked on top of it. Now the anchor excludes
      // ONLY itself, the rebooker's rung-1-locked occupancy probe sees the
      // committed row, and the move fails SLOT_TAKEN — a loud per-member
      // failure instead of a silent overlap.
      const logRow = chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) });
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [
            { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30', window_end: '13:30', customer_id: 'cust-2', service_type: 'Lawn Care' },
          ] }),
        ],
        reschedule_log: [logRow, chain()],
      });
      SmartRebooker.reschedule
        .mockResolvedValueOnce({ success: true }) // svc-2 commits at 15:30
        .mockRejectedValueOnce(Object.assign(
          new Error('That window conflicts with another job on the technician\'s route'),
          { statusCode: 409, code: 'SLOT_TAKEN' },
        )); // anchor blocked by svc-2's re-moved position

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-11', window: { start: '13:00', end: '15:00' } },
        notifyCustomer: false,
      });

      // The property that makes the block possible: the anchor's exclusion
      // array is [its own id] — the already-moved svc-2 is NOT in it.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-2', '2026-06-11', { start: '15:30', end: '17:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-1', '2026-06-11', { start: '13:00', end: '15:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      // Loud partial result: the blocked anchor is reported failed; the
      // sibling's committed move stands.
      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.results.find((r) => r.id === 'svc-1')).toMatchObject({ ok: false, statusCode: 409 });
      expect(result.results.find((r) => r.id === 'svc-2')).toMatchObject({ ok: true });
    });

    test('a not-yet-processed member genuinely occupying an earlier target BLOCKS that move (no anticipatory exclusion)', async () => {
      // Same-day forward push, tail-first: the sibling (svc-2) moves first,
      // while the ANCHOR (svc-1) is still unprocessed. Another actor
      // (customer /reschedule link, dispatch) has concurrently moved svc-1
      // into svc-2's target window and COMMITTED. Under the old blanket
      // exclusion svc-1's id was pre-excluded and the probe sailed past the
      // committed row — a silent double-book no later bookkeeping could
      // undo. Now svc-1 is NOT in svc-2's exclusion set, the rebooker's
      // occupancy probe (rung-1-locked, committed rows visible) sees it and
      // throws SLOT_TAKEN — a loud per-member failure instead.
      const logRow = chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) });
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [
            { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30', window_end: '13:30', customer_id: 'cust-2', service_type: 'Lawn Care' },
          ] }),
        ],
        reschedule_log: [logRow, chain()],
      });
      SmartRebooker.reschedule
        .mockRejectedValueOnce(Object.assign(
          new Error('That window conflicts with another job on the technician\'s route'),
          { statusCode: 409, code: 'SLOT_TAKEN' },
        ))
        .mockResolvedValueOnce({ success: true });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-11', window: { start: '13:00', end: '15:00' } },
        notifyCustomer: false,
      });

      // The property that makes the block possible: svc-2's probe excluded
      // ONLY svc-2 — the unprocessed anchor stayed visible to it.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-2', '2026-06-11', { start: '15:30', end: '17:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
      // The anchor's own move still ran, excluding only itself — the
      // exclusion is always exactly the row being moved.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-1', '2026-06-11', { start: '13:00', end: '15:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      // Loud partial result: the clashing member is reported failed, the
      // rest of the batch is not stranded.
      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.results.find((r) => r.id === 'svc-2')).toMatchObject({ ok: false, statusCode: 409 });
      expect(result.results.find((r) => r.id === 'svc-1')).toMatchObject({ ok: true });
    });
  });

  describe('dispatcher note (customerNote)', () => {
    const sanitize = () => RainOut._test.sanitizeCustomerNote;

    test('sanitizer: absent/blank notes are null, text is collapsed+trimmed', () => {
      expect(sanitize()(undefined)).toEqual({ note: null });
      expect(sanitize()(null)).toEqual({ note: null });
      expect(sanitize()('   ')).toEqual({ note: null });
      expect(sanitize()('  Gate code\n still  works!  ')).toEqual({ note: 'Gate code still works!' });
    });

    test('sanitizer: rejects over-long, shortener, and non-string notes', () => {
      expect(sanitize()('x'.repeat(201))).toEqual({ error: 'note_too_long' });
      expect(sanitize()('details here bit.ly/abc')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('see t.co/xyz')).toEqual({ error: 'note_link_blocked' });
      // Trailing root dot is a valid FQDN spelling of the same host —
      // must not slip the guard (codex pre-push P1).
      expect(sanitize()('go to https://bit.ly./abc now')).toEqual({ error: 'note_link_blocked' });
      // Punctuation-wrapped naked links are still valid links (codex P1).
      expect(sanitize()('details (bit.ly/abc)')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('see [t.co/xyz] for info')).toEqual({ error: 'note_link_blocked' });
      // Encoded/unicode forms that canonicalize back to a shortener host
      // must not slip the textual regex (codex PR P1): percent-encoded dot,
      // ideographic full stop, fullwidth chars, zero-width joins.
      expect(sanitize()('go https://bit%2ely/abc')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('go https://bit。ly/abc')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('go ｂｉｔ．ｌｙ/abc')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('go bit\u200B.ly/abc')).toEqual({ error: 'note_link_blocked' });
      // A shortener blocklist can never be complete \u2014 ANY URL is banned in
      // a note (codex r2 P1): unlisted shorteners, scheme'd URLs, www.
      // forms, bare host/path tokens.
      expect(sanitize()('go tiny.one/x now')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('go https://v.gd/x')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('see www.example.com for details')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('pay at waves.com/pay please')).toEqual({ error: 'note_link_blocked' });
      // No-path clickable forms (codex r3 P1): bare common-TLD host,
      // query-only, non-HTTP scheme, IPv4.
      expect(sanitize()('go to tiny.one now')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('example.com?x=1 has it')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('grab ftp://files.example.io/x')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('open 192.168.4.20/pay')).toEqual({ error: 'note_link_blocked' });
      // Bare hosts are validated against the REAL public-suffix list (psl),
      // not a hand-kept TLD subset (codex r3 P1) — new gTLDs included, and
      // real ccTLD prose-typos ("late.Be" = late.be, Belgium) block too.
      expect(sanitize()('try example.xyz today')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('ask example.ai about it')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('Running late.Be there at 3')).toEqual({ error: 'note_link_blocked' });
      // Bare IDNs never matched the ASCII candidate regex — punycoded via
      // domainToASCII and checked against the same suffix list (codex r4 P1).
      expect(sanitize()('перейти на пример.рф сейчас')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('访问 例子.中国 了解')).toEqual({ error: 'note_link_blocked' });
      // Unicode word pairs with no real suffix stay prose.
      expect(sanitize()('ask for café.Bueno at the door')).toEqual({ note: 'ask for café.Bueno at the door' });
      // Plain prose with dots/times must NOT false-positive.
      expect(sanitize()('Arriving 12:30. See you at 2 p.m. sharp')).toEqual({ note: 'Arriving 12:30. See you at 2 p.m. sharp' });
      expect(sanitize()('Back gate. Code 4482 works. Thanks')).toEqual({ note: 'Back gate. Code 4482 works. Thanks' });
      expect(sanitize()('Ask for Mr.Smith at the door')).toEqual({ note: 'Ask for Mr.Smith at the door' });
    });

    test('sanitizer: mirrors the outbound sms-guard so the note fails BEFORE the move, not the send after', () => {
      // sms-guard.js rejects assembled bodies containing these \u2014 a note
      // that trips it would strand a committed move with no SMS (codex r2 P2).
      expect(sanitize()('Gate code 1970 still works')).toEqual({ error: 'note_guard_blocked', guardReason: 'broken-render:1970' });
      expect(sanitize()('{gate_code} is 4482')).toEqual({ error: 'note_guard_blocked', guardReason: 'unsubstituted-variable:{gate_code}' });
      expect(sanitize()('the code is null for now')).toEqual({ error: 'note_guard_blocked', guardReason: 'broken-render:null' });
      // Words merely CONTAINING guard tokens pass, same as the guard itself.
      expect(sanitize()('we will annull nothing, promise')).toEqual({ note: 'we will annull nothing, promise' });
      // The check runs on the GSM-NORMALIZED note — the send path deletes
      // zero-width chars before ITS guard, so "19​70" fuses into
      // "1970" after a raw-text check would have passed (codex r4 P2).
      expect(sanitize()('code 19\u200B70 works')).toEqual({ error: 'note_guard_blocked', guardReason: 'broken-render:1970' });
      expect(sanitize()('value un\u2060defined here')).toEqual({ error: 'note_guard_blocked', guardReason: 'broken-render:undefined' });
    });

    test('sanitizer: compliance hard rules via the CANONICAL social-media checker', () => {
      // complianceLanguageIssues (social-media.js) \u2014 same clause logic and
      // regression matrix as validateContent, not a parallel weaker copy
      // (codex r5/r6). Free-form notes are customer copy like any other.
      const blocked = (s) => expect(sanitize()(s)).toMatchObject({ error: 'note_compliance_blocked' });
      blocked('our treatment is pet-safe');
      blocked('products are totally safe for kids');
      blocked('EPA-approved products only');
      blocked('re-enter after 30 minutes');
      blocked('keep pets off treated areas for 30 minutes');
      // Bare dry-idiom WITHOUT technician-confirmed timing blocks too \u2014
      // the canonical rule, stricter than a naive idiom allowlist.
      blocked('treatment is safe once dry');
      // A confirmation about APPOINTMENT logistics is not a drying
      // confirmation and must not exempt the idiom (codex r7).
      blocked('Treatment is safe once dry. Your technician confirms arrival timing.');
      // A confirmation about any NON-drying subject doesn't exempt either —
      // the exemption requires a drying/timing object (r9), and "ready"/
      // "will let you know" can't smuggle an unrelated object in (r11).
      blocked('Treatment is safe once dry. Your technician confirms the gate code.');
      blocked('Treatment is safe once dry. Your technician confirms the gate code is ready.');
      blocked('Treatment is safe once dry. Your technician will let you know the gate code.');
      // The confirmation must come from the TECHNICIAN — office/dispatch
      // can't stand in (r16).
      blocked('Treatment is safe once dry. The office confirms timing.');
      blocked('Treatment is safe once dry. Timing will be confirmed by dispatch.');
      // Plain enter directives are fixed re-entry timing too (r16).
      blocked('Wait 30 minutes before entering');
      blocked("Don't enter for 30 minutes");
      // Protective weather advice is NOT a product claim — no product
      // word in the sentence, so it stays sendable (r16).
      expect(sanitize()('Keep your pets safe indoors during the storm'))
        .toEqual({ note: 'Keep your pets safe indoors during the storm' });
      // ...but a well-wish phrasing wrapped around the PRODUCT is still a
      // claim (r17).
      blocked('Treatment will be safe');
      blocked('Our pesticide will be safe');
      // Nor can an arbitrary noun qualify the time object — only filler
      // words (articles/possessives) may sit between the confirm verb and
      // its timing object (r15).
      blocked('Treatment is safe once dry. Your technician confirms the invoice time.');
      blocked('Treatment is safe once dry. The invoice timing will be confirmed by your technician.');
      // Stripping an unrelated confirmation must not recombine the
      // technician with ANOTHER party's confirmation across the deleted
      // span or a clause boundary (r20).
      blocked('Treatment is safe once dry. Your technician confirms arrival timing; the office confirms timing.');
      blocked('Treatment is safe once dry. Your technician confirms arrival timing and the office confirms timing.');
      // ...nor across a conjunction to another subject's verb (r21).
      blocked('Treatment is safe once dry. Your technician checks the gate and the office confirms timing.');
      // Passive order can't smuggle logistics past the strip either (r12).
      blocked('Treatment is safe once dry. Appointment timing will be confirmed by your technician.');
      expect(sanitize()('Treatment is safe once dry. Timing will be confirmed by your technician.'))
        .toEqual({ note: 'Treatment is safe once dry. Timing will be confirmed by your technician.' });
      // ...while the object-less and drying-tied forms still exempt.
      expect(sanitize()('Treatment is safe once dry. Your technician will let you know.'))
        .toEqual({ note: 'Treatment is safe once dry. Your technician will let you know.' });
      expect(sanitize()("Treatment is safe once dry. Your tech will tell you when it's dry."))
        .toEqual({ note: "Treatment is safe once dry. Your tech will tell you when it's dry." });
      // ...but a DRYING confirmation located at the appointment IS one (r8).
      expect(sanitize()('Treatment is safe once dry. Your technician confirms drying time at the appointment.'))
        .toEqual({ note: 'Treatment is safe once dry. Your technician confirms drying time at the appointment.' });
      // Spelled-out durations are the same banned class as digits.
      blocked('Keep pets off treated areas for two hours');
      // Compact/decimal durations and dotted EPA (pre-push r13): the
      // sentence splitter must not treat a decimal point as a boundary,
      // and "30m" / "1.5 hours" / "E.P.A." are the same banned classes.
      blocked('Stay off for 30m');
      blocked('Re-enter in 1.5 hours');
      // Seconds are the same banned class (r18).
      blocked('Keep pets off treated areas for 30 seconds');
      blocked('Re-enter in 90 sec');
      // Weather/premises durations are advice about THAT, not implicit
      // re-entry (r19) — the treated-area route still blocks.
      expect(sanitize()('Stay inside for 30 minutes because of lightning'))
        .toEqual({ note: 'Stay inside for 30 minutes because of lightning' });
      expect(sanitize()('Avoid the flooded entrance for 30 minutes'))
        .toEqual({ note: 'Avoid the flooded entrance for 30 minutes' });
      // ...but explicit treatment context in the clause overrides the
      // premises exemption — an incidental logistics word can't launder a
      // fixed re-entry time (r22).
      blocked('Stay inside for 30 minutes after treatment because the gate is open');
      // A split instruction is one instruction — the directive may sit in
      // the adjacent clause or sentence (r23).
      blocked('Stay off and wait 30 minutes');
      blocked('Stay off. Wait 30 minutes.');
      blocked('Wait 30 minutes, then go back on the lawn');
      // ...but a bare duration next to a well-wish stays sendable.
      expect(sanitize()('Stay dry! See you at 2:30.'))
        .toEqual({ note: 'Stay dry! See you at 2:30.' });
      // Invisible joiners can't split a banned word past the compliance
      // regexes — validation runs on a folded copy (r24).
      blocked('Our treatment is sa\u200Dfe');
      // Treatment context in the PRIOR clause defeats the premises
      // exemption (r24).
      blocked('We treated the lawn. Stay inside near the gate for 30 minutes before going outside.');
      // An arrival clock next to a stay directive is not a re-entry time —
      // adjacency propagation needs a duration figure (r24).
      expect(sanitize()('Please wait inside. We will arrive at 2:30.'))
        .toEqual({ note: 'Please wait inside. We will arrive at 2:30.' });
      blocked('This is E.P.A. approved');
      // ...but only APPROVED-status EPA claims block — label-direction
      // references are compliant (r14 client-parity case).
      expect(sanitize()('Following EPA label directions as always'))
        .toEqual({ note: 'Following EPA label directions as always' });
      // Cross-sentence context (pre-push r10): the note ALWAYS rides a
      // treatment SMS, so the claim and its product/area context need not
      // share a sentence — impliedTreatmentContext closes the split.
      blocked('Treatment today. Totally safe.');
      blocked('We treated the lawn. Stay off for 30 minutes.');
      // ...while courtesy well-wishes and plain rescheduling times pass.
      expect(sanitize()('Rain rolled in - stay safe out there! New window is 2:30 pm.'))
        .toEqual({ note: 'Rain rolled in - stay safe out there! New window is 2:30 pm.' });
      expect(sanitize()("We'll be back tomorrow at 9:00 to re-treat the lawn."))
        .toEqual({ note: "We'll be back tomorrow at 9:00 to re-treat the lawn." });
      // The implied-context strictness is the NOTE path only — the social
      // checker keeps its same-sentence co-occurrence rule.
      const { complianceLanguageIssues } = require('../services/social-media');
      expect(complianceLanguageIssues('Treatment today. Totally safe.')).toEqual([]);
      expect(complianceLanguageIssues('We treated the lawn. Stay off for 30 minutes.')).toEqual([]);
      // Approved framings and unrelated durations pass.
      expect(sanitize()('Safe once dry - your technician confirms timing')).toEqual({ note: 'Safe once dry - your technician confirms timing' });
      expect(sanitize()('keeping your home safe from termites')).toEqual({ note: 'keeping your home safe from termites' });
      expect(sanitize()('EPA-registered product, same as always')).toEqual({ note: 'EPA-registered product, same as always' });
      expect(sanitize()('visit takes about 45 minutes')).toEqual({ note: 'visit takes about 45 minutes' });
      expect(sanitize()('avoid watering for 24 hours')).toEqual({ note: 'avoid watering for 24 hours' });
    });

    test('sanitizer: rejects emoji BEFORE the move (send layer would block the SMS after)', () => {
      // sendCustomerMessage's EMOJI_FOR_CUSTOMER validator would otherwise
      // fire after the reschedule committed — move done, customer silent.
      expect(sanitize()('See you Friday 👍')).toEqual({ error: 'note_emoji_blocked' });
      expect(sanitize()('Rain check ☔ sorry!')).toEqual({ error: 'note_emoji_blocked' });
      // Flags (regional indicators) and keycaps are emoji too — neither is
      // Extended_Pictographic, both now covered by the shared validator
      // (codex r3 P1).
      expect(sanitize()('See you 🇺🇸')).toEqual({ error: 'note_emoji_blocked' });
      expect(sanitize()('Press 1️⃣ to confirm')).toEqual({ error: 'note_emoji_blocked' });
      // Smart punctuation is NOT emoji — same line the voice validator draws.
      expect(sanitize()('Friday — we’ll be there')).toEqual({ note: 'Friday — we’ll be there' });
      expect(sanitize()(42)).toEqual({ error: 'note_invalid' });
      // "habit.ly" is a REAL registrable .ly host, so the no-URL rule now
      // correctly blocks it; dot-joined words off the TLD set still pass.
      expect(sanitize()('a habit.ly no wait')).toEqual({ error: 'note_link_blocked' });
      expect(sanitize()('an orbit.lyric moment, truly')).toEqual({ note: 'an orbit.lyric moment, truly' });
    });

    test('commit appends the note after the rendered template body', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
        customerNote: '  Sorry for the shuffle — see you Friday!  ',
        actorUserId: 'admin-7',
      });

      expect(result.ok).toBe(true);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage.mock.calls[0][0].body)
        .toBe('rendered body\n\nNote from our team: Sorry for the shuffle — see you Friday!');
      // Operator attribution: adminUserId → sms_log.admin_user_id, so the
      // durable record shows who authored the customer-visible note
      // (codex r2 P2). Absent actor → key absent (system-initiated shape).
      expect(sendCustomerMessage.mock.calls[0][0].metadata.adminUserId).toBe('admin-7');
    });

    test('route scope: the note rides the ANCHOR SMS only — siblings get the standard text', async () => {
      // Same wiring as the route-scope suite: anchor + one phone-having
      // sibling; a stop-specific note (gate code) must never fan out.
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [{ id: 'svc-2', status: 'confirmed', scheduled_date: '2026-06-11', window_start: '11:30', window_end: '13:30', customer_id: 'cust-2', service_type: 'Lawn Care' }] }),
        ],
        customers: [
          chain({ first: jest.fn().mockResolvedValue({ id: 'cust-2', phone: '+19415550002', first_name: 'Sam', zip: '34203' }) }),
        ],
        reschedule_log: [chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) }), chain()],
      });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: true,
        customerNote: 'Gate code 4482 still works.',
      });

      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(2);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
      const bodies = sendCustomerMessage.mock.calls.map((c) => c[0].body);
      expect(bodies[0]).toBe('rendered body\n\nNote from our team: Gate code 4482 still works.');
      expect(bodies[1]).toBe('rendered body');
    });

    test('commit rejects a shortener note BEFORE moving anything', async () => {
      // No db queues wired past the service load — a rejected note must
      // never reach the rebooker or the send.
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '14:00' } },
        notifyCustomer: true,
        customerNote: 'reschedule at bit.ly/waves',
      });

      expect(result).toEqual({ ok: false, reason: 'note_link_blocked' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  describe('getOptions', () => {
    test('attaches NWS rain chances to day options and counts the remaining route', async () => {
      SmartRebooker.findRescheduleOptions.mockResolvedValue([
        { date: '2026-06-12', displayDate: 'Fri, Jun 12', suggestedWindow: { start: '08:00', end: '10:00', display: '8:00-10:00 AM' }, score: 120 },
        { date: '2026-06-13', displayDate: 'Sat, Jun 13', suggestedWindow: { start: '09:00', end: '12:00', display: '9:00 AM-12:00 PM' }, score: 100 },
      ]);
      getDailyRainOutlook.mockResolvedValue({
        '2026-06-12': { rainChance: 65, shortForecast: 'Thunderstorms' },
        '2026-06-13': { rainChance: 20, shortForecast: 'Mostly Sunny' },
      });
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [{ id: 'svc-2' }, { id: 'svc-3' }] }),
        ],
      });

      const options = await RainOut.getOptions('svc-1');

      expect(options.ok).toBe(true);
      // Offers probe the same one-hour block commit() books (codex P2).
      expect(SmartRebooker.findRescheduleOptions).toHaveBeenCalledWith(
        'svc-1', 'weather_rain', { probeSpanMinutes: 60 },
      );
      expect(options.days).toHaveLength(2);
      expect(options.days[0]).toMatchObject({ date: '2026-06-12', rainChance: 65 });
      expect(options.days[1]).toMatchObject({ date: '2026-06-13', rainChance: 20 });
      // Day options are booked as on-the-hour 1-hour slots, not the rebooker's
      // wider 2-3h suggestedWindow, and the display is re-derived to match.
      expect(options.days[0].window).toEqual({ start: '08:00', end: '09:00' });
      expect(options.days[0].display).toBe('Fri, Jun 12, 8:00 AM-9:00 AM');
      expect(options.days[1].window).toEqual({ start: '09:00', end: '10:00' });
      expect(options.remainingRouteCount).toBe(2);
      expect(options.service.hasPhone).toBe(true);
      // Chips hidden in both sheets while the gate is dark.
      expect(options.extraReasonsEnabled).toBe(false);
    });

    test('extraReasonsEnabled mirrors GATE_QUICKMOVE_EXTRA_REASONS for the sheets', async () => {
      process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
      try {
        SmartRebooker.findRescheduleOptions.mockResolvedValue([]);
        wireDb({
          scheduled_services: [
            chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
            chain({ rows: [] }),
          ],
        });

        const options = await RainOut.getOptions('svc-1');

        expect(options.ok).toBe(true);
        expect(options.extraReasonsEnabled).toBe(true);
      } finally {
        delete process.env.GATE_QUICKMOVE_EXTRA_REASONS;
      }
    });
  });

  describe('custom reason (GATE_QUICKMOVE_CUSTOM_REASON)', () => {
    afterEach(() => {
      delete process.env.GATE_QUICKMOVE_CUSTOM_REASON;
    });

    function wireSingle() {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });
    }

    // Realistic custom-rung render so the pre-move segment check counts a
    // body shaped like production's (mirrors the migration BODY).
    function mockCustomRender() {
      renderSmsTemplate.mockImplementation(async (key, vars) => {
        if (key !== 'rain_out_moved_custom_v1') return 'rendered body';
        return `Hi ${vars.first_name} - ${vars.custom_message}\n\nWe've moved your ${vars.service_type} to ${vars.new_option}.${vars.link_clause}`;
      });
    }

    const MESSAGE = 'The building limits vendor entry after 6 - I will come back tomorrow afternoon.';
    const COMMIT_ARGS = {
      serviceId: 'svc-1',
      technicianId: 'tech-1',
      reasonCode: 'custom',
      scope: 'job',
      target: { date: '2026-06-12', window: { start: '13:00', end: '14:00' } },
      notifyCustomer: true,
      customerNote: MESSAGE,
      actorUserId: 'admin-7',
    };

    test('gate off: custom is rejected before any reschedule (fail closed)', async () => {
      wireSingle();
      const result = await RainOut.commit(COMMIT_ARGS);
      expect(result).toMatchObject({ ok: false, reason: 'bad_reason' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    });

    test('gate on: route scope rejected — a custom message is stop-specific, like the note', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      wireSingle();
      const result = await RainOut.commit({ ...COMMIT_ARGS, scope: 'route' });
      expect(result).toMatchObject({ ok: false, reason: 'custom_route_scope' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    });

    test('gate on: notifying without a message is rejected — the message IS the reason', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      wireSingle();
      const result = await RainOut.commit({ ...COMMIT_ARGS, customerNote: null });
      expect(result).toMatchObject({ ok: false, reason: 'custom_requires_note' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    });

    test('gate on: message opens the SMS, move line + link close it, no note append, no weather work', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      mockCustomRender();
      wireSingle();

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.ok).toBe(true);
      const sent = sendCustomerMessage.mock.calls[0][0];
      expect(sent.body).toBe(
        `Hi Pat - ${MESSAGE}\n\n`
        + "We've moved your quarterly pest control to Fri, Jun 12, 1:00 PM - 3:00 PM."
        + ' New time & other options: https://waves.test/r/tok123',
      );
      // The message is the FRONT — never also appended as a trailing note.
      expect(sent.body).not.toContain('Note from our team');
      expect(sent.metadata).toMatchObject({
        original_message_type: 'rain_out_moved_custom_v1',
        reason_code: 'custom',
        adminUserId: 'admin-7',
      });
      // No weather claims and no NWS fetches on a custom move.
      expect(getDailyRainOutlook).not.toHaveBeenCalled();
      expect(getHourlyRainOutlook).not.toHaveBeenCalled();
      // Checked body == sent body: the link is built once and the template
      // rendered once (pre-move segment check); the send reuses both — an
      // admin template edit or a shortener long-URL fallback between check
      // and send could otherwise exceed the cap the check passed.
      expect(buildRescheduleLink).toHaveBeenCalledTimes(1);
      const customCalls = renderSmsTemplate.mock.calls.filter((c) => c[0] === 'rain_out_moved_custom_v1');
      expect(customCalls).toHaveLength(1);
    });

    test('gate on: a body that would send as 3 segments is rejected BEFORE the move', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      mockCustomRender();
      wireSingle();

      // 200 chars (the note cap) + the ~130-char fixed tail ≈ 340 GSM slots
      // — over the 306-slot 2-segment budget.
      const result = await RainOut.commit({ ...COMMIT_ARGS, customerNote: 'x'.repeat(200) });

      expect(result).toMatchObject({ ok: false, reason: 'note_too_many_segments' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('gate on: missing/disabled custom template rejects the move pre-commit (kill switch, fail closed)', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      renderSmsTemplate.mockResolvedValueOnce(null);
      wireSingle();

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result).toMatchObject({ ok: false, reason: 'custom_message_unavailable' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('gate on: notifyCustomer=false moves silently with no render and no segment check', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      wireSingle();

      const result = await RainOut.commit({ ...COMMIT_ARGS, notifyCustomer: false, customerNote: null });

      expect(result.ok).toBe(true);
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-12', { start: '13:00', end: '14:00' }, 'custom', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] },
      );
      expect(renderSmsTemplate).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('gate on: the standard note guards still screen the custom message pre-move', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      wireSingle();
      const result = await RainOut.commit({ ...COMMIT_ARGS, customerNote: 'Back tomorrow 👍' });
      expect(result).toMatchObject({ ok: false, reason: 'note_emoji_blocked' });
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    });

    test('commit reuses the visit\'s EXISTING short code — counter estimate and enforcer measure the same URL', async () => {
      // codex PR P2: getOptions' counter estimates with the existing code,
      // so commit must build the body with the SAME one — a legacy
      // odd-length code vs a fresh 10-char mint flips boundary cases.
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      mockCustomRender();
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        short_codes: [chain({ first: jest.fn().mockResolvedValue({ code: 'abcde' }) })],
      });

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.ok).toBe(true);
      expect(buildRescheduleLink).not.toHaveBeenCalled();
      expect(sendCustomerMessage.mock.calls[0][0].body).toContain('/l/abcde');
    });

    test('custom renders pin the base row and demand the load-bearing placeholders (renderer opts contract)', async () => {
      // The enforcement itself lives in getTemplate (see
      // admin-sms-templates-render.test.js): noVariants pins the base row
      // (a weighted variant can't be previewed by the counter or the
      // pre-move cap — codex r3 P1) and requiredVars nulls a render whose
      // selected body lost {custom_message}/{new_option}/{link_clause}
      // (codex r3 P2). This test asserts rain-out actually ASKS for both
      // on every custom render.
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      mockCustomRender();
      wireSingle();

      const result = await RainOut.commit(COMMIT_ARGS);

      expect(result.ok).toBe(true);
      const customCalls = renderSmsTemplate.mock.calls.filter((c) => c[0] === 'rain_out_moved_custom_v1');
      expect(customCalls.length).toBeGreaterThan(0);
      for (const call of customCalls) {
        expect(call[3]).toEqual({
          noVariants: true,
          requiredVars: ['custom_message', 'new_option', 'link_clause'],
        });
      }
    });

    test('series-anchor path: the prebuilt SMS quotes the NORMALIZED on-the-hour window that actually books', async () => {
      // codex r2 P1: an off-hour custom-time target on a recurring visit is
      // floored to the hour by the series path — the SMS must be rendered
      // from that normalized window, never the raw request (13:30 booking
      // 13:00 while the text says 1:30 PM).
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
      try {
        mockCustomRender();
        wireDb({
          scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE, is_recurring: true }) })],
        });

        const result = await RainOut.commit({
          ...COMMIT_ARGS,
          target: { date: '2026-06-12', window: { start: '13:30', end: '14:30' } },
        });

        expect(result.ok).toBe(true);
        expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledWith(
          'svc-1', '2026-06-12', { start: '13:00', end: '14:00' }, 'custom', 'tech',
          expect.any(Object),
        );
        const sent = sendCustomerMessage.mock.calls[0][0];
        expect(sent.body).toContain('Fri, Jun 12, 1:00 PM - 3:00 PM');
        expect(sent.body).not.toContain('1:30 PM');
      } finally {
        delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
      }
    });

    test('custom template body stays GSM-7 and a representative render fits 2 segments', () => {
      const { BODY } = require('../models/migrations/20260811000020_rain_out_moved_custom_template')._test;
      const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
      expect(detectEncoding(BODY).encoding).toBe('GSM_7');
      const rendered = BODY
        .replace('{first_name}', 'Riley')
        .replace('{custom_message}', 'They limit vendor entry at six, other than emergencies. I will circle back tomorrow afternoon.')
        .replace('{service_type}', 'quarterly pest control')
        .replace('{new_option}', 'Fri, Aug 14, 8:00 AM - 10:00 AM')
        .replace('{link_clause}', ' New time & other options: portal.wavespestcontrol.com/l/ty34tarkdu');
      expect(detectEncoding(rendered).encoding).toBe('GSM_7');
      expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
    });

    test('getOptions: customCompose = availability signal (gate + live row); disabled row or gate off hide the option', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      SmartRebooker.findRescheduleOptions.mockResolvedValue([]);
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [] }),
        ],
        sms_templates: [
          chain({ first: jest.fn().mockResolvedValue({ is_active: true }) }),
        ],
      });
      let options = await RainOut.getOptions('svc-1');
      expect(options.customReasonEnabled).toBe(true);
      // No render payload — the counter is server-rendered on demand via
      // previewCustomSms (codex r9 P1); this is only the availability flag.
      expect(options.customCompose).toEqual({ maxSegments: 2 });

      // Disabled row = ops kill switch: the sheet must not offer Custom.
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [] }),
        ],
        sms_templates: [
          chain({ first: jest.fn().mockResolvedValue({ is_active: false }) }),
        ],
      });
      options = await RainOut.getOptions('svc-1');
      expect(options.customCompose).toBeNull();

      delete process.env.GATE_QUICKMOVE_CUSTOM_REASON;
      wireDb({
        scheduled_services: [
          chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) }),
          chain({ rows: [] }),
        ],
      });
      options = await RainOut.getOptions('svc-1');
      expect(options.customReasonEnabled).toBe(false);
      expect(options.customCompose).toBeNull();
    });

    test('previewCustomSms: renders through the real pipeline and returns the enforcement math', async () => {
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      mockCustomRender();
      // Existing short code reused (read-only) — never a fresh mint; the
      // counter and commit() measure the same URL (codex PR P2 lineage).
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE, reschedule_token: 'tok-abc' }) })],
        short_codes: [chain({ first: jest.fn().mockResolvedValue({ code: 'abcde' }) })],
      });

      const result = await RainOut.previewCustomSms({
        serviceId: 'svc-1',
        customMessage: `  ${MESSAGE}  `,
        target: { date: '2026-06-12', window: { start: '13:00', end: '14:00' } },
      });

      expect(result.ok).toBe(true);
      expect(buildRescheduleLink).not.toHaveBeenCalled();
      const vars = renderSmsTemplate.mock.calls[0][1];
      expect(vars.link_clause).toContain('/l/abcde');
      // Whitespace-collapsed like sanitizeCustomerNote before rendering.
      expect(vars.custom_message).toBe(MESSAGE);
      // The math IS the enforcement math: same countSegments over the
      // rendered body.
      const { countSegments } = require('../services/messaging/segment-counter');
      const body = `Hi Pat - ${MESSAGE}\n\nWe've moved your quarterly pest control to Fri, Jun 12, 1:00 PM - 3:00 PM.${vars.link_clause}`;
      const seg = countSegments(body);
      expect(result).toMatchObject({
        segments: seg.segmentCount,
        maxSegments: 2,
        withinCap: true,
        remaining: 306 - seg.gsmSlotCount,
        encoding: 'GSM_7',
      });
    });

    test('previewCustomSms: gate off / dead template reject like commit would', async () => {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });
      let result = await RainOut.previewCustomSms({
        serviceId: 'svc-1', customMessage: MESSAGE,
        target: { date: '2026-06-12', window: { start: '13:00', end: '14:00' } },
      });
      expect(result).toMatchObject({ ok: false, reason: 'bad_reason' });

      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      renderSmsTemplate.mockResolvedValueOnce(null);
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
      });
      result = await RainOut.previewCustomSms({
        serviceId: 'svc-1', customMessage: MESSAGE,
        target: { date: '2026-06-12', window: { start: '13:00', end: '14:00' } },
      });
      expect(result).toMatchObject({ ok: false, reason: 'custom_message_unavailable' });
    });

    test('commit: template-static send blockers (emoji, guard markers) reject the move BEFORE it commits', async () => {
      // codex r9 P2: an admin-saved emoji or a marker like '1970' in the
      // TEMPLATE's static text passes every note guard, renders truthy,
      // and would strand a committed move when the send layer blocks it.
      process.env.GATE_QUICKMOVE_CUSTOM_REASON = 'true';
      for (const staticTail of [' See you! \u2614', ' Since 1970.']) {
        renderSmsTemplate.mockImplementationOnce(async (key, vars) => (
          `Hi Pat - ${vars.custom_message}\n\nWe've moved your ${vars.service_type} to ${vars.new_option}.${vars.link_clause}${staticTail}`
        ));
        wireSingle();
        const result = await RainOut.commit(COMMIT_ARGS);
        expect(result).toMatchObject({ ok: false, reason: 'custom_message_unavailable' });
      }
      expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });
});
