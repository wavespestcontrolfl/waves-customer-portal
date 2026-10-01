// GATE_FAST_COMPLETE_RECAP: the dark switch that lets the Fast Complete sheet
// send the customer completion text. Read once at load (the same pattern as
// GATE_RESERVICE_FAST_COMPLETE) and mirrored onto the schedule payload as
// `fastCompleteRecapEnabled` (server/routes/admin-schedule.js).
const fs = require('fs');
const path = require('path');

function loadGates(value) {
  const saved = process.env.GATE_FAST_COMPLETE_RECAP;
  if (value === undefined) delete process.env.GATE_FAST_COMPLETE_RECAP;
  else process.env.GATE_FAST_COMPLETE_RECAP = value;
  jest.resetModules();
  try {
    return require('../config/feature-gates');
  } finally {
    if (saved === undefined) delete process.env.GATE_FAST_COMPLETE_RECAP;
    else process.env.GATE_FAST_COMPLETE_RECAP = saved;
  }
}

describe('fastCompleteRecap gate', () => {
  test('ships dark: unset is off', () => {
    expect(loadGates(undefined).isEnabled('fastCompleteRecap')).toBe(false);
  });

  test('only an exact "true" turns it on', () => {
    expect(loadGates('true').isEnabled('fastCompleteRecap')).toBe(true);
    for (const value of ['1', 'on', 'TRUE', 'yes', 'false', '']) {
      expect(loadGates(value).isEnabled('fastCompleteRecap')).toBe(false);
    }
  });

  test('is a separate switch from the sheet routing gate', () => {
    const { gates } = loadGates('true');
    expect(gates.fastCompleteRecap).toBe(true);
    expect(Object.keys(gates)).toEqual(expect.arrayContaining(['fastCompleteRecap', 'reserviceFastComplete']));
  });

  // The route file needs a live DB to import, so the payload wiring is pinned
  // by source: every projection of the completion context carries the flag,
  // and the loader reads it from the gate registry (never a literal).
  test('every schedule payload that carries the routing gate carries the recap flag', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    const routing = count(/reserviceFastCompleteEnabled:/g);
    expect(routing).toBe(3);
    expect(count(/fastCompleteRecapEnabled:/g)).toBe(routing);
    expect(src).toContain("fastCompleteRecapEnabled: require('../config/feature-gates').isEnabled('fastCompleteRecap')");
    expect(count(/fastCompleteRecapEnabled: projectCompletionContext\.fastCompleteRecapEnabled === true/g)).toBe(2);
  });
});
