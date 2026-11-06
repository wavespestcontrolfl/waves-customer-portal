// GATE_DAY_ONLY_PROMISE part B2: the migration that adds the day-only MOVE rows (reschedule text, rain-out text, the two
// series texts, the reschedule email), the template registry's required placeholders for them, the day-only reschedule line,
// and the wiring of the callers (source scans: the sender functions are far too large to drive end to end). Synthetic data only.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('no database in this test'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261106130000_day_only_move_templates');
const b1 = require('../models/migrations/20261106120000_day_only_promise_templates');
const { recordAuditEvent } = require('../services/audit-log');
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = jest.requireActual('../routes/admin-sms-templates');

const { SMS_TEMPLATES, EMAIL_TEMPLATES } = migration._test;
const byKey = Object.fromEntries(SMS_TEMPLATES.map((t) => [t.key, t]));
const placeholders = (body) => [...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const render = (body, vars) => normalizeGsmPunctuation(body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')).replace(/\n{3,}/g, '\n\n').trim();

const VARS = {
  first_name: 'Maria', service_type: 'Quarterly Pest Control Service', day: 'Monday', date: 'November 9', start_date: 'Friday, Nov 27',
  service_name: 'Monthly Mosquito Control Service', new_option: 'Thu, Nov 12', weather_lead: 'storms are likely tomorrow',
  link_clause: ' New time, forecast & other options: portal.wavespestcontrol.com/l/k3j9m2x7qp', different_time_line: 'Need a different day or a set time? portal.wavespestcontrol.com/l/k3j9m2x7qp',
};

describe('the day-only move rows', () => {
  test('the four text keys, word for word', () => {
    expect(SMS_TEMPLATES.map((t) => t.key)).toEqual([
      'appointment_rescheduled_day_v1', 'rain_out_moved_day_v1', 'appointment_series_rescheduled_day_v1', 'appointment_recurring_placement_confirmed_day_v1',
    ]);
    expect(byKey.appointment_rescheduled_day_v1.body).toBe("Hi {first_name}, your Waves {service_type} is now {day}, {date}. We'll text your arrival window the day before.\n\n{different_time_line}");
    expect(render(byKey.appointment_rescheduled_day_v1.body, VARS)).toBe(
      "Hi Maria, your Waves Quarterly Pest Control Service is now Monday, November 9. We'll text your arrival window the day before.\n\nNeed a different day or a set time? portal.wavespestcontrol.com/l/k3j9m2x7qp",
    );
    expect(byKey.appointment_series_rescheduled_day_v1.body).toContain("We'll text the arrival window the day before each visit.");
    expect(byKey.appointment_recurring_placement_confirmed_day_v1.body).toContain("We'll text the arrival window the day before each visit.");
  });

  test.each(SMS_TEMPLATES.map((t) => [t.key, t]))('%s: no hour var, GSM-7, "Waves" never "Waves Pest Control", declared variables cover the body, at most 2 segments', (_key, t) => {
    expect(placeholders(t.body)).not.toContain('window');
    expect(placeholders(t.body)).not.toContain('time');
    expect(placeholders(t.body)).not.toContain('window_text');
    expect(t.variables).not.toContain('window');
    expect(detectEncoding(t.body).encoding).toBe('GSM_7');
    expect(t.body).not.toMatch(/[–—‘’“”]/);
    expect(t.body).not.toMatch(/Waves Pest Control/);
    expect(placeholders(t.body).every((name) => t.variables.includes(name))).toBe(true);
    expect(countSegments(render(t.body, VARS)).segmentCount).toBeLessThanOrEqual(2);
  });

  test('the rain-out day row is the LIVE v3 row with the day-before line (same variables, no footer)', () => {
    // The live v3 body: 20260730600000 seeded it, 20260810000060 dropped the STOP footer from customer transactional
    // texts, and 20260928210000 changed "so we moved" to "so Waves moved" (owner: texts say "Waves").
    const liveV3 = 'Hi {first_name}, {weather_lead}, so Waves moved your {service_type} to {new_option}.{link_clause}';
    const brand = require('fs').readFileSync(require.resolve('../models/migrations/20260928210000_sms_brand_just_waves'), 'utf8');
    expect(brand).toContain(liveV3);
    expect(byKey.rain_out_moved_day_v1.body).toBe(liveV3.replace('{new_option}.{link_clause}', "{new_option}. We'll text your arrival window the day before.{link_clause}"));
  });

  test('the template registry requires the day (or the first date), never a window', () => {
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.appointment_rescheduled_day_v1).toEqual(['date', 'day']);
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.rain_out_moved_day_v1).toEqual(['new_option']);
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.appointment_series_rescheduled_day_v1).toEqual(['start_date']);
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.appointment_recurring_placement_confirmed_day_v1).toEqual(['start_date']);
    for (const t of SMS_TEMPLATES) {
      const required = REQUIRED_TEMPLATE_PLACEHOLDERS[t.key];
      expect(required.every((name) => t.body.includes(`{${name}}`) && t.variables.includes(name))).toBe(true);
    }
  });

  test('the day email carries the day and no hour, and requires the day and date', () => {
    expect(EMAIL_TEMPLATES.map((t) => t.key)).toEqual(['appointment.rescheduled_day']);
    const [email] = EMAIL_TEMPLATES;
    expect(email.required).toEqual(['first_name', 'service_type', 'appointment_day', 'appointment_date']);
    expect(JSON.stringify(email.blocks)).not.toMatch(/arrival_window|appointment_time|\b\d{1,2}:\d{2}\b|\b(?:AM|PM)\b/);
    expect(JSON.stringify(email.blocks)).toContain("We'll send your arrival window the day before.");
  });
});

describe('the migration', () => {
  function fakeKnex({ rows = {}, tables } = {}) {
    const have = new Set(tables || ['sms_templates', 'email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log']);
    const inserted = {};
    let n = 0;
    const knex = (table) => {
      const q = { filter: {} };
      q.where = (f) => { q.filter = f; return q; };
      q.first = async () => (rows[table] || []).find((r) => Object.entries(q.filter).every(([k, v]) => r[k] === v));
      q.update = async () => 1;
      q.insert = (row) => {
        (inserted[table] = inserted[table] || []).push(row);
        n += 1;
        const stored = { id: `${table}-${n}`, version_number: 1, ...row };
        (rows[table] = rows[table] || []).push(stored);
        return { returning: async () => [stored] };
      };
      return q;
    };
    knex.schema = { hasTable: async (t) => have.has(t), hasColumn: async () => true, alterTable: async () => { throw new Error('no column change in this migration'); } };
    knex.raw = async () => { throw new Error('no raw SQL in this migration'); };
    knex.transaction = async (cb) => cb(knex);
    return { knex, inserted };
  }
  beforeEach(() => recordAuditEvent.mockClear());

  test('has a later stamp than the frozen B1 migration, and a different id', () => {
    const dir = path.join(__dirname, '..', 'models', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => /day_only/.test(f)).sort();
    expect(files).toEqual(['20261106120000_day_only_promise_templates.js', '20261106130000_day_only_move_templates.js']);
    expect(migration._test.MIGRATION_ID).toBe('20261106130000_day_only_move_templates');
    expect(b1._test.SMS_TEMPLATES.map((t) => t.key).filter((k) => byKey[k])).toEqual([]);
  });

  test('inserts the four active text rows beside their base rows and the email template with a version and a fixture; no column work', async () => {
    const { knex, inserted } = fakeKnex({
      rows: { sms_templates: [{ template_key: 'appointment_rescheduled', category: 'service', sort_order: 7 }, { template_key: 'rain_out_moved_v3', category: 'service', sort_order: 11 }] },
    });
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).toEqual(SMS_TEMPLATES.map((t) => t.key));
    expect(inserted.sms_templates[0]).toMatchObject({ category: 'service', is_active: true, sort_order: 8, body: byKey.appointment_rescheduled_day_v1.body });
    expect(inserted.sms_templates[1].sort_order).toBe(12);
    expect(inserted.email_templates.map((r) => r.template_key)).toEqual(['appointment.rescheduled_day']);
    expect(inserted.email_templates[0]).toMatchObject({ status: 'active', send_stream: 'transactional_required' });
    expect(inserted.email_template_versions).toHaveLength(1);
    expect(inserted.email_template_fixtures).toHaveLength(1);
    expect(recordAuditEvent).toHaveBeenCalledTimes(5);
  });

  test('idempotent: rows that exist (possibly edited or disabled) are left alone', async () => {
    const { knex, inserted } = fakeKnex({
      rows: { sms_templates: SMS_TEMPLATES.map((t) => ({ template_key: t.key, body: 'edited', is_active: false })), email_templates: EMAIL_TEMPLATES.map((t) => ({ template_key: t.key })) },
    });
    await migration.up(knex);
    expect(inserted).toEqual({});
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('missing tables are skipped; down is a no-op', async () => {
    const { knex, inserted } = fakeKnex({ tables: [] });
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(inserted).toEqual({});
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});

describe('rescheduledDayTextLine', () => {
  test('no link can be made (the builder fails): the day-only ask with how to reach someone, and no trailing blank lines', async () => {
    const linkModule = require('../services/reschedule-link');
    expect(await linkModule.rescheduledDayTextLine('svc-1', { customerId: 'cust-1' })).toBe('Need a different day or a set time? Reply here or call.');
  });

  test('a link: the ask, then the link', () => {
    const linkModule = require('../services/reschedule-link');
    expect(linkModule.dayOnlyLineFor('https://x.test/l/abc').trim()).toBe('Need a different day or a set time? https://x.test/l/abc');
  });
});

describe('the callers pass what the decision needs (source scans)', () => {
  const schedule = read('routes/admin-schedule.js');
  const dispatch = read('routes/admin-dispatch.js');
  const reschedulePublic = read('routes/reschedule-public.js');
  const act = read('services/sms-scheduling-act.js');
  const ib = read('services/intelligence-bar/schedule-tools.js');

  test('update-details: the previous date and the box ride to the sender; the intent is written inside the moving transaction', () => {
    expect(schedule).toContain('scheduleMoveForNotice = { date: nextDate, start: nextStart || null, previousDate: prevDate };');
    expect(schedule).toContain('await recordOfficeMoveIntent(trx, [req.params.id], req.body);');
    expect(schedule).toMatch(/sendRescheduleNoticeForVisit\(req\.params\.id, scheduleMoveForNotice\.date, scheduleMoveForNotice\.start, \{\s*previousDate: scheduleMoveForNotice\.previousDate, customerAskedTime: req\.body\.customerAskedTime,/);
  });

  test('bulk reschedule: the intent is written in the moving transaction; the sender gets the previous date and the box', () => {
    expect(schedule).toContain('await recordOfficeMoveIntent(trx, [id], payload);');
    expect(schedule).toMatch(/sendRescheduleNoticeForVisit\(id, bulkTargetDate, bulkNoticeStart, \{\s*previousDate: bulkPreviousDate, customerAskedTime: payload\?\.customerAskedTime,/);
  });

  test('dispatch board: the plan carries the box, every moved member records the intent, the sender gets the date it moved from', () => {
    expect(dispatch).toContain('customerAskedTime: body?.customerAskedTime === true }');
    expect(dispatch).toContain('await recordVisitMoveIntent({ result, plan, serviceId });');
    expect(dispatch).toContain('previousDate: result.originalDate, customerAskedTime: plan?.customerAskedTime');
    expect(dispatch).toContain('const ids = [serviceId, ...(visitMove?.moved || [])];');
  });

  test('Intelligence Bar: the batch mover records the intent per moved stop and passes the previous date', () => {
    expect(ib).toContain('await recordMovedStopIntent(s, plan);');
    expect(ib).toContain('previousDate: s.scheduled_date,');
    expect(ib).toContain('customerAskedTime: input.customer_asked_time === true,');
  });

  test('customer moves: the reschedule page and the text-offer mover pass set_time with the date they moved from, only with the gate on', () => {
    expect(reschedulePublic).toContain("...await moveNoticeArgs(svc, 'set_time'),");
    expect(reschedulePublic).toContain('? { timePromise, previousDate: apptDateStr(svc.scheduled_date) }');
    expect(act).toContain("{ timePromise: 'set_time', previousDate }");
    expect(act).toContain('previousDate: dateOnlyString(svc.scheduled_date)');
  });
});

describe('B2 day sends carry B1\'s day fields through every stored-for-later path', () => {
  const { dayMoveMeta, dayFellBack, withDayMeta } = require('../services/day-only-move-notice');
  const timePromise = require('../services/time-promise');
  const SLOT = Date.parse('2026-11-27T14:00:00Z');

  test('promiseMetaOf of a B2 day send is exactly B1\'s four fields; the move-only slot is not carried', () => {
    const meta = withDayMeta({ scheduled_service_id: 'ss1', rendered_slot_ms: SLOT }, { dayOnly: true }, SLOT);
    expect(Object.keys(timePromise.promiseMetaOf(meta)).sort()).toEqual([...timePromise.PROMISE_META_KEYS].sort());
    expect(timePromise.promiseMetaOf(meta)).toEqual({ promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-11-27' });
    expect(meta.move_notice_slot_ms).toBe(SLOT);
  });

  test('dayMoveMeta is built from B1\'s helpers (DAY_PROMISE_META + dayGuardMeta), not a second list', () => {
    const src = read('services/day-only-move-notice.js');
    expect(src).toContain('...DAY_PROMISE_META');
    expect(src).toMatch(/\.dayGuardMeta\(slotMs\)/);
    expect(src).toContain('PROMISE_META_KEYS');
    expect(dayMoveMeta(undefined)).toEqual({ window_unknown: true, promise_level: 'day' });
  });

  test('a fallback to the window copy removes exactly B1\'s fields and the move slot, keeping the rest', () => {
    const state = { dayOnly: true };
    const meta = withDayMeta({ scheduled_service_id: 'ss1', rendered_slot_ms: SLOT }, state, SLOT);
    dayFellBack(state, { move_notice_slot_ms: SLOT });
    expect(state.dayOnly).toBe(false);
    expect(meta).toEqual({ scheduled_service_id: 'ss1', rendered_slot_ms: SLOT, move_notice_slot_ms: SLOT });
  });

  test('B2 adds no second chokepoint, no second persisted-fields list and no stored-body replay of its own', () => {
    const b2Files = ['services/day-only-move-notice.js', 'routes/admin-schedule.js', 'routes/admin-dispatch.js', 'services/rain-out.js'];
    for (const f of b2Files) {
      const src = read(f);
      expect(src).not.toMatch(/\bpromiseMetaOf\(|\bisDayPromise\(|replay_purpose/);
      expect(src).not.toMatch(/revalidateDelayedDaySend|delayedSendIsStale/);
    }
  });
});
