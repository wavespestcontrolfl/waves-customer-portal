// @vitest-environment jsdom
// Acceptance terms scope (owner ruling 2026-09-30, codex #5434 r1 P0): the
// tab attests the SCOPE it rendered beside the version — 'plan' when the
// served Services line carried the annual rate review sentence, 'base'
// otherwise — and a plan estimate the customer toggles to a one-time visit
// renders (and attests) the served one-time lines instead.
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'token-A' }),
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

import { renderedAcceptanceTermsScope } from './EstimateViewPage';

const RATE_SENTENCE = 'Rates are reviewed once a year after your first 12 months, with at least 30 days’ written notice before any change.';
const BASE_LINES = [{ label: 'Services', text: 'at the price and frequency shown, until you cancel. No contract.' }];
const PLAN_LINES = [{ label: 'Services', text: `at the price and frequency shown, until you cancel. No contract. ${RATE_SENTENCE}` }];
const planTerms = { version: 'v2026-10', scope: 'plan', line: 'Accepting authorizes…', terms: PLAN_LINES, oneTimeTerms: BASE_LINES };
const baseTerms = { version: 'v2026-10', scope: 'base', line: 'Accepting authorizes…', terms: BASE_LINES };

describe('renderedAcceptanceTermsScope', () => {
  it("a plan payload renders 'plan' for a recurring accept", () => {
    expect(renderedAcceptanceTermsScope(planTerms, 'recurring')).toBe('plan');
  });

  it("the customer's one-time toggle on a plan payload renders the served one-time lines: 'base'", () => {
    expect(renderedAcceptanceTermsScope(planTerms, 'one_time')).toBe('base');
  });

  it("a base payload (rodent, one-time-only) is 'base' in either mode", () => {
    expect(renderedAcceptanceTermsScope(baseTerms, 'recurring')).toBe('base');
    expect(renderedAcceptanceTermsScope(baseTerms, 'one_time')).toBe('base');
  });

  it('nothing served ⇒ nothing attested', () => {
    expect(renderedAcceptanceTermsScope(undefined, 'recurring')).toBeNull();
    expect(renderedAcceptanceTermsScope({}, 'recurring')).toBeNull();
  });
});
