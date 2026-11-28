// Runs with the existing CI PostgreSQL pass; never a production connection.
// Tech Rewards Plan D5-3: the owner's monthly protocol audit (tech-protocol-audit.js) against real
// Postgres with the real tech_protocol_audits migration. The tables the reads join are minimal copies
// in a private schema, so CI's migrated tables stay untouched. Synthetic names and ids only.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `tech_protocol_audit_${randomUUID().replaceAll('-', '')}`;
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
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(async (key) => `https://photos.test/${key}`) }));

// the first board read loads the report module that holds the protocol-version reader: slow once
jest.setTimeout(60000);

const MONTH = '2026-04';
const MONTH_START = '2026-04-01';

describe('pickSample (pure)', () => {
  const { pickSample, SAMPLE_SIZE } = require('../services/tech-protocol-audit');
  const rows = Array.from({ length: 12 }, (_, i) => ({ scheduled_service_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
  const tech = '11111111-1111-4111-8111-111111111111';

  test('five lowest ranks, the same in any input order; fewer than five shows what exists', () => {
    const first = pickSample(rows, { technicianId: tech, monthStart: MONTH_START });
    const again = pickSample([...rows].reverse(), { technicianId: tech, monthStart: MONTH_START });
    expect(first).toHaveLength(SAMPLE_SIZE);
    expect(again.map((r) => r.scheduled_service_id)).toEqual(first.map((r) => r.scheduled_service_id));
    expect(pickSample(rows.slice(0, 3), { technicianId: tech, monthStart: MONTH_START })).toHaveLength(3);
    // another month or another technician draws a different five
    const other = pickSample(rows, { technicianId: tech, monthStart: '2026-05-01' });
    expect(other.map((r) => r.scheduled_service_id)).not.toEqual(first.map((r) => r.scheduled_service_id));
  });

  test('a marked visit always stays in the sample, and the total stays five', () => {
    const first = pickSample(rows, { technicianId: tech, monthStart: MONTH_START });
    const outside = rows.filter((r) => !first.includes(r)).pop();
    const kept = pickSample(rows, { technicianId: tech, monthStart: MONTH_START, markedIds: new Set([outside.scheduled_service_id]) });
    expect(kept).toHaveLength(SAMPLE_SIZE);
    expect(kept).toContain(outside);
  });
});

(SKIP ? describe.skip : describe)('tech protocol audit (live Postgres)', () => {
  let db;
  let audit;
  let scores;
  let tech;
  let other;
  let customerId;
  const photos = require('../services/photos');

  // One completed visit (scheduled service + its completed record) for a technician.
  async function visit(technicianId, fields = {}) {
    const { status = 'completed', service_date = '2026-04-10', withVisit = true, ...rest } = fields;
    const svc = withVisit ? (await db('scheduled_services').insert({ technician_id: technicianId }).returning('*'))[0] : null;
    const [record] = await db('service_records').insert({
      technician_id: technicianId, customer_id: customerId, scheduled_service_id: svc?.id || null, status, service_date,
      service_type: 'Lawn Care Treatment', service_line: 'lawn', ...rest,
    }).returning('*');
    return { svc, record };
  }
  const lawnVisits = async (technicianId, n, fields = {}) => {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(await visit(technicianId, fields));
    return out;
  };
  // marks a visit under the technician and month its record shows now (what the board would have sent)
  const save = async (args) => {
    const [current] = /^[0-9a-f-]{36}$/.test(args.scheduledServiceId) ? await audit.eligibleVisits({ scheduledServiceId: args.scheduledServiceId }) : [];
    const fingerprint = current ? (await audit.evidenceFingerprints([current])).get(current.scheduled_service_id) : '0'.repeat(64);
    return audit.saveMark({ technicianId: current ? current.technician_id : tech, month: current ? current.month.slice(0, 7) : MONTH,
      recordId: current ? current.record_id : '00000000-0000-4000-8000-000000000000', evidenceFingerprint: fingerprint, ...args });
  };
  const board = async (month = MONTH) => (await audit.getBoard(month)).technicians;
  const ids = (t) => t.visits.map((v) => v.scheduledServiceId);

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
      t.text('lawn_protocol_version');
      t.text('lawn_protocol_window_key');
      t.text('lawn_protocol_window_title');
    });
    await db.schema.withSchema(mockSchema).createTable('lawn_protocol_service_completions', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable().unique();
      t.text('protocol_version');
      t.text('window_key');
      t.text('window_title');
    });
    await db.schema.withSchema(mockSchema).createTable('customers', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.text('first_name');
      t.text('last_name');
    });
    await db.schema.withSchema(mockSchema).createTable('service_records', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.uuid('customer_id');
      t.uuid('scheduled_service_id');
      t.text('status');
      t.text('service_type');
      t.text('service_line');
      t.text('protocol_name');
      t.integer('area_serviced_sqft');
      t.date('service_date').notNullable();
      t.boolean('is_callback');
      t.jsonb('structured_notes');
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await db.schema.withSchema(mockSchema).createTable('service_products', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable();
      t.text('product_name');
      t.decimal('application_rate', 8, 3);
      t.text('rate_unit');
      t.decimal('total_amount', 8, 3);
      t.text('amount_unit');
      t.text('application_area');
      t.decimal('area_value', 10, 2);
      t.text('area_unit');
      t.specificType('targets', 'text[]').notNullable().defaultTo('{}');
      t.timestamp('applied_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await db.schema.withSchema(mockSchema).createTable('service_photos', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable();
      t.text('photo_type').notNullable();
      t.text('s3_key');
      t.text('caption');
      t.integer('sort_order').defaultTo(0);
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await db.schema.withSchema(mockSchema).createTable('audit_log', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('actor_type', 32).notNullable();
      t.uuid('actor_id');
      t.string('action', 96).notNullable();
      t.string('resource_type', 48);
      t.uuid('resource_id');
      t.jsonb('metadata').defaultTo('{}');
      t.string('ip_address', 64);
      t.text('user_agent');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    });
    await require('../models/migrations/20261120150000_tech_rewards_scores').up(db);
    await require('../models/migrations/20261120190000_tech_protocol_audit_evidence').up(db);
    audit = require('../services/tech-protocol-audit');
    scores = require('../services/tech-rewards-scores');
    [{ id: tech }, { id: other }] = await db('technicians').insert([{ name: 'Fixture One' }, { name: 'Fixture Two' }]).returning('id');
    [{ id: customerId }] = await db('customers').insert({ first_name: 'Sample', last_name: 'Customer' }).returning('id');
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    await db('audit_log').del();
    await db('tech_protocol_audits').del();
    await db('service_products').del();
    await db('service_photos').del();
    await db('lawn_protocol_service_completions').del();
    await db('service_records').del();
    await db('scheduled_services').del();
  });

  test('only completed, performed, non-callback lawn and tree & shrub visits of the month are eligible', async () => {
    const good = [
      await visit(tech),
      await visit(tech, { service_line: 'tree_shrub', service_type: 'Tree & Shrub Treatment' }),
      await visit(tech, { service_line: null, service_type: 'Tree & Shrub Treatment' }), // legacy record: the report classifier decides
      await visit(tech, { structured_notes: { visitOutcome: 'completed' } }),
    ];
    await visit(tech, { service_line: 'pest', service_type: 'Quarterly Pest Control' });
    await visit(tech, { structured_notes: { visitOutcome: 'inspection_only' } });
    await visit(tech, { structured_notes: { visitOutcome: 'customer_declined' } });
    await visit(tech, { is_callback: true });
    await visit(tech, { status: 'incomplete' });
    await visit(tech, { service_date: '2026-05-02' });
    await visit(tech, { withVisit: false });
    const eligible = await audit.eligibleVisits({ monthStart: MONTH_START });
    expect(eligible.map((r) => r.scheduled_service_id).sort()).toEqual(good.map((g) => g.svc.id).sort());
    expect(eligible.every((r) => r.month === MONTH_START)).toBe(true);
  });

  test('a visit with a callback sibling record is no regular visit', async () => {
    const { svc } = await visit(tech);
    await db('service_records').insert({ technician_id: tech, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-04-11', service_type: 'Lawn Care Treatment', service_line: 'lawn', is_callback: true });
    expect(await audit.eligibleVisits({ monthStart: MONTH_START })).toHaveLength(0);
  });

  test('the board shows five visits per technician, the same five on every load, and fewer when fewer exist', async () => {
    await lawnVisits(tech, 9);
    await lawnVisits(other, 3);
    const first = await board();
    expect(first.map((t) => [t.name, t.eligibleCount, t.visits.length])).toEqual([['Fixture One', 9, 5], ['Fixture Two', 3, 3]]);
    const second = await board();
    expect(ids(second[0])).toEqual(ids(first[0]));
    expect(ids(second[1])).toEqual(ids(first[1]));
    expect(await board('2026-03')).toEqual([]);
  });

  test('a visit shows its products, rate, targets, counts, photos and customer', async () => {
    const { record } = await visit(tech, { protocol_name: 'Sample protocol', area_serviced_sqft: 5000 });
    await db('service_products').insert({ service_record_id: record.id, product_name: 'Sample Product', application_rate: 2.5, rate_unit: 'oz/1000 sq ft',
      area_value: 5000, area_unit: 'sq ft', targets: ['chinch bugs', 'dollarweed'] });
    await db('service_photos').insert([
      { service_record_id: record.id, photo_type: 'before', s3_key: 'k/before.jpg', caption: 'Front lawn' },
      { service_record_id: record.id, photo_type: 'after', s3_key: 'k/after.jpg' },
    ]);
    const [shown] = (await board())[0].visits;
    expect(shown).toMatchObject({
      serviceDate: '2026-04-10', serviceLine: 'lawn', protocolName: 'Sample protocol', areaSqft: 5000, customerName: 'Sample Customer', audit: null,
      counts: { products: 1, photos: 2, photosByType: { before: 1, after: 1 } },
    });
    expect(shown.products).toEqual([{ name: 'Sample Product', rate: 2.5, rateUnit: 'oz/1000 sq ft', totalAmount: null, amountUnit: null,
      area: '5000 sq ft', targets: ['chinch bugs', 'dollarweed'] }]);
    expect(shown.photos.map((p) => p.url).sort()).toEqual(['https://photos.test/k/after.jpg', 'https://photos.test/k/before.jpg']);
    photos.getViewUrl.mockRejectedValueOnce(new Error('no s3'));
    expect((await board())[0].visits[0].photos.filter((p) => p.url === null)).toHaveLength(1); // a presign failure drops one url, not the board
  });

  test('marking is one upsert per visit: marking again changes result, note and time; visits and records are untouched', async () => {
    await lawnVisits(tech, 6);
    const [shown] = await board();
    const target = shown.visits[0].scheduledServiceId;
    const before = { visits: await db('scheduled_services').orderBy('id'), records: await db('service_records').orderBy('id') };
    const first = await save({ scheduledServiceId: target, result: 'match', note: '  looks right ', auditedBy: other });
    expect(first).toMatchObject({ scheduledServiceId: target, result: 'match', note: 'looks right' });
    const row1 = await db('tech_protocol_audits').where({ scheduled_service_id: target });
    expect(row1).toHaveLength(1);
    expect(row1[0]).toMatchObject({ technician_id: tech, audit_month: expect.any(Date), audited_by: other });
    expect(row1[0].audit_month.getUTCDate() === 1 || row1[0].audit_month.getDate() === 1).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    await save({ scheduledServiceId: target, result: 'mismatch', note: 'rate off', auditedBy: tech });
    const row2 = await db('tech_protocol_audits').where({ scheduled_service_id: target });
    expect(row2).toHaveLength(1);
    expect(row2[0]).toMatchObject({ result: 'mismatch', note: 'rate off', audited_by: tech });
    expect(row2[0].audited_at.getTime()).toBeGreaterThan(row1[0].audited_at.getTime());
    expect((await board())[0]).toMatchObject({ markedCount: 1 });
    expect((await board())[0].visits.find((v) => v.scheduledServiceId === target).audit).toMatchObject({ result: 'mismatch', note: 'rate off' });
    expect({ visits: await db('scheduled_services').orderBy('id'), records: await db('service_records').orderBy('id') }).toEqual(before);
  });

  test('refusals: bad input, a mismatch without a note, an ineligible visit, a visit outside the sample', async () => {
    const all = await lawnVisits(tech, 9);
    const inSample = new Set(ids((await board())[0]));
    const outside = all.find((v) => !inSample.has(v.svc.id)).svc.id;
    const code = async (args) => { try { await save({ auditedBy: tech, ...args }); } catch (err) { return `${err.status} ${err.code}`; } return null; };
    const target = [...inSample][0];
    expect(await code({ scheduledServiceId: 'nope', result: 'match' })).toBe('400 INVALID_VISIT');
    expect(await code({ scheduledServiceId: target, result: 'maybe' })).toBe('400 INVALID_RESULT');
    expect(await code({ scheduledServiceId: target, result: 'mismatch', note: '   ' })).toBe('400 NOTE_REQUIRED');
    expect(await code({ scheduledServiceId: target, result: 'match', note: 'x'.repeat(1001) })).toBe('400 NOTE_TOO_LONG');
    expect(await code({ scheduledServiceId: randomUUID(), result: 'match' })).toBe('404 NOT_ELIGIBLE');
    const pest = await visit(tech, { service_line: 'pest', service_type: 'Quarterly Pest Control' });
    expect(await code({ scheduledServiceId: pest.svc.id, result: 'match' })).toBe('404 NOT_ELIGIBLE');
    expect(await code({ scheduledServiceId: outside, result: 'match' })).toBe('409 NOT_IN_SAMPLE');
    expect(await db('tech_protocol_audits')).toHaveLength(0);
    expect(() => audit.parseMonth('2026-13')).toThrow(/month must be/);
  });

  test("a visit's newest record decides its month and technician: an older record in another month never shows or saves", async () => {
    const { svc } = await visit(tech, { service_date: '2026-04-28', created_at: new Date('2026-04-28T15:00:00Z') });
    await db('service_records').insert({ technician_id: other, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-05-02', service_type: 'Lawn Care Treatment', service_line: 'lawn', created_at: new Date('2026-05-02T15:00:00Z') });
    expect(await board('2026-04')).toEqual([]); // the newest record moved it to May and to the other technician
    const may = await board('2026-05');
    expect(may.map((t) => [t.name, ids(t)])).toEqual([['Fixture Two', [svc.id]]]);
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech });
    expect(await db('tech_protocol_audits').first()).toMatchObject({ technician_id: other });
    expect((await db('tech_protocol_audits').first()).audit_month.getMonth() + 1).toBe(5);
  });

  test('a correction that moves a marked visit shows it unmarked, and marking again re-attributes the row', async () => {
    const { svc, record } = await visit(tech);
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech });
    expect((await board())[0].visits[0].audit).toMatchObject({ result: 'match' });
    await db('service_records').where({ id: record.id }).update({ technician_id: other }); // the visit was corrected to another technician
    const moved = (await board())[0];
    expect(moved.name).toBe('Fixture Two');
    expect(moved.visits[0]).toMatchObject({ audit: null, needsRecheck: true });
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBeNull(); // gone from the old technician's score at once
    await save({ scheduledServiceId: svc.id, result: 'mismatch', note: 'wrong rate', auditedBy: tech });
    const rows = await db('tech_protocol_audits');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ technician_id: other, result: 'mismatch' });
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBeNull(); // the first technician's score no longer counts it
  });

  test('a replacement record made after the mark asks for a re-mark: needs re-check, not counted, then counted again', async () => {
    const { svc } = await visit(tech);
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech });
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBe(100);
    await db('service_records').insert({ technician_id: tech, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-04-11', service_type: 'Lawn Care Treatment', service_line: 'lawn', created_at: new Date(Date.now() + 60000) });
    expect((await board())[0].visits[0]).toMatchObject({ audit: null, needsRecheck: true });
    expect((await board())[0].markedCount).toBe(0);
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBeNull();
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech }); // a re-mark names the new record
    expect((await board())[0].visits[0]).toMatchObject({ audit: { result: 'match' }, needsRecheck: false });
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBe(100);
  });

  test('a mark without the reviewed record id is refused', async () => {
    const { svc } = await visit(tech);
    await expect(save({ scheduledServiceId: svc.id, recordId: undefined, result: 'match', auditedBy: tech })).rejects.toMatchObject({ status: 400, code: 'INVALID_RECORD' });
    expect(await db('tech_protocol_audits')).toHaveLength(0);
  });

  test('a newest record with no technician makes the visit unauditable; an older assigned sibling does not win', async () => {
    const { svc } = await visit(tech);
    await db('service_records').insert({ technician_id: null, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-04-11', service_type: 'Lawn Care Treatment', service_line: 'lawn', created_at: new Date(Date.now() + 60000) });
    expect(await audit.eligibleVisits({ scheduledServiceId: svc.id })).toHaveLength(0);
    expect(await board()).toHaveLength(0);
  });

  test('a save that names a record the visit no longer has is refused as stale', async () => {
    const { svc, record } = await visit(tech);
    await db('service_records').insert({ technician_id: tech, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-04-11', service_type: 'Lawn Care Treatment', service_line: 'lawn', created_at: new Date(Date.now() + 60000) });
    await expect(save({ scheduledServiceId: svc.id, recordId: record.id, result: 'match', auditedBy: tech })).rejects.toMatchObject({ status: 409, code: 'STALE_VISIT' });
    expect(await db('tech_protocol_audits')).toHaveLength(0);
  });

  test('parallel marks never put more than five visits of one technician and month in the audit', async () => {
    const all = await lawnVisits(tech, 12);
    const inSample = new Set(ids((await board())[0]));
    const attempts = await Promise.allSettled(all.map((v) => save({ scheduledServiceId: v.svc.id, result: 'match', auditedBy: tech })));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(5);
    expect((await db('tech_protocol_audits')).map((r) => r.scheduled_service_id).sort()).toEqual([...inSample].sort());
  });

  test('the mark is filed under the technician and month the board showed: a visit that moved since is refused with 409', async () => {
    const { svc, record } = await visit(tech);
    const shown = (await board())[0].visits[0];
    expect(shown).toMatchObject({ technicianId: tech, month: MONTH, scheduledServiceId: svc.id });
    const send = (over = {}) => audit.saveMark({ scheduledServiceId: svc.id, technicianId: shown.technicianId, month: shown.month, recordId: shown.recordId, evidenceFingerprint: shown.evidenceFingerprint, result: 'match', auditedBy: tech, ...over });
    await expect(send({ technicianId: undefined })).rejects.toMatchObject({ status: 400, code: 'INVALID_CONTEXT' });
    await expect(send({ month: '2026-4' })).rejects.toMatchObject({ status: 400, code: 'INVALID_CONTEXT' });
    await db('service_records').where({ id: record.id }).update({ technician_id: other }); // reassigned after the board loaded
    await expect(send()).rejects.toMatchObject({ status: 409, code: 'STALE_VISIT' });
    await db('service_records').where({ id: record.id }).update({ technician_id: tech, service_date: '2026-05-03' }); // moved to May
    await expect(send()).rejects.toMatchObject({ status: 409, code: 'STALE_VISIT' });
    expect(await db('tech_protocol_audits')).toHaveLength(0);
    await db('service_records').where({ id: record.id }).update({ service_date: '2026-04-10' });
    expect(await send()).toMatchObject({ result: 'match' });
  });

  test('a visit that returns to a technician never makes a sixth counted mark, in the board or the score', async () => {
    await lawnVisits(tech, 9);
    const sampled = (await board())[0].visits;
    for (const v of sampled) await save({ scheduledServiceId: v.scheduledServiceId, result: 'match', auditedBy: tech });
    const window = { from: '2026-04-01', to: '2026-04-30' };
    expect(await scores.readAudit(tech, window)).toBe(100);
    const away = sampled[0];
    await db('service_records').where({ id: away.recordId }).update({ technician_id: other }); // one marked visit is reassigned
    expect((await board())[0].visits).toHaveLength(5); // the technician's sample refills to five
    const replacement = (await board())[0].visits.find((v) => !v.audit);
    expect(replacement).toBeTruthy();
    await save({ scheduledServiceId: replacement.scheduledServiceId, result: 'mismatch', note: 'x', auditedBy: tech });
    expect(await scores.readAudit(tech, window)).toBe(80); // 4 matches + 1 mismatch; the moved visit does not count
    await db('service_records').where({ id: away.recordId }).update({ technician_id: tech }); // and it comes back with its old mark current again
    const after = (await board())[0];
    expect(after.visits).toHaveLength(5);
    expect(after.markedCount).toBe(5);
    const counted = await audit.countedMarks(tech, { fromMonth: MONTH_START, toMonth: MONTH_START });
    expect(counted).toHaveLength(5); // six current marks, five counted
    const score = await scores.readAudit(tech, window);
    expect(score).toBe(counted.filter((m) => m.result === 'match').length * 20);
    expect(after.visits.filter((v) => v.audit).map((v) => v.audit.result).sort()).toEqual(counted.map((m) => m.result).sort());
  });

  test('a mark stores the record and the evidence the owner reviewed; a missing fingerprint is refused', async () => {
    const { svc, record } = await visit(tech);
    const shown = (await board())[0].visits[0];
    expect(shown.evidenceFingerprint).toMatch(/^v2:[0-9a-f]{64}$/);
    const base = { scheduledServiceId: svc.id, technicianId: tech, month: MONTH, recordId: record.id, result: 'match', auditedBy: tech };
    await expect(audit.saveMark({ ...base, evidenceFingerprint: undefined })).rejects.toMatchObject({ status: 400, code: 'INVALID_EVIDENCE' });
    await audit.saveMark({ ...base, evidenceFingerprint: shown.evidenceFingerprint });
    expect(await db('tech_protocol_audits').first()).toMatchObject({ reviewed_record_id: record.id, evidence_fingerprint: shown.evidenceFingerprint });
    expect((await board())[0].visits[0].evidenceFingerprint).toBe(shown.evidenceFingerprint); // stable between loads
  });

  test('a photo added after the mark changes the evidence: the save is refused as stale, and an earlier mark stops counting', async () => {
    const { svc, record } = await visit(tech);
    const window = { from: '2026-04-01', to: '2026-04-30' };
    const shown = (await board())[0].visits[0];
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech });
    expect(await scores.readAudit(tech, window)).toBe(100);
    await db('service_photos').insert({ service_record_id: record.id, photo_type: 'after', s3_key: 'k/late.jpg' });
    expect((await board())[0].visits[0]).toMatchObject({ audit: null, needsRecheck: true });
    expect(await scores.readAudit(tech, window)).toBeNull();
    const send = (fingerprint) => audit.saveMark({ scheduledServiceId: svc.id, technicianId: tech, month: MONTH, recordId: record.id, evidenceFingerprint: fingerprint, result: 'match', auditedBy: tech });
    await expect(send(shown.evidenceFingerprint)).rejects.toMatchObject({ status: 409, code: 'STALE_EVIDENCE' }); // marked on what the board showed before the photo
    const reloaded = (await board())[0].visits[0];
    expect(reloaded.evidenceFingerprint).not.toBe(shown.evidenceFingerprint);
    await send(reloaded.evidenceFingerprint);
    expect(await scores.readAudit(tech, window)).toBe(100); // counted again on the new evidence
  });

  test('a mark that needs a re-check keeps its place in the board sample and can be marked again; only its score drops', async () => {
    const rank = (visitId) => require('crypto').createHash('sha256').update(`${tech}:${MONTH_START}:${visitId}`).digest('hex');
    const window = { from: '2026-04-01', to: '2026-04-30' };
    await lawnVisits(tech, 6);
    const sampled = (await board())[0].visits;
    expect(sampled).toHaveLength(5);
    // the marked visit that ranks LAST gets the mismatch; the other four match
    const target = [...sampled].sort((x, y) => (rank(x.scheduledServiceId) < rank(y.scheduledServiceId) ? 1 : -1))[0];
    for (const v of sampled) {
      await save(v === target ? { scheduledServiceId: v.scheduledServiceId, result: 'mismatch', note: 'rate off', auditedBy: tech } : { scheduledServiceId: v.scheduledServiceId, result: 'match', auditedBy: tech });
    }
    expect(await scores.readAudit(tech, window)).toBe(80);
    // a visit that ranks LOWER than the target completes: it would take the slot the target frees if the target lost its place
    let newer = null;
    for (let i = 0; i < 400 && !newer; i += 1) {
      const candidate = await visit(tech);
      if (rank(candidate.svc.id) < rank(target.scheduledServiceId)) newer = candidate;
    }
    expect(newer).toBeTruthy();
    expect(ids((await board())[0])).not.toContain(newer.svc.id); // all five slots are marked: no free slot yet
    await db('service_photos').insert({ service_record_id: target.recordId, photo_type: 'after', s3_key: 'k/late.jpg' }); // the evidence changes after the mark
    const after = (await board())[0];
    expect(after.visits).toHaveLength(5);
    expect(ids(after)).toContain(target.scheduledServiceId); // the stale visit keeps its slot ...
    expect(ids(after)).not.toContain(newer.svc.id); // ... the lower-ranked newcomer does not take it
    const shown = after.visits.find((v) => v.scheduledServiceId === target.scheduledServiceId);
    expect(shown).toMatchObject({ audit: null, needsRecheck: true });
    expect(after.markedCount).toBe(4);
    expect(await scores.readAudit(tech, window)).toBe(100); // its old mismatch no longer scores: 4 of 4
    await audit.saveMark({ scheduledServiceId: shown.scheduledServiceId, technicianId: tech, month: MONTH, recordId: shown.recordId, evidenceFingerprint: shown.evidenceFingerprint, result: 'match', auditedBy: tech }); // not NOT_IN_SAMPLE
    expect((await board())[0].markedCount).toBe(5);
    expect(await scores.readAudit(tech, window)).toBe(100);
  });

  test('the fingerprint covers the photos the board shows (the first 12, in order): moving a 13th photo into view changes it', async () => {
    const { svc, record } = await visit(tech);
    const photoIds = [];
    for (let i = 0; i < 13; i += 1) {
      const [p] = await db('service_photos').insert({ service_record_id: record.id, photo_type: 'progress', s3_key: `k/${i}.jpg`, sort_order: i }).returning('id');
      photoIds.push(p.id);
    }
    const fingerprint = async () => (await board())[0].visits[0].evidenceFingerprint;
    const before = await fingerprint();
    expect((await board())[0].visits[0].photos).toHaveLength(12);
    await db('service_photos').where({ id: photoIds[12] }).update({ sort_order: -1 }); // the 13th now shows first, the 12th drops out of view; the set of 13 is unchanged
    const moved = await fingerprint();
    expect(moved).not.toBe(before);
    await db('service_photos').where({ id: photoIds[12] }).update({ sort_order: 12 });
    expect(await fingerprint()).toBe(before); // back to the same display: the same fingerprint
    // and a mark made on the old display no longer saves
    await db('service_photos').where({ id: photoIds[12] }).update({ sort_order: -1 });
    await expect(audit.saveMark({ scheduledServiceId: svc.id, technicianId: tech, month: MONTH, recordId: record.id, evidenceFingerprint: before, result: 'match', auditedBy: tech }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_EVIDENCE' });
  });

  test('the protocol assignments of a whole board are read in one ledger query and one pin query, and agree with the report reader', async () => {
    const a = await visit(tech);
    const b = await visit(tech);
    const c = await visit(tech);
    await db('lawn_protocol_service_completions').insert({ service_record_id: a.record.id, protocol_version: null, window_key: 'w' }); // a ledger row with no version wins over the pin
    await db('scheduled_services').where({ id: a.svc.id }).update({ lawn_protocol_version: 'pin-a' });
    await db('scheduled_services').where({ id: b.svc.id }).update({ lawn_protocol_version: 'pin-b', lawn_protocol_window_key: 'wb' });
    const seen = [];
    const listener = (q) => seen.push(q.sql);
    db.on('query', listener);
    const shown = new Map((await board())[0].visits.map((v) => [v.scheduledServiceId, v.protocol]));
    db.removeListener('query', listener);
    expect(seen.filter((sql) => sql.includes('lawn_protocol_service_completions'))).toHaveLength(1);
    expect(seen.filter((sql) => sql.includes('lawn_protocol_window_key'))).toHaveLength(1);
    const { resolveRecordedProtocolVersion } = require('../services/service-report/report-data');
    for (const v of [a, b, c]) {
      const reader = await resolveRecordedProtocolVersion(db, { id: v.record.id, scheduled_service_id: v.svc.id });
      expect(shown.get(v.svc.id)?.version ?? null).toBe(reader);
    }
    expect(shown.get(a.svc.id)).toEqual({ version: null, windowKey: 'w', windowTitle: null });
    expect(shown.get(b.svc.id)).toEqual({ version: 'pin-b', windowKey: 'wb', windowTitle: null });
    expect(shown.get(c.svc.id)).toBeNull();
  });

  test('a mark stored with the v1 digest (no prefix) keeps counting on unchanged evidence, reads re-check once the evidence changed, and new marks store v2', async () => {
    const { svc, record } = await visit(tech);
    const window = { from: '2026-04-01', to: '2026-04-30' };
    const [current] = await audit.eligibleVisits({ scheduledServiceId: svc.id });
    const v1 = audit._private.evidenceFingerprintV1((await audit._private.loadEvidence([current])).get(svc.id));
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    await db('tech_protocol_audits').insert({ technician_id: tech, scheduled_service_id: svc.id, audit_month: MONTH_START, result: 'match',
      reviewed_record_id: record.id, evidence_fingerprint: v1 }); // a mark saved before the v2 format
    const shown = (await board())[0].visits[0];
    expect(shown.evidenceFingerprint).toMatch(/^v2:/); // the board shows v2
    expect(shown).toMatchObject({ audit: { result: 'match' }, needsRecheck: false });
    expect(await scores.readAudit(tech, window)).toBe(100);
    // a board loaded before the change still submits a v1 digest: accepted on unchanged evidence, stored as v2
    await audit.saveMark({ scheduledServiceId: svc.id, technicianId: tech, month: MONTH, recordId: record.id, evidenceFingerprint: v1, result: 'mismatch', note: 'x', auditedBy: tech });
    expect((await db('tech_protocol_audits').first()).evidence_fingerprint).toMatch(/^v2:[0-9a-f]{64}$/);
    // a v1 mark whose evidence changed reads re-check
    await db('tech_protocol_audits').update({ result: 'match', evidence_fingerprint: v1 });
    expect(await scores.readAudit(tech, window)).toBe(100);
    await db('service_photos').insert({ service_record_id: record.id, photo_type: 'after', s3_key: 'k/changed.jpg' });
    expect((await board())[0].visits[0]).toMatchObject({ audit: null, needsRecheck: true });
    expect(await scores.readAudit(tech, window)).toBeNull();
    await expect(audit.saveMark({ scheduledServiceId: svc.id, technicianId: tech, month: MONTH, recordId: record.id, evidenceFingerprint: v1, result: 'match', auditedBy: tech }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_EVIDENCE' });
  });

  test('a v1 digest submitted for a visit with several photos is refused: it cannot show which photos the owner saw', async () => {
    const { svc, record } = await visit(tech);
    const ids13 = [];
    for (let i = 0; i < 13; i += 1) {
      const [p] = await db('service_photos').insert({ service_record_id: record.id, photo_type: 'progress', s3_key: `k/${i}.jpg`, sort_order: i }).returning('id');
      ids13.push(p.id);
    }
    const [current] = await audit.eligibleVisits({ scheduledServiceId: svc.id });
    const v1 = audit._private.evidenceFingerprintV1((await audit._private.loadEvidence([current])).get(svc.id));
    await db('service_photos').where({ id: ids13[12] }).update({ sort_order: -1 }); // photo 13 moves into view after a v1 board loaded
    await expect(audit.saveMark({ scheduledServiceId: svc.id, technicianId: tech, month: MONTH, recordId: record.id, evidenceFingerprint: v1, result: 'match', auditedBy: tech }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_EVIDENCE' });
    expect(await db('tech_protocol_audits')).toHaveLength(0);
  });

  test('correcting the service line (same service type) changes the evidence and the mark stops counting', async () => {
    const { svc, record } = await visit(tech, { service_type: 'Lawn and Tree Care' });
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech });
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBe(100);
    await db('service_records').where({ id: record.id }).update({ service_line: 'tree_shrub' });
    expect((await board())[0].visits[0]).toMatchObject({ serviceLine: 'tree_shrub', audit: null, needsRecheck: true });
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBeNull();
  });

  test('an older sibling record never inherits a mark when the newest record stops being eligible', async () => {
    const { svc, record: older } = await visit(tech);
    const [newer] = await db('service_records').insert({ technician_id: tech, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-04-11', service_type: 'Lawn Care Treatment', service_line: 'lawn', created_at: new Date(Date.now() + 1000) }).returning('*');
    const window = { from: '2026-04-01', to: '2026-04-30' };
    const shown = (await board())[0].visits[0];
    expect(shown.recordId).toBe(newer.id);
    await save({ scheduledServiceId: svc.id, result: 'match', auditedBy: tech });
    expect(await scores.readAudit(tech, window)).toBe(100);
    await db('service_records').where({ id: newer.id }).update({ status: 'incomplete' }); // the newest record is no longer a completed one
    expect((await board())[0].visits[0]).toMatchObject({ recordId: older.id, audit: null, needsRecheck: true });
    expect(await scores.readAudit(tech, window)).toBeNull();
    // the same shape on an OLD row (no stored record or fingerprint) keeps today's rule: the older record predates the mark
    await db('tech_protocol_audits').update({ reviewed_record_id: null, evidence_fingerprint: null });
    expect((await board())[0].visits[0]).toMatchObject({ audit: { result: 'match' }, needsRecheck: false });
    expect(await scores.readAudit(tech, window)).toBe(100);
  });

  test('a legacy row with no stored record or fingerprint counts as before, and still drops when a newer record follows it', async () => {
    const { svc } = await visit(tech);
    const window = { from: '2026-04-01', to: '2026-04-30' };
    await db('tech_protocol_audits').insert({ technician_id: tech, scheduled_service_id: svc.id, audit_month: MONTH_START, result: 'match' });
    expect(await scores.readAudit(tech, window)).toBe(100);
    await db('service_records').insert({ technician_id: tech, customer_id: customerId, scheduled_service_id: svc.id, status: 'completed',
      service_date: '2026-04-11', service_type: 'Lawn Care Treatment', service_line: 'lawn', created_at: new Date(Date.now() + 60000) });
    expect(await scores.readAudit(tech, window)).toBeNull();
  });

  test("the board shows the visit's frozen lawn protocol version and window, from the closeout ledger first, else the visit's pin; none = not recorded", async () => {
    const withLedger = await visit(tech);
    const withPin = await visit(tech);
    const none = await visit(tech, { service_line: 'tree_shrub', service_type: 'Tree & Shrub Treatment' });
    await db('lawn_protocol_service_completions').insert({ service_record_id: withLedger.record.id, protocol_version: '2026.10-v13', window_key: 'apr_v13', window_title: 'April take-all' });
    await db('scheduled_services').where({ id: withLedger.svc.id }).update({ lawn_protocol_version: 'older', lawn_protocol_window_key: 'older_window' }); // the ledger wins
    await db('scheduled_services').where({ id: withPin.svc.id }).update({ lawn_protocol_version: '2026.06', lawn_protocol_window_key: 'jun', lawn_protocol_window_title: 'June' });
    const shown = new Map((await board())[0].visits.map((v) => [v.scheduledServiceId, v]));
    expect(shown.get(withLedger.svc.id).protocol).toEqual({ version: '2026.10-v13', windowKey: 'apr_v13', windowTitle: 'April take-all' });
    expect(shown.get(withPin.svc.id).protocol).toEqual({ version: '2026.06', windowKey: 'jun', windowTitle: 'June' });
    expect(shown.get(none.svc.id).protocol).toBeNull();
    // the protocol is part of the evidence: changing the recorded version changes the fingerprint
    const before = shown.get(withLedger.svc.id).evidenceFingerprint;
    await db('lawn_protocol_service_completions').update({ protocol_version: '2026.11-v14' });
    expect((await board())[0].visits.find((v) => v.scheduledServiceId === withLedger.svc.id).evidenceFingerprint).not.toBe(before);
  });

  test('the evidence migration is additive: two nullable columns, repeatable, constraints untouched, down drops only them', async () => {
    const migration = require('../models/migrations/20261120190000_tech_protocol_audit_evidence');
    await migration.up(db);
    const columns = await db.raw("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = 'tech_protocol_audits' AND column_name IN ('reviewed_record_id', 'evidence_fingerprint') ORDER BY 1", [mockSchema]);
    expect(columns.rows).toEqual([{ column_name: 'evidence_fingerprint', is_nullable: 'YES' }, { column_name: 'reviewed_record_id', is_nullable: 'YES' }]);
    const svc = (await db('scheduled_services').insert({ technician_id: tech }).returning('*'))[0];
    await expect(db('tech_protocol_audits').insert({ technician_id: tech, scheduled_service_id: svc.id, audit_month: MONTH_START, result: 'maybe' })).rejects.toThrow(/result_check/);
    await migration.down(db);
    expect(await db.schema.hasColumn('tech_protocol_audits', 'reviewed_record_id')).toBe(false);
    expect(await db.schema.hasColumn('tech_protocol_audits', 'result')).toBe(true);
    await migration.up(db);
    expect(await db.schema.hasColumn('tech_protocol_audits', 'evidence_fingerprint')).toBe(true);
  });

  test('a marked visit stays on the board when more visits complete later, and the season score reads the marks', async () => {
    await lawnVisits(tech, 6);
    const [shown] = await board();
    await save({ scheduledServiceId: shown.visits[0].scheduledServiceId, result: 'match', auditedBy: tech });
    await save({ scheduledServiceId: shown.visits[1].scheduledServiceId, result: 'mismatch', note: 'wrong product', auditedBy: tech });
    await lawnVisits(tech, 20); // lower ranks may now outrank the unmarked ones; the marked two never leave
    const after = ids((await board())[0]);
    expect(after).toHaveLength(5);
    expect(after).toEqual(expect.arrayContaining([shown.visits[0].scheduledServiceId, shown.visits[1].scheduledServiceId]));
    expect(await scores.readAudit(tech, { from: '2026-04-01', to: '2026-04-30' })).toBe(50);
  });
});
