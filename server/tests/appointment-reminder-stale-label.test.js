// Stale-label regression (08-14 incident): appointment_reminders.service_type
// is FROZEN at registration — a recurring child spawns with its parent's
// label, and a later admin relabel of the visit never re-syncs the row (the
// 20260716150000 trigger covers appointment_time/flags only). A customer's 72h
// reminder called a relabeled "Termite Bond Service (1-Year Term)" visit
// "Quarterly Pest Control Service". The 72h/24h reminder legs now re-resolve
// the label from the LIVE scheduled_services row at send time via
// liveReminderServiceLabel, falling back to the stored label for legacy
// unlinked rows and on any lookup failure.
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => sql);
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));

const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');

const { liveReminderServiceLabel } = AppointmentReminders._test;

// Thenable query-builder stub: every chain method returns the builder, and
// awaiting it resolves `result` (matching knex's builder-as-promise shape,
// which buildMergedServiceLabel awaits directly after .select()).
function chain(result) {
  const qb = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'leftJoin', 'select', 'whereNull', 'whereIn']) {
    qb[m] = jest.fn(() => qb);
  }
  // An Error result makes every terminal reject — simulates one component
  // query failing while the others succeed.
  const failing = result instanceof Error;
  qb.first = jest.fn(async () => {
    if (failing) throw result;
    return Array.isArray(result) ? (result[0] ?? null) : result;
  });
  qb.pluck = jest.fn(async () => {
    if (failing) throw result;
    return Array.isArray(result) ? result : [];
  });
  qb.then = (resolve, reject) => (failing
    ? Promise.reject(result).then(resolve, reject)
    : Promise.resolve(result).then(resolve, reject));
  return qb;
}

// Queue one chain per db(<table>) call, in call order.
function queueChains(...results) {
  const queue = results.map(chain);
  db.mockImplementation(() => {
    if (!queue.length) throw new Error('unexpected db() call — queue exhausted');
    return queue.shift();
  });
}

const STALE_ROW = {
  id: 'ar-1',
  customer_id: 'cust-1',
  scheduled_service_id: 'ss-termite',
  appointment_time: new Date('2026-08-17T16:00:00Z'),
  service_type: 'Quarterly Pest Control Service', // frozen at registration
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('liveReminderServiceLabel', () => {
  test('re-resolves a relabeled visit from the live row — the exact 08-14 incident shape', async () => {
    queueChains(
      // buildMergedServiceLabel sibling scan: coalesce(ss.service_type, ar.service_type)
      [{ scheduled_service_id: 'ss-termite', label: 'Termite Bond Service (1-Year Term)' }],
      // estimateBackedServiceName visit read — a mapped canonical label
      // passes through unchanged (notes/interest do not match the
      // fall-through signature)
      { notes: null, service_interest: 'Pest Control' },
      // addon pluck — none
      [],
    );
    const label = await liveReminderServiceLabel(STALE_ROW);
    // Live service_type wins over the frozen registration label, and
    // smsServiceLabel strips the "(1-Year Term)" paren qualifier.
    expect(label).toBe('Termite Bond Service');
    expect(label).not.toMatch(/Quarterly/);
  });

  test('live add-ons still merge into the label (no buildMergedServiceLabel regression)', async () => {
    queueChains(
      [{ scheduled_service_id: 'ss-termite', label: 'Termite Bond Service' }],
      { notes: null, service_interest: null },
      ['Mosquito Control'],
    );
    const label = await liveReminderServiceLabel(STALE_ROW);
    expect(label).toBe('Termite Bond Service & Mosquito Control');
  });

  test('legacy unlinked rows keep the stored label — no live lookup exists for them', async () => {
    queueChains(); // any db() call would throw
    const label = await liveReminderServiceLabel({ ...STALE_ROW, scheduled_service_id: null });
    expect(label).toBe('Quarterly Pest Control Service');
    expect(db).not.toHaveBeenCalled();
  });

  test("falls back to the stored label when the merged result is the 'service' placeholder (appointment moved mid-scan)", async () => {
    queueChains([]); // sibling scan finds nothing at this customer+slot
    const label = await liveReminderServiceLabel(STALE_ROW);
    expect(label).toBe('Quarterly Pest Control Service');
  });

  test('falls back to the stored label on lookup failure — a stale-labeled reminder beats no reminder', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const label = await liveReminderServiceLabel(STALE_ROW);
    expect(label).toBe('Quarterly Pest Control Service');
  });

  test('a PARTIALLY failed merge (add-on read down) keeps the stored label — strict mode surfaces swallowed component errors (codex r1 P2)', async () => {
    // Sibling scan and estimate-name read succeed, the add-on pluck fails:
    // best-effort mode would return a base label MISSING an add-on the
    // persisted label already carries; strict mode throws to the fallback.
    queueChains(
      [{ scheduled_service_id: 'ss-termite', label: 'Termite Bond Service' }],
      { notes: null, service_interest: null },
      new Error('addons table read failed'),
    );
    const label = await liveReminderServiceLabel(STALE_ROW);
    expect(label).toBe('Quarterly Pest Control Service');
  });

  test('a failed estimate-name component read also falls back to the stored label (strict mode)', async () => {
    queueChains(
      [{ scheduled_service_id: 'ss-termite', label: 'Termite Bond Service' }],
      new Error('estimates join read failed'),
    );
    const label = await liveReminderServiceLabel(STALE_ROW);
    expect(label).toBe('Quarterly Pest Control Service');
  });
});

describe('send-site wiring', () => {
  const src = require('fs').readFileSync(
    require.resolve('../services/appointment-reminders'), 'utf8',
  );

  test('both reminder legs + the 24h night-skip email leg resolve the label live', () => {
    // 72h SMS + 24h SMS sites
    expect(src.split('const serviceLabel = await liveReminderServiceLabel(r);').length - 1).toBe(2);
    // 24h night-skip email leg
    expect(src).toContain('serviceLabel: await liveReminderServiceLabel(r),');
    // No reminder-loop site still reads the frozen row column directly.
    expect(src).not.toContain('smsServiceLabelStored(r.service_type)');
  });

  test('the other notice paths are deliberately unchanged (reschedule/cancel reference rows the live-merge query excludes by status)', () => {
    expect(src).toContain('smsServiceLabelStored(record.service_type)');
    expect(src).toContain('smsServiceLabelStored(reminderRow.service_type)');
  });
});
