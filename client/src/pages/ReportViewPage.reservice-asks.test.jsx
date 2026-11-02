// @vitest-environment jsdom
// "Your re-service" (GATE_RESERVICE_ASKS): the four numbered glass cards on the
// live report and the same four cards in the PDF document. The server decides
// every phrase; these tests pin that the client renders what it is given, that
// the block replaces today's card, and that no payload key means nothing new.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage, { ReserviceReportCard, reserviceAsksView } from './ReportViewPage';
import ServiceReportDocument from './ServiceReportDocument';
import pestReportV2 from './__fixtures__/pest-report-v2.json';

const REPORT = {
  version: 1,
  title: 'Your re-service',
  lane: 'pest',
  summary: 'You told us about 2 things and asked 1 question. Here is what we did for each.',
  told: [
    { label: 'Text · Oct 30', words: '“Ants are back in the kitchen.”', quoted: true },
    { label: 'Call · Oct 31', words: 'On your call, you mentioned spiders on the porch.', quoted: false },
    { label: 'Your question · Nov 1', words: null, quoted: true },
  ],
  did: [
    { chip: 'Treated', subject: 'Ants', line: 'We treated it with Test Product and Test Product B.' },
    { chip: 'Follow-up', subject: 'Spiders', line: 'We will follow up on this one.' },
    { chip: 'Answered', subject: 'Your question', line: 'They fade as it dries.' },
  ],
  products: [
    { name: 'Test Product', where: null, how: 'Ants walk through the band and carry it back.' },
    { name: 'Test Product B', where: 'The front yard', how: null },
  ],
  expectation: 'Treatments can take several days to knock activity down fully.',
  stillSeeing: 'ants or spiders',
};

const live = (extra = {}) => ({
  reserviceReport: { outcome: 'treated', serviceLine: 'pest' },
  reserviceAsksReport: REPORT,
  reserviceEligible: true,
  ...extra,
});

beforeEach(() => {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Your re-service on the full page', () => {
  const CALLBACK = {
    ...pestReportV2,
    isCallback: true,
    reserviceGateOn: true,
    reserviceEligible: true,
    reserviceReport: {
      serviceLine: 'pest', outcome: 'treated', heading: 'we came back and took care of it!',
      result: 'Re-service completed.', completedFallback: 'Reported activity areas were re-treated today.',
      expectation: REPORT.expectation, includedWithWaveGuard: false, billingLine: null, billingReason: 'non_member',
    },
  };

  async function renderReport(payload) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
    const view = render(
      <MemoryRouter initialEntries={['/report/test-reservice-asks']}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.container.querySelector('#service-status')).not.toBeNull());
    return view;
  }

  it('shows the block right after the hero; with the key absent the page is identical to one that never knew it', async () => {
    const { container } = await renderReport({ ...CALLBACK, reserviceAsksReport: REPORT });
    const block = container.querySelector('#reservice-asks');
    expect(block).not.toBeNull();
    expect(container.querySelector('#service-status').compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    const baseline = await renderReport({ ...CALLBACK });
    const html = baseline.container.innerHTML;
    cleanup();
    const again = await renderReport({ ...CALLBACK, reserviceAsksReport: undefined });
    expect(again.container.innerHTML).toBe(html);
    expect(again.container.querySelector('#reservice-asks')).toBeNull();
  });
});

describe('Your re-service on the live report', () => {
  it('renders the title, summary and four numbered cards with real headings', () => {
    const { container } = render(<ReserviceReportCard data={live()} mode="live" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Your re-service' })).toBeInTheDocument();
    expect(screen.getByText(REPORT.summary)).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['1What you told us', '2What we did for each', '3Products and how they help', '4What to expect']);
    for (const id of ['reservice-asks-told', 'reservice-asks-did', 'reservice-asks-products', 'reservice-asks-expect']) {
      expect(container.querySelector(`#${id}`)).toHaveAttribute('data-glass', 'card');
    }
  });

  it('card 1: label and words per item; a row with no words keeps its label; only quoted words carry marks', () => {
    const { container } = render(<ReserviceReportCard data={live()} mode="live" />);
    const rows = container.querySelectorAll('#reservice-asks-told [data-glass="soft"]');
    expect([...rows].map((r) => r.querySelector('[data-gt="eyebrow"]').textContent)).toEqual(['Text · Oct 30', 'Call · Oct 31', 'Your question · Nov 1']);
    expect(rows[0]).toHaveTextContent('“Ants are back in the kitchen.”');
    expect(rows[1].textContent).toContain('On your call, you mentioned spiders on the porch.');
    expect(rows[1].textContent).not.toMatch(/[“”"]/);
    expect(rows[2].querySelector('.reservice-row-value')).toBeNull();
  });

  it('card 2: a chip, a subject and the line for each item', () => {
    const { container } = render(<ReserviceReportCard data={live()} mode="live" />);
    const rows = container.querySelectorAll('#reservice-asks-did [data-glass="soft"]');
    expect(rows).toHaveLength(3);
    expect([...rows].map((r) => r.querySelector('[data-glass="chip"]').textContent)).toEqual(['Treated', 'Follow-up', 'Answered']);
    expect(rows[0].textContent).toContain('Ants');
    expect(rows[0].textContent).toContain('We treated it with Test Product and Test Product B.');
  });

  it('card 3: name, where and the approved "How it helps" line only when present', () => {
    const { container } = render(<ReserviceReportCard data={live()} mode="live" />);
    const rows = container.querySelectorAll('#reservice-asks-products [data-glass="soft"]');
    expect(rows[0].textContent).toContain('Test Product');
    expect(rows[0].textContent).toContain('How it helps');
    expect(rows[0].textContent).toContain('Ants walk through the band and carry it back.');
    expect(rows[0].textContent).not.toContain('Where:');
    expect(rows[1].textContent).toContain('Where: The front yard');
    expect(rows[1].textContent).not.toContain('How it helps');
  });

  it('card 4: the expectation line and the gold "Still seeing" button on the existing Schedule path', () => {
    const { container } = render(<ReserviceReportCard data={live()} mode="live" />);
    const card = container.querySelector('#reservice-asks-expect');
    expect(within(card).getByText(REPORT.expectation)).toBeInTheDocument();
    const cta = within(card).getByRole('link', { name: 'Still seeing ants or spiders? Tell us' });
    expect(cta).toHaveAttribute('href', '/?tab=schedule');
    expect(cta).toHaveAttribute('data-glass-accent');
  });

  it('card 4: no button when the customer cannot book from the report', () => {
    const { container } = render(<ReserviceReportCard data={live({ reserviceEligible: false })} mode="live" />);
    expect(container.textContent).not.toContain('Still seeing');
    expect(container.querySelector('#reservice-asks-expect')).not.toBeNull();
  });

  it('cards with nothing to show drop out and the rest renumber', () => {
    const data = live({ reserviceAsksReport: { ...REPORT, products: [], expectation: '' }, reserviceEligible: false });
    render(<ReserviceReportCard data={data} mode="live" />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['1What you told us', '2What we did for each']);
  });

  it('replaces today\'s card: both render only from their own payload key', () => {
    const both = live({ reserviceReportCard: { version: 1, youToldUs: { source: 'picker', quoted: true, text: 'Old card words.', pests: [] }, whatWeDid: null, stillSeeing: 'ants' } });
    const { container } = render(<ReserviceReportCard data={both} mode="live" />);
    expect(container.querySelector('#reservice-you-told-us')).toBeNull();
    expect(container.textContent).not.toContain('Old card words.');
    expect(container.querySelector('#reservice-asks')).not.toBeNull();
  });

  it('no payload key: today\'s card renders as before, and a pdf mode renders nothing here', () => {
    const card = { version: 1, youToldUs: { source: 'picker', quoted: true, lead: null, text: 'Ants are back.', pests: [] }, whatWeDid: null, stillSeeing: 'ants' };
    const { container } = render(<ReserviceReportCard data={{ reserviceReport: { outcome: 'treated' }, reserviceReportCard: card, reserviceEligible: true }} mode="live" />);
    expect(container.querySelector('#reservice-you-told-us')).not.toBeNull();
    expect(container.querySelector('#reservice-asks')).toBeNull();
    cleanup();
    const pdf = render(<ReserviceReportCard data={live()} mode="pdf" />);
    expect(pdf.container.innerHTML).toBe('');
  });

  it('an unreadable block renders nothing', () => {
    expect(reserviceAsksView({ version: 2, told: REPORT.told })).toBeNull();
    expect(reserviceAsksView({ version: 1, told: [] })).toBeNull();
    const { container } = render(<ReserviceReportCard data={live({ reserviceAsksReport: { version: 2 } })} mode="live" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('Your re-service in the PDF document', () => {
  const BASE = {
    serviceDisplayName: 'Pest Control Re-Service',
    serviceLine: 'pest',
    customerName: 'Dana Q.',
    serviceAddress: '100 Example St',
  };

  it('prints the same four cards and no button', () => {
    render(<ServiceReportDocument data={{ ...BASE, reserviceAsksReport: REPORT }} token="tok123" />);
    expect(screen.getByText('Your re-service')).toBeInTheDocument();
    expect(screen.getByText(REPORT.summary)).toBeInTheDocument();
    for (const heading of ['1. What you told us', '2. What we did for each', '3. Products and how they help', '4. What to expect']) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    expect(screen.getByText('“Ants are back in the kitchen.”')).toBeInTheDocument();
    expect(screen.getByText('Follow-up')).toBeInTheDocument();
    expect(screen.getByText(/We will follow up on this one\./)).toBeInTheDocument();
    expect(screen.getByText(/How it helps: Ants walk through the band/)).toBeInTheDocument();
    expect(screen.getByText(REPORT.expectation)).toBeInTheDocument();
    expect(screen.queryByText(/Still seeing/)).toBeNull();
  });

  it('no payload key: the document is unchanged', () => {
    const { container: without } = render(<ServiceReportDocument data={{ ...BASE }} token="tok123" />);
    const html = without.innerHTML;
    cleanup();
    const { container: dark } = render(<ServiceReportDocument data={{ ...BASE, reserviceAsksReport: undefined }} token="tok123" />);
    expect(dark.innerHTML).toBe(html);
    expect(dark.textContent).not.toMatch(/Your re-service/);
  });
});
