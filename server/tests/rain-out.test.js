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
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlook: jest.fn().mockResolvedValue(null),
  forecastLinkForZip: jest.fn((zip) => (zip ? `https://forecast.weather.gov/zipcity.php?inputstring=${zip}` : null)),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { getDailyRainOutlook } = require('../services/weather-forecast');
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
      const logRow = chain({ first: jest.fn().mockResolvedValue({ id: 'log-1' }) });
      const logUpdate = chain();
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SERVICE }) })],
        reschedule_log: [logRow, logUpdate],
      });
      return { logUpdate };
    }

    test('same-day move books exactly the displayed window, passes allowLive, texts with alt + forecast link', async () => {
      const { logUpdate } = wireSingle();

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'job',
        target: { date: '2026-06-11', window: { start: '13:00', end: '15:00' } },
        alt: { date: '2026-06-12', window: { start: '08:00', end: '10:00' } },
        notifyCustomer: true,
      });

      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(1);

      // The anchor books the window the tech saw in the sheet — verbatim.
      expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
        'svc-1', '2026-06-11', { start: '13:00', end: '15:00' }, 'weather_rain', 'tech',
        { allowLive: true },
      );

      const vars = renderSmsTemplate.mock.calls[0][1];
      expect(vars.weather_phrase).toBe('heavy rain');
      expect(vars.new_option).toContain('1:00 PM-3:00 PM');
      expect(vars.alt_clause).toContain('Reply 1 to confirm, or 2 to switch');
      expect(vars.forecast_clause).toContain('forecast.weather.gov/zipcity.php?inputstring=34202');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

      // Reply options written into the rebooker's reschedule_log row —
      // windows carry `display` because handleRescheduleReply renders
      // selectedOption.window.display in the confirmation SMS.
      const notes = JSON.parse(logUpdate.update.mock.calls[0][0].notes);
      expect(notes.option1).toEqual({
        date: '2026-06-11',
        window: { start: '13:00', end: '15:00', display: '1:00 PM-3:00 PM' },
      });
      expect(notes.option2).toEqual({
        date: '2026-06-12',
        window: { start: '08:00', end: '10:00', display: '8:00 AM-10:00 AM' },
      });
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
        alt: { date: '2026-06-12', window: { start: '08:00', end: '10:00' } },
        notifyCustomer: true,
      });

      // Anchor 09:00→13:00 = +4h delta; sibling 11:30-13:30 → 15:30-17:30.
      // Tail-first: the later sibling moves BEFORE the anchor so the anchor's
      // new 13:00-15:00 slot isn't blocked by the not-yet-moved sibling.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-2', '2026-06-11', { start: '15:30', end: '17:30' }, 'weather_rain', 'tech', { allowLive: true });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-1', '2026-06-11', { start: '13:00', end: '15:00' }, 'weather_rain', 'tech', { allowLive: true });
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
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'admin', { allowLive: true });
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

    test('day move shifts all stops to the new date keeping each window; anchor gets the alt', async () => {
      wireRoute();

      const result = await RainOut.commit({
        serviceId: 'svc-1',
        technicianId: 'tech-1',
        reasonCode: 'weather_rain',
        scope: 'route',
        target: { date: '2026-06-12', window: { start: '09:00', end: '11:00' } },
        alt: { date: '2026-06-13', window: { start: '09:00', end: '11:00' } },
        notifyCustomer: true,
      });

      expect(result.ok).toBe(true);
      expect(result.movedCount).toBe(3);

      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(1,
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'tech', { allowLive: true });
      // Route siblings keep their own windows on the new date.
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(2,
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech', { allowLive: true });
      expect(SmartRebooker.reschedule).toHaveBeenNthCalledWith(3,
        'svc-3', '2026-06-12', { start: '14:00', end: '16:00' }, 'weather_rain', 'tech', { allowLive: true });

      // Anchor SMS carries reply-2 alt; sibling SMS does not; no-phone
      // sibling skipped.
      expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
      expect(renderSmsTemplate.mock.calls[0][1].alt_clause).toContain('Reply 1 to confirm');
      expect(renderSmsTemplate.mock.calls[1][1].alt_clause).toContain('Reply to this message');
      const noPhone = result.results.find((r) => r.id === 'svc-3');
      expect(noPhone.smsSent).toBe(false);
      expect(noPhone.smsReason).toBe('no_phone');
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
        'svc-2', '2026-06-12', { start: '11:30', end: '13:30' }, 'weather_rain', 'tech', { allowLive: true });
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
