// @vitest-environment jsdom
// Good / Better / Best checkbox in the estimate tool: the pure form helper.
import { describe, expect, it } from 'vitest';
import { nextFormForOfferTiers } from './EstimateToolViewV2';

describe('nextFormForOfferTiers', () => {
  it('turns tiers on by default when the generated estimate offers them', () => {
    const form = { offerTiers: false, _offerTiersDeclined: false, notes: 'x' };
    const next = nextFormForOfferTiers(form, { offerTiersAvailable: true });
    expect(next).toEqual({ offerTiers: true, _offerTiersDeclined: false, notes: 'x' });
    expect(next).not.toBe(form);
  });

  it('keeps a manually declined form off across a regenerate', () => {
    const form = { offerTiers: false, _offerTiersDeclined: true };
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: true })).toBe(form);
  });

  it('leaves an already-on form alone while tiers stay available', () => {
    const form = { offerTiers: true, _offerTiersDeclined: false };
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: true })).toBe(form);
  });

  it('clears the box when the estimate no longer offers tiers', () => {
    const form = { offerTiers: true, _offerTiersDeclined: false };
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: false })).toEqual({
      offerTiers: false, _offerTiersDeclined: false,
    });
    expect(nextFormForOfferTiers(form, {})).toEqual({ offerTiers: false, _offerTiersDeclined: false });
    expect(nextFormForOfferTiers(form, null)).toEqual({ offerTiers: false, _offerTiersDeclined: false });
  });

  it('keeps the declined mark when tiers become unavailable, so a later eligible result stays off', () => {
    const form = { offerTiers: false, _offerTiersDeclined: true };
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: false })).toBe(form);
  });

  it('returns the same object when nothing applies', () => {
    const form = { offerTiers: false, _offerTiersDeclined: false };
    expect(nextFormForOfferTiers(form, null)).toBe(form);
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: false })).toBe(form);
  });

  it('treats only a literal true as available', () => {
    const form = { offerTiers: false, _offerTiersDeclined: false };
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: 'true' })).toBe(form);
    expect(nextFormForOfferTiers(form, { offerTiersAvailable: 1 })).toBe(form);
  });
});

describe('save body', () => {
  it('sends offerTiersDeclined beside offerTiers so the server can tell a staff uncheck from a missing availability flag', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // vitest runs from client/ locally and in CI; tolerate a repo-root cwd too
    const candidates = ['src/pages/admin/EstimateToolViewV2.jsx', 'client/src/pages/admin/EstimateToolViewV2.jsx'].map((rel) => path.resolve(process.cwd(), rel));
    const src = fs.readFileSync(candidates.find((f) => fs.existsSync(f)), 'utf8');
    expect(src).toMatch(/offerTiersDeclined: !!form\._offerTiersDeclined,/);
    // Both estimate loads (edit open and post-send refresh) carry the availability flag.
    expect(src.match(/offerTiersAvailable === true \? \{ offerTiersAvailable: true \} : \{\}/g)).toHaveLength(2);
  });
});
