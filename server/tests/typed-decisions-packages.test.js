const fs = require('fs');
const path = require('path');
const { PACKAGES, packageFor, packageHash } = require('../services/typed-decisions/packages');

const SNAPSHOT = path.join(__dirname, '..', 'fixtures', 'typed-decisions', 'package-hashes.json');

describe('typed-decision packages', () => {
  const ids = Object.keys(PACKAGES);

  test('ships the three foundation packages', () => {
    expect(ids.sort()).toEqual(['call_gate_checks.v1', 'call_judge.v2', 'sms_courtesy.v1', 'sms_reschedule.v1']);
  });

  test.each(ids)('%s: id is <capability>.v<version> and shape is complete', (id) => {
    const pkg = PACKAGES[id];
    expect(pkg.id).toBe(`${pkg.capability}.v${pkg.version}`);
    expect(Number.isInteger(pkg.version) && pkg.version >= 1).toBe(true);
    expect(pkg.description).toEqual(expect.any(String));
    expect(Array.isArray(pkg.stateShape) && pkg.stateShape.length).toBeTruthy();
    expect(pkg.thresholds).toEqual({ confident_low: 0.15, confident_high: 0.85 });
    expect(Object.keys(pkg.questions).length).toBeGreaterThan(0);
    for (const q of Object.values(pkg.questions)) {
      expect(['noul', 'choice', 'score']).toContain(q.type);
      expect(q.instructions).toEqual(expect.any(String));
    }
  });

  test('call_gate_checks.v1 asks one yes/no per dark call gate, over the same call state as call_judge', () => {
    const pkg = PACKAGES['call_gate_checks.v1'];
    expect(Object.keys(pkg.questions)).toEqual(['service_unclear', 'reschedule_committed', 'promise_open']);
    for (const q of Object.values(pkg.questions)) expect(q.type).toBe('noul');
    expect(pkg.stateShape).toEqual(PACKAGES['call_judge.v2'].stateShape);
  });

  test('call_judge.v2 asks the six agreed questions', () => {
    const qs = PACKAGES['call_judge.v2'].questions;
    expect(Object.keys(qs)).toEqual(['is_lead', 'is_spam', 'is_voicemail', 'appointment_agreed', 'quote_promised', 'complaint']);
    expect(qs.is_spam.criteria.false).toMatch(/never spam/);
    expect(PACKAGES['call_judge.v2'].stateShape).toEqual(['call_direction', 'duration_seconds', 'transcript']);
  });

  test('packages are deep-frozen: assignment throws in strict mode', () => {
    'use strict';
    const pkg = PACKAGES['call_judge.v2'];
    expect(() => { pkg.version = 2; }).toThrow(TypeError);
    expect(() => { pkg.questions.is_lead.instructions = 'x'; }).toThrow(TypeError);
    expect(() => { pkg.thresholds.confident_low = 0; }).toThrow(TypeError);
    expect(() => { pkg.stateShape.push('x'); }).toThrow(TypeError);
    expect(() => { PACKAGES.extra = {}; }).toThrow(TypeError);
  });

  test('packageFor looks up own ids only', () => {
    expect(packageFor('sms_courtesy.v1')).toBe(PACKAGES['sms_courtesy.v1']);
    expect(packageFor('nope.v1')).toBeNull();
    expect(packageFor('toString')).toBeNull();
  });

  test('packageHash is stable, hex sha256, ignores key order and description', () => {
    const pkg = PACKAGES['sms_reschedule.v1'];
    expect(packageHash(pkg)).toMatch(/^[0-9a-f]{64}$/);
    expect(packageHash(pkg)).toBe(packageHash(pkg));
    const reordered = { description: 'edited prose', thresholds: { confident_high: 0.85, confident_low: 0.15 }, stateShape: pkg.stateShape, questions: pkg.questions };
    expect(packageHash(reordered)).toBe(packageHash(pkg));
    const edited = { ...pkg, questions: { wants_visit_change: { ...pkg.questions.wants_visit_change, instructions: 'changed' } } };
    expect(packageHash(edited)).not.toBe(packageHash(pkg));
  });

  test('every published package matches the pinned hash snapshot (edit a published package = bump its version)', () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    expect(Object.keys(snapshot).sort()).toEqual(ids.slice().sort());
    for (const id of ids) expect({ id, hash: packageHash(PACKAGES[id]) }).toEqual({ id, hash: snapshot[id] });
  });
});

describe('decision providers', () => {
  const { DECISION_PROVIDERS, DEFAULT_DECISION_PROVIDER, DECISION_PROVIDER_LABELS, providerLabel } = require('../services/typed-decisions/packages');
  test('a closed set with typesafe as the default, each with the name reviewers see', () => {
    expect([...DECISION_PROVIDERS]).toEqual(['typesafe', 'cloudflare']);
    expect(DEFAULT_DECISION_PROVIDER).toBe('typesafe');
    expect(Object.keys(DECISION_PROVIDER_LABELS).sort()).toEqual([...DECISION_PROVIDERS].sort());
    expect(providerLabel('typesafe')).toBe('Jev');
    expect(providerLabel('cloudflare')).toBe('Clef');
    // rows from before the column, and anything unknown, read as the default: never an object key
    // provider is NOT NULL and registry-constrained: an unknown value is malformed data, never shown as Jev's
    expect(() => providerLabel(undefined)).toThrow(/unknown decision provider/);
    expect(() => providerLabel('constructor')).toThrow(/unknown decision provider/);
  });
});
