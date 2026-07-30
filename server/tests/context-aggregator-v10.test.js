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
