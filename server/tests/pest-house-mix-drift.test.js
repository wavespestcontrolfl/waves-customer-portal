/**
 * The server copy of the pest house mix (procurement/pest-house-mix.js) must say
 * what the client close-out says (client/src/lib/pest-default-mix.js): the same
 * three products, the same amounts, the same identity patterns, and the same
 * answer on which visits get the mix. The client file is ESM with no imports, so
 * it is read as source and run here (the way other server tests read client files).
 */
const fs = require('fs');
const path = require('path');
const {
  PEST_HOUSE_MIX, NON_MIX_SERVICE_RE, RECURRING_GENERAL_PEST_RE, SEMIANNUAL_RE, KEYLESS_GENERAL_PEST_RE, GENERAL_PEST_KEYS, isPestHouseMixVisit, resolveHouseMix,
} = require('../services/procurement/pest-house-mix');

const clientSource = fs.readFileSync(path.join(__dirname, '../../client/src/lib/pest-default-mix.js'), 'utf8');
const client = new Function(`${clientSource.replace(/^export /gm, '')}; return { PEST_DEFAULT_MIX, isPestDefaultMixVisit, pestDefaultMixSelections, SEMIANNUAL_RE, KEYLESS_GENERAL_PEST_RE, GENERAL_PEST_KEYS };`)();

describe('pest house mix: server copy matches the client close-out', () => {
  test('same entries in the same order: pattern and amount', () => {
    expect(PEST_HOUSE_MIX.map((e) => [e.pattern.source, e.pattern.flags, e.totalAmount]))
      .toEqual(client.PEST_DEFAULT_MIX.map((e) => [e.pattern.source, e.pattern.flags, e.totalAmount]));
  });

  test('the visit rules are the same expressions', () => {
    const nonMix = /const NON_MIX_SERVICE_RE =\s*\n?\s*(\/.*\/i);/.exec(clientSource)[1];
    const recurring = /const RECURRING_GENERAL_PEST_RE =\s*\n?\s*(\/.*\/i);/.exec(clientSource)[1];
    expect(String(NON_MIX_SERVICE_RE)).toBe(nonMix);
    expect(String(RECURRING_GENERAL_PEST_RE)).toBe(recurring);
    // the no-card rule's own expressions and key set (client PR #8672)
    expect(String(SEMIANNUAL_RE)).toBe(String(client.SEMIANNUAL_RE));
    expect(String(KEYLESS_GENERAL_PEST_RE)).toBe(String(client.KEYLESS_GENERAL_PEST_RE));
    expect([...GENERAL_PEST_KEYS].sort()).toEqual([...client.GENERAL_PEST_KEYS].sort());
  });

  const NAMES = [
    'General Pest Control', 'Quarterly Pest Control', 'Bi-Monthly Pest Control', 'Monthly Pest Control Service',
    'Semi-Annual Pest Control', 'Recurring Pest Control', 'One-Time Pest Control Service', 'Pest Control Re-service',
    'Pest Callback', 'Pest Control Service', 'General Pest Control (Initial)', 'Initial Pest Cleanout',
    'Pest Inspection Service', 'Cockroach Control', 'Ant Control', 'Flea Control Service', 'Rodent Control',
    'Monthly Trap-Only Retainer Service', 'Lawn & Pest Combo', 'Quarterly Pest + Termite Bait Station',
    'Mosquito Control', 'Bee Wasp Removal', 'Tree & Shrub Care', 'Lawn Care Treatment', '',
    // semi-annual: with "pest", or as a whole bare name
    'Semi-Annual Service', 'Semiannual Visit', 'Semi Annual', 'Semi-Annual Lawn Service', 'Semi-Annual Termite Check',
    // keyless bare names
    'Re-Service', 'Reservice', 'Callback', 'Callback Visit', 'Recurring', 'Recurring Visit', 'Courtesy Visit', 'Re-Service Termite',
  ];

  test.each(NAMES)('"%s" gets the mix on the server exactly when it does on the client', (name) => {
    expect(isPestHouseMixVisit({ service_type: name })).toBe(client.isPestDefaultMixVisit({ serviceType: name }));
  });

  // The same visit through both rules, with a key and a callback flag.
  const KEYS = [...client.GENERAL_PEST_KEYS, 'lawn_inspection', 'termite_bait_check', 'tick_control', ''];
  const KEYED_NAMES = ['Semi-Annual Service', 'Semi-Annual Pest Control', 'Re-Service', 'Callback', 'Recurring', 'Courtesy Visit', 'Pest Control Service', 'Quarterly Service', 'Pest Visit'];
  test.each(KEYS.flatMap((key) => KEYED_NAMES.flatMap((name) => [[key, name, false], [key, name, true]])))(
    'key "%s", name "%s", callback %s: the server and the client agree',
    (key, name, callback) => {
      expect(isPestHouseMixVisit({ service_type: name, is_callback: callback, profile_service_key: key || null }))
        .toBe(client.isPestDefaultMixVisit({ serviceType: name, isCallback: callback, completionProfile: { serviceKey: key } }));
      expect(isPestHouseMixVisit({ service_type: name, is_callback: callback, service_key_snapshot: key || null }))
        .toBe(client.isPestDefaultMixVisit({ serviceType: name, isCallback: callback, service_key_snapshot: key }));
    },
  );

  test('the no-card answers: a general pest key counts a bare re-service; a bare re-service under another key, and a no-key courtesy visit, do not', () => {
    expect(isPestHouseMixVisit({ service_type: 'Re-Service', profile_service_key: 'pest_general_quarterly' })).toBe(true);
    expect(isPestHouseMixVisit({ service_type: 'Re-Service' })).toBe(true);
    expect(isPestHouseMixVisit({ service_type: 'Re-Service', profile_service_key: 'tick_control' })).toBe(false);
    expect(isPestHouseMixVisit({ service_type: 'Courtesy Visit', is_callback: true })).toBe(false);
    expect(isPestHouseMixVisit({ service_type: 'Semi-Annual Service' })).toBe(true);
    expect(isPestHouseMixVisit({ service_type: 'Semi-Annual Service', profile_service_key: 'tick_control' })).toBe(false);
    expect(isPestHouseMixVisit({ service_type: 'Quarterly Service', profile_service_key: 'lawn_inspection' })).toBe(false);
  });

  test('the re-service flag and the one-time catalog key agree too', () => {
    expect(isPestHouseMixVisit({ service_type: 'Pest Visit', is_callback: true }))
      .toBe(client.isPestDefaultMixVisit({ serviceType: 'Pest Visit', isCallback: true }));
    expect(isPestHouseMixVisit({ service_type: 'Pest Control Service', service_key_snapshot: 'one_time_pest_control' }))
      .toBe(client.isPestDefaultMixVisit({ serviceType: 'Pest Control Service', serviceKey: 'one_time_pest_control' }));
    expect(isPestHouseMixVisit({ service_type: 'Pest Control Service', service_key_snapshot: 'one_time_pest_control' })).toBe(true);
  });

  test('a bare label resolved to the one-time pest service by its profile gets the mix, as on the client; a typed form or bed bug visit does not', () => {
    expect(isPestHouseMixVisit({ service_type: 'Pest Control Service', profile_service_key: 'one_time_pest_control' }))
      .toBe(client.isPestDefaultMixVisit({ serviceType: 'Pest Control Service', completionProfile: { serviceKey: 'one_time_pest_control' } }));
    expect(isPestHouseMixVisit({ service_type: 'Pest Control Service', profile_service_key: 'one_time_pest_control' })).toBe(true);
    // the profile key wins over a stale snapshot, as in the close-out
    expect(isPestHouseMixVisit({ service_type: 'Pest Control Service', profile_service_key: 'something_else', service_key_snapshot: 'one_time_pest_control' })).toBe(false);
    // close-out surfaces that never open on the mix (SchedulePage isTypedFindings / isBedBugVisit)
    expect(isPestHouseMixVisit({ service_type: 'Quarterly Pest Control', typed_findings: true })).toBe(false);
    expect(isPestHouseMixVisit({ service_type: 'Quarterly Pest Control', profile_service_key: 'bed_bug_treatment' })).toBe(false);
  });

  test('the catalog identity pass picks the same rows as the client and flags what is missing', () => {
    const rows = [
      { id: 1, name: 'LESCO CrossCheck Plus', inventory_unit: 'gal' },
      { id: 2, name: 'Taurus SC', inventory_unit: 'fl_oz' },
      { id: 3, name: 'LESCO 90/10 Nonionic Surfactant', inventory_unit: 'fl_oz' },
      { id: 4, name: 'Taurus SC Extra', inventory_unit: 'gal' },
    ];
    const server = resolveHouseMix(rows);
    expect(server.matched.map((m) => m.product.id)).toEqual(client.pestDefaultMixSelections(rows).map((s) => s.product.id));
    expect(server.matched.map((m) => m.perVisit)).toEqual([1.6, 2.5 / 128, 0.25]);
    expect(resolveHouseMix([rows[0]]).missing.map((e) => e.key)).toEqual(['taurus_sc', 'surfactant']);
  });
});
