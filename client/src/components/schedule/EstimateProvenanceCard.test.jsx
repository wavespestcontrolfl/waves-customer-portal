// @vitest-environment jsdom
/**
 * Quoted-figure framing (owner ruling 2026-08-02): the card must read
 * per-application when real quote lines exist — the blended monthly+one-time
 * total ($135.30 for a $121/application + $99 setup quote) matches nothing
 * the customer ever pays at once, and comparing a per-visit price against it
 * manufactured phantom "vs quoted" deltas.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import EstimateProvenanceCard from './EstimateProvenanceCard';

describe('EstimateProvenanceCard quoted framing', () => {
  afterEach(cleanup);

  it('reads per-application + one-time when real quote lines exist, with per-line prices', () => {
    render(
      <EstimateProvenanceCard
        quotedTotal={135.30}
        onetimeTotal={99}
        currentPrice={121}
        lines={[{ name: 'Quarterly Pest Control', cadence: 'quarterly', price: 121, perApplicationPrice: 121 }]}
        estimateRef="EST-2026-0001"
      />,
    );
    expect(screen.getByText(/Quoted \$121\.00\/application \+ \$99\.00 one-time/)).toBeTruthy();
    expect(screen.getByText(/\$121\.00\/application · quarterly/i)).toBeTruthy();
    // $121 booked vs $121/application quoted — NO phantom delta from the
    // $135.30 blended figure.
    expect(screen.queryByText(/vs quoted/i)).toBeNull();
  });

  it('mixed quotes compare against recurring + schedulable one-time (the booked visit charge)', () => {
    render(
      <EstimateProvenanceCard
        quotedTotal={135.30}
        onetimeTotal={200}
        currentPrice={321}
        lines={[
          { name: 'Quarterly Pest Control', cadence: 'quarterly', price: 121, perApplicationPrice: 121 },
          { name: 'Bed Bug Treatment', cadence: 'one_time', price: 200 },
        ]}
        estimateRef="EST-2026-0003"
      />,
    );
    // $321 booked vs $121 + $200 quoted for the same visit — no phantom +165%.
    expect(screen.queryByText(/vs quoted/i)).toBeNull();
  });

  it('suppresses the comparison when any line lacks a real price (no like-for-like total)', () => {
    render(
      <EstimateProvenanceCard
        quotedTotal={135.30}
        onetimeTotal={0}
        currentPrice={321}
        lines={[
          { name: 'Quarterly Pest Control', cadence: 'quarterly', price: 121, perApplicationPrice: 121 },
          { name: 'Mystery Add-on', cadence: 'quarterly', price: null },
        ]}
        estimateRef="EST-2026-0004"
      />,
    );
    expect(screen.queryByText(/vs quoted/i)).toBeNull();
  });

  it('keeps the legacy blended total when only synthesized fallback lines exist', () => {
    render(
      <EstimateProvenanceCard
        quotedTotal={24}
        onetimeTotal={0}
        currentPrice={null}
        lines={[{ name: 'Termite Monitoring', cadence: 'quarterly', price: 24, derived: 'estimate_totals_fallback' }]}
        estimateRef="EST-2026-0002"
      />,
    );
    expect(screen.getByText(/Quoted \$24\.00$/)).toBeTruthy();
    expect(screen.queryByText(/application/)).toBeNull();
  });
});
