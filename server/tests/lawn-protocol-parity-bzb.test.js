// Guards the Bermuda/Zoysia/Bahia operating-layer parity seed
// (20260630000001). Runs the migration's up() against a mock knex (no DB) and
// asserts the row shapes the plan/approval engines depend on.
const mig = require('../models/migrations/20260630000001_lawn_protocol_parity_bzb.js');

function runMigration() {
  const inserts = { lawn_protocols: [], lawn_protocol_windows: [], lawn_protocol_gates: [] };
  const table = (name) => ({
    where: () => table(name),
    whereIn: () => table(name),
    first: async () => null,
    select: async () => [],
    del: async () => 0,
    insert(row) {
      return {
        returning: async () => {
          const id = `${name}-${inserts[name].length + 1}`;
          inserts[name].push({ ...row, id });
          return [{ id }];
        },
        then: (res, rej) => {
          inserts[name].push(row);
          return Promise.resolve([1]).then(res, rej);
        },
      };
    },
  });
  const knex = (name) => table(name);
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW()' };
  return mig.up(knex).then(() => inserts);
}

const SHARED_GATES = ['sarasota_blackout', 'north_port_blackout', 'manatee_blackout', 'valid_calibration_required', 'celsius_annual_rate', 'speedzone_heat_gate'];

describe('lawn protocol parity (Bermuda/Zoysia/Bahia) seed', () => {
  let inserts;
  beforeAll(async () => { inserts = await runMigration(); });

  test('seeds three active protocols, one per turf track', () => {
    const P = inserts.lawn_protocols;
    expect(P).toHaveLength(3);
    expect(P.map((p) => p.grass_track).sort()).toEqual(['bahia', 'bermuda', 'zoysia']);
    P.forEach((p) => {
      expect(p.status).toBe('active');
      expect(p.region).toBe('swfl');
      expect(p.protocol_key).toMatch(/^swfl_(bermuda|zoysia|bahia)_10_10$/);
    });
  });

  test('each protocol has 12 unique windows, each with >=2 required tasks', () => {
    const P = inserts.lawn_protocols;
    P.forEach((p) => {
      const wins = inserts.lawn_protocol_windows.filter((w) => w.lawn_protocol_id === p.id);
      expect(wins).toHaveLength(12);
      expect(new Set(wins.map((w) => w.window_key)).size).toBe(12);
      wins.forEach((w) => {
        const tasks = JSON.parse(w.required_tasks);
        expect(tasks.length).toBeGreaterThanOrEqual(2);
        expect(typeof w.title).toBe('string');
        expect(typeof w.visit_type).toBe('string');
        JSON.parse(w.assessment_bridge); // valid JSON
      });
    });
  });

  test('every turf carries the shared ordinance + calibration + Celsius + SpeedZone-heat gates', () => {
    const P = inserts.lawn_protocols;
    P.forEach((p) => {
      const gateKeys = new Set(inserts.lawn_protocol_gates.filter((g) => g.lawn_protocol_id === p.id).map((g) => g.gate_key));
      SHARED_GATES.forEach((k) => expect(gateKeys.has(k)).toBe(true));
    });
  });

  test('blackout months (Jun/Jul/Sep) require blackout_zero_np on every turf', () => {
    inserts.lawn_protocol_windows
      .filter((w) => ['Jun', 'Jul', 'Sep'].includes(w.month))
      .forEach((w) => expect(JSON.parse(w.required_tasks)).toContain('blackout_zero_np'));
  });

  test('turf-specific product-restriction gates are present', () => {
    const gatesFor = (track) => {
      const proto = inserts.lawn_protocols.find((p) => p.grass_track === track);
      return new Set(inserts.lawn_protocol_gates.filter((g) => g.lawn_protocol_id === proto.id).map((g) => g.gate_key));
    };
    expect(gatesFor('bermuda').has('no_atrazine_bermuda')).toBe(true);
    expect(gatesFor('zoysia').has('no_atrazine_zoysia')).toBe(true);
    expect(gatesFor('zoysia').has('no_anuew_zoysia')).toBe(true);
    expect(gatesFor('bahia').has('no_pgr_bahia')).toBe(true);
  });

  test('all gate logic is valid JSON and block severity', () => {
    inserts.lawn_protocol_gates.forEach((g) => {
      expect(() => JSON.parse(g.logic)).not.toThrow();
      expect(g.severity).toBe('block');
    });
  });
});
