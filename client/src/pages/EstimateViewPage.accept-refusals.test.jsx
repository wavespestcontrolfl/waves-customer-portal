// @vitest-environment jsdom
/**
 * Approve refusals that are not about the time (estimate page audit
 * 2026-11-05). The page read every accept 409 it did not name as "That slot
 * was just taken", so a customer picked a new time into the same refusal (a
 * discount refresh, a re-price, a retired plan option, a frozen restart quote).
 * Driving the accept handler for real needs the whole /data payload, which a
 * unit suite cannot mount (EstimateViewPage.hold-countdown.test.jsx says the
 * same), so its routing is pinned by source; the banners render for real.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EstimateErrorBanner, SlotIssueBanner } from './EstimateViewPage';
// Vite's ?raw import: the page source as a string.
import pageSource from './EstimateViewPage.jsx?raw';

afterEach(cleanup);

// The accept handler's 409 branch, from its slot split to its own end.
const accept409 = () => {
  const at = pageSource.indexOf("const slotGone = body.code === 'SLOT_UNAVAILABLE'");
  return pageSource.slice(at, pageSource.indexOf('throw new Error(body.error || `accept failed: ${r.status}`);', at));
};

describe('accept 409s', () => {
  it('sends only a gone slot or a lapsed hold to the "slot taken" recovery', () => {
    const handler = accept409();
    const split = handler.indexOf('if (expired || slotGone) {');
    expect(split).toBeGreaterThan(-1);
    expect(handler.indexOf("recoverFromDeadHold(expired ? 'reservation_expired' : 'slot_conflict');")).toBeGreaterThan(split);
  });

  it('gives every other 409 the same recovery, with the server reason for the banner', () => {
    const handler = accept409();
    const split = handler.indexOf('if (expired || slotGone) {');
    const withReason = handler.indexOf("recoverFromDeadHold('slot_conflict', body.error || null);");
    expect(withReason).toBeGreaterThan(split);
    // No new exit: the reason rides the recovery, so a refusal that needs its
    // reload (a renewal with no appointment) still gets it.
    expect(handler.slice(split)).not.toContain('throw new Error');
  });
});

describe('the reserve refusal for a taken slot', () => {
  it('clears any reason an earlier accept refusal left, so it says "slot taken"', () => {
    const at = pageSource.indexOf('if (/slot no longer available/i.test(message)) {');
    expect(at).toBeGreaterThan(-1);
    const branch = pageSource.slice(at, pageSource.indexOf("setCtaPhase('slot_conflict');", at));
    expect(branch).toContain('setDeadHoldNote(null);');
  });

  it('is the only place outside the recovery that sets the slot_conflict phase', () => {
    expect(pageSource.match(/setCtaPhase\('slot_conflict'\)/g)).toHaveLength(1);
  });
});

describe('SlotIssueBanner', () => {
  it('shows the server reason in place of "slot taken"', () => {
    render(<SlotIssueBanner kind="conflict" note="That visit is before your move-in date. Please pick a time on or after it." />);
    expect(screen.getByText('That visit is before your move-in date. Please pick a time on or after it.')).toBeInTheDocument();
    expect(screen.queryByText(/That slot was just taken/)).not.toBeInTheDocument();
  });

  it('keeps the taken-slot copy when there is no reason', () => {
    render(<SlotIssueBanner kind="conflict" />);
    expect(screen.getByText(/That slot was just taken/)).toBeInTheDocument();
  });
});

describe('EstimateErrorBanner', () => {
  it('prints a server sentence with one period, not two', () => {
    const { container } = render(<EstimateErrorBanner error="This estimate is being re-priced — please try again in a few minutes." />);
    expect(container.textContent).toContain('Something went wrong: This estimate is being re-priced — please try again in a few minutes. Try again or call');
    expect(container.textContent).not.toContain('minutes..');
  });
});

describe('the included-item removal message', () => {
  it('gives the main Waves number', () => {
    expect(pageSource).not.toContain('234-8929');
    expect(pageSource).toContain("Give us a call at ${WAVES_PHONE_DISPLAY} and we'll sort it out with you.");
  });
});
