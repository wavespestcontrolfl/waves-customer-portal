// @vitest-environment jsdom
// Past visits on the tech Visit Brief (facts.past_visits): first 3, "N more" opens all, and
// the panel keeps its single Last visit block when the server sends no past_visits.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PastVisitsSection from './PastVisitsSection';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const VISITS = [
  { date: '2026-11-10', type: 'Lawn Care Treatment', notes: 'Edged the bed near the gate.', products: [{ name: 'Example Herbicide' }], callback: false },
  { date: '2026-10-20', type: 'Pest Control Re-Service', notes: 'Ants back at the lanai door.', products: [{ name: 'Example Gel Bait' }, { name: 'Example Dust' }], callback: true },
  { date: '2026-09-01', type: 'Mosquito Control', notes: null, products: [], callback: false },
  { date: '2026-08-01', type: 'Pest Control Service', notes: 'Fourth visit note.', products: [], callback: false },
  { date: '2026-07-01', type: 'Lawn Care Treatment', notes: null, products: [], callback: false },
];

const SVC = { id: 'svc-1', status: 'confirmed', customerName: 'Pat Sample', customerPhone: '(941) 555-0100', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control', lastLineServiceDate: '2026-05-05', lastLineServiceType: 'Pest Control Service', lastLineServiceNotes: 'Old single note.' };

function renderPanel(facts) {
  render(
    <VisitBriefPanel
      stop={{ key: 'row:x', isVisit: false, services: [SVC], primary: SVC, liveCount: 1 }}
      detail={{ status: 'ready', byService: { [SVC.id]: { estimate: null, brief: { brief: null, facts } } } }}
      request={vi.fn(async () => ({}))}
      onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />,
  );
}

describe('PastVisitsSection', () => {
  it('shows the first 3 visits and a button for the rest', () => {
    render(<PastVisitsSection memberBits={[{ facts: { past_visits: VISITS } }]} />);
    expect(screen.getByText('Past visits')).toBeInTheDocument();
    expect(screen.getByText(/2026-11-10 · Lawn Care Treatment/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-01 · Mosquito Control/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-08-01/)).toBeNull();
    expect(screen.getByText('Edged the bed near the gate.')).toBeInTheDocument();
    expect(screen.getByText('Example Gel Bait, Example Dust')).toBeInTheDocument();
    expect(screen.getByText(/Free return visit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 more' })).toBeInTheDocument();
  });

  it('the button opens all five, then folds back', () => {
    render(<PastVisitsSection memberBits={[{ facts: { past_visits: VISITS } }]} />);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(screen.getByText(/2026-08-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-07-01/)).toBeInTheDocument();
    expect(screen.getByText('Fourth visit note.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText(/2026-08-01/)).toBeNull();
  });

  it('three or fewer visits: no button', () => {
    render(<PastVisitsSection memberBits={[{ facts: { past_visits: VISITS.slice(0, 3) } }]} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('VisitBriefPanel past visits', () => {
  it('past_visits replaces the single Last visit block', () => {
    renderPanel({ access: null, last_visit: { date: '2026-05-05', type: 'Pest Control Service', products: [] }, past_visits: VISITS });
    expect(screen.getByText('Past visits')).toBeInTheDocument();
    expect(screen.queryByText('Last visit')).toBeNull();
    expect(screen.queryByText('Old single note.')).toBeNull();
  });

  it.each([
    ['no key (old server)', { access: null, last_visit: { date: '2026-05-05', type: 'Pest Control Service', products: [] } }],
    ['an empty list', { access: null, last_visit: { date: '2026-05-05', type: 'Pest Control Service', products: [] }, past_visits: [] }],
  ])('%s: today\'s Last visit block stays', (_label, facts) => {
    renderPanel(facts);
    expect(screen.getByText('Last visit')).toBeInTheDocument();
    expect(screen.getByText('Old single note.')).toBeInTheDocument();
    expect(screen.queryByText('Past visits')).toBeNull();
  });
});
