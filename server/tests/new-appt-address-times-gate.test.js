// GATE_NEW_APPT_ADDRESS_TIMES: New Appointment's time box answers on a new caller's picked
// address alone. Dark unless set; the admin schedule day view hands the flag to Dispatch as
// `addressFirstTimes`, which passes it to the modal.
const fs = require('fs');
const path = require('path');

function gateWith(value) {
  const saved = process.env.GATE_NEW_APPT_ADDRESS_TIMES;
  if (value === undefined) delete process.env.GATE_NEW_APPT_ADDRESS_TIMES;
  else process.env.GATE_NEW_APPT_ADDRESS_TIMES = value;
  try {
    let on;
    jest.isolateModules(() => { on = require('../config/feature-gates').isEnabled('newApptAddressTimes'); });
    return on;
  } finally {
    if (saved === undefined) delete process.env.GATE_NEW_APPT_ADDRESS_TIMES;
    else process.env.GATE_NEW_APPT_ADDRESS_TIMES = saved;
  }
}

describe('newApptAddressTimes gate', () => {
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

  it('rides the admin schedule day view to the page, and the retired drawer gate is gone', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(route).toContain("addressFirstTimes: isEnabled('newApptAddressTimes')");
    expect(route).not.toContain('dispatchFindTimePanel');
    const gates = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(gates).not.toContain('GATE_DISPATCH_FIND_TIME_PANEL');
  });
});
