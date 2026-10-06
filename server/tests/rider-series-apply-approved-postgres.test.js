// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// scripts/rider-series-apply-approved.js — the ONE-TIME, owner-approved,
// silent move of quarterly pest visits onto the customer's lawn dates.
// RETIRED 2026-10-05 (owner: pest and lawn never share one stop): the rider
// pairing table no longer lets pest ride a lawn, so the script's own preview
// re-check refuses every pest pair. Proves: an approval file written before the
// change is refused in a dry run AND in an apply, nothing is written, and NO
// message-side table gets a row.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { previewRiderPair, TARGET_GAP_DAYS } = require('../services/rider-series-preview');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { applyApproved } = require('../../scripts/rider-series-apply-approved');

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

jest.setTimeout(180000);

// Every table a message, notice, tech push or series-move effect would land in.
const SILENT_TABLES = ['outbox_messages', 'series_moves', 'sms_log', 'messaging_audit_log', 'reschedule_log', 'job_status_history'];

postgres('rider-series one-time apply against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let techId;
  let tmpDir;

  const LAWN_START = '2098-01-08';
  const ANCHOR = addDays(LAWN_START, -TARGET_GAP_DAYS);

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !ownedQA && !privateQa) throw new Error("Use disposable CI or this worktree's private QA database");
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rider-apply-'));
  });

  // The apply path lazily loads the schedule route and its service graph; pay
  // that cost once here rather than inside the first test's timeout.
  beforeAll(() => {
    require('../routes/admin-schedule');
    for (const m of ['cancellation-processor', 'no-show-detector', 'recurring-appointment-seeder', 'self-booking-plan-sync', 'complete-scheduled-service', 'billing-lane', 'series-customer-eligibility']) {
      require(`../services/${m}`);
    }
  }, 300000);

  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    techId = randomUUID();
    await trx('technicians').insert({
      id: techId, name: 'Synthetic tech', employment_status: 'active', field_dispatchable: true,
    });
    await trx('customers').insert({
      id: customerId,
      first_name: 'Rider-apply',
      last_name: 'Fixture',
      email: `${customerId}@example.invalid`,
      phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      address_line1: '100 Test Lane',
      city: 'Test City',
      zip: '00000',
      active: true,
      pipeline_stage: 'active_customer',
    });
  });

  afterEach(async () => { if (trx && !trx.isCompleted()) await trx.rollback().catch(() => {}); });
  afterAll(async () => {
    await database?.destroy();
    await require('../models/db').destroy();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function row(overrides = {}) {
    const [r] = await trx('scheduled_services').insert({
      id: randomUUID(),
      customer_id: customerId,
      status: 'confirmed',
      is_recurring: true,
      recurring_ongoing: false,
      service_type: 'Test Service',
      ...overrides,
    }).returning('*');
    return r;
  }

  // Lawn host (every 6 weeks, 09:00-10:00, tech) + pest rider (quarterly,
  // completed anchor + two pending children the plan moves onto lawn dates).
  async function buildPair({ pestTech = null } = {}) {
    const lawnParent = await row({
      recurring_ongoing: true,
      recurring_pattern: 'every_6_weeks',
      service_type: 'Lawn Care - Every 6 Weeks',
      scheduled_date: LAWN_START,
      window_start: '09:00',
      window_end: '10:00',
      technician_id: techId,
    });
    for (let i = 1; i <= 6; i++) {
      await row({
        recurring_parent_id: lawnParent.id,
        recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks',
        service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: addDays(LAWN_START, i * 42),
        window_start: '09:00',
        window_end: '10:00',
        technician_id: techId,
      });
    }
    const pestParent = await row({
      status: 'completed',
      recurring_ongoing: true,
      recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control',
      scheduled_date: ANCHOR,
      estimated_price: 100,
      create_invoice_on_complete: true,
      window_start: '14:00',
      window_end: '15:00',
    });
    const kids = [];
    for (const off of [91, 182]) {
      kids.push(await row({
        recurring_parent_id: pestParent.id,
        recurring_ongoing: true,
        status: 'pending',
        recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control',
        scheduled_date: addDays(ANCHOR, off),
        estimated_price: 100,
        create_invoice_on_complete: true,
        window_start: '14:00',
        window_end: '15:00',
        route_order: 3,
        technician_id: pestTech,
      }));
    }
    return { lawnParent, pestParent, kids };
  }

  const dateOnly = (v) => (v instanceof Date ? require('../utils/datetime-et').etCalendarDayOf(v) : String(v).slice(0, 10));

  async function silentCounts() {
    const out = {};
    for (const t of SILENT_TABLES) out[t] = Number((await trx(t).count('* as n').first()).n);
    return out;
  }

  async function snapshot() {
    return JSON.stringify(await trx('scheduled_services').select('*').orderBy('id'));
  }


  // An approval written while pest still rode the lawn: one pending pest visit
  // approved to move onto the 84-day lawn date.
  function staleApproval({ lawnParent, pestParent, kids }) {
    return {
      generatedAt: new Date().toISOString(),
      results: [{
        lawnParentId: lawnParent.id, pestParentId: pestParent.id, customerId, propertyId: null, extraReasons: [],
        eligible: true, reasons: [], insert: [],
        move: [{ id: kids[0].id, from: dateOnly(kids[0].scheduled_date), to: addDays(LAWN_START, 84) }],
      }],
    };
  }

  test('the pest + lawn pair is no longer eligible: pest does not ride a lawn', async () => {
    const { lawnParent, pestParent } = await buildPair();
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.eligible).toBe(false);
    expect(preview.reasons).toContain('pairing_not_enabled');
  });

  test.each([[false], [true]])('apply=%s: an earlier approval is refused, nothing is written and nothing is messaged', async (apply) => {
    const pair = await buildPair();
    const before = await snapshot();
    const counts = await silentCounts();
    const res = await applyApproved(trx, staleApproval(pair), { apply });
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0].status).toBe('skipped');
    expect(['preview_not_eligible', 'candidate_pair_not_found']).toContain(res.pairs[0].reason);
    expect(res.pairs[0].moves).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(await silentCounts()).toEqual(counts);
  });
});
