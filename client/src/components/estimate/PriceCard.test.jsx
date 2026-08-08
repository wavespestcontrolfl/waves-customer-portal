// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PriceCard from './PriceCard';
import { setGlassDefault } from '../../lib/estimate-glass-copy';

afterEach(() => cleanup());

describe('PriceCard — narrow low-confidence commercial range', () => {
  it('renders a ±20% "confirmed on site" range for a single all-LOW line', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          label: 'Commercial Turf Treatment Program',
          monthly: 400,
          annual: 4800,
          lowConfidenceRangePct: 0.2,
          lowConfidenceFraction: 1,
        }}
      />,
    );

    // $400.00/mo, fraction 1 → $320.00–$480.00/mo band (interval = monthly, so 1×).
    expect(screen.getByText('$320.00–$480.00')).toBeInTheDocument();
    // Annual is banded too.
    expect(screen.getByText('$3,840.00 – $5,760.00 / year')).toBeInTheDocument();
    // Site-confirmation caption present; single exact price is NOT shown.
    expect(screen.getByText(/confirm your exact price/i)).toBeInTheDocument();
    expect(screen.queryByText('$400.00')).toBeNull();
  });

  it('bands only the LOW share on a mixed-confidence card (no overstated range)', () => {
    // $900.00/mo total where only a $400.00 LOW line is uncertain (fraction 0.4444…):
    // band = 900 × 0.4444 × 0.2 = $80.00 → $820.00–$980,.00 NOT a blanket ±20% ($720.00–$1,080.00).
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          label: 'Recurring services',
          monthly: 900,
          annual: 10800,
          lowConfidenceRangePct: 0.2,
          lowConfidenceFraction: 400 / 900,
        }}
      />,
    );

    expect(screen.getByText('$820.00–$980.00')).toBeInTheDocument();
    expect(screen.queryByText('$720.00–$1,080.00')).toBeNull();
  });

  it('suppresses exact per-application treatment rows while ranging', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          monthly: 400,
          annual: 4800,
          lowConfidenceRangePct: 0.2,
          lowConfidenceFraction: 1,
          perServiceTreatments: [
            { service: 'commercial_lawn', label: 'Turf application', displayPrice: 1200, visitsPerYear: 4 },
          ],
        }}
      />,
    );

    // Range shows; the exact per-application price must NOT leak.
    expect(screen.getByText('$320.00–$480.00')).toBeInTheDocument();
    expect(screen.queryByText('$1,200.00')).toBeNull();
    expect(screen.queryByText(/per application/i)).toBeNull();
  });

  it('still renders per-application treatment rows when NOT ranging', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          monthly: 400,
          perServiceTreatments: [
            { service: 'commercial_lawn', label: 'Turf application', displayPrice: 1200, visitsPerYear: 4 },
          ],
        }}
      />,
    );

    expect(screen.getByText('$1,200.00')).toBeInTheDocument();
  });

  it('never renders an "applications per year included" headline line (owner 2026-07-23)', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          monthly: 400,
          perServiceTreatments: [
            { service: 'lawn', label: 'Turf application', displayPrice: 120, visitsPerYear: 8 },
            { service: 'mosquito', label: 'Mosquito treatment', displayPrice: 60, visitsPerYear: 12 },
          ],
        }}
      />,
    );

    expect(screen.queryByText(/applications per year included/i)).toBeNull();
    // The count still shows per row, where it belongs.
    expect(screen.getByText(/8 applications\/year/)).toBeInTheDocument();
    expect(screen.getByText(/12 applications\/year/)).toBeInTheDocument();
  });

  it('no visit-count headline even when a cadence-key count exists and there are no treatment rows', () => {
    render(<PriceCard frequency={{ key: 'quarterly', monthly: 50 }} />);

    expect(screen.queryByText(/applications per year included/i)).toBeNull();
  });

  it('renders the exact price (no range) when the marker is absent', () => {
    render(<PriceCard frequency={{ key: 'monthly', monthly: 400, annual: 4800 }} />);

    expect(screen.getByText('$400.00')).toBeInTheDocument();
    expect(screen.queryByText('$320.00–$480.00')).toBeNull();
    expect(screen.queryByText(/confirm your exact price/i)).toBeNull();
  });

  it('ignores the range marker when the line is quote-required', () => {
    render(
      <PriceCard
        frequency={{ key: 'monthly', quoteRequired: true, lowConfidenceRangePct: 0.2 }}
      />,
    );

    expect(screen.getByText('Quote required')).toBeInTheDocument();
    expect(screen.queryByText(/confirm your exact price/i)).toBeNull();
  });
});

describe('PriceCard — WaveGuard savings display', () => {
  it('suppresses a rounding-noise "savings" on a 0%-discount tier (Bronze quarterly)', () => {
    // $94.00/visit quarterly stored as $31.33/mo → cadence 93.99 vs anchor 94:
    // the $0.01 delta is monthly-rounding noise, not a member discount.
    render(
      <PriceCard
        frequency={{ key: 'quarterly', monthly: 31.33, annual: 375.96, perVisit: 94 }}
        waveGuardTier="Bronze"
      />,
    );

    expect(screen.queryByText(/You save/)).toBeNull();
    // No strike-through anchor either — just the billed price.
    expect(screen.queryByText('$94.00/quarter')).toBeNull();
    expect(screen.getByText('$93.99')).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Bronze')).toBeInTheDocument();
    // No annual figure on a standard exact price (owner directive).
    expect(screen.queryByText(/\/ year/)).toBeNull();
  });

  it('shows a real tier discount as the struck-through anchor, with no savings line', () => {
    // Anchor $100.00/visit, member pays $90.00/quarter (10% Silver).
    render(
      <PriceCard
        frequency={{ key: 'quarterly', monthly: 30, annual: 360, perVisit: 100 }}
        waveGuardTier="Silver"
      />,
    );

    // The "You save" line was removed globally (anchor-vs-cadence delta
    // misattributed to the tier) — the struck anchor is the discount signal.
    expect(screen.queryByText(/You save/)).toBeNull();
    expect(screen.getByText('$100.00/quarter')).toBeInTheDocument();
  });

  it('derives the anchor from monthlyBase when perVisit is absent (non-pest bundle rows)', () => {
    // Lawn in a Silver bundle: $83.00/mo base → $74.70/mo member price. Own-cadence
    // ladder rows never carry perVisit, only monthlyBase.
    render(
      <PriceCard
        frequency={{ key: 'premium', label: 'Monthly', monthly: 74.7, monthlyBase: 83, visitsPerYear: 12 }}
        waveGuardTier="Silver"
      />,
    );

    expect(screen.getByText('$83.00/mo')).toBeInTheDocument();
    expect(screen.queryByText(/You save/)).toBeNull();
  });

  it('shows no anchor or savings when monthlyBase equals the billed monthly (0% tier)', () => {
    render(
      <PriceCard
        frequency={{ key: 'premium', label: 'Monthly', monthly: 83, monthlyBase: 83, visitsPerYear: 12 }}
        waveGuardTier="Bronze"
      />,
    );

    expect(screen.queryByText(/You save/)).toBeNull();
    expect(screen.queryByText('$83.00/mo')).toBeNull();
    expect(screen.getByText('$83.00')).toBeInTheDocument();
  });
});


describe('PriceCard — manual discount is not double-reported in-card', () => {
  it('shows the promo row but no anchor/savings when the gap is the manual discount alone', () => {
    render(
      <PriceCard
        frequency={{
          key: 'premium',
          label: 'Monthly',
          monthly: 73,
          monthlyBase: 83,
          visitsPerYear: 12,
          manualDiscount: { amount: 120, recurringAmount: 120, label: 'Spring promo' },
        }}
        waveGuardTier="Silver"
      />,
    );

    expect(screen.getByText('Spring promo')).toBeInTheDocument();
    expect(screen.queryByText(/You save/)).toBeNull();
    expect(screen.queryByText('$83.00/mo')).toBeNull();
  });

  it('per-application headline: no struck-through anchor when the gap is the promo alone', () => {
    // Mosquito-only with a manual promo: perTreatment is already net of the
    // promo ($66.00 → $56.00 via $120.00/yr over 12 apps) and the promo renders as its
    // own labeled row — the anchor strike-through must not restate it as
    // member savings.
    render(
      <PriceCard
        frequency={{
          key: 'monthly12',
          label: 'Monthly',
          monthly: 56,
          visitsPerYear: 12,
          perTreatment: 56,
          perVisit: 66,
          manualDiscount: { amount: 120, recurringAmount: 120, label: 'Spring promo' },
        }}
        waveGuardTier="Bronze"
        preferPerApplicationPrice
      />,
    );

    expect(screen.getByText('Spring promo')).toBeInTheDocument();
    // Net per-application headline renders…
    expect(screen.getByText('$56.00')).toBeInTheDocument();
    // …but no $66.00 anchor strike-through (the whole gap is the promo).
    expect(screen.queryByText(/\$66.00 \/ application/)).toBeNull();
  });

  it('per-application headline: a real tier discount still anchors after the promo is netted out', () => {
    // Anchor $66,.00 net $46.00: $10.00/app is the promo, the remaining $10.00/app is a
    // genuine member discount — the strike-through stays.
    render(
      <PriceCard
        frequency={{
          key: 'monthly12',
          label: 'Monthly',
          monthly: 46,
          visitsPerYear: 12,
          perTreatment: 46,
          perVisit: 66,
          manualDiscount: { amount: 120, recurringAmount: 120, label: 'Spring promo' },
        }}
        waveGuardTier="Gold"
        preferPerApplicationPrice
      />,
    );

    expect(screen.getByText('Spring promo')).toBeInTheDocument();
    expect(screen.getByText(/\$66.00 \/ application/)).toBeInTheDocument();
  });
});

describe('PriceCard — a discount reads in the unit of the price it reduces (owner 2026-08-01)', () => {
  // Lawn: 9 applications a year on a monthly billing interval. The credit is an
  // ANNUAL $43.44, so the old "/mo" row showed $3.62 — a billing period this
  // plan does not use, next to a headline quoted per application.
  const lawnFrequency = (overrides = {}) => ({
    key: 'lawn_9',
    label: '9 applications/year',
    monthly: 74.7,
    annual: 896.4,
    perTreatment: 99.6,
    monthlyBase: 83,
    visitsPerYear: 9,
    billedPerApplication: true,
    manualDiscount: { amount: 43.44, recurringAmount: 43.44, label: 'Custom Percentage Discount' },
    ...overrides,
  });

  it('quotes the credit per application when the card leads with a per-application price', () => {
    render(<PriceCard frequency={lawnFrequency()} waveGuardTier="Silver" preferPerApplicationPrice />);

    // $43.44/yr over 9 applications = $4.83 each, itemized in the savings stack.
    expect(screen.getByText(/[−-]\$4\.83/)).toBeInTheDocument();
    // The monthly amortization ($43.44/12) is gone.
    expect(screen.queryByText(/\$3\.62/)).toBeNull();
  });

  it('keeps the billing-interval unit when the card itself leads with a cadence price', () => {
    // No per-application headline (preferPerApplicationPrice off) → the credit
    // stays in the interval the card quotes, so the two never disagree.
    render(<PriceCard frequency={lawnFrequency()} waveGuardTier="Silver" />);

    expect(screen.getByText(/\$3\.62\/mo/)).toBeInTheDocument();
    expect(screen.queryByText(/\/ application/)).toBeNull();
  });

  it('still renders the row for a flat-monthly service with no per-application price', () => {
    // Termite monitoring bills a flat monthly and has no visit-priced headline —
    // "/mo" is the correct unit there and must survive.
    render(
      <PriceCard
        frequency={{
          key: 'recurring',
          label: 'Termite Bait Monitoring',
          monthly: 35,
          annual: 420,
          manualDiscount: { amount: 43.44, recurringAmount: 43.44, label: 'Custom Percentage Discount' },
        }}
        preferPerApplicationPrice
      />,
    );

    expect(screen.getByText(/\$3\.62\/mo/)).toBeInTheDocument();
  });
});

describe('PriceCard — savings stack (owner 2026-08-01: discounts belong where the price is)', () => {
  // List $110.00/application × 9 = $990/yr. WaveGuard Silver takes $11.00 an
  // application, a $43.44/yr custom credit takes $4.83 → $94.17 net.
  const lawn = (overrides = {}) => ({
    key: 'lawn_9',
    label: '9 applications/year',
    visitsPerYear: 9,
    monthlyBase: 82.5,
    perTreatment: 94.17,
    monthly: 70.63,
    annual: 847.56,
    billedPerApplication: true,
    manualDiscount: { amount: 43.44, recurringAmount: 43.44, label: 'Custom Percentage Discount' },
    ...overrides,
  });

  const stackRows = (container) => [...container.querySelectorAll('div')]
    .map((el) => el.textContent)
    .filter((t) => /^(WaveGuard|Custom Percentage Discount)/.test(t));

  it('itemizes the tier discount and the custom discount as separate per-application rows', () => {
    render(<PriceCard frequency={lawn()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    expect(screen.getByText('WaveGuard Silver Discount')).toBeInTheDocument();
    expect(screen.getByText('Custom Percentage Discount')).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$11\.00/)).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$4\.83/)).toBeInTheDocument();
  });

  it.each(['Bronze', 'Silver', 'Gold', 'Platinum'])('names the tier row "WaveGuard %s Discount"', (tier) => {
    // The tier name alone reads like the plan badge above it — the row has to
    // say outright that it is a discount, at every tier.
    render(<PriceCard frequency={lawn()} waveGuardTier={tier} waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    expect(screen.getByText(`WaveGuard ${tier} Discount`)).toBeInTheDocument();
  });

  it('strips a tier value that already carries the WaveGuard prefix', () => {
    // Payloads send both "Silver" and "WaveGuard Silver"; neither may produce
    // "WaveGuard WaveGuard Silver Discount".
    render(<PriceCard frequency={lawn()} waveGuardTier="WaveGuard Gold" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    expect(screen.getByText('WaveGuard Gold Discount')).toBeInTheDocument();
  });

  it('reconciles: anchor minus every stack row equals the headline price', () => {
    render(<PriceCard frequency={lawn()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    // $110.00 anchor − $11.00 − $4.83 = $94.17 headline.
    expect(screen.getByText(/\$110\.00 \/ application/)).toBeInTheDocument();
    expect(screen.getByText('$94.17')).toBeInTheDocument();
    expect(110 - 11 - 4.83).toBeCloseTo(94.17, 2);
  });

  it('does not also render the standalone discount row (no double-reporting)', () => {
    const { container } = render(
      <PriceCard frequency={lawn()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />,
    );

    // The custom discount appears exactly once on the card.
    expect(stackRows(container).filter((t) => t.startsWith('Custom Percentage Discount'))).toHaveLength(1);
  });

  it('collapses to a single row when WaveGuard is the only discount', () => {
    // Pest quarterly with no plan credit: the card carries a tier discount and
    // nothing else.
    render(
      <PriceCard
        frequency={{
          key: 'quarterly',
          label: 'Quarterly',
          visitsPerYear: 4,
          perVisit: 130,
          perTreatment: 117,
          monthly: 39,
          annual: 468,
          billedPerApplication: true,
        }}
        waveGuardTier="Silver"
        waveGuardDiscountPct={0.1}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.getByText('WaveGuard Silver Discount')).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$13\.00/)).toBeInTheDocument();
    expect(screen.queryByText('Custom Percentage Discount')).toBeNull();
  });

  it('restates itself against the selected cadence', () => {
    // Same plan at 12 applications a year: the tier slice and the credit slice
    // both re-divide, so the stack is derived, never stamped.
    render(
      <PriceCard
        frequency={lawn({ key: 'lawn_12', visitsPerYear: 12, monthlyBase: 95, perTreatment: 81.88, monthly: 81.88, annual: 982.56 })}
        waveGuardTier="Silver"
        waveGuardDiscountPct={0.1}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.getByText(/[−-]\$9\.50/)).toBeInTheDocument();   // tier: $95.00 × 10%
    expect(screen.getByText(/[−-]\$3\.62/)).toBeInTheDocument();   // credit: $43.44 / 12
    expect(screen.getByText('$81.88')).toBeInTheDocument();
  });

  it('leaves the anchor gap unlabeled when it is not the tier slice (codex #3183 P1)', () => {
    // Preference removals / floor adjustments also shape the net: here the
    // residual gap is $15.83, not the $11.00 a 10% Silver slice would be —
    // labeling it "WaveGuard Silver Discount" would misattribute dollars.
    render(
      <PriceCard
        frequency={lawn({ perTreatment: 89.34, monthly: 67.01, annual: 804.06 })}
        waveGuardTier="Silver"
        waveGuardDiscountPct={0.1}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.queryByText('WaveGuard Silver Discount')).toBeNull();
    // The anchor strike and the authoritative manual slice still render.
    expect(screen.getByText(/\$110\.00 \/ application/)).toBeInTheDocument();
    expect(screen.getByText('Custom Percentage Discount')).toBeInTheDocument();
  });

  it('names no tier row without the authoritative tier pct to corroborate the gap', () => {
    render(<PriceCard frequency={lawn()} waveGuardTier="Silver" showTierBadge={false} preferPerApplicationPrice />);

    expect(screen.queryByText('WaveGuard Silver Discount')).toBeNull();
    expect(screen.getByText('Custom Percentage Discount')).toBeInTheDocument();
  });

  it('names no tier row when the card has no WaveGuard tier', () => {
    // Without a tier there is nothing to label the anchor gap with — inventing
    // one would put a discount name on the card that no plan grants.
    render(<PriceCard frequency={lawn()} showTierBadge={false} preferPerApplicationPrice />);

    expect(screen.queryByText(/^WaveGuard/)).toBeNull();
    // The custom discount still itemizes.
    expect(screen.getByText('Custom Percentage Discount')).toBeInTheDocument();
  });

  it('falls back to the standalone row when the anchor is suppressed (showSavings off)', () => {
    const { container } = render(
      <PriceCard frequency={lawn()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice showSavings={false} />,
    );

    expect(screen.queryByText('WaveGuard Silver Discount')).toBeNull();
    // The credit is still visible, in per-application units.
    expect(container.textContent).toMatch(/\$4\.83 \/ application/);
  });
});

describe('PriceCard — applications-per-year line under the price (owner 2026-08-03)', () => {
  // Lawn-shaped glass single-row card: the count belongs under the price like
  // the rowless pest card shows it, and the row sub-label keeps only the tier
  // tag (restating the count read twice).
  const lawnRowFrequency = () => ({
    key: 'enhanced',
    label: 'Every 6 weeks (9 visits)',
    monthly: 40.19,
    annual: 482.22,
    monthlyBase: 47,
    perTreatment: 53.58,
    billedPerApplication: true,
    perServiceTreatments: [{
      service: 'lawn_care', label: 'Lawn Care', perTreatment: 56.4, displayPrice: 53.58, visitsPerYear: 9,
    }],
  });

  afterEach(() => setGlassDefault(false));

  it('glass single-row card shows the count under the price and drops it from the sub-label', () => {
    setGlassDefault(true);
    const { container } = render(<PriceCard frequency={lawnRowFrequency()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    expect(container.textContent).toMatch(/9 applications per year/);
    expect(screen.queryByText(/9 applications\/year/)).toBeNull();
    // The tier tag survives alone in the row sub-label.
    expect(screen.getByText('WaveGuard Silver')).toBeInTheDocument();
  });

  // Customer-facing estimate surfaces never show combined plan totals
  // ("$X/mo" / "$X/yr") — owner rule 2026-07-23, AGENTS.md. An annual figure
  // briefly rode this line during the 2026-08-07 cadence-discount work and was
  // removed on review (codex #3274 P1); this guard keeps it out.
  it('never renders a combined annual dollar total on the cadence line', () => {
    setGlassDefault(true);
    const { container } = render(<PriceCard frequency={lawnRowFrequency()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    expect(container.textContent).toMatch(/9 applications per year/);
    expect(container.textContent).not.toMatch(/\$[\d,.]+\s*per year/);
    expect(container.textContent).not.toMatch(/\$[\d,.]+\s*\/\s*yr/);
  });

  it('non-glass card keeps the count in the row sub-label (no header line)', () => {
    render(<PriceCard frequency={lawnRowFrequency()} waveGuardTier="Silver" waveGuardDiscountPct={0.1} showTierBadge={false} preferPerApplicationPrice />);

    expect(screen.queryByText('9 applications per year')).toBeNull();
    expect(screen.getByText(/9 applications\/year/)).toBeInTheDocument();
  });
});

describe('PriceCard — no monthly billing note (owner 2026-07-23: billing is always per application)', () => {
  const termiteFrequency = (overrides = {}) => ({
    key: 'recurring',
    label: 'Termite Bait Monitoring',
    monthly: 35,
    annual: 420,
    perTreatment: 105,
    visitsPerYear: 4,
    ...overrides,
  });

  it('legacy monthly-billed payloads keep a factual "Billed $X/mo" note — without the retired "spread across the year" framing (codex P1)', () => {
    render(<PriceCard frequency={termiteFrequency()} preferPerApplicationPrice />);
    expect(screen.queryByText(/spread across the year/)).toBeNull();
    expect(screen.getByText('$105.00')).toBeInTheDocument();
    // The charge on accept is still a flat monthly for unflagged legacy rows
    // (estimate-public frequencyFromTreatmentRow) — the card must say so.
    expect(screen.getByText(/Billed \$35\.00\/mo/)).toBeInTheDocument();
  });

  it('billedPerApplication payloads render no monthly note — the headline IS the charge', () => {
    render(<PriceCard frequency={termiteFrequency({ billedPerApplication: true })} preferPerApplicationPrice />);
    expect(screen.queryByText(/spread across the year/)).toBeNull();
    expect(screen.queryByText(/Billed \$/)).toBeNull();
    expect(screen.getByText('$105.00')).toBeInTheDocument();
    expect(screen.queryByText(/applications per year included/)).toBeNull();
  });

  it('tier-ladder shape at a 6-visit cadence (monthly ≠ per-app, the #2965 regression) shows no monthly note', () => {
    // Mirrors the server lawn/T&S ladder contract: tier plans bill per
    // application (converter plan annual ÷ visits), so the server stamps
    // billedPerApplication on every tier entry (estimator audit 2026-07-24).
    // The pre-fix bug: only the 12-visit tier was tested, where monthly ==
    // per-app hides the note arithmetically.
    render(
      <PriceCard
        frequency={{
          key: 'standard',
          label: 'Bi-monthly (6 visits)',
          serviceCategory: 'lawn_care',
          monthly: 55.5,
          annual: 666,
          perTreatment: 111,
          visitsPerYear: 6,
          billingFrequencyKey: 'monthly',
          billedPerApplication: true,
          perServiceTreatments: [{
            service: 'lawn_care', label: 'Lawn Care', perTreatment: 111, displayPrice: 111, visitsPerYear: 6,
          }],
        }}
        preferPerApplicationPrice
      />,
    );
    // Headline + the per-row sub-label both carry the per-app figure.
    expect(screen.getAllByText('$111.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Billed \$/)).toBeNull();
    expect(screen.queryByText(/spread across the year/)).toBeNull();
  });

  it('rowless per-application cards show a muted cadence count, never the "included" headline (codex P2)', () => {
    render(<PriceCard frequency={termiteFrequency({ billedPerApplication: true })} preferPerApplicationPrice />);
    expect(screen.getByText(/4 applications per year/)).toBeInTheDocument();
    expect(screen.queryByText(/applications per year included/)).toBeNull();
  });

  it('cards WITH treatment rows never show the rowless cadence line — the count lives on the rows', () => {
    render(
      <PriceCard
        preferPerApplicationPrice
        frequency={{
          key: 'quarterly',
          monthly: 31.17,
          perServiceTreatments: [
            { service: 'pest', label: 'Quarterly application', displayPrice: 93.5, visitsPerYear: 4 },
          ],
        }}
      />,
    );
    expect(screen.queryByText(/applications per year(?! included)/)).toBeNull();
    expect(screen.getByText(/4 applications\/year/)).toBeInTheDocument();
  });
});

describe('guarantee line fully retired (owner 2026-07-24)', () => {
  it('never renders the risk-free line — the CTA micro is the one sanctioned guarantee claim', () => {
    render(
      <PriceCard
        frequency={{ key: 'quarterly', label: 'Quarterly', monthly: 39, annual: 468, perTreatment: 117, visitsPerYear: 4 }}
        preferPerApplicationPrice
      />,
    );
    expect(screen.queryByText(/risk-free/i)).toBeNull();
    expect(screen.queryByText(/money-back/i)).toBeNull();
  });
});

describe('PriceCard — current-member savings corroborate the anchor gap (owner 2026-08-04)', () => {
  // Pest quarterly on a current member's estimate: anchor $100.00/application,
  // the margin guard capped the applied rate at 12.7% → $87.30 net. The plan
  // tier pct (15% Gold) can't reconcile the $12.70 gap, and the snapshot's
  // whole-% discountPct (13%) rounds too coarsely — only the snapshot's
  // applied per-application saving matches the dollars.
  const cappedMember = (overrides = {}) => ({
    key: 'quarterly',
    label: 'Quarterly',
    visitsPerYear: 4,
    perVisit: 100,
    perTreatment: 87.3,
    monthly: 29.1,
    annual: 349.2,
    billedPerApplication: true,
    ...overrides,
  });

  it('labels the member discount from the snapshot saving when the tier pct cannot corroborate', () => {
    render(
      <PriceCard
        frequency={cappedMember()}
        waveGuardTier="Gold"
        waveGuardDiscountPct={0.15}
        memberPerApplicationSavings={12.7}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.getByText('WaveGuard Gold Discount')).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$12\.70/)).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00 \/ application/)).toBeInTheDocument();
    expect(screen.getByText('$87.30')).toBeInTheDocument();
  });

  it('keeps the unlabeled strike-through when neither the tier pct nor the member saving matches', () => {
    // A wrong member figure must not put a name on dollars it doesn't explain
    // — same principle as the tier-pct corroboration (codex #3183 P1).
    render(
      <PriceCard
        frequency={cappedMember()}
        waveGuardTier="Gold"
        waveGuardDiscountPct={0.15}
        memberPerApplicationSavings={9.99}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.queryByText('WaveGuard Gold Discount')).toBeNull();
    expect(screen.getByText(/\$100\.00 \/ application/)).toBeInTheDocument();
  });

  it('invents no row from a member saving when the price shows no anchor gap', () => {
    render(
      <PriceCard
        frequency={cappedMember({ perTreatment: 100, monthly: 33.33, annual: 400 })}
        waveGuardTier="Gold"
        memberPerApplicationSavings={12.7}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.queryByText('WaveGuard Gold Discount')).toBeNull();
    expect(screen.queryByText(/\$100\.00 \/ application/)).toBeNull();
  });

  it('needs a tier to name — a member saving alone labels nothing', () => {
    render(
      <PriceCard
        frequency={cappedMember()}
        memberPerApplicationSavings={12.7}
        showTierBadge={false}
        preferPerApplicationPrice
      />,
    );

    expect(screen.queryByText(/WaveGuard .* Discount/)).toBeNull();
  });
});
