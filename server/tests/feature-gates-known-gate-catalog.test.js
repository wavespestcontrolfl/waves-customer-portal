/**
 * knownGateCatalog (server/config/feature-gates.js) feeds the Intelligence Bar's
 * set_railway_gate: a name outside it is refused, so a typo can never create a
 * Railway variable.
 */
const { knownGateCatalog } = require('../config/feature-gates');

describe('knownGateCatalog', () => {
  const catalog = knownGateCatalog();

  test('lists the gates the file documents and registers', () => {
    for (const name of ['GATE_STAMPED_ZERO_FREE', 'GATE_TWILIO_SMS', 'GATE_PORTAL_ACTIVITY', 'GATE_PHOTO_ID_V2']) {
      expect(catalog.has(name)).toBe(true);
    }
  });

  test('every entry is a well-formed GATE_ name', () => {
    for (const [name, entry] of catalog) {
      expect(name).toMatch(/^GATE_[A-Z0-9_]*[A-Z0-9]$/);
      expect(entry.name).toBe(name);
      expect(typeof entry.boolean).toBe('boolean');
    }
  });

  test('carries the header description for a documented gate', () => {
    expect(catalog.get('GATE_STAMPED_ZERO_FREE').description).toMatch(/bills nothing/);
  });

  test('does not know made-up names, and keeps a retired gate out', () => {
    expect(catalog.has('GATE_NOT_A_REAL_GATE_ZZZ')).toBe(false);
    expect(catalog.has('GATE_ONE_TIME_WELCOME_EMAIL')).toBe(false);
  });

  test('gates that take a timestamp or mode are never classified as on/off', () => {
    for (const name of [
      'GATE_PEST_STRANDED_RECOVERY', 'GATE_EMAIL_TEMPLATE_AUTOMATIONS', 'GATE_SMS_OPERATIONAL_ACTIONS_SINCE',
      // off | shadow | auto, and shadow | true — read only through their mode lists in this file.
      'GATE_REVIEW_AUTO_REPLY', 'GATE_SMS_SPAM_CLASSIFIER',
    ]) {
      expect(catalog.get(name).kind).toBe('mode');
      expect(catalog.get(name).boolean).toBe(false);
    }
  });

  test('plain on/off gates are classified boolean; a gate only named in a comment is unverified', () => {
    for (const name of ['GATE_STAMPED_ZERO_FREE', 'GATE_TWILIO_SMS', 'GATE_PORTAL_ACTIVITY']) {
      expect(catalog.get(name).kind).toBe('boolean');
    }
    const unverified = [...catalog.values()].filter((e) => e.kind === 'unverified');
    expect(unverified.length).toBeGreaterThan(0);
    for (const e of unverified) expect(e.boolean).toBe(false);
  });
});
