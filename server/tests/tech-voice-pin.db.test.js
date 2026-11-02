// The tech voice line's PIN (services/tech-voice-pin.js) against PostgreSQL: 4 to 6 digits stored only as a salted
// scrypt hash; a wrong try counts under the row lock, the fifth in a row locks the PIN for 15 minutes and raises one
// admin alert, a lock refuses even the right PIN until it lapses, and an admin reset clears it. Synthetic technician
// rows, deleted after each test. Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: jest.fn(async () => ({ id: 1 })) }));

const knex = require('knex');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { setTechVoicePin, hasTechVoicePin, checkTechVoicePin, MAX_FAILED_TRIES } = require('../services/tech-voice-pin');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);

const NOW = new Date('2026-11-12T20:00:00Z');
const later = (minutes) => new Date(NOW.getTime() + minutes * 60 * 1000);

describeDb('tech voice PIN (PostgreSQL)', () => {
  let database;
  let techId;
  const row = () => database('tech_voice_pins').where({ technician_id: techId }).first();
  const check = (pin, now = NOW) => checkTechVoicePin(database, { technicianId: techId, technicianName: 'Pat Sample', pin, now });

  beforeAll(() => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
  });
  beforeEach(async () => {
    raiseAdminAlert.mockClear();
    [{ id: techId }] = await database('technicians').insert({ name: 'Voice PIN Test' }).returning('id');
  });
  afterEach(async () => {
    await database('tech_voice_pins').where({ technician_id: techId }).del();
    await database('technicians').where({ id: techId }).del();
  });
  afterAll(async () => { if (database) await database.destroy(); });

  test('only 4 to 6 digits are accepted, and only a salted hash is stored', async () => {
    for (const bad of ['123', '1234567', '12a4', '', null]) {
      expect(await setTechVoicePin(database, { technicianId: techId, pin: bad })).toEqual({ ok: false, reason: 'pin_format' });
    }
    expect(await hasTechVoicePin(database, techId)).toBe(false);
    expect(await setTechVoicePin(database, { technicianId: techId, pin: '4512' })).toEqual({ ok: true });
    const stored = await row();
    expect(stored.pin_hash).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    expect(stored.pin_hash).not.toContain('4512');
    // The same PIN set again gets a new salt.
    await setTechVoicePin(database, { technicianId: techId, pin: '4512' });
    expect((await row()).pin_hash).not.toBe(stored.pin_hash);
    expect(await check('4512')).toEqual({ ok: true });
  });

  test('no PIN on file refuses', async () => {
    expect(await check('4512')).toEqual({ ok: false, reason: 'no_pin' });
  });

  test('the fifth wrong try in a row locks for 15 minutes with one alert; the lock refuses even the right PIN', async () => {
    await setTechVoicePin(database, { technicianId: techId, pin: '4512' });
    for (let i = 1; i < MAX_FAILED_TRIES; i += 1) expect(await check('0000')).toEqual({ ok: false, reason: 'wrong_pin' });
    expect((await row()).failed_attempts).toBe(MAX_FAILED_TRIES - 1);
    expect(await check('9999')).toEqual({ ok: false, reason: 'locked_now' });
    expect(new Date((await row()).locked_until).getTime()).toBe(later(15).getTime());
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('system');
    expect(spec).toMatchObject({ area: 'System', severity: 'needs-you', who: 'person', link: '/admin/timetracking?tab=team' });
    expect(JSON.stringify([spec, opts])).not.toMatch(/4512|9999|0000/);
    expect(await check('4512', later(14))).toEqual({ ok: false, reason: 'locked' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    // Lapsed: the right PIN works and clears the count.
    expect(await check('4512', later(16))).toEqual({ ok: true });
    expect(await row()).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  test('a right PIN clears the count; a lapsed lock starts a fresh count; an admin reset clears a lock', async () => {
    await setTechVoicePin(database, { technicianId: techId, pin: '4512' });
    await check('0000');
    await check('0000');
    expect(await check('4512')).toEqual({ ok: true });
    expect((await row()).failed_attempts).toBe(0);
    for (let i = 0; i < MAX_FAILED_TRIES; i += 1) await check('0000');
    expect(await check('0000', later(16))).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(await row()).toMatchObject({ failed_attempts: 1, locked_until: null });
    for (let i = 1; i < MAX_FAILED_TRIES; i += 1) await check('0000', later(17));
    expect((await row()).locked_until).not.toBeNull();
    await setTechVoicePin(database, { technicianId: techId, pin: '7788' });
    expect(await check('7788', later(18))).toEqual({ ok: true });
    expect(await check('4512', later(18))).toEqual({ ok: false, reason: 'wrong_pin' });
  });

  test('two calls racing wrong tries both count (the row lock)', async () => {
    await setTechVoicePin(database, { technicianId: techId, pin: '4512' });
    await Promise.all([check('0000'), check('1111'), check('2222')]);
    expect((await row()).failed_attempts).toBe(3);
  });
});
