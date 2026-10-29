/**
 * Catalog contract (docs/admin-notifications.md, owner 2026-10-29 "ok go", step D1): every
 * TRIGGER_REGISTRY type declares how it closes. A `rule` is either
 *   { area, severity, who, doneWhen, closedBy }  code exists that marks the type's rows done, or
 *   { area, severity, who, expiryDays }          only the retention sweep closes it.
 * Deterministic, filesystem only, no DB. Watch mode refuses nothing; this test is the gate.
 */
const fs = require('fs');
const path = require('path');

const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
const { AREAS, SEVERITIES, WHO, DONE_WHEN } = require('../services/admin-alert-compose');

const REPO_ROOT = path.join(__dirname, '..', '..');
const entries = Object.entries(TRIGGER_REGISTRY);

// The 7 types that were `informational: true` before the rule existed (a fact, not work).
const FYI_KEYS = [
  'job_application_withdrawn', 'job_interview_booked', 'job_complete', 'newsletter_proof_approved',
  'one_tap_purchase_completed', 'payment_refunded', 'payment_succeeded',
];

describe('trigger registry catalog contract', () => {
  test.each(entries)('%s declares a valid rule', (key, trigger) => {
    const { rule } = trigger;
    expect(rule).toEqual(expect.any(Object));
    expect(AREAS).toContain(rule.area);
    expect(SEVERITIES).toContain(rule.severity);
    expect(WHO).toContain(rule.who);

    const closes = rule.doneWhen !== undefined || rule.closedBy !== undefined;
    const expires = rule.expiryDays !== undefined;
    expect(closes).not.toBe(expires); // exactly one of {doneWhen + closedBy} or {expiryDays}
    if (closes) {
      expect(rule.doneWhen).toMatch(DONE_WHEN);
      expect(fs.existsSync(path.join(REPO_ROOT, rule.closedBy))).toBe(true);
    } else {
      expect(rule.expiryDays).toBe(rule.severity === 'fyi' ? 7 : 30);
    }
    expect(Object.keys(rule).filter((k) => !['area', 'severity', 'who', 'doneWhen', 'closedBy', 'expiryDays'].includes(k))).toEqual([]);
    expect(trigger.informational).toBeUndefined(); // superseded by severity 'fyi'
  });

  test('an fyi rule closes by expiry only', () => {
    for (const [, trigger] of entries) {
      if (trigger.rule.severity === 'fyi') expect(trigger.rule.doneWhen).toBeUndefined();
    }
  });

  test('the fyi set is the 7 former informational types', () => {
    const fyi = entries.filter(([, t]) => t.rule.severity === 'fyi').map(([key]) => key).sort();
    expect(fyi).toEqual([...FYI_KEYS].sort());
  });
});
