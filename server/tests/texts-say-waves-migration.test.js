/**
 * 20261105000000_texts_say_waves: the wording itself (owner 2026-11-04, "for all
 * texts, instead of it's Waves Pest Control., just use waves"). DB-backed up() /
 * down() behavior (base row + variant swap, admin-edit safety, audit tracking,
 * tracked-only revert) is in texts-say-waves-migration-postgres.test.js.
 */
const migration = require('../models/migrations/20261105000000_texts_say_waves');
const SEEDED = require('../models/migrations/20260920000001_job_applications_interview_comms')._TEMPLATES;

const { _SWAPS: SWAPS } = migration;
const placeholders = (s) => (s.match(/\{[a-z_]+\}/g) || []).sort();

test('swaps exactly the four recruiting texts, each from its seeded body', () => {
  expect(SWAPS.map(([key]) => key)).toEqual(['job_application_received', 'job_application_received_es', 'job_interview_invite', 'job_interview_invite_es']);
  for (const [key, before] of SWAPS) expect(before).toBe(SEEDED.find((t) => t.template_key === key).body);
});

test('each new body says "Waves", never "Waves Pest Control", and keeps its placeholders and STOP line', () => {
  for (const [, before, after] of SWAPS) {
    expect(after).toBe(before.replace('Waves Pest Control', 'Waves'));
    expect(after).not.toMatch(/Waves Pest Control/);
    expect(placeholders(after)).toEqual(placeholders(before));
    expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
  }
  expect(SWAPS.find(([key]) => key === 'job_interview_invite')[2])
    .toBe('Hi {first_name}, Waves would like to interview you. Pick a phone or in-person time that works for you: {interview_url}');
});

test('the audit actions fit audit_log.action (varchar 96)', () => {
  expect(migration._AUDIT_ACTION.length).toBeLessThanOrEqual(96);
  expect(migration._AUDIT_ROLLBACK_ACTION.length).toBeLessThanOrEqual(96);
});
