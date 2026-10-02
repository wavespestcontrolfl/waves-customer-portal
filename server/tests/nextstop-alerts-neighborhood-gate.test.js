// The day feed's "Gate:" line falls back to the neighborhood directory only
// when the customer has no neighborhood gate code of their own.
const { compilePropertyAlerts } = require('../services/nextstop-alerts');

const gates = (alerts) => alerts.filter((a) => a.type === 'gate').map((a) => a.text);

describe('compilePropertyAlerts — neighborhood gate fallback', () => {
  test("the customer's own code wins; the directory is ignored", () => {
    const alerts = compilePropertyAlerts({
      prefs: { neighborhood_gate_code: '1111' },
      neighborhoodGate: [{ gate_label: 'Main gate', code: '2222', status: 'active' }],
    });
    expect(gates(alerts)).toEqual(['Gate: 1111']);
  });

  test('no code of their own: confirmed entries and flagged unconfirmed codes, labeled as the neighborhood', () => {
    const alerts = compilePropertyAlerts({
      prefs: { property_gate_code: '9999' },
      neighborhoodGate: [
        { gate_label: 'Main gate', code: '2566', status: 'active' },
        { gate_label: 'Main gate', code: '2556', status: 'needs_confirm' },
        { gate_label: 'Back gate', code: null, instructions: 'Call the guard house', status: 'active' },
      ],
    });
    expect(gates(alerts)).toEqual([
      'Gate: 2566 (neighborhood)',
      'Gate: 2556 (neighborhood, confirm on site)',
      'Back gate: Call the guard house (neighborhood)',
      'Yard: 9999',
    ]);
  });

  test('no directory entries (or not passed): byte-identical to before', () => {
    const prefs = { property_gate_code: '9999' };
    expect(compilePropertyAlerts({ prefs })).toEqual(compilePropertyAlerts({ prefs, neighborhoodGate: [] }));
    expect(gates(compilePropertyAlerts({ prefs }))).toEqual(['Yard: 9999']);
  });
});
