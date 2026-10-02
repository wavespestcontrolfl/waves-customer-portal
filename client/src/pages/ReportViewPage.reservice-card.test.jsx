// @vitest-environment jsdom
// Re-service report card (GATE_RESERVICE_REPORT_CARD): "You told us", "What we
// did", and the "Still seeing X? Tell us" button on the live glass report.
// The server decides every phrase and the quote rule; these tests pin that the
// client renders what it is given — quote marks only when `quoted` — and that
// no payload key means nothing new on the page.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReserviceReportCard } from './ReportViewPage';

const SAFETY = 'Keep kids and pets off treated areas until dry; your technician confirms the timing.';

function card(overrides = {}) {
  return {
    version: 1,
    youToldUs: {
      source: 'picker', quoted: true, lead: null, text: 'Ants are back in the kitchen.', pests: ['Ants'],
    },
    whatWeDid: {
      pests: ['ants', 'spiders'], where: 'inside and outside', found: { rating: 2, label: 'Low' }, safetyLine: SAFETY,
    },
    stillSeeing: 'ants or spiders',
    ...overrides,
  };
}

const payload = (cardOverrides, extra = {}) => ({
  reserviceReport: { outcome: 'treated', serviceLine: 'pest' },
  reserviceReportCard: card(cardOverrides),
  reserviceEligible: true,
  ...extra,
});

afterEach(cleanup);

describe('ReserviceReportCard: gate on', () => {
  it('renders both sections as glass cards with soft rows and chip pills', () => {
    const { container } = render(<ReserviceReportCard data={payload()} mode="live" />);
    const told = container.querySelector('#reservice-you-told-us');
    const did = container.querySelector('#reservice-what-we-did');
    expect(told).toHaveAttribute('data-glass', 'card');
    expect(did).toHaveAttribute('data-glass', 'card');
    expect(within(told).getByRole('heading', { name: 'You told us' })).toBeInTheDocument();
    expect(within(did).getByRole('heading', { name: 'What we did' })).toBeInTheDocument();
    // Pest chips are glass chips.
    const chips = told.querySelectorAll('[data-glass="chip"]');
    expect([...chips].map((c) => c.textContent)).toEqual(['Ants']);
    // "What we did" rows are glass soft rows, labelled on the glass eyebrow scale.
    const rows = did.querySelectorAll('[data-glass="soft"]');
    expect(rows).toHaveLength(3);
    expect([...rows].map((r) => r.querySelector('[data-gt="eyebrow"]').textContent)).toEqual(['Treated for', 'Where', 'Activity seen']);
    expect([...rows].map((r) => r.lastChild.textContent)).toEqual(['Ants and spiders', 'Inside and outside', 'Low']);
    // The type sheet, not the legacy hidden eyebrow class.
    expect(container.querySelector('.reservice-card .section-eyebrow')).toBeNull();
    expect(within(told).getByRole('heading', { name: 'You told us' })).toHaveAttribute('data-gt', 'h3x');
  });

  it('prints the safety line only when the payload carries it', () => {
    render(<ReserviceReportCard data={payload()} mode="live" />);
    expect(screen.getByText(SAFETY)).toBeInTheDocument();
    cleanup();
    render(<ReserviceReportCard data={payload({ whatWeDid: { pests: ['ants'], where: null, found: null, safetyLine: null } })} mode="live" />);
    expect(screen.queryByText(/kids and pets/i)).toBeNull();
    // The row value and the customer's chip.
    expect(screen.getAllByText('Ants')).toHaveLength(2);
  });

  it('picker words are quoted', () => {
    render(<ReserviceReportCard data={payload()} mode="live" />);
    expect(screen.getByText('“Ants are back in the kitchen.”')).toBeInTheDocument();
  });

  it('text words are quoted', () => {
    render(<ReserviceReportCard data={payload({ youToldUs: { source: 'text', quoted: true, lead: null, text: 'Roaches again by the sink.', pests: [] } })} mode="live" />);
    expect(screen.getByText('“Roaches again by the sink.”')).toBeInTheDocument();
  });

  it('a call paraphrase has NO quote marks and reads "On your call, you mentioned"', () => {
    const { container } = render(<ReserviceReportCard
      data={payload({ youToldUs: { source: 'call', quoted: false, lead: 'On your call, you mentioned', text: 'ants in the kitchen near the sink.', pests: [] } })}
      mode="live"
    />);
    const body = container.querySelector('#reservice-you-told-us .reservice-card-body');
    expect(body.textContent).toBe('On your call, you mentioned ants in the kitchen near the sink.');
    expect(body.textContent).not.toMatch(/["“”]/);
    expect(body).toHaveAttribute('data-quoted', 'false');
  });

  it('an office entry has NO quote marks and reads as reported', () => {
    const { container } = render(<ReserviceReportCard
      data={payload({ youToldUs: { source: 'office', quoted: false, lead: 'As reported to our office:', text: 'Spiders around the lanai.', pests: [] } })}
      mode="live"
    />);
    const body = container.querySelector('#reservice-you-told-us .reservice-card-body');
    expect(body.textContent).toBe('As reported to our office: Spiders around the lanai.');
    expect(body.textContent).not.toMatch(/["“”]/);
  });

  it('chips alone (no words) still show "You told us"', () => {
    const { container } = render(<ReserviceReportCard
      data={payload({ youToldUs: { source: 'picker', quoted: false, lead: null, text: null, pests: ['Roaches', 'Spiders'] } })}
      mode="live"
    />);
    expect(container.querySelector('#reservice-you-told-us .reservice-card-body')).toBeNull();
    expect([...container.querySelectorAll('[data-glass="chip"]')].map((c) => c.textContent)).toEqual(['Roaches', 'Spiders']);
  });

  it('nothing on file hides "You told us" but keeps "What we did"', () => {
    const { container } = render(<ReserviceReportCard data={payload({ youToldUs: null })} mode="live" />);
    expect(container.querySelector('#reservice-you-told-us')).toBeNull();
    expect(container.querySelector('#reservice-what-we-did')).not.toBeNull();
  });

  it('a not-performed outcome (no "What we did") still shows "You told us"', () => {
    const { container } = render(<ReserviceReportCard data={payload({ whatWeDid: null })} mode="live" />);
    expect(container.querySelector('#reservice-what-we-did')).toBeNull();
    expect(container.querySelector('#reservice-you-told-us')).not.toBeNull();
  });

  it('the customer words render as text, never as markup', () => {
    const { container } = render(<ReserviceReportCard
      data={payload({ youToldUs: { source: 'picker', quoted: true, lead: null, text: 'Ants <img src=x onerror=alert(1)> in the kitchen.', pests: [] } })}
      mode="live"
    />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('#reservice-you-told-us').textContent).toContain('<img src=x');
  });
});

describe('ReserviceReportCard: still-seeing button', () => {
  it('links the existing authenticated portal Schedule path when the server says the customer is eligible', () => {
    render(<ReserviceReportCard data={payload()} mode="live" />);
    const link = screen.getByRole('link', { name: 'Still seeing ants or spiders? Tell us' });
    expect(link).toHaveAttribute('href', '/?tab=schedule');
    expect(link).toHaveAttribute('data-glass-accent');
    // No token, no public re-service route.
    expect(link.getAttribute('href')).not.toMatch(/token|reservice\//i);
  });

  it('no button when the customer is not eligible', () => {
    render(<ReserviceReportCard data={payload(undefined, { reserviceEligible: false })} mode="live" />);
    expect(screen.queryByRole('link', { name: /Still seeing/ })).toBeNull();
    cleanup();
    render(<ReserviceReportCard data={payload(undefined, { reserviceEligible: undefined })} mode="live" />);
    expect(screen.queryByRole('link', { name: /Still seeing/ })).toBeNull();
  });

  it('with neither section, the button stands alone in its own glass card', () => {
    const { container } = render(<ReserviceReportCard data={payload({ youToldUs: null, whatWeDid: null, stillSeeing: 'activity' })} mode="live" />);
    expect(container.querySelector('#reservice-still-seeing')).toHaveAttribute('data-glass', 'card');
    expect(screen.getByRole('link', { name: 'Still seeing activity? Tell us' })).toBeInTheDocument();
  });
});

describe('ReserviceReportCard: gate off / not applicable renders nothing new', () => {
  it('no payload key', () => {
    expect(render(<ReserviceReportCard data={{ reserviceReport: { outcome: 'treated' }, reserviceEligible: true }} mode="live" />).container).toBeEmptyDOMElement();
  });

  it('null / junk payload key', () => {
    for (const bad of [null, undefined, 'x', 5]) {
      cleanup();
      expect(render(<ReserviceReportCard data={{ reserviceReportCard: bad, reserviceEligible: true }} mode="live" />).container).toBeEmptyDOMElement();
    }
  });

  it('empty card (gate on, nothing to say, not eligible)', () => {
    const empty = { version: 1, youToldUs: null, whatWeDid: null, stillSeeing: 'activity' };
    expect(render(<ReserviceReportCard data={{ reserviceReportCard: empty, reserviceEligible: false }} mode="live" />).container).toBeEmptyDOMElement();
  });

  it('live view only: pdf / static / sms_preview render nothing', () => {
    for (const mode of ['pdf', 'static', 'sms_preview']) {
      cleanup();
      expect(render(<ReserviceReportCard data={payload()} mode={mode} />).container).toBeEmptyDOMElement();
    }
  });
});
