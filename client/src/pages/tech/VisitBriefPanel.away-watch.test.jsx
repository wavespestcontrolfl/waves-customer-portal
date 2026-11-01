// @vitest-environment jsdom
// GATE_AWAY_WATCH: the tech's Visit Brief shows the Away Watch lines the visit-brief answer carries (`awayWatch.lines`,
// the same lines as the job card), so the tech knows about the 3 outside photos and the Welcome Home sweep before the
// visit. No key = no section.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SERVICE = {
  id: 'svc-1',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Quarterly Pest Control',
};
const stop = { key: 'row:svc-1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };
const AWAY = 'Away Watch: member away until 2026-09-30. Take 3 photos of the outside of the home from the ground and note standing water.';
const WELCOME = 'Welcome Home: last visit before the member is back. Do a lanai cobweb sweep (no product).';

function renderWith(brief) {
  render(
    <VisitBriefPanel
      stop={stop}
      detail={{ status: 'ready', byService: { 'svc-1': { estimate: null, brief } } }}
      request={vi.fn(async () => ({}))}
      onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />,
  );
}

describe('Visit Brief: Away Watch', () => {
  it('shows each line the brief answer carries, in order', () => {
    renderWith({ brief: null, awayWatch: { lines: [AWAY, WELCOME] } });
    const section = screen.getByTestId('visit-brief-away-watch');
    expect(section).toHaveTextContent('Away Watch');
    expect(section).toHaveTextContent(AWAY);
    expect(section).toHaveTextContent(WELCOME);
  });

  it('no key, or no lines: no section', () => {
    renderWith({ brief: null });
    expect(screen.queryByTestId('visit-brief-away-watch')).toBeNull();
    cleanup();
    renderWith({ brief: null, awayWatch: { lines: [] } });
    expect(screen.queryByTestId('visit-brief-away-watch')).toBeNull();
  });
});
