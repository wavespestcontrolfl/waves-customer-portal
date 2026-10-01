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

  test('gates that take a timestamp or mode are marked non-boolean', () => {
    expect(catalog.get('GATE_PEST_STRANDED_RECOVERY').boolean).toBe(false);
    expect(catalog.get('GATE_EMAIL_TEMPLATE_AUTOMATIONS').boolean).toBe(false);
    expect(catalog.get('GATE_SMS_OPERATIONAL_ACTIONS_SINCE').boolean).toBe(false);
  });
});
