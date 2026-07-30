/**
 * ContextAggregator v10 pure helpers — the egress guards the SMS facts
 * depend on (codex r1-r5, PR #3076). No DB.
 */
const { redactAccessCodes, customerSafeVisitNotes, lawnOverall } = require('../services/context-aggregator');

describe('redactAccessCodes — deterministic code masking', () => {
  test('keyword-before-value: "front gate code is 4545" masks the digits', () => {
    const out = redactAccessCodes('front gate code is 4545, use the side door');
    expect(out).not.toContain('4545');
    expect(out).toContain('[redacted]');
  });

  test('value-before-keyword (codex r5): "4545 is the gate code" masks too', () => {
    const out = redactAccessCodes('4545 is the gate code');
    expect(out).not.toContain('4545');
    expect(out).toContain('gate code');
  });

  test('alphanumeric credentials mask too (codex r6: "gate code BLUE")', () => {
    const out = redactAccessCodes('TECH ONLY: gate code BLUE 1234');
    expect(out).not.toContain('BLUE');
    expect(out).not.toContain('1234');
    expect(redactAccessCodes('door code Sunset22')).not.toContain('Sunset22');
    // no code noun in the segment → no alphanumeric pass, prose survives
    expect(redactAccessCodes('close the gate so the dog stays in')).toContain('dog stays in');
  });

  test('CVV/CVC values mask (codex r12)', () => {
    expect(redactAccessCodes('my CVV is 123 on the visa')).not.toMatch(/\b123\b/);
    expect(redactAccessCodes('security code 4321')).not.toContain('4321');
  });

  test('reverse multiword + password nouns + structured identifiers (codex r11)', () => {
    expect(redactAccessCodes('four five four five is the gate code')).not.toMatch(/four|five/);
    expect(redactAccessCodes('waves is the gate password')).not.toContain('waves');
    const ids = redactAccessCodes('my social is 123-45-6789 and card 4242 4242 4242 4242');
    expect(ids).not.toContain('123-45-6789');
    expect(ids).not.toContain('4242');
    // phone numbers and dates survive
    expect(redactAccessCodes('call me at 941-555-1234 about July 15')).toContain('941-555-1234');
  });

  test('multiword spoken credentials mask fully (codex r10)', () => {
    const out = redactAccessCodes('the gate code is four five four five');
    expect(out).not.toMatch(/four|five/);
  });

  test('quoted credentials mask (codex r9)', () => {
    expect(redactAccessCodes('gate password is "waves"')).not.toContain('waves');
  });

  test('password-labeled credentials mask (codex r8)', () => {
    expect(redactAccessCodes('gate password is waves')).not.toContain('waves');
    expect(redactAccessCodes('the wifi passphrase is sunshine1')).not.toContain('sunshine1');
  });

  test('lowercase credentials mask positionally (codex r7)', () => {
    expect(redactAccessCodes('gate code blue')).not.toContain('blue');
    expect(redactAccessCodes('the gate code is waves')).not.toContain('waves');
    expect(redactAccessCodes('door pin beach')).not.toContain('beach');
  });

  test('multiple codes in one string all mask; benign digits survive', () => {
    const out = redactAccessCodes('gate code 1234 and garage 5678; visit on July 15');
    expect(out).not.toContain('1234');
    expect(out).not.toContain('5678');
    expect(out).toContain('July 15');
  });
});

describe('customerSafeVisitNotes — the ONLY sanctioned tech-notes egress', () => {
  test('a valid WHAT WE DID / WHAT WE FOUND note returns the vetted body (codex r5 — did/found read discarded every note)', () => {
    const notes = 'WHAT WE DID:\nTreated the exterior perimeter and swept eaves.\nWHAT WE FOUND:\nLight ant activity near the lanai.';
    const out = customerSafeVisitNotes(notes);
    expect(out).toContain('Treated the exterior perimeter');
    expect(out).toContain('Light ant activity near the lanai');
  });

  test('free-text notes (access codes, candid remarks) return null — never raw', () => {
    expect(customerSafeVisitNotes('gate code 4545, customer grumpy, treated exterior')).toBeNull();
    expect(customerSafeVisitNotes('')).toBeNull();
    expect(customerSafeVisitNotes(null)).toBeNull();
  });
});

describe('lawnOverall — canonical scoring mirror', () => {
  test('modern rows trust the stored overall; legacy rows recompute 30/25/25/20', () => {
    expect(lawnOverall({ overall_score: 81, stress_damage: 70 })).toBe(81);
    // legacy row (no stress_damage): 30% density + 25% weed + 25% color + 20% worst(fungus, thatch)
    expect(lawnOverall({ turf_density: 80, weed_suppression: 60, color_health: 80, fungus_control: 50, thatch_level: 70 }))
      .toBe(Math.round(80 * 0.30 + 60 * 0.25 + 80 * 0.25 + 50 * 0.20));
  });
});
