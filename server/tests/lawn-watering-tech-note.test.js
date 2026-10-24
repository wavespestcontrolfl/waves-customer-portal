// Owner 2026-10-24: "I dont want an office alert for this". A lawn visit whose
// products clash (water_in_conflict, same_day_too_late) gets a Today-screen
// note for the visit's technician; the office alert is only the fallback.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { sendLawnWateringSms } = require('../services/service-report/lawn-watering-sms');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const ENV_KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_EVERY_VISIT'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = 'true';
  jest.clearAllMocks();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const CONFLICT = {
  reason: 'water_in_conflict',
  products: ['Dylox 6.2 G', 'Anuew EZ'],
  waterInProducts: ['Dylox 6.2 G'],
  holdProducts: ['Anuew EZ'],
};
const TOO_LATE = { reason: 'same_day_too_late', products: ['Dylox 6.2 G'], waterInProducts: ['Dylox 6.2 G'] };

// A database whose transaction claims the visit's marker (`claimed` rows) and
// rolls back when the body throws; `updates` records each claim attempt.
function fakeDb({ claimed = 1 } = {}) {
  const updates = [];
  const trx = (table) => {
    const query = { where: () => query, whereRaw: () => query, update: async (row) => { updates.push({ table, row }); return claimed; } };
    return query;
  };
  trx.raw = (sql, bindings) => ({ sql, bindings });
  return { transaction: async (body) => body(trx), updates, trx };
}
const claimedMarker = (db) => JSON.parse(db.updates[0].row.structured_notes.bindings[0]);

function harness({ noClaim, notes = {}, svc = {}, sendTechNotification, claimed = 1 } = {}) {
  const mergeNotes = jest.fn(async () => {});
  const db = fakeDb({ claimed });
  const raiseAdminAlert = jest.fn(async (category, spec) => ({ id: 'n-1', composed: composeAdminAlert(spec) }));
  const tech = sendTechNotification || jest.fn(async () => true);
  const state = {
    record: { id: 'rec-1', structured_notes: {} },
    svc: {
      id: 'svc-1', customer_id: 'cust-1', cust_phone: '+19415550100', technician_id: 'tech-1',
      first_name: 'Pat', last_name: 'Sample', service_address_line1: '1 Example Way', service_address_city: 'Venice',
      ...svc,
    },
    notes,
    isBackfill: false,
    deliveryMode: 'auto_send',
    internalOnly: false,
    completionTextRequested: true,
    noClaim,
  };
  const deps = {
    db, sendCustomerMessage: jest.fn(), getTemplate: jest.fn(), mergeNotes, raiseAdminAlert,
    sendTechNotification: tech, throwIfDeliveryUnverified: (r) => r,
  };
  return { state, deps, mergeNotes, raiseAdminAlert, tech, db };
}

describe('lawn watering tech note', () => {
  test('water_in_conflict: one card to the visit technician with the exact copy, no office alert', async () => {
    const h = harness({ noClaim: CONFLICT });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'tech_noted_no_instruction' });
    expect(h.tech).toHaveBeenCalledTimes(1);
    expect(h.tech.mock.calls[0][2]).toEqual({ knex: h.db.trx });
    expect(h.tech).toHaveBeenCalledWith('tech-1', {
      type: 'lawn_watering_tech_note',
      message: 'Do not water now: Anuew EZ needs time with no water. Dylox 6.2 G needs watering in, and no time is left today for both, so the customer got no watering text. Ask the customer to water Dylox 6.2 G in as soon as the no-water time for Anuew EZ is over. Next time, water Dylox 6.2 G in before you apply Anuew EZ.',
      payload: {
        headline: 'Do not water this lawn now',
        customer_name: 'Pat Sample',
        address: '1 Example Way, Venice',
        service_id: 'svc-1',
        reason: 'water_in_conflict',
      },
    }, expect.anything());
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
    expect(h.deps.sendCustomerMessage).not.toHaveBeenCalled();
    // The marker is claimed in the card's own transaction, never by a separate write.
    expect(h.mergeNotes).not.toHaveBeenCalled();
    expect(h.db.updates).toHaveLength(1);
    expect(h.db.updates[0].table).toBe('service_records');
    expect(claimedMarker(h.db)).toEqual({
      lawnWateringSmsStatus: 'skipped_no_instruction',
      lawnWateringNoClaimReason: 'water_in_conflict',
      lawnWateringTechNoteAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(h.state.notes.lawnWateringTechNoteAt).toBeTruthy();
  });

  test('same_day_too_late: the exact copy', async () => {
    const h = harness({ noClaim: TOO_LATE });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'tech_noted_no_instruction' });
    const [, card] = h.tech.mock.calls[0];
    expect(card.message).toBe('Dylox 6.2 G must be watered in today, and this visit ended too late for the customer to run a full watering. Water it in on site before you leave.');
    expect(card.payload.reason).toBe('same_day_too_late');
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('without the optional fields: first product, and "another product on this visit"', async () => {
    const h = harness({ noClaim: { reason: 'water_in_conflict', products: ['Dylox 6.2 G', 'Anuew EZ'] } });
    await sendLawnWateringSms(h.state, h.deps);
    expect(h.tech.mock.calls[0][1].message).toBe('Do not water now: another product on this visit needs time with no water. Dylox 6.2 G needs watering in, and no time is left today for both, so the customer got no watering text. Ask the customer to water Dylox 6.2 G in as soon as the no-water time for another product on this visit is over. Next time, water Dylox 6.2 G in before you apply another product on this visit.');
  });

  test('several names join with " and "; the payload leaves out a missing address', async () => {
    const h = harness({
      noClaim: { ...CONFLICT, waterInProducts: ['Dylox 6.2 G', 'Merit 0.5 G'], holdProducts: ['Anuew EZ', 'Scimitar CS'] },
      svc: { service_address_line1: null },
    });
    await sendLawnWateringSms(h.state, h.deps);
    const [, card] = h.tech.mock.calls[0];
    expect(card.message).toContain('Do not water now: Anuew EZ and Scimitar CS need time with no water. Dylox 6.2 G and Merit 0.5 G need watering in,');
    expect(card.payload).not.toHaveProperty('address');
  });

  test.each([
    ['no technician on the visit', { technician_id: null }, undefined],
    ['the card insert failing', {}, jest.fn(async () => false)],
    ['the card call throwing', {}, jest.fn(async () => { throw new Error('boom'); })],
  ])('falls back to today\'s office alert on %s', async (_, svc, sendTechNotification) => {
    const h = harness({ noClaim: CONFLICT, svc, sendTechNotification });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'alerted_no_instruction' });
    expect(h.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [, spec, opts] = h.raiseAdminAlert.mock.calls[0];
    expect(spec.why).toMatch(/need opposite watering/);
    expect(opts.dedupeKey).toBe('lawn-watering-no-instruction:rec-1');
    expect(opts.detail).toContain('ask for watering that cannot be done together, so this lawn visit');
    expect(opts.detail).not.toContain('a hold the label requires');
    expect(h.mergeNotes).toHaveBeenCalledWith('rec-1', { lawnWateringSmsStatus: 'skipped_no_instruction', lawnWateringNoClaimReason: 'water_in_conflict' });
    if (!svc.technician_id && 'technician_id' in svc) expect(h.tech).not.toHaveBeenCalled();
  });

  test('a visit that already carries lawnWateringTechNoteAt gets no second card and no alert', async () => {
    const h = harness({ noClaim: CONFLICT, notes: { lawnWateringTechNoteAt: '2026-10-24T20:00:00.000Z' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'tech_noted_no_instruction' });
    expect(h.tech).not.toHaveBeenCalled();
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
    expect(h.mergeNotes).not.toHaveBeenCalled();
  });

  test('another caller claimed the visit first: no second card and no alert', async () => {
    const h = harness({ noClaim: CONFLICT, claimed: 0 });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'tech_noted_no_instruction' });
    expect(h.tech).not.toHaveBeenCalled();
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
    expect(h.state.notes.lawnWateringTechNoteAt).toBeUndefined();
  });

  test.each([
    ['unruled_product', ['Medallion SC']],
    ['unchecked_rules', ['LESCO 24-0-10']],
    ['inputs_unreadable', []],
    ['report_not_built', []],
  ])('%s still raises the office alert and sends no card', async (reason, products) => {
    const h = harness({ noClaim: { reason, products } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'alerted_no_instruction' });
    expect(h.raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(h.tech).not.toHaveBeenCalled();
  });

  test('same_day_too_late alert copy says "that day", not "before 11 PM"', async () => {
    const h = harness({ noClaim: TOO_LATE, svc: { technician_id: null } });
    await sendLawnWateringSms(h.state, h.deps);
    const [, , opts] = h.raiseAdminAlert.mock.calls[0];
    expect(opts.detail).toContain('the visit ended too late to fit a run that day');
    expect(opts.detail).not.toContain('11 PM');
  });
});

// The real producer: the label ladder's no-claim names which product to water in.
describe('the note from a real clash', () => {
  const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
  const { techNoteMessage } = require('../services/service-report/lawn-watering-tech-note');
  const DYLOX = { name: 'Dylox 6.2 G', rule: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, water_in_same_day: true, source: 'owner' } };
  const ANUEW = { name: 'Anuew EZ', rule: { mode: 'hold', hold_hours: 4, source: 'label' } };

  test('Dylox with Anuew EZ after 5 PM: do not water now, water in once the no-water time is over', () => {
    // Tue 6 PM ET: Anuew's 4 hours end at 10 PM, too late for a full run before midnight.
    const ins = buildWateringInstruction({ rules: [DYLOX, ANUEW], completedAt: '2026-10-27T22:00:00Z', plainWhenNoSetup: true, labelFirst: true });
    expect(ins.state).toBeNull();
    expect(techNoteMessage(ins.noClaim)).toBe('Do not water now: Anuew EZ needs time with no water. Dylox 6.2 G needs watering in, and no time is left today for both, so the customer got no watering text. Ask the customer to water Dylox 6.2 G in as soon as the no-water time for Anuew EZ is over. Next time, water Dylox 6.2 G in before you apply Anuew EZ.');
  });

  test('Dylox alone after 9 PM: water it in on site', () => {
    const ins = buildWateringInstruction({ rules: [DYLOX], completedAt: '2026-10-28T01:30:00Z', plainWhenNoSetup: true, labelFirst: true });
    expect(techNoteMessage(ins.noClaim)).toBe('Dylox 6.2 G must be watered in today, and this visit ended too late for the customer to run a full watering. Water it in on site before you leave.');
  });
});
