// The termite bait "Service Details" guide must not promise coverage that the
// signed termite agreements do not give (owner 2026-10-26, decision D4-A).
// Bait agreement v2 and Annual Protection v3 exclude drywood termites,
// powderpost beetles and old house borers; repair exists only under a signed
// repair bond; no agreement states a $1,000,000 repair amount.

jest.mock('../models/db', () => jest.fn(() => {
  throw new Error('db must not be used by the static guide copy');
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { SERVICE_DETAILS_COPY } = require('../services/estimate-service-details');

const guide = SERVICE_DETAILS_COPY.termite_bait;
const allText = JSON.stringify(guide);
const rowLabels = guide.systemBox.rows.map((r) => r[0]);
const faqQuestions = guide.faq.map((f) => f.q);

describe('termite bait guide matches the signed agreements', () => {
  test('system box states the agreement covers subterranean and Formosan termites only', () => {
    const row = guide.systemBox.rows.find((r) => r[0] === 'Agreement covers');
    expect(row).toBeDefined();
    expect(row[1]).toBe('Subterranean and Formosan termites');
  });

  test('system box has no guarantee, warranty-type or repair-amount rows', () => {
    expect(rowLabels).not.toContain('Repair coverage');
    expect(rowLabels).not.toContain('Guarantee covers');
    expect(rowLabels).not.toContain('Warranty type');
    expect(rowLabels).not.toContain('Required for guarantee');
  });

  test('retreatment and repair row defers to the signed agreement or bond', () => {
    const row = guide.systemBox.rows.find((r) => r[0] === 'Retreatment and repair');
    expect(row).toBeDefined();
    expect(row[1]).toBe('As your signed agreement or bond states');
  });

  test('no text promises a $1,000,000 repair amount or the WDO guarantee', () => {
    expect(allText).not.toContain('1,000,000');
    expect(allText).not.toContain('WDO Guarantee');
    expect(allText).not.toContain('How can it cover drywood');
  });

  test('the layered-coverage FAQ is gone and the cover/not-cover FAQs name the agreement', () => {
    expect(faqQuestions).not.toContain('What exactly does the WaveGuard guarantee cover?');
    expect(faqQuestions).not.toContain('What does the guarantee NOT cover?');
    const covers = guide.faq.find((f) => f.q === 'What exactly does the agreement cover?');
    const notCovers = guide.faq.find((f) => f.q === 'What does the agreement NOT cover?');
    expect(covers.a).toMatch(/does not cover drywood termites, powderpost beetles or old house borers/);
    expect(notCovers.a).toMatch(/Drywood termites, powderpost beetles, old house borers/);
    expect(notCovers.a).toMatch(/repair of any damage unless a signed repair bond covers it/);
  });

  test('transfer answer says agreement, not guarantee', () => {
    const faq = guide.faq.find((f) => f.q.startsWith('What are the term options'));
    expect(faq.a).toContain('Your agreement is transferable to a new homeowner');
    expect(faq.a).not.toContain('The guarantee is transferable');
  });
});
