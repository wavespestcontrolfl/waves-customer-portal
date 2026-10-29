/**
 * Technician ID-card and training reminders (GATE_TECH_TRAINING_DATES). The stage rules, the bell text through the real
 * composeAdminAlert (it throws on a rule break under NODE_ENV=test), dedupe keys, and the open / close decisions. The SQL
 * (real notifications rows, dedupe and close) runs in technician-training-dates-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1', deduped: false })) }));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn(async (_c, keys) => keys.length), openAdminAlertKeys: jest.fn(async () => []) }));

const NotificationService = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const reminders = require('../services/technician-training-reminders');

const { dueReminders, stageOf, keyFor, alertSpec } = reminders._private;
const TECH = '11111111-1111-4111-8111-111111111111';
const GATE = 'GATE_TECH_TRAINING_DATES';

const tech = (over = {}) => ({
  id: TECH, name: 'Maria Lopez', hire_date: '2026-10-01', license_expiry: null,
  id_card_applied_on: null, id_card_issued_on: null, classroom_hours_done_on: null, renewal_training_done_on: null, ...over,
});

// A conn whose technicians query resolves to `rows`.
function connWith(rows) {
  const q = new Proxy({}, { get: (_t, name) => (name === 'then' ? (resolve) => resolve(rows) : () => q) });
  const conn = jest.fn(() => q);
  conn.raw = (sql) => sql;
  return conn;
}

describe('stages', () => {
  test.each([
    ['idcard', '2026-11-30', '2026-11-15', null],
    ['idcard', '2026-11-30', '2026-11-16', 'd14'],
    ['idcard', '2026-11-30', '2026-11-26', 'd14'],
    ['idcard', '2026-11-30', '2026-11-27', 'd3'],
    ['idcard', '2026-11-30', '2026-11-30', 'd3'],
    ['idcard', '2026-11-30', '2026-12-01', 'overdue'],
    ['classroom', '2027-04-15', '2027-03-15', null],
    ['classroom', '2027-04-15', '2027-03-16', 'd30'],
    ['classroom', '2027-04-15', '2027-04-07', 'd30'],
    ['classroom', '2027-04-15', '2027-04-08', 'd7'],
    ['classroom', '2027-04-15', '2027-04-16', 'overdue'],
    ['renewal', '2027-06-30', '2027-05-30', null],
    ['renewal', '2027-06-30', '2027-05-31', 'd30'],
    ['renewal', '2027-06-30', '2027-06-30', 'd30'],
    ['renewal', '2027-06-30', '2027-07-01', null],
  ])('%s due %s on %s is stage %s', (deadline, dueOn, today, expected) => {
    expect(stageOf(deadline, dueOn, null, today)).toBe(expected);
  });

  test('a done date or no due date has no stage', () => {
    expect(stageOf('idcard', '2026-11-30', '2026-11-01', '2026-12-05')).toBeNull();
    expect(stageOf('idcard', null, null, '2026-12-05')).toBeNull();
  });
});

describe('dueReminders', () => {
  test('a new hire inside the 14-day window has one ID card reminder keyed by deadline, technician, due date and stage', () => {
    const list = dueReminders(tech(), '2026-10-20');
    expect(list).toEqual([{ deadline: 'idcard', stage: 'd14', dueOn: '2026-10-31', key: `tech-training:idcard:${TECH}:2026-10-31:d14` }]);
  });

  test('applying for the card closes the ID card deadline, and issuing it starts the classroom clock', () => {
    expect(dueReminders(tech({ id_card_applied_on: '2026-10-10' }), '2026-12-01')).toEqual([]);
    const issued = dueReminders(tech({ id_card_applied_on: '2026-10-10', id_card_issued_on: '2026-10-25' }), '2027-03-30');
    expect(issued.map((r) => [r.deadline, r.stage, r.dueOn])).toEqual([['classroom', 'd30', '2027-04-25']]);
    expect(dueReminders(tech({ id_card_issued_on: '2026-10-25', classroom_hours_done_on: '2026-12-01' }), '2027-04-20')).toEqual([]);
  });

  test('renewal training is open only for the current renewal year', () => {
    const open = dueReminders(tech({ id_card_applied_on: '2026-10-10', license_expiry: '2027-06-30' }), '2027-06-10');
    expect(open.map((r) => r.key)).toEqual([keyFor('renewal', TECH, '2027-06-30', 'd30')]);
    const doneThisYear = dueReminders(tech({ id_card_applied_on: '2026-10-10', license_expiry: '2027-06-30', renewal_training_done_on: '2027-03-01' }), '2027-06-10');
    expect(doneThisYear).toEqual([]);
    const doneLastYear = dueReminders(tech({ id_card_applied_on: '2026-10-10', license_expiry: '2027-06-30', renewal_training_done_on: '2026-05-01' }), '2027-06-10');
    expect(doneLastYear).toHaveLength(1);
  });
});

describe('the bell text passes the admin notification rule for every deadline, stage and a long name', () => {
  const stages = [
    ['idcard', 'd14', '2026-10-31', '2026-10-20'], ['idcard', 'd3', '2026-10-31', '2026-10-29'], ['idcard', 'overdue', '2026-10-31', '2026-11-05'],
    ['classroom', 'd30', '2027-04-25', '2027-03-30'], ['classroom', 'd7', '2027-04-25', '2027-04-20'], ['classroom', 'overdue', '2027-04-25', '2027-05-02'],
    ['renewal', 'd30', '2027-06-30', '2027-06-10'],
  ];
  test.each(stages)('%s %s', (deadline, stage, dueOn, today) => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    for (const name of ['Maria Lopez', 'Maria Guadalupe Hernandez-Villanueva de la Cruz Montgomery', 'J_R. Smith']) {
      const composed = composeAdminAlert(alertSpec(tech({ name }), { deadline, stage, dueOn }, today));
      expect(composed.headline.length).toBeLessThanOrEqual(60);
      expect(composed.why.length).toBeLessThanOrEqual(110);
      expect(composed.metadata).toMatchObject({ area: 'System', severity: 'needs-you', who: 'person', subject: { type: 'check', id: TECH } });
      expect(composed.link).toBe('/admin/compliance?tab=licenses');
    }
  });
});

describe('runTechnicianTrainingReminders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    episodes.openAdminAlertKeys.mockResolvedValue([]);
  });
  afterEach(() => { delete process.env[GATE]; });

  test('gate off returns before any query, bell or close', async () => {
    const conn = connWith([tech()]);
    expect(await reminders.runTechnicianTrainingReminders({ conn, today: '2026-10-20' })).toEqual({ skipped: 'gate_off' });
    expect(conn).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('gate on raises one bell per technician and deadline, deduped on its key, as an admin bell only', async () => {
    process.env[GATE] = 'true';
    const result = await reminders.runTechnicianTrainingReminders({ conn: connWith([tech()]), today: '2026-10-20' });
    expect(result).toEqual({ scanned: 1, raised: 1, closed: 0 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(headline).toMatch(/^System — .*Maria Lopez/);
    expect(why).toMatch(/ID card application is due Oct 31, 30 days after hire\./);
    expect(opts).toMatchObject({
      dedupeKey: `tech-training:idcard:${TECH}:2026-10-31:d14`,
      link: '/admin/compliance?tab=licenses',
      metadata: { technicianId: TECH, deadline: 'idcard', stage: 'd14', dueOn: '2026-10-31' },
    });
  });

  test('a later stage closes the earlier stage\'s bell and a settled deadline closes its own; nothing else is touched', async () => {
    process.env[GATE] = 'true';
    const earlier = `tech-training:idcard:${TECH}:2026-10-31:d14`;
    const otherTech = 'tech-training:idcard:99999999-9999-4999-8999-999999999999:2026-10-31:d14';
    episodes.openAdminAlertKeys.mockResolvedValue([earlier, otherTech]);
    // Oct 29: the d3 stage takes over for this technician. The other technician's key is not in this run's scope.
    const result = await reminders.runTechnicianTrainingReminders({ conn: connWith([tech()]), today: '2026-10-29', technicianId: TECH });
    expect(result.raised).toBe(1);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [earlier], 'training_date_entered', expect.objectContaining({ resolution: expect.any(String) }));
    expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe(`tech-training:idcard:${TECH}:2026-10-31:d3`);
  });

  test('closeOnly (the save on the Licenses tab) closes what the entered date settled and raises nothing', async () => {
    process.env[GATE] = 'true';
    const standing = `tech-training:idcard:${TECH}:2026-10-31:d3`;
    episodes.openAdminAlertKeys.mockResolvedValue([standing]);
    const applied = tech({ id_card_applied_on: '2026-10-28' });
    const result = await reminders.runTechnicianTrainingReminders({ conn: connWith([applied]), today: '2026-10-29', technicianId: TECH, closeOnly: true });
    expect(result).toEqual({ scanned: 1, raised: 0, closed: 1 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [standing], 'training_date_entered', expect.anything());
  });
});
