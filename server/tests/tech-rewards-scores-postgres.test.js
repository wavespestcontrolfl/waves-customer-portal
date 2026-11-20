// Runs with the existing CI PostgreSQL pass; never a production connection.
// Tech Rewards Plan D5-2: score settings versions, the five score parts and the
// season score, against real Postgres with the real migration. The migrated
// tables the migration points at (technicians, scheduled_services) and the
// tables the reads join are minimal copies in a private schema, so CI's
// migrated tables stay untouched. Synthetic ids and round numbers only.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `tech_rewards_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 4 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');

const WINDOW = { from: '2026-03-01', to: '2026-08-31' };
const WEIGHTS = { onTime: 30, audit: 20, callbacks: 20, truck: 10, ownerRating: 20 };
const CUTS = { top: 95, mid: 85, low: 75 };

describe('tech rewards scores input checks', () => {
  const scores = require('../services/tech-rewards-scores');

  test('bad technician, window and settings input fail before any read', async () => {
    const code = async (fn) => { try { await fn(); } catch (err) { return err.code; } return null; };
    expect(await code(() => scores.readAudit('nope', WINDOW))).toBe('INVALID_TECHNICIAN');
    expect(await code(() => scores.readTruck(randomUUID(), { from: '2026-09-01', to: '2026-08-31' }))).toBe('INVALID_WINDOW');
    expect(await code(() => scores.readOwnerRating(randomUUID(), { from: '2026-13-01', to: '2026-08-31' }))).toBe('INVALID_WINDOW');
    expect(await code(() => scores.getSettings('soon'))).toBe('INVALID_AS_OF');
    expect(await code(() => scores.saveSettings({ weights: { ...WEIGHTS, onTime: 31 }, cutLines: CUTS, effectiveFrom: '2026-01-01' }))).toBe('INVALID_SETTINGS');
    expect(await code(() => scores.saveSettings({ weights: WEIGHTS, cutLines: { top: 80, mid: 85, low: 75 }, effectiveFrom: '2026-01-01' }))).toBe('INVALID_SETTINGS');
    expect(await code(() => scores.saveSettings({ weights: WEIGHTS, cutLines: { ...CUTS, extra: 1 }, effectiveFrom: '2026-01-01' }))).toBe('INVALID_SETTINGS');
    expect(await code(() => scores.saveSettings({ weights: WEIGHTS, cutLines: CUTS, effectiveFrom: 'x' }))).toBe('INVALID_EFFECTIVE_FROM');
    expect(await code(() => scores.saveSettings({ weights: WEIGHTS, cutLines: CUTS, effectiveFrom: '2026-01-01' }, 'not-a-uuid'))).toBe('INVALID_ACTOR');
    expect(await code(() => scores.seasonScore(randomUUID(), 1800))).toBe('INVALID_YEAR');
  });
});

(SKIP ? describe.skip : describe)('tech rewards scores (live Postgres)', () => {
  let db;
  let scores;
  let calc;
  let tech;
  let other;

  const ts = (iso) => new Date(iso);

  async function visit(technicianId, fields = {}) {
    const [row] = await db('service_records').insert({
      technician_id: technicianId, customer_id: fields.customer_id || randomUUID(), status: 'completed',
      service_type: 'Quarterly Pest Control', service_date: '2026-04-10', report_template_version: 'service_report_v1', report_view_token: 'fixture-token',
      created_at: ts('2026-04-10T15:00:00Z'), ...fields,
    }).returning('*');
    return row;
  }

  async function scheduled(technicianId) {
    const [row] = await db('scheduled_services').insert({ technician_id: technicianId }).returning('*');
    return row;
  }

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    await db.schema.withSchema(mockSchema).createTable('technicians', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('name').notNullable();
    });
    await db.schema.withSchema(mockSchema).createTable('scheduled_services', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.uuid('service_id');
      t.text('service_type');
      t.timestamp('completed_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('customers', (t) => {
      t.uuid('id').primary();
      t.text('first_name');
      t.text('last_name');
    });
    await db.schema.withSchema(mockSchema).createTable('projects', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('scheduled_service_id');
      t.uuid('service_record_id');
    });
    await db.schema.withSchema(mockSchema).createTable('services', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.text('name');
      t.boolean('requires_service_report');
      t.boolean('requires_customer_notice');
      t.boolean('requires_application_log');
      t.text('closeout_requirements_source');
    });
    await db.schema.withSchema(mockSchema).createTable('service_completion_attempts', (t) => {
      t.uuid('service_id');
      t.string('status', 20);
      t.uuid('service_record_id');
      t.timestamp('updated_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await db.schema.withSchema(mockSchema).createTable('messaging_audit_log', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.text('audience');
      t.text('purpose');
      t.text('channel');
      t.jsonb('metadata');
      t.timestamp('sent_at', { useTz: true });
      t.text('blocked_code');
      t.text('provider_message_id');
      t.text('provider');
    });
    await db.schema.withSchema(mockSchema).createTable('service_records', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.uuid('scheduled_service_id');
      t.text('report_view_token');
      t.text('completion_source');
      t.timestamp('recap_sms_sent_at', { useTz: true });
      t.uuid('customer_id');
      t.text('status');
      t.text('service_type');
      t.date('service_date').notNullable();
      t.boolean('is_callback');
      t.string('report_template_version');
      t.jsonb('structured_notes');
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await db.schema.withSchema(mockSchema).createTable('service_report_deliveries', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable();
      t.string('status', 20);
      t.timestamp('sent_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('email_messages', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('status');
      t.string('idempotency_key');
      t.timestamp('sent_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('service_recaps', (t) => {
      t.bigIncrements('id');
      t.uuid('scheduled_service_id').notNullable().unique();
      t.string('status', 20);
      t.timestamp('sent_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('service_visits', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('status', 20).notNullable().defaultTo('closed');
      t.timestamp('summary_token_issued_at', { useTz: true });
      t.timestamp('summary_token_revoked_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('visit_effects', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('visit_id').notNullable();
      t.string('effect_type', 40).notNullable();
      t.string('status', 20).notNullable().defaultTo('pending');
      t.timestamp('sent_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('visit_completion_packets', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('visit_id').notNullable();
      t.string('status', 20).notNullable().defaultTo('done');
    });
    await db.schema.withSchema(mockSchema).createTable('visit_completion_packet_items', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('packet_id').notNullable();
      t.uuid('service_record_id');
      t.string('status', 20).notNullable().defaultTo('done');
    });
    await db.schema.withSchema(mockSchema).createTable('equipment_checks', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.timestamp('checked_at', { useTz: true }).notNullable();
      t.integer('missing_count').notNullable().defaultTo(0);
      t.integer('damaged_count').notNullable().defaultTo(0);
    });
    await require('../models/migrations/20261120150000_tech_rewards_scores').up(db);
    scores = require('../services/tech-rewards-scores');
    calc = require('../services/tech-rewards-calc');
    [{ id: tech }, { id: other }] = await db('technicians').insert([{ name: 'Fixture One' }, { name: 'Fixture Two' }]).returning('id');
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  // Never row-deleted by the app (a trigger refuses): the settings table is rebuilt between tests.
  beforeEach(async () => {
    await db.raw('TRUNCATE tech_reward_settings');
    await db('tech_protocol_audits').del();
    await db('tech_owner_ratings').del();
    await db('equipment_checks').del();
    await db('customers').del();
    await db('messaging_audit_log').del();
    await db('service_completion_attempts').del();
    await db('projects').del();
    await db('services').del();
    await db('service_recaps').del();
    await db('visit_completion_packet_items').del();
    await db('visit_completion_packets').del();
    await db('visit_effects').del();
    await db('service_visits').del();
    await db('service_report_deliveries').del();
    await db('email_messages').del();
    await db('service_records').del();
    await db('scheduled_services').del();
  });

  describe('migration', () => {
    test('up is repeatable, constraints hold, down drops all three tables', async () => {
      await require('../models/migrations/20261120150000_tech_rewards_scores').up(db);
      const svc = await scheduled(tech);
      const base = { technician_id: tech, scheduled_service_id: svc.id, audit_month: '2026-04-01', result: 'match' };
      await expect(db('tech_protocol_audits').insert({ ...base, result: 'maybe' })).rejects.toThrow(/result_check/);
      await expect(db('tech_protocol_audits').insert({ ...base, audit_month: '2026-04-15' })).rejects.toThrow(/month_check/);
      await db('tech_protocol_audits').insert(base);
      await expect(db('tech_protocol_audits').insert({ ...base, audit_month: '2026-05-01' })).rejects.toThrow(/duplicate key/);
      await expect(db('tech_protocol_audits').insert({ ...base, scheduled_service_id: randomUUID() })).rejects.toThrow(/foreign key/);
      await db('scheduled_services').where({ id: svc.id }).del(); // a deleted visit keeps its audit result
      expect(await db('tech_protocol_audits').where({ technician_id: tech }).first()).toMatchObject({ scheduled_service_id: null, result: 'match' });
      const svc2 = await scheduled(tech);
      await db('tech_protocol_audits').insert({ ...base, scheduled_service_id: svc2.id, audit_month: '2026-06-01' });
      await db('scheduled_services').where({ id: svc2.id }).del(); // two orphaned audits do not collide on the unique column
      expect((await db('tech_protocol_audits').whereNull('scheduled_service_id')).length).toBe(2);
      const rate = { technician_id: tech, period_month: '2026-04-01', rating: 80 };
      await expect(db('tech_owner_ratings').insert({ ...rate, rating: 101 })).rejects.toThrow(/rating_check/);
      await expect(db('tech_owner_ratings').insert({ ...rate, rating: -1 })).rejects.toThrow(/rating_check/);
      await expect(db('tech_owner_ratings').insert({ ...rate, period_month: '2026-04-02' })).rejects.toThrow(/month_check/);
      await db('tech_owner_ratings').insert(rate);
      await expect(db('tech_owner_ratings').insert({ ...rate, rating: 90 })).rejects.toThrow(/duplicate key/);
      const down = require('../models/migrations/20261120150000_tech_rewards_scores').down;
      await down(db);
      for (const table of ['tech_reward_settings', 'tech_protocol_audits', 'tech_owner_ratings']) {
        expect(await db.schema.hasTable(table)).toBe(false);
      }
      await down(db); // repeatable
      await require('../models/migrations/20261120150000_tech_rewards_scores').up(db);
      expect(await db.schema.hasTable('tech_reward_settings')).toBe(true);
    });
  });

  describe('settings', () => {
    test('no row at all falls back to the calculator defaults', async () => {
      const s = await scores.getSettings('2026-08-31');
      expect(s).toMatchObject({ version: 0, source: 'default', weights: calc.DEFAULT_WEIGHTS, cutLines: calc.DEFAULT_CUT_LINES });
    });

    test('versions count up, the highest one effective on the date wins, rows are never changed', async () => {
      const v1 = await scores.saveSettings({ weights: WEIGHTS, cutLines: CUTS, effectiveFrom: '2026-01-01' }, tech);
      expect(v1).toMatchObject({ version: 1, effectiveFrom: '2026-01-01', weights: WEIGHTS, cutLines: CUTS, source: 'stored' });
      const v2 = await scores.saveSettings({ weights: calc.DEFAULT_WEIGHTS, cutLines: calc.DEFAULT_CUT_LINES, effectiveFrom: '2026-06-01' });
      expect(v2.version).toBe(2);
      expect((await scores.getSettings('2026-05-31')).version).toBe(1);
      expect((await scores.getSettings('2026-06-01')).version).toBe(2);
      expect((await scores.getSettings(new Date('2026-12-01T12:00:00Z'))).version).toBe(2);
      expect((await db('tech_reward_settings').where({ version: 1 }).first()).created_by).toBe(tech);
      await expect(scores.saveSettings({ weights: WEIGHTS, cutLines: CUTS, effectiveFrom: '2026-05-01' })).rejects.toMatchObject({ code: 'INVALID_EFFECTIVE_FROM' });
      await expect(db('tech_reward_settings').where({ version: 1 }).update({ weights: '{}' })).rejects.toThrow(/never changed or deleted/);
      await expect(db('tech_reward_settings').where({ version: 1 }).del()).rejects.toThrow(/never changed or deleted/);
      await expect(db('tech_reward_settings').where({ version: 1 }).update({ created_by: null })).rejects.toThrow(/never changed or deleted/);
      // the author is a plain uuid: removing the login changes nothing on the frozen row
      await db('technicians').where({ id: tech }).del().catch(() => {});
      expect((await db('tech_reward_settings').where({ version: 1 }).first()).created_by).toBe(tech);
      await db('technicians').insert({ id: tech, name: 'Fixture One' }).onConflict('id').ignore();
    });

    test('two saves at once get two different versions', async () => {
      const saves = await Promise.all([1, 2, 3].map(() => scores.saveSettings({ weights: WEIGHTS, cutLines: CUTS, effectiveFrom: '2026-01-01' })));
      expect(saves.map((s) => s.version).sort()).toEqual([1, 2, 3]);
    });

    test('rows that all start later throw; a malformed stored row throws, never the defaults', async () => {
      await scores.saveSettings({ weights: WEIGHTS, cutLines: CUTS, effectiveFrom: '2026-09-01' });
      await expect(scores.getSettings('2026-08-31')).rejects.toMatchObject({ code: 'NO_SETTINGS_IN_FORCE' });
      await db('tech_reward_settings').insert({ version: 2, weights: { onTime: 50 }, cut_lines: CUTS, effective_from: '2026-09-02' });
      await expect(scores.getSettings('2026-09-02')).rejects.toMatchObject({ code: 'MALFORMED_SETTINGS' });
      await db('tech_reward_settings').insert({ version: 3, weights: WEIGHTS, cut_lines: { top: 50, mid: 60, low: 70 }, effective_from: '2026-09-03' });
      await expect(scores.getSettings('2026-09-03')).rejects.toMatchObject({ code: 'MALFORMED_SETTINGS' });
      expect((await scores.getSettings('2026-09-01')).version).toBe(1);
    });
  });

  describe('score parts', () => {
    test('onTime: share of completed report visits whose report went out within 24 hours', async () => {
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull();
      const a = await visit(tech); // report row sent in 2 h: on time
      await db('service_report_deliveries').insert({ service_record_id: a.id, status: 'sent', sent_at: ts('2026-04-10T17:00:00Z') });
      const b = await visit(tech); // report email 30 h later, production key with role: late
      const u = await visit(tech); // on-time email whose status later became unsubscribed: credit stays
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${u.id}:primary`, status: 'unsubscribed', sent_at: ts('2026-04-10T16:00:00Z') });
      const sp = await visit(tech); // same for a spam report
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${sp.id}:primary`, status: 'spam_report', sent_at: ts('2026-04-10T16:00:00Z') });
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${b.id}:primary`, status: 'delivered', sent_at: ts('2026-04-11T21:00:00Z') });
      const d = await visit(tech); // the ONLY send is an on-time email with role and suffix: on time
      await db('email_messages').insert([
        { idempotency_key: `service_report_ready:${d.id}:payer:2`, status: 'sent', sent_at: ts('2026-04-10T18:00:00Z') },
        { idempotency_key: `service_report_ready:${randomUUID()}:payer`, status: 'sent', sent_at: ts('2026-04-10T15:30:00Z') },
        { idempotency_key: `other_email:${d.id}:payer`, status: 'sent', sent_at: ts('2026-04-10T15:30:00Z') },
      ]);
      const c = await visit(tech, { structured_notes: { completionSmsStatus: 'sent', sentSmsAt: '2026-04-10T15:05:00.000Z' } }); // text: on time
      await visit(tech); // nothing went out: not on time
      // not counted: a held text replayed in the morning still counts from its delivery, other tech, other window,
      // another report version, a quiet backdated closeout, a failed send, a callback with no problem (still a visit)
      const held = await visit(tech, { structured_notes: { completionSmsStatus: 'sent', completionSmsDeferredDeliveredAt: '2026-04-11T12:00:00.000Z', sentSmsAt: '2026-04-10T01:00:00.000Z' } });
      expect(held.id).toBeTruthy();
      await visit(other);
      await visit(tech, { service_date: '2026-02-28' });
      await visit(tech, { report_template_version: null });
      await visit(tech, { structured_notes: { backfill: true } });
      const failed = await visit(tech);
      await db('service_report_deliveries').insert({ service_record_id: failed.id, status: 'failed', sent_at: null });
      expect(c.id).toBeTruthy();
      // on time: a, c, d, u, sp, held (21 h after creation) = 6 of 9 counted (a, b, c, d, u, sp, nothing, held, failed);
      // without the email join, or if a later status dropped the credit, this reads lower
      expect(await scores.readOnTime(tech, WINDOW)).toBe(66.67);
    });

    test('onTime: a confirmed video recap text is a send; an unconfirmed one (no sent_at) is not', async () => {
      const onTimeVisit = await scheduled(tech);
      const lateVisit = await scheduled(tech);
      const unsentVisit = await scheduled(tech);
      await visit(tech, { scheduled_service_id: onTimeVisit.id });
      await visit(tech, { scheduled_service_id: lateVisit.id });
      await visit(tech, { scheduled_service_id: unsentVisit.id });
      await db('service_recaps').insert([
        { scheduled_service_id: onTimeVisit.id, status: 'approved', sent_at: ts('2026-04-10T17:00:00Z') },
        { scheduled_service_id: lateVisit.id, status: 'approved', sent_at: ts('2026-04-11T21:00:00Z') },
        { scheduled_service_id: unsentVisit.id, status: 'approved', sent_at: null },
      ]);
      expect(await scores.readOnTime(tech, WINDOW)).toBe(33.33); // 1 of 3: the recap is the only send of the first
    });

    test('onTime: a combined visit summary counts for each member; no-report records leave the share', async () => {
      // one stop, one summary text sent 2 h after the records, for members m1 and m2
      const [{ id: visitId }] = await db('service_visits').insert({ summary_token_issued_at: ts('2026-04-10T15:00:00Z') }).returning('id');
      const [{ id: packetId }] = await db('visit_completion_packets').insert({ visit_id: visitId }).returning('id');
      await db('visit_effects').insert([
        { visit_id: visitId, effect_type: 'completion_sms', status: 'sent', sent_at: ts('2026-04-10T17:00:00Z') },
        { visit_id: visitId, effect_type: 'completion_email', status: 'suppressed', sent_at: null },
      ]);
      const link = (record) => db('visit_completion_packet_items').insert({ packet_id: packetId, service_record_id: record.id });
      await link(await visit(tech));
      await link(await visit(tech));
      // a second stop whose summary went out 30 h late: late
      for (const [revoked, sentAt] of [[null, '2026-04-11T21:00:00Z']]) {
        const [{ id: v2 }] = await db('service_visits').insert({ summary_token_issued_at: ts('2026-04-10T15:00:00Z'), summary_token_revoked_at: revoked }).returning('id');
        const [{ id: p2 }] = await db('visit_completion_packets').insert({ visit_id: v2 }).returning('id');
        await db('visit_effects').insert({ visit_id: v2, effect_type: 'completion_sms', status: 'sent', sent_at: ts(sentAt) });
        await db('visit_completion_packet_items').insert({ packet_id: p2, service_record_id: (await visit(tech)).id });
      }
      // no customer report expected: never counted, with or without a send
      await visit(tech, { structured_notes: { internalOnlyCompletion: true, typedReportDelivery: 'disabled' } });
      await visit(tech, { structured_notes: { typedReportDelivery: 'disabled' } }); // legacy shape, no frozen flag
      // a frozen delivery mode that suppresses the customer's copy is out even when the internal-only flag is false
      await visit(tech, { structured_notes: { internalOnlyCompletion: false, typedReportDelivery: 'disabled' } });
      await visit(tech, { structured_notes: { internalOnlyCompletion: false, typedReportDelivery: 'internal_only' } });
      // an auto_send report with no send at all is owed and late
      await visit(tech, { structured_notes: { typedReportDelivery: 'auto_send' } });
      // owed: 2 on time via the summary, 1 late summary, 1 owed with no send = 2 of 4
      expect(await scores.readOnTime(tech, WINDOW)).toBe(50);
      // the link revoked the day after an on-time delivery keeps the credit
      await db('service_visits').where({ id: visitId }).update({ summary_token_revoked_at: ts('2026-04-11T15:00:00Z') });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(50);
    });

    test('onTime: a malformed stored text timestamp never fails the read; it is missing data unless another send exists', async () => {
      const bad = (value) => ({ completionSmsStatus: 'sent', sentSmsAt: value });
      const ok = await visit(tech, { structured_notes: { completionSmsStatus: 'sent', sentSmsAt: '2026-04-10T15:05:00.000Z' } });
      expect(ok.id).toBeTruthy();
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
      for (const value of ['2026-02-30T12:00:00Z', '2026-04-10T25:00:00Z', '2026-04-10T15:05:00', 'yesterday']) {
        const record = await visit(tech, { structured_notes: bad(value) });
        expect(await scores.readOnTime(tech, WINDOW)).toBeNull(); // only evidence is unreadable: missing data
        // a valid email delivery for the same record settles it
        await db('email_messages').insert({ idempotency_key: `service_report_ready:${record.id}:primary`, status: 'sent', sent_at: ts('2026-04-10T16:00:00Z') });
        expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
        await db('service_records').where({ id: record.id }).del();
        await db('email_messages').del();
      }
    });

    test('onTime: an unreadable text timestamp beside a late email is unknown; beside an on-time email it is credited', async () => {
      const record = await visit(tech, { structured_notes: { completionSmsStatus: 'sent', sentSmsAt: '2026-02-30T12:00:00Z' } });
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${record.id}:primary`, status: 'sent', sent_at: ts('2026-04-12T16:00:00Z') }); // 49 h: late
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull();
      await db('email_messages').del();
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${record.id}:primary`, status: 'sent', sent_at: ts('2026-04-10T16:00:00Z') });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
    });

    test('onTime: a confirmed completion text with no stored time is unknown unless another send is on time', async () => {
      const record = await visit(tech, { structured_notes: { completionSmsStatus: 'sent' } });
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull();
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${record.id}:primary`, status: 'sent', sent_at: ts('2026-04-12T16:00:00Z') }); // late email
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull();
      await db('email_messages').del();
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${record.id}:primary`, status: 'sent', sent_at: ts('2026-04-10T16:00:00Z') });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
    });

    test('onTime: a provider-confirmed pest recap text on a sibling record credits the visit; consent-blocked and waived visits are left out', async () => {
      // two records for one visit: the recap text is keyed to the sibling, the other record has no send of its own
      const svc = await scheduled(tech);
      const first = await visit(tech, { scheduled_service_id: svc.id });
      const sibling = await visit(tech, { scheduled_service_id: svc.id, structured_notes: { completionSmsStatus: 'skipped_recap_sms_already_sent' } });
      await db('messaging_audit_log').insert([
        { audience: 'customer', purpose: 'service_completion', channel: 'sms', metadata: { original_message_type: 'pest_recap', service_record_id: sibling.id },
          sent_at: ts('2026-04-10T16:00:00Z'), provider_message_id: `SM${'a'.repeat(32)}` },
        // a gate-blocked synthetic send is no delivery
        { audience: 'customer', purpose: 'service_completion', channel: 'sms', metadata: { original_message_type: 'pest_recap', service_record_id: first.id },
          sent_at: ts('2026-04-10T15:10:00Z'), provider_message_id: 'synthetic-blocked' },
      ]);
      expect(first.id).toBeTruthy();
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100); // both records of the visit share the recap evidence
      const snap = (report, notice) => ({ v: 1, source: 'catalog', requiresServiceReport: report, requiresApplicationLog: false, requiresCustomerSignature: false,
        requiresCustomerNotice: notice, requiresLicense: false, requiredPhotoCount: 0 });
      // a consent-blocked text waives the NOTICE only: with the report waived too nothing is owed ...
      await visit(tech, { structured_notes: { completionSmsStatus: 'blocked', closeoutRequirements: snap(false, true) } });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
      // ... but a required report whose email never went out is still owed, and late
      const blockedOwed = await visit(tech, { structured_notes: { completionSmsStatus: 'blocked', closeoutRequirements: snap(true, true) } });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(66.67);
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${blockedOwed.id}:primary`, status: 'sent', sent_at: ts('2026-04-10T16:00:00Z') });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100); // the report email on time credits it
      await db('email_messages').del();
      await db('service_records').where({ id: blockedOwed.id }).del();
      // a frozen closeout snapshot that waives BOTH the report and the notice: not owed; waiving only one: owed
      const waivedSvc = await scheduled(tech);
      await visit(tech, { scheduled_service_id: waivedSvc.id, structured_notes: { closeoutRequirements: snap(false, false) } });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
      const owedSvc = await scheduled(tech);
      await visit(tech, { scheduled_service_id: owedSvc.id, structured_notes: { closeoutRequirements: snap(false, true) } });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(66.67); // 2 on time of 3 owed (the new one has no send)
      // a project-backed visit is judged on the project report path, not here
      const projectSvc = await scheduled(tech);
      const projectRecord = await visit(tech, { scheduled_service_id: projectSvc.id });
      await db('projects').insert({ scheduled_service_id: projectSvc.id, service_record_id: projectRecord.id });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(66.67);
    });

    test('onTime: an internal test customer visit owes no report; a suppressed summary pair is not a late report', async () => {
      const testCustomer = INTERNAL_TEST_CUSTOMER_IDS[0];
      await db('customers').insert({ id: testCustomer, first_name: 'Fixture', last_name: 'Demo' });
      await visit(tech, { customer_id: testCustomer }); // linked and unlinked records of a test customer are both out
      await visit(tech, { customer_id: testCustomer, scheduled_service_id: (await scheduled(tech)).id });
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull(); // nothing owed
      const real = await visit(tech);
      await db('email_messages').insert({ idempotency_key: `service_report_ready:${real.id}:primary`, status: 'sent', sent_at: ts('2026-04-10T16:00:00Z') });
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100);
      // a combined visit whose summary text AND email were both suppressed: closeout-status says not required
      const pairVisit = async (statuses) => {
        const [{ id: visitId }] = await db('service_visits').insert({ summary_token_issued_at: ts('2026-04-10T15:00:00Z') }).returning('id');
        const [{ id: packetId }] = await db('visit_completion_packets').insert({ visit_id: visitId }).returning('id');
        await db('visit_effects').insert(['completion_sms', 'completion_email'].map((effect_type, i) => ({ visit_id: visitId, effect_type, status: statuses[i], sent_at: null })));
        await db('visit_completion_packet_items').insert({ packet_id: packetId, service_record_id: (await visit(tech)).id });
      };
      await pairVisit(['suppressed', 'suppressed']);
      expect(await scores.readOnTime(tech, WINDOW)).toBe(100); // exempt
      await pairVisit(['suppressed', 'failed']); // only one suppressed: still owed, no send, late
      expect(await scores.readOnTime(tech, WINDOW)).toBe(50);
    });

    test('onTime: an unlinked record (its visit was deleted) honors its own frozen waiver', async () => {
      const snap = (report, notice) => ({ v: 1, source: 'catalog', requiresServiceReport: report, requiresApplicationLog: false, requiresCustomerSignature: false,
        requiresCustomerNotice: notice, requiresLicense: false, requiredPhotoCount: 0 });
      const svc = await scheduled(tech);
      await visit(tech, { scheduled_service_id: svc.id, structured_notes: { closeoutRequirements: snap(false, false) } });
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull(); // linked: waived
      await db('service_records').update({ scheduled_service_id: null }); // the visit row was deleted
      expect(await scores.readOnTime(tech, WINDOW)).toBeNull(); // unlinked: still waived by its own snapshot
      await visit(tech, { structured_notes: { closeoutRequirements: snap(false, true) } }); // only one waived: owed, late
      expect(await scores.readOnTime(tech, WINDOW)).toBe(0);
    });

    test('audit: match share of audited visits in the window months', async () => {
      expect(await scores.readAudit(tech, WINDOW)).toBeNull();
      const add = async (month, result, technicianId = tech) => db('tech_protocol_audits').insert({
        technician_id: technicianId, scheduled_service_id: (await scheduled(technicianId)).id, audit_month: month, result,
      });
      await add('2026-03-01', 'match');
      await add('2026-04-01', 'match');
      await add('2026-05-01', 'mismatch');
      await add('2026-02-01', 'mismatch'); // outside
      await add('2026-04-01', 'mismatch', other); // other tech
      expect(await scores.readAudit(tech, WINDOW)).toBe(66.67);
      expect(await scores.readAudit(tech, { from: '2026-03-15', to: '2026-03-20' })).toBe(100); // audit month 2026-03-01 holds the 15th
    });

    test('callbacks: callbacks per 100 visits, 0 per 100 = 100, 10 per 100 or more = 0', async () => {
      expect(await scores.readCallbacks(tech, WINDOW)).toBeNull();
      const customers = Array.from({ length: 20 }, () => randomUUID());
      for (const customer_id of customers) await visit(tech, { customer_id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(100);
      // one callback on a visit of this tech = 5 per 100 visits (20 visits) = 50
      await visit(other, { customer_id: customers[0], service_date: '2026-04-20', is_callback: true });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(50);
      expect(await scores.readCallbacks(other, WINDOW)).toBeNull(); // the callback is no regular visit and credit went to tech
      await visit(other, { customer_id: customers[1], service_date: '2026-04-21', is_callback: true });
      await visit(other, { customer_id: customers[2], service_date: '2026-04-22', is_callback: true });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0); // 15 per 100, clamped
      expect(await scores.readCallbacks(tech, { from: '2026-05-01', to: '2026-05-31' })).toBeNull();
    });

    test('callbacks: 63 callbacks in 1,600 visits is exactly 60.625, rounded half up to 60.63; both id spellings agree', async () => {
      const customers = Array.from({ length: 1600 }, () => randomUUID());
      await db.batchInsert('service_records', customers.map((customer_id) => ({
        technician_id: tech, customer_id, status: 'completed', service_type: 'Quarterly Pest Control',
        service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z'),
      })), 500);
      await db.batchInsert('service_records', customers.slice(0, 63).map((customer_id) => ({
        technician_id: other, customer_id, status: 'completed', service_type: 'Quarterly Pest Control',
        service_date: '2026-04-20', is_callback: true, created_at: ts('2026-04-20T14:00:00Z'),
      })), 500);
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(60.63);
      expect(await scores.readCallbacks(tech.toUpperCase(), WINDOW)).toBe(60.63);
    });

    test('callbacks: a customer_declined visit performed no service and is not a visit; a legacy row without an outcome is', async () => {
      await visit(tech, { structured_notes: { visitOutcome: 'customer_declined' } });
      expect(await scores.readCallbacks(tech, WINDOW)).toBeNull(); // only declined visits: no data, not a perfect 100
      await visit(tech, { structured_notes: { visitOutcome: 'completed' } });
      await visit(tech); // legacy row: no outcome
      await visit(tech, { structured_notes: {} });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(100);
      const customer = randomUUID();
      await visit(tech, { customer_id: customer, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') });
      await visit(other, { customer_id: customer, service_date: '2026-04-20', is_callback: true });
      // 1 callback over 4 counted visits (the declined one is out) = 25 per 100: clamped to 0 at 10 per 100
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0);
    });

    test('callbacks: sibling records of one visit count once, in the visits and in the callbacks', async () => {
      const customers = Array.from({ length: 10 }, () => randomUUID());
      for (const customer_id of customers) {
        const svc = await scheduled(tech);
        await visit(tech, { customer_id, scheduled_service_id: svc.id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') });
        await visit(tech, { customer_id, scheduled_service_id: svc.id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:05:00Z') }); // sibling rail
      }
      // 10 visits (20 records), no callbacks
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(100);
      // one callback visit with two sibling callback records = ONE callback in 10 visits = 10 per 100 -> 0
      const cbSvc = await scheduled(other);
      for (const minute of ['14:00', '14:05']) {
        await visit(other, { customer_id: customers[0], scheduled_service_id: cbSvc.id, is_callback: true, service_date: '2026-04-20', created_at: ts(`2026-04-20T${minute}:00Z`) });
      }
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0);
      // 20 visits make one callback 5 per 100 = 50: counting records instead would read 10 visits (0) or 40 (75)
      for (const customer_id of customers) {
        const svc = await scheduled(tech);
        await visit(tech, { customer_id, scheduled_service_id: svc.id, service_date: '2026-05-01', created_at: ts('2026-05-01T14:00:00Z') });
      }
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(50);
    });

    test('callbacks: a declined visit by another technician is never the source a callback corrects', async () => {
      const customer_id = randomUUID();
      await visit(tech, { customer_id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') }); // performed the service
      await visit(other, { customer_id, service_date: '2026-04-10', created_at: ts('2026-04-10T14:00:00Z'), structured_notes: { visitOutcome: 'customer_declined' } });
      await visit(tech, { customer_id: randomUUID(), service_date: '2026-04-02', created_at: ts('2026-04-02T14:00:00Z') });
      await visit(other, { customer_id, service_date: '2026-04-20', is_callback: true }); // callback after both visits
      // the callback corrects tech's performed visit (not other's declined one): 1 callback in 2 visits
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0);
      expect(await scores.readCallbacks(other, WINDOW)).toBeNull(); // only a declined visit: no data
    });

    test('callbacks: an incomplete visit is no source and an incomplete re-service is no callback', async () => {
      const customer_id = randomUUID();
      await visit(tech, { customer_id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') }); // performed the service
      await visit(other, { customer_id, service_date: '2026-04-10', created_at: ts('2026-04-10T14:00:00Z'), status: 'incomplete' });
      await visit(tech, { customer_id: randomUUID(), service_date: '2026-04-02', created_at: ts('2026-04-02T14:00:00Z') });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(100);
      // a re-service closed as incomplete is not a completed callback
      await visit(other, { customer_id, service_date: '2026-04-15', is_callback: true, status: 'incomplete' });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(100);
      // a completed re-service after the incomplete visit is charged to the technician who performed the service
      await visit(other, { customer_id, service_date: '2026-04-20', is_callback: true });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0); // 1 callback in 2 visits, clamped
      expect(await scores.readCallbacks(other, WINDOW)).toBeNull();
    });

    test('callbacks: inspection-only visits and re-services are not performed, by the shared outcome list', async () => {
      const customer_id = randomUUID();
      await visit(tech, { customer_id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') });
      await visit(other, { customer_id, service_date: '2026-04-10', created_at: ts('2026-04-10T14:00:00Z'), structured_notes: { visitOutcome: 'inspection_only' } });
      await visit(tech, { customer_id: randomUUID(), service_date: '2026-04-02', created_at: ts('2026-04-02T14:00:00Z') });
      await visit(tech, { customer_id: randomUUID(), service_date: '2026-04-03', structured_notes: { visitOutcome: 'inspection_only' } }); // not a visit
      // an inspection-only re-service is no callback
      await visit(other, { customer_id, service_date: '2026-04-15', is_callback: true, structured_notes: { visitOutcome: 'inspection_only' } });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(100);
      // a performed re-service is charged to the technician who treated, not the one who only inspected
      await visit(other, { customer_id, service_date: '2026-04-20', is_callback: true });
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0); // 1 callback in 2 performed visits
      expect(await scores.readCallbacks(other, WINDOW)).toBeNull(); // inspection-only: no visits
    });

    test('callbacks: a visit with any callback sibling is a callback visit, never a source or a regular visit', async () => {
      const customer_id = randomUUID();
      await visit(tech, { customer_id, service_date: '2026-04-01', created_at: ts('2026-04-01T14:00:00Z') }); // real source
      await visit(tech, { customer_id: randomUUID(), service_date: '2026-04-02', created_at: ts('2026-04-02T14:00:00Z') });
      // one scheduled service, two sibling records: a legacy row with NO callback flag, then a flagged callback
      const svc = await scheduled(other);
      await visit(other, { customer_id, scheduled_service_id: svc.id, service_date: '2026-04-10', created_at: ts('2026-04-10T14:00:00Z'), is_callback: null });
      await visit(other, { customer_id, scheduled_service_id: svc.id, service_date: '2026-04-10', created_at: ts('2026-04-10T14:05:00Z'), is_callback: true });
      // the unflagged sibling is not a source of its own visit (and not a regular visit of other): the callback
      // goes to tech's April 1 visit: 1 callback in 2 visits -> 0
      expect(await scores.readCallbacks(tech, WINDOW)).toBe(0);
      expect(await scores.readCallbacks(other, WINDOW)).toBeNull();
    });

    test('every read takes an uppercase technician id like the lowercase one', async () => {
      const upper = tech.toUpperCase();
      await db('tech_owner_ratings').insert({ technician_id: tech, period_month: '2026-04-01', rating: 70 });
      expect(await scores.readOwnerRating(upper, WINDOW)).toBe(70);
      expect(await scores.readAudit(upper, WINDOW)).toBeNull();
      expect(await scores.readTruck(upper, WINDOW)).toBeNull();
      expect((await scores.seasonScore(upper, 2026)).missing).toEqual(['onTime', 'audit', 'callbacks', 'truck']);
    });

    test('truck: share of checks with nothing missing or damaged, window in ET days', async () => {
      expect(await scores.readTruck(tech, WINDOW)).toBeNull();
      const check = (iso, missing = 0, damaged = 0, technicianId = tech) => db('equipment_checks').insert({
        technician_id: technicianId, checked_at: ts(iso), missing_count: missing, damaged_count: damaged,
      });
      await check('2026-04-01T14:00:00Z');
      await check('2026-04-08T14:00:00Z', 1);
      await check('2026-04-15T14:00:00Z', 0, 1);
      await check('2026-04-22T14:00:00Z');
      await check('2026-04-22T14:00:00Z', 5, 0, other);
      await check('2026-03-01T03:00:00Z', 2); // Feb 28 ET: outside
      await check('2026-09-01T03:00:00Z'); // Aug 31 ET 11 PM: inside, clean
      expect(await scores.readTruck(tech, WINDOW)).toBe(60);
    });

    test('ownerRating: average of the monthly ratings in the window', async () => {
      expect(await scores.readOwnerRating(tech, WINDOW)).toBeNull();
      await db('tech_owner_ratings').insert([
        { technician_id: tech, period_month: '2026-03-01', rating: 90 },
        { technician_id: tech, period_month: '2026-04-01', rating: 85 },
        { technician_id: tech, period_month: '2026-05-01', rating: 85 },
        { technician_id: tech, period_month: '2026-02-01', rating: 0 },
        { technician_id: other, period_month: '2026-03-01', rating: 10 },
      ]);
      expect(await scores.readOwnerRating(tech, WINDOW)).toBe(86.67);
    });
  });

  describe('seasonScore', () => {
    async function seedAllParts() {
      const a = await visit(tech);
      await db('service_report_deliveries').insert({ service_record_id: a.id, status: 'sent', sent_at: ts('2026-04-10T16:00:00Z') });
      await db('tech_protocol_audits').insert({ technician_id: tech, scheduled_service_id: (await scheduled(tech)).id, audit_month: '2026-04-01', result: 'match' });
      await db('equipment_checks').insert({ technician_id: tech, checked_at: ts('2026-04-08T14:00:00Z') });
      await db('tech_owner_ratings').insert({ technician_id: tech, period_month: '2026-04-01', rating: 80 });
    }

    test('a malformed text timestamp makes the season incomplete (onTime missing), not an error or a number', async () => {
      await seedAllParts();
      await visit(tech, { structured_notes: { completionSmsStatus: 'sent', sentSmsAt: '2026-02-30T12:00:00Z' } });
      const result = await scores.seasonScore(tech, 2026);
      expect(result).toMatchObject({ complete: false, missing: ['onTime'] });
      expect(result.score).toBeUndefined();
    });

    test('every part and the settings read in one read-only repeatable-read snapshot', async () => {
      await seedAllParts();
      const levels = [];
      db.client.on('query', (q) => { if (/transaction_isolation|isolation level|read only/i.test(q.sql)) levels.push(q.sql); });
      await scores.seasonScore(tech, 2026);
      db.client.removeAllListeners('query');
      expect(levels.join(' ').toLowerCase()).toMatch(/isolation level repeatable read/);
      expect(levels.join(' ').toLowerCase()).toMatch(/read only/);
      expect(scores.seasonScore.length).toBe(2); // no connection parameter: it always opens its own transaction
    });

    test('incomplete: a part with no data blocks the number and is named', async () => {
      await seedAllParts();
      await db('equipment_checks').del();
      await db('tech_owner_ratings').del();
      const result = await scores.seasonScore(tech, 2026);
      expect(result).toMatchObject({ complete: false, missing: ['truck', 'ownerRating'], year: 2026 });
      expect(result.score).toBeUndefined();
      expect(result.parts).toMatchObject({ onTime: 100, audit: 100, callbacks: 100, truck: null, ownerRating: null });
    });

    test('complete: weighted score and band use the settings in force on the window end', async () => {
      await seedAllParts();
      const defaults = await scores.seasonScore(tech, 2026);
      // four parts at 100 and the owner rating at 80: 80 + 80 x 0.20 = 96 under either weight set
      expect(defaults).toMatchObject({ complete: true, score: 96, rateBps: 400, settings: { version: 0 } });
      await scores.saveSettings({ weights: WEIGHTS, cutLines: { top: 99, mid: 85, low: 75 }, effectiveFrom: '2026-01-01' });
      // same score, stricter cut lines (top 99): the 2.5% band
      const v1 = await scores.seasonScore(tech, 2026);
      expect(v1).toMatchObject({ complete: true, score: 96, rateBps: 250, settings: { version: 1 } });
      await scores.saveSettings({ weights: calc.DEFAULT_WEIGHTS, cutLines: calc.DEFAULT_CUT_LINES, effectiveFrom: '2026-09-01' });
      expect((await scores.seasonScore(tech, 2026)).settings.version).toBe(1); // v2 starts after the window end
    });
  });
});
