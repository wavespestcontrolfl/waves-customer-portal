// GATE_DISPATCH_FIND_TIME_PANEL: the Dispatch "Find a time" button. Dark unless set; the admin
// schedule day view hands the flag to the page as `findTimePanel`.
const fs = require('fs');
const path = require('path');

function gateWith(value) {
  const saved = process.env.GATE_DISPATCH_FIND_TIME_PANEL;
  if (value === undefined) delete process.env.GATE_DISPATCH_FIND_TIME_PANEL;
  else process.env.GATE_DISPATCH_FIND_TIME_PANEL = value;
  try {
    let on;
    jest.isolateModules(() => { on = require('../config/feature-gates').isEnabled('dispatchFindTimePanel'); });
    return on;
  } finally {
    if (saved === undefined) delete process.env.GATE_DISPATCH_FIND_TIME_PANEL;
    else process.env.GATE_DISPATCH_FIND_TIME_PANEL = saved;
  }
}

describe('dispatchFindTimePanel gate', () => {
  it('is off unless set', () => {
    expect(gateWith(undefined)).toBe(false);
    expect(gateWith('')).toBe(false);
    expect(gateWith('false')).toBe(false);
  });

  it('is on for true, 1 and on', () => {
    expect(gateWith('true')).toBe(true);
    expect(gateWith('1')).toBe(true);
    expect(gateWith('ON')).toBe(true);
  });

  it('rides the admin schedule day view to the page', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(route).toContain("findTimePanel: isEnabled('dispatchFindTimePanel')");
  });
});
