jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  findRescheduleOptions: jest.fn().mockResolvedValue([]),
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

const db = require('../models/db');
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
        .toBe(' Saturday looks a lot better — just a 20% chance of rain.');
      expect(clause({ ...base, todayChance: 85, newChance: 35 }))
        .toBe(' Saturday looks better — a 35% chance of rain.');
      // Unknown today still allows a low-chance claim about the new day.
      expect(clause({ ...base, todayChance: null, newChance: 15 }))
        .toBe(' Saturday looks a lot better — just a 15% chance of rain.');
    });

    test('tomorrow is called Tomorrow', () => {
      expect(clause({ ...base, chosenDate: '2026-06-12', todayChance: 85, newChance: 10 }))
        .toBe(' Tomorrow looks a lot better — just a 10% chance of rain.');
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
        .toBe(' Saturday morning looks a lot better — just a 10% chance of rain around your new time.');
      expect(clause({ ...base, todayChance: 85, windowChance: 35, windowStart: '13:00' }))
        .toBe(' Saturday afternoon looks better — a 35% chance of rain around your new time.');
      expect(clause({ ...base, chosenDate: '2026-06-12', todayChance: 85, windowChance: 15, windowStart: '15:00' }))
        .toBe(' Tomorrow afternoon looks a lot better — just a 15% chance of rain around your new time.');
    });

    test('same-day push can promise later today, with a tighter cap', () => {
      const sameDay = { ...base, isSameDay: true, chosenDate: '2026-06-11' };
      expect(clause({ ...sameDay, todayChance: 85, windowChance: 15, windowStart: '15:00' }))
        .toBe(' Later today looks a lot better — just a 15% chance of rain around your new time.');
      // Same storm system: window claims over 30% stay silent on same-day moves.
      expect(clause({ ...sameDay, todayChance: 85, windowChance: 35, windowStart: '15:00' })).toBe('');
    });

    test('window claims still respect the today-delta rule and fall back to day-level without hourly data', () => {
      expect(clause({ ...base, todayChance: 45, windowChance: 30, windowStart: '08:00' })).toBe(''); // delta < 20
      expect(clause({ ...base, todayChance: 85, windowChance: null, newChance: 20 }))
        .toBe(' Saturday looks a lot better — just a 20% chance of rain.'); // day-level fallback
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
        // excludeServiceIds = the row being moved + already-VACATED batch
        // members (here just the anchor itself) so the rebooker's tech-blind
        // occupancy check never clashes a move against the row's own
        // pre-move position.
        { allowLive: true, excludeServiceIds: ['svc-1'] },
      );

      // ...but the CUSTOMER is quoted the usual 2-hour arrival window from the
      // start (13:00 → 1:00-3:00 PM), never the internal 1-hour end.
      // Renders the forecast-grounded v2 template seeded by this PR's
      // migration; the untouched legacy row is only a fallback.
      expect(renderSmsTemplate.mock.calls[0][0]).toBe('rain_out_moved_v2');
      const vars = renderSmsTemplate.mock.calls[0][1];
      expect(vars.weather_lead).toBe('storms are likely today (85% chance)');
      expect(vars.better_day_clause).toBe(' Thursday afternoon looks a lot better — just a 10% chance of rain around your new time.');
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
      // Exclusion = current row + already-vacated members only: the sibling
      // moves first excluding just ITSELF (the not-yet-moved anchor's old
      // 09:00 row stays visible — the tail-first order keeps the sibling's
      // 15:30 target clear of it); the anchor then excludes itself + the
      // vacated sibling.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-2', '2026-06-11', { start: '15:30', end: '17:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-1', '2026-06-11', { start: '13:00', end: '15:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1', 'svc-2'] });
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
      // the pull shifts the anchor AWAY from it); the sibling then excludes
      // itself + the vacated anchor.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-11', { start: '07:00', end: '08:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-11', { start: '09:30', end: '11:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2', 'svc-1'] });
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
      // date-scoped probes can't see them, so nothing is pre-excluded. The
      // set grows only with members already landed on the target date.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      // Route siblings keep their own windows on the new date.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2', 'svc-1'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(3,
        'svc-3', '2026-06-12', { start: '14:00', end: '16:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-3', 'svc-1', 'svc-2'] });

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
        { allowLive: true, excludeServiceIds: ['svc-2', 'svc-1'] });
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

    test('exclusion = current + SUCCEEDED only; a FAILED member never leaves the conflict domain', async () => {
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

      // Every move excludes ONLY itself + members already vacated. Members
      // still awaiting their move are NOT pre-excluded — a blanket batch
      // exclusion let a member another actor concurrently moved into an
      // earlier target commit an invisible overlap that removing the id
      // later could not undo.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-1'] });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-2', 'svc-1'] });
      // svc-2 FAILED — its row is still live at its OLD position and it
      // never entered the vacated set, so svc-3's probe keeps seeing the
      // stranded row (and can block on it) instead of silently
      // double-booking on top of it.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(3,
        'svc-3', '2026-06-12', { start: '14:00', end: '16:00' }, 'weather_rain', 'tech',
        { allowLive: true, excludeServiceIds: ['svc-3', 'svc-1'] });
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
      // The anchor's own move still ran, excluding only itself (svc-2
      // failed, so it never joined the vacated set).
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
    });
  });
});
