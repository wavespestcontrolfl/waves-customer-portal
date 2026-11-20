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
    return audit.saveMark({ technicianId: current ? current.technician_id : tech, month: current ? current.month.slice(0, 7) : MONTH,
      recordId: current ? current.record_id : '00000000-0000-4000-8000-000000000000', ...args });
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
    await require('../models/migrations/20261120150000_tech_rewards_scores').up(db);
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
    await db('tech_protocol_audits').del();
    await db('service_products').del();
    await db('service_photos').del();
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
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await db('tech_protocol_audits').update({ audited_at: new Date(Date.now() + 120000) }); // a re-mark after the replacement
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
    const send = (over = {}) => audit.saveMark({ scheduledServiceId: svc.id, technicianId: shown.technicianId, month: shown.month, recordId: shown.recordId, result: 'match', auditedBy: tech, ...over });
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
