/**
 * The day re-plan writes with the initiator 'day_replan' (owner ruling 2026-11-03). It is an AUTOMATIC mover for
 * the night pass (a re-planned visit is not "person-placed"), and it is NOT the auto_dispatch signature that
 * move-limit.js counts toward the night pass's two-move cap.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { isPersonPlacedVisit } = require('../services/auto-dispatch/eligibility');
const moveLimit = require('../services/auto-dispatch/move-limit');
const { INITIATOR, REASON_CODE } = require('../services/day-replan/apply');

const T1 = '2026-11-04T08:40:00Z';

// An in-memory reschedule_log filtered by the predicates the query sends (copied from the eligibility suite).
function personPlacedDb(log) {
  const slotChanged = (r) => r.original_date !== r.new_date || r.original_window !== r.new_window;
  return (table) => {
    if (table !== 'reschedule_log') throw new Error(`unexpected table ${table}`);
    const preds = [];
    const chain = {
      where(key, value) { preds.push((r) => String(r[key]) === String(value)); return chain; },
      whereNotNull(key) { preds.push((r) => r[key] != null); return chain; },
      whereRaw(sql) {
        if (sql.startsWith('(original_date IS DISTINCT')) preds.push(slotChanged);
        else if (/created_at = \(SELECT max\(r2\.created_at\)/.test(sql)) {
          preds.push((r) => {
            const peers = log.filter((x) => x.scheduled_service_id === r.scheduled_service_id && x.new_date != null && slotChanged(x));
            return new Date(r.created_at).getTime() === Math.max(...peers.map((x) => new Date(x.created_at).getTime()));
          });
        } else throw new Error(`unexpected raw sql ${sql}`);
        return chain;
      },
      select: async () => log.filter((r) => preds.every((p) => p(r))),
    };
    return chain;
  };
}

// A reschedule_log that answers countAutoMoves with the rows its where() predicates keep.
function moveLogDb(log) {
  const preds = [];
  const chain = {
    whereIn(key, ids) { preds.push((r) => ids.map(String).includes(String(r[key]))); return chain; },
    where(key, value) { preds.push((r) => r[key] === value); return chain; },
    whereRaw() { return chain; },
    groupBy() { return chain; },
    count() { return chain; },
    select: async () => {
      const kept = log.filter((r) => preds.every((p) => p(r)));
      const counts = new Map();
      kept.forEach((r) => counts.set(r.scheduled_service_id, (counts.get(r.scheduled_service_id) || 0) + 1));
      return [...counts].map(([scheduled_service_id, moves]) => ({ scheduled_service_id, moves }));
    },
  };
  return () => chain;
}

describe('the initiator', () => {
  test('is day_replan, with a reason code the log column holds', () => {
    expect(INITIATOR).toBe('day_replan');
    expect(REASON_CODE).toBe('day_replan');
    expect(REASON_CODE.length).toBeLessThanOrEqual(30);
  });

  test('a visit the day re-plan moved is not person-placed, so the night pass may still optimize it', async () => {
    const visit = { id: 's1', scheduled_date: '2026-11-04', window_start: '09:00:00' };
    const moved = (initiated_by) => [{
      id: 'l1', scheduled_service_id: 's1', series_move_id: null, original_date: '2026-11-04', new_date: '2026-11-04',
      original_window: '13:00-14:00', new_window: '09:00-10:00', initiated_by, created_at: T1,
    }];
    expect(await isPersonPlacedVisit(visit, personPlacedDb(moved('day_replan')))).toEqual({ placed: false });
    // The control: an unknown mover still protects the visit, so the answer above is the list, not a blind spot.
    expect(await isPersonPlacedVisit(visit, personPlacedDb(moved('some_new_flow')))).toMatchObject({ placed: true });
  });

  test('is not counted toward the night pass\'s two-move cap', async () => {
    const row = (initiated_by, reason_code) => ({
      scheduled_service_id: 's1', initiated_by, reason_code, original_window: '13:00-14:00',
    });
    const log = [row('day_replan', 'day_replan'), row('day_replan', 'day_replan'), row('day_replan', 'day_replan')];
    expect((await moveLimit.countAutoMoves(moveLogDb(log), ['s1'])).get('s1')).toBeUndefined();
    // The night pass's own moves are still counted next to them.
    const mixed = [...log, row('auto_dispatch', 'auto_dispatch')];
    expect((await moveLimit.countAutoMoves(moveLogDb(mixed), ['s1'])).get('s1')).toBe(1);
  });
});

describe('booking_make_room (the make-room accept, owner 2026-11-09) is an automatic mover too', () => {
  test('a visit it moved is not person-placed', async () => {
    const visit = { id: 's1', scheduled_date: '2026-11-04', window_start: '10:00:00' };
    const log = [{
      id: 'l1', scheduled_service_id: 's1', series_move_id: null, original_date: '2026-11-04', new_date: '2026-11-04',
      original_window: '09:00-10:00', new_window: '10:00-11:00', initiated_by: 'booking_make_room', created_at: T1,
    }];
    expect(await isPersonPlacedVisit(visit, personPlacedDb(log))).toEqual({ placed: false });
  });

  test('the funnel\'s automatic-mover list and the proofreader\'s program list name it', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(read('services/sms-scheduling-funnel.js')).toMatch(/AUTOMATIC_MOVE_INITIATORS = Object\.freeze\(\[[^\]]*'booking_make_room'/);
    expect(read('services/auto-dispatch/proofreader/record.js')).toMatch(/PROGRAM_RESCHEDULERS = \[[^\]]*'booking_make_room'/);
  });
});

describe('every place that classifies a mover knows day_replan', () => {
  // These lists are not exported; the static guard keeps the three in step with eligibility.js.
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the funnel\'s automatic-mover list, the proofreader\'s program list and the rebooker\'s night-writer rule', () => {
    expect(read('services/sms-scheduling-funnel.js')).toMatch(/AUTOMATIC_MOVE_INITIATORS = Object\.freeze\(\[[^\]]*'day_replan'/);
    expect(read('services/auto-dispatch/proofreader/record.js')).toMatch(/PROGRAM_RESCHEDULERS = \[[^\]]*'day_replan'/);
    expect(read('services/rebooker.js')).toMatch(/const isNightWriter = \(initiatedBy\) => initiatedBy === 'auto_dispatch' \|\| initiatedBy === 'day_replan'/);
  });

  test('the rebooker applies the night-writer rule everywhere it used to name auto_dispatch alone', () => {
    // Everything but the one definition of the rule.
    const src = read('services/rebooker.js').replace(/const isNightWriter = .*\n/, '');
    expect(src).not.toMatch(/initiatedBy [!=]== 'auto_dispatch'/);
    expect(src).not.toMatch(/source === 'auto_dispatch'/);
    expect((src.match(/isNightWriter\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});
