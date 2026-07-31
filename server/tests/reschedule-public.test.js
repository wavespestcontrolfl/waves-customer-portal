/**
 * Public self-serve reschedule — eligibility gating, booking-window range,
 * the SMS {reschedule_line} clause contract, and the template migrations'
 * embed shape.
 */

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const { getDailyRainOutlookBounded } = require('../services/weather-forecast');
const reschedulePublicRouter = require('../routes/reschedule-public');
const { smsLineFor } = require('../services/reschedule-link');
const smsMigration = require('../models/migrations/20260702000011_reschedule_link_sms_templates');
const emailMigration = require('../models/migrations/20260702000012_reschedule_link_email_templates');

const {
  eligibility, bookingRange, searchParseOpts, apptDateStr, label12,
  pullForwardDays, shouldReanchor, REANCHOR_PULLFORWARD_DAYS,
  loadWeatherMove, WEATHER_MOVE_MAX_AGE_DAYS, collectiveAnchorActive,
  seriesScopeMismatch,
} = reschedulePublicRouter._test;

// Fixed "now": 2026-07-02 12:00 ET (16:00 UTC, EDT).
const NOW = new Date('2026-07-02T16:00:00.000Z');

describe('reschedule-public eligibility', () => {
  test('terminal and live statuses are not reschedulable, with customer-safe reasons', () => {
    expect(eligibility({ status: 'completed', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'completed' });
    expect(eligibility({ status: 'cancelled', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'cancelled' });
    expect(eligibility({ status: 'canceled', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'cancelled' });
    expect(eligibility({ status: 'en_route', scheduled_date: '2026-07-02' }, NOW))
      .toEqual({ ok: false, reason: 'in_progress' });
    expect(eligibility({ status: 'on_site', scheduled_date: '2026-07-02' }, NOW))
      .toEqual({ ok: false, reason: 'in_progress' });
    expect(eligibility({ status: 'no_show', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: false, reason: 'not_available' });
    expect(eligibility({ status: 'skipped', scheduled_date: '2026-07-10' }, NOW))
      .toEqual({ ok: false, reason: 'not_available' });
  });

  test('past pending/confirmed appointments are MISSED and rebookable (owner ruling 2026-07-13)', () => {
    expect(eligibility({ status: 'confirmed', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: true, missed: true });
    expect(eligibility({ status: 'pending', scheduled_date: '2026-06-20' }, NOW))
      .toEqual({ ok: true, missed: true });
    // Terminal/live/no-show states stay blocked even when past — only visits
    // that were never served (still pending-family) get the rebook path.
    expect(eligibility({ status: 'no_show', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: false, reason: 'not_available' });
    expect(eligibility({ status: 'completed', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: false, reason: 'completed' });
    // A past 'rescheduled' row is a pending-rebook PLACEHOLDER, not a missed
    // visit — reviving it would resurrect a phantom (codex r6). Future
    // 'rescheduled' rows stay plainly reschedulable (tested above).
    expect(eligibility({ status: 'rescheduled', scheduled_date: '2026-07-01' }, NOW))
      .toEqual({ ok: false, reason: 'past' });
    expect(eligibility({
      status: 'rescheduled',
      scheduled_date: '2026-07-02',
      window_start: '08:00:00',
      window_end: '09:00:00',
    }, NOW)).toEqual({ ok: false, reason: 'past' });
  });

  test('same-day appointment is missed only after the QUOTED arrival window (start + 2h), not the job block', () => {
    // 8:00 start, job block ends 10:00, arrival promise ran to 10:00 —
    // by 12:00 ET it is genuinely missed.
    expect(eligibility({
      status: 'confirmed',
      scheduled_date: '2026-07-02',
      window_start: '08:00:00',
      window_end: '10:00:00',
    }, NOW)).toEqual({ ok: true, missed: true });
    // 10:30 start with job block ending 11:00: at 12:00 ET the job block has
    // elapsed but the quoted 10:30–12:30 arrival window has NOT — the tech
    // may still legitimately arrive, so it's a plain reschedulable visit,
    // never "we missed each other" (codex P2 2026-07-13).
    expect(eligibility({
      status: 'confirmed',
      scheduled_date: '2026-07-02',
      window_start: '10:30:00',
      window_end: '11:00:00',
    }, NOW)).toEqual({ ok: true });
  });

  test('same-day appointment with a window still ahead stays reschedulable', () => {
    expect(eligibility({
      status: 'confirmed',
      scheduled_date: '2026-07-02',
      window_start: '13:00:00',
      window_end: '15:00:00',
    }, NOW)).toEqual({ ok: true });
  });

  test('pending / confirmed / rescheduled future appointments are reschedulable', () => {
    for (const status of ['pending', 'confirmed', 'rescheduled']) {
      expect(eligibility({ status, scheduled_date: '2026-07-10' }, NOW)).toEqual({ ok: true });
    }
  });

  test('apptDateStr normalizes Date and string forms', () => {
    expect(apptDateStr('2026-07-10T00:00:00.000Z')).toBe('2026-07-10');
    expect(apptDateStr(new Date('2026-07-10T00:00:00.000Z'))).toBe('2026-07-10');
    expect(apptDateStr(null)).toBe(null);
  });

  test('label12 formats HH:MM(:SS) into 12-hour labels for the replay response', () => {
    expect(label12('09:00')).toBe('9:00 AM');
    expect(label12('14:00:00')).toBe('2:00 PM');
    expect(label12('00:30')).toBe('12:30 AM');
    expect(label12('12:00')).toBe('12:00 PM');
    expect(label12(null)).toBe(null);
  });
});

describe('reschedule-public series re-anchor rule', () => {
  test('pullForwardDays: positive for earlier targets, negative for push-backs', () => {
    expect(pullForwardDays('2026-08-13', '2026-07-16')).toBe(28);
    expect(pullForwardDays('2026-07-16', '2026-08-13')).toBe(-28);
    expect(pullForwardDays('2026-07-16', '2026-07-16')).toBe(0);
    expect(pullForwardDays(null, '2026-07-16')).toBe(0);
  });

  test('re-anchors ONLY recurring visits pulled forward by at least the threshold', () => {
    const recurring = { is_recurring: true, scheduled_date: '2026-08-13' };
    // 28-day pull-forward (Bill Waterman's case) → re-anchor.
    expect(shouldReanchor(recurring, '2026-07-16')).toBe(true);
    // Exactly at threshold → re-anchor; one day short → single move.
    const at = new Date(Date.UTC(2026, 7, 13, 12) - REANCHOR_PULLFORWARD_DAYS * 86400000)
      .toISOString().slice(0, 10);
    const under = new Date(Date.UTC(2026, 7, 13, 12) - (REANCHOR_PULLFORWARD_DAYS - 1) * 86400000)
      .toISOString().slice(0, 10);
    expect(shouldReanchor(recurring, at)).toBe(true);
    expect(shouldReanchor(recurring, under)).toBe(false);
    // Push-backs never re-anchor.
    expect(shouldReanchor(recurring, '2026-08-20')).toBe(false);
    // Non-recurring visits never re-anchor regardless of distance.
    expect(shouldReanchor({ is_recurring: false, scheduled_date: '2026-08-13' }, '2026-07-16')).toBe(false);
    // A genuine child occurrence carries is_recurring itself and re-anchors.
    expect(shouldReanchor({ is_recurring: true, recurring_parent_id: 'abc', scheduled_date: '2026-08-13' }, '2026-07-16')).toBe(true);
    // BOOSTER extras share recurring_parent_id but are is_recurring=false —
    // moving one must NEVER shift the base plan (codex P1 2026-07-13).
    expect(shouldReanchor({ is_recurring: false, recurring_parent_id: 'abc', scheduled_date: '2026-08-13' }, '2026-07-16')).toBe(false);
  });
});

describe('reschedule-public booking window', () => {
  test('mirrors booking_config advance days', () => {
    const range = bookingRange({ advance_days_min: 1, advance_days_max: 14 }, NOW);
    expect(range).toEqual({ rangeFrom: '2026-07-03', rangeTo: '2026-07-16' });
  });

  test('defaults match the public /book funnel defaults', () => {
    const range = bookingRange({}, NOW);
    expect(range).toEqual({ rangeFrom: '2026-07-03', rangeTo: '2026-07-16' });
  });
});

describe('reschedule-public AI search window', () => {
  test('parseWhen opts clamp BOTH ends to the reschedule window — no 90-day reach', () => {
    const opts = searchParseOpts({ advance_days_min: 1, advance_days_max: 14 }, NOW);
    expect(opts).toEqual({ now: NOW, minDaysOut: 1, maxDaysOut: 14, defaultWindowDays: 14 });
  });

  test('defaults mirror bookingRange defaults so search never exceeds the slot list', () => {
    const opts = searchParseOpts({}, NOW);
    expect(opts.minDaysOut).toBe(1);
    expect(opts.maxDaysOut).toBe(14);
    expect(opts.defaultWindowDays).toBe(14);
  });

  test('a widened booking_config widens the search window in lockstep', () => {
    const opts = searchParseOpts({ advance_days_min: 2, advance_days_max: 21 }, NOW);
    expect(opts.minDaysOut).toBe(2);
    expect(opts.maxDaysOut).toBe(21);
    expect(opts.defaultWindowDays).toBe(21);
  });
});

describe('reschedule-link SMS clause', () => {
  test('renders the embed clause for a URL and empty string for none', () => {
    expect(smsLineFor('https://portal.wavespestcontrol.com/l/abc12'))
      .toBe('Need a different time? Reschedule online: https://portal.wavespestcontrol.com/l/abc12\n\n');
    expect(smsLineFor(null)).toBe('');
    expect(smsLineFor('')).toBe('');
  });
});

describe('SMS template migration embed contract', () => {
  test('every updated template body embeds {reschedule_line} and lists the variable', () => {
    expect(smsMigration.UPDATES.map((u) => u.template_key).sort())
      .toEqual(['appointment_confirmation', 'reminder_24h', 'reminder_72h']);
    for (const u of smsMigration.UPDATES) {
      expect(u.newBody).toContain('{reschedule_line}');
      expect(u.variables).toContain('reschedule_line');
      // Clause var carries its own trailing blank line — the body must not
      // double it up ("\n\n{reschedule_line}" is the only valid embedding).
      expect(u.newBody).toContain('\n\n{reschedule_line}');
      expect(u.newBody).not.toContain('{reschedule_line}\n\n');
    }
  });
});

describe('email template migration helpers', () => {
  const { insertRescheduleCta, referencesRescheduleUrl, withVariable } = emailMigration.__private;

  test('inserts the reschedule CTA before the existing CTA', () => {
    const blocks = [
      { type: 'paragraph', content: 'Hello' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thanks' },
    ];
    const next = insertRescheduleCta(blocks);
    expect(next).toHaveLength(4);
    expect(next[1]).toEqual({ type: 'cta', label: 'Reschedule appointment', url_variable: 'reschedule_url' });
    expect(next[2].url_variable).toBe('customer_portal_url');
  });

  test('falls back to before-signature, then append, when no CTA exists', () => {
    const withSig = insertRescheduleCta([
      { type: 'paragraph', content: 'Hello' },
      { type: 'signature', content: 'Thanks' },
    ]);
    expect(withSig[1].url_variable).toBe('reschedule_url');
    expect(withSig[2].type).toBe('signature');

    const appended = insertRescheduleCta([{ type: 'paragraph', content: 'Hello' }]);
    expect(appended[1].url_variable).toBe('reschedule_url');
  });

  test('detects existing reschedule_url references (idempotent up)', () => {
    expect(referencesRescheduleUrl([{ type: 'cta', url_variable: 'reschedule_url' }])).toBe(true);
    expect(referencesRescheduleUrl([{ type: 'small_note', content: 'Reschedule: {{reschedule_url}}' }])).toBe(true);
    expect(referencesRescheduleUrl([{ type: 'cta', url_variable: 'customer_portal_url' }])).toBe(false);
    expect(referencesRescheduleUrl('[{"type":"cta","url_variable":"reschedule_url"}]')).toBe(true);
  });

  test('withVariable appends once and tolerates JSON-string columns', () => {
    expect(withVariable(['a'], 'reschedule_url')).toEqual(['a', 'reschedule_url']);
    expect(withVariable(['a', 'reschedule_url'], 'reschedule_url')).toEqual(['a', 'reschedule_url']);
    expect(withVariable('["a"]', 'reschedule_url')).toEqual(['a', 'reschedule_url']);
  });
});

describe('weatherMove banner context (GATE_RAINOUT_MOVE_BANNER)', () => {
  afterEach(() => {
    delete process.env.GATE_RAINOUT_MOVE_BANNER;
    jest.clearAllMocks();
  });

  const SVC = {
    id: 'svc-1',
    scheduled_date: '2026-07-04',
    window_start: '09:00:00',
    latitude: '27.4',
    longitude: '-82.4',
  };
  const LOG = {
    reason_code: 'weather_rain',
    initiated_by: 'tech',
    original_date: '2026-07-03',
    original_window: '12:00:00-14:00:00',
    new_date: '2026-07-04',
    new_window: '09:00:00-10:00:00',
    created_at: '2026-07-02T15:00:00.000Z',
  };

  function wireLog(row) {
    mockDb.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(row),
    }));
  }

  test('gate off: always null, no queries', async () => {
    wireLog(LOG);
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('gate on: a recent weather move the visit still sits on returns was/now + forecast chances', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog(LOG);
    getDailyRainOutlookBounded.mockResolvedValueOnce({
      '2026-07-03': { rainChance: 80 },
      '2026-07-04': { rainChance: 15 },
    });

    const move = await loadWeatherMove(SVC, NOW);
    expect(move).toEqual({
      reasonCode: 'weather_rain',
      from: { date: '2026-07-03', windowStart: '12:00' },
      to: { date: '2026-07-04', windowStart: '09:00' },
      fromChance: 80,
      toChance: 15,
    });
    expect(getDailyRainOutlookBounded).toHaveBeenCalledWith('27.4', '-82.4', { deadlineMs: 1500 });
  });

  test('forecast failure or no coverage is fail-open: move present, chips null', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog(LOG);
    getDailyRainOutlookBounded.mockRejectedValueOnce(new Error('nws down'));

    const move = await loadWeatherMove(SVC, NOW);
    expect(move).toMatchObject({ fromChance: null, toChance: null });
    expect(move.from.date).toBe('2026-07-03');
  });

  test('a non-weather newest log row means no banner — later moves supersede the story', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog({ ...LOG, reason_code: 'customer_request' });
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();
  });

  test('a series rain-out (reason weather_rain_series) still banners with the normalized reason (codex P2)', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog({ ...LOG, reason_code: 'weather_rain_series' });
    getDailyRainOutlookBounded.mockResolvedValueOnce({
      '2026-07-03': { rainChance: 80 },
      '2026-07-04': { rainChance: 15 },
    });

    const move = await loadWeatherMove(SVC, NOW);
    expect(move).toMatchObject({ reasonCode: 'weather_rain', fromChance: 80, toChance: 15 });
  });

  test('a customer-initiated move keeping the weather reason is the customer\'s pick, not a banner (codex r3)', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    // reschedule-sms reply flow logs customer_sms with the original
    // weather_* reason; the self-serve page logs customer_self_serve.
    wireLog({ ...LOG, initiated_by: 'customer_sms' });
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();
    wireLog({ ...LOG, initiated_by: 'customer_self_serve' });
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();
  });

  test('a weather move the visit no longer sits on (date or start changed) means no banner', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog({ ...LOG, new_date: '2026-07-05' });
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();

    wireLog({ ...LOG, new_window: '13:00:00-14:00:00' });
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();
  });

  test('a stale move ages out', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    const staleMs = (WEATHER_MOVE_MAX_AGE_DAYS + 1) * 86400000;
    wireLog({ ...LOG, created_at: new Date(NOW.getTime() - staleMs).toISOString() });
    expect(await loadWeatherMove(SVC, NOW)).toBeNull();
  });

  test('non-rain reasons render the banner without rain chips and never fetch the forecast (codex r4)', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog({ ...LOG, reason_code: 'weather_wind' });
    const move = await loadWeatherMove(SVC, NOW);
    expect(move).toMatchObject({ reasonCode: 'weather_wind', fromChance: null, toChance: null });
    expect(getDailyRainOutlookBounded).not.toHaveBeenCalled();
  });

  test('missing coordinates skip the forecast but keep the banner', async () => {
    process.env.GATE_RAINOUT_MOVE_BANNER = 'true';
    wireLog(LOG);
    const move = await loadWeatherMove({ ...SVC, latitude: null, longitude: null }, NOW);
    expect(move).toMatchObject({ fromChance: null, toChance: null });
    // Bounded lookup is still invoked; it no-ops on null coords itself.
    expect(getDailyRainOutlookBounded).toHaveBeenCalledWith(null, null, { deadlineMs: 1500 });
  });
});

describe('collective series anchoring (GATE_COLLECTIVE_SERIES_ANCHOR)', () => {
  afterEach(() => { delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR; });

  test('GET→POST scope pin: a gate flip between render and commit is rejected, either direction (codex P1)', () => {
    const series = { is_recurring: true, scheduled_date: '2026-08-13' };
    // Disclosed legacy, gate now collective → mismatch.
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    expect(seriesScopeMismatch(series, false)).toBe(true);
    expect(seriesScopeMismatch(series, true)).toBe(false);
    // Disclosed collective, gate now off → mismatch.
    delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
    expect(seriesScopeMismatch(series, true)).toBe(true);
    expect(seriesScopeMismatch(series, false)).toBe(false);
    // Non-series visits and pre-disclosure clients (field absent) never pin.
    expect(seriesScopeMismatch({ is_recurring: false }, true)).toBe(false);
    expect(seriesScopeMismatch(series, undefined)).toBe(false);
  });

  test('gate on: ANY date change re-anchors a series visit — both directions, any size', () => {
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    const rec = { is_recurring: true, scheduled_date: '2026-08-13' };
    expect(shouldReanchor(rec, '2026-08-14')).toBe(true);  // 1-day push-back
    expect(shouldReanchor(rec, '2026-08-12')).toBe(true);  // 1-day pull-forward
    expect(shouldReanchor(rec, '2026-09-13')).toBe(true);  // big push-back
    expect(shouldReanchor(rec, '2026-08-13')).toBe(false); // time-only move: no delta
    // Non-recurring and boosters never shift the base plan.
    expect(shouldReanchor({ is_recurring: false, scheduled_date: '2026-08-13' }, '2026-08-20')).toBe(false);
    expect(shouldReanchor({ is_recurring: false, recurring_parent_id: 'abc', scheduled_date: '2026-08-13' }, '2026-08-20')).toBe(false);
  });

  test('gate off: the 07-13 pull-forward threshold behavior is unchanged', () => {
    const rec = { is_recurring: true, scheduled_date: '2026-08-13' };
    expect(shouldReanchor(rec, '2026-08-12')).toBe(false);
    expect(shouldReanchor(rec, '2026-09-13')).toBe(false);
    expect(shouldReanchor(rec, '2026-07-16')).toBe(true); // 28-day pull still re-anchors
    expect(collectiveAnchorActive()).toBe(false);
  });
});
