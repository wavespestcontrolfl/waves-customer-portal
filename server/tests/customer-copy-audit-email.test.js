const migration = require('../models/migrations/20260926120100_customer_copy_audit_email');
// Active versions of the patched templates as published in production on
// 2026-09-26 (template content only).
const baseline = require('./fixtures/customer-copy-audit-email-baseline.json');

const byKey = Object.fromEntries(baseline.map((t) => [t.template_key, t]));
const patched = Object.fromEntries(migration.KEYS.map((key) => {
  const { version, misses } = migration.applyPatches(byKey[key], migration.PATCHES.filter((p) => p.key === key));
  return [key, { version, misses }];
}));
const textOf = ({ subject, preview_text: preview, blocks }) => [
  subject, preview,
  ...blocks.flatMap((b) => [b.content, ...(b.items || []), ...(b.rows || []).map((r) => r.value)]),
].filter((s) => typeof s === 'string').join('\n');

test('the fixture covers every patched template', () => {
  expect(Object.keys(byKey).sort()).toEqual([...migration.KEYS].sort());
});

test.each(migration.KEYS)('%s: every patch matches the live version exactly once', (key) => {
  expect(patched[key].misses).toEqual([]);
});

test.each(migration.KEYS)('%s: placeholders are unchanged and no block is added or dropped', (key) => {
  const vars = (s) => [...s.matchAll(/\{\{\s*\w+\s*\}\}/g)].map((m) => m[0]).sort();
  expect(vars(textOf(patched[key].version))).toEqual(vars(textOf(byKey[key])));
  expect(patched[key].version.blocks.map((b) => b.type)).toEqual(byKey[key].blocks.map((b) => b.type));
});

test('a patch that no longer matches reports a miss instead of half-applying', () => {
  const edited = { ...byKey['billing_late_payment_60_day'], blocks: [{ type: 'paragraph', content: 'Administrator copy' }] };
  const { misses } = migration.applyPatches(edited, migration.PATCHES.filter((p) => p.key === 'billing_late_payment_60_day'));
  expect(misses).toHaveLength(2);
});

test('compliance idiom holds in every patched template', () => {
  for (const key of migration.KEYS) {
    const text = textOf(patched[key].version);
    expect(text).not.toMatch(/\bsafe(ly)?\b/i);
    expect(text).not.toMatch(/EPA[- ]approved/i);
    expect(text).not.toMatch(/Waves Lawn & Pest/);
  }
});

test('audit corrections land', () => {
  const t = (key) => textOf(patched[key].version);
  for (const key of migration.KEYS.filter((k) => k.startsWith('estimate.engage_'))) {
    expect(t(key)).not.toMatch(/every time|in minutes|in Bradenton/);
  }
  expect(t('estimate.accepted_onboarding')).toContain('For most exterior services');
  expect(t('invoice.followup_30_day')).not.toMatch(/final/i);
  expect(t('invoice.followup_3_day')).not.toMatch(/:\s*$/m);
  expect(t('billing_late_payment_60_day')).not.toContain('remains on hold');
  expect(t('billing_late_payment_90_day')).not.toContain('further recovery action');
  expect(t('payment.ach_processing')).not.toContain('3-5');
  expect(t('payment.microdeposit_verification')).toContain('starting with SM');
  expect(t('payment.autopay_enabled')).not.toMatch(/autopay(?!_)/i);
  expect(t('membership.paused')).not.toContain('paused or placed on hold');
  expect(t('irrigation.weekly_cut_back')).not.toContain('#1');
});
