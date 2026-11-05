/**
 * Caller callback late bell (owner 2026-11-04, option A), the pure part: the due time (2 business hours after the
 * call, 8 AM to 8 PM Eastern, closed days skipped; a named deadline wins; a named floor moves where the 2 hours
 * start), the bell copy through the real composeAdminAlert (a normal name, a long name, no name), and the three
 * guards that return before any read. The SQL side runs in caller-callback-bell-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('crypto');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { OPEN_CALENDAR } = require('../services/followup-sla-watcher');
const { runCallerCallbackBell, _private } = require('../services/caller-callback-bell');

const { dueOf, specFor, detailFor } = _private;

// Eastern time is UTC-5 after the 2026-11-01 clock change, so 10:00 AM Eastern is 15:00Z.
const WED_10AM = new Date('2026-11-04T15:00:00Z');
const WED_758PM = new Date('2026-11-05T00:58:00Z');
const promise = (over = {}) => ({ due_at: null, due_type: null, description: 'We will call you right back', ...over });

describe('due time', () => {
  test('a 10:00 AM call is due at 12:00 PM', () => {
    const due = dueOf(promise(), WED_10AM, OPEN_CALENDAR);
    expect(due.at.toISOString()).toBe('2026-11-04T17:00:00.000Z');
    expect(due.basis).toBe('afterCall');
  });

  test('a 7:58 PM call is due at 9:58 AM the next day', () => {
    expect(dueOf(promise(), WED_758PM, OPEN_CALENDAR).at.toISOString()).toBe('2026-11-05T14:58:00.000Z');
  });

  test('a named deadline is the due time, with no 2 hours added', () => {
    const due = dueOf(promise({ due_at: '2026-11-04T21:00:00Z', due_type: 'deadline' }), WED_10AM, OPEN_CALENDAR);
    expect(due.at.toISOString()).toBe('2026-11-04T21:00:00.000Z');
    expect(due.basis).toBe('named');
  });

  test('a named floor (or an untyped time) after the call is where the 2 business hours start', () => {
    for (const due_type of ['floor', null]) {
      const due = dueOf(promise({ due_at: '2026-11-05T14:00:00Z', due_type }), WED_10AM, OPEN_CALENDAR);
      expect(due.at.toISOString()).toBe('2026-11-05T16:00:00.000Z'); // 9 AM + 2 hours = 11 AM Eastern
      expect(due.basis).toBe('afterNamed');
    }
  });

  test('a named time at or before the call end is ignored, even a deadline', () => {
    const due = dueOf(promise({ due_at: '2026-11-04T14:00:00Z', due_type: 'deadline' }), WED_10AM, OPEN_CALENDAR);
    expect(due.at.toISOString()).toBe('2026-11-04T17:00:00.000Z');
    expect(due.basis).toBe('afterCall');
  });

  test('a closed day does not count as office time', () => {
    const closed = { ...OPEN_CALENDAR, closed: new Set(['2026-11-05']) };
    // Wednesday 7:58 PM: 2 minutes tonight, Thursday is closed, 118 minutes on Friday from 8:00 AM = 9:58 AM.
    expect(dueOf(promise(), WED_758PM, closed).at.toISOString()).toBe('2026-11-06T14:58:00.000Z');
  });
});

describe('bell copy', () => {
  const calledAt = new Date('2026-11-05T00:52:00Z'); // Wed Nov 4, 7:52 PM Eastern
  const base = { last4: '0100', leadId: randomUUID(), callLogId: randomUUID(), calledAt };

  test('a normal name leads the headline and the why is one plain sentence in the allowed length', () => {
    const alert = composeAdminAlert(specFor({ ...base, name: 'Pat Synthetic' }));
    expect(alert.headline).toBe('Leads — call Pat Synthetic back');
    expect(alert.why).toBe('Said on the Wed, Nov 4, 7:52 PM call they would call back; no call or text since.');
    expect(alert.link).toBe(`/admin/leads?lead=${base.leadId}`);
    expect(alert.metadata).toMatchObject({
      area: 'Leads', severity: 'needs-you', who: 'person', doneWhen: 'lead_contacted', subject: { type: 'lead', id: base.leadId },
      buttons: { kind: 'call_back' },
    });
    expect(alert.metadata.buttons.items[0].args).toEqual({ callLogId: base.callLogId });
  });

  test('a 45-character name drops "back" to fit; a longer one is cut at a word with an ellipsis', () => {
    const long = composeAdminAlert(specFor({ ...base, name: 'Bartholomew Alexander Montgomery-Fitzgerald III' }));
    expect(long.headline).toBe('Leads — call Bartholomew Alexander Montgomery-Fitzgerald III');
    const longer = composeAdminAlert(specFor({ ...base, name: 'Bartholomew Alexander Montgomery-Fitzgerald Wellington Thornbury III' }));
    expect(longer.headline.length).toBeLessThanOrEqual(60);
    expect(longer.headline).toMatch(/^Leads — call Bartholomew .*…$/);
  });

  test('with no name the bell names the number ending', () => {
    expect(composeAdminAlert(specFor({ ...base, name: null })).headline).toBe('Leads — call the caller ending 0100 back');
    expect(composeAdminAlert(specFor({ ...base, name: null, last4: '' })).headline).toBe('Leads — call the caller back');
  });

  test('the detail states the promise, the call, the due time and why it is due', () => {
    const lead = { service_interest: 'Quarterly pest control' };
    const due = dueOf(promise(), new Date('2026-11-05T00:52:00Z'), OPEN_CALENDAR);
    const detail = detailFor({ promise: promise({ description: 'Call me at 941-555-0100 about the quote' }), calledAt, due, lead });
    expect(detail).toContain('Said on the Wed, Nov 4, 7:52 PM call.');
    expect(detail).toContain('Callback was due Thu, Nov 5, 9:52 AM (2 business hours after the call).');
    expect(detail).toContain('Interested in: Quarterly pest control');
    expect(detail).not.toContain('941-555-0100');
    const named = dueOf(promise({ due_at: '2026-11-05T21:00:00Z', due_type: 'deadline' }), calledAt, OPEN_CALENDAR);
    expect(detailFor({ promise: promise(), calledAt, due: named, lead: {} })).toContain('Callback was due Thu, Nov 5, 4:00 PM (the time they named).');
  });
});

describe('guards that return before any read', () => {
  const noDatabase = () => { throw new Error('the database must not be read'); };

  test('gate off', async () => {
    await expect(runCallerCallbackBell({ database: noDatabase, gateEnabled: false })).resolves.toEqual({ skipped: 'disabled' });
    await expect(runCallerCallbackBell({ database: noDatabase })).resolves.toEqual({ skipped: 'disabled' });
  });

  test('call commitments off, and the alert-episodes switch off', async () => {
    await expect(runCallerCallbackBell({ database: noDatabase, gateEnabled: true })).resolves.toEqual({ skipped: 'commitments_off' });

    process.env.GATE_CALL_COMMITMENTS = 'true';
    process.env.ALERT_EPISODES = 'off';
    try {
      // feature-gates reads GATE_CALL_COMMITMENTS once, when it loads, so load the whole chain fresh.
      jest.resetModules();
      const isolated = require('../services/caller-callback-bell');
      await expect(isolated.runCallerCallbackBell({ database: noDatabase, gateEnabled: true })).resolves.toEqual({ skipped: 'episodes_off' });
    } finally {
      delete process.env.GATE_CALL_COMMITMENTS;
      delete process.env.ALERT_EPISODES;
    }
  });
});
