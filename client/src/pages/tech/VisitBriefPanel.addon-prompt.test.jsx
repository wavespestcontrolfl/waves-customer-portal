// @vitest-environment jsdom
// Visit Brief zero-price Add-On Prompt (owner 2026-11-27 "ok go").
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const LAWN_PROMPT = {
  targetFamily: 'lawn_care',
  targetLabel: 'Lawn Care',
  fieldLeadServiceType: 'Lawn',
  headline: 'No Lawn Care plan on file',
  detail: 'Ask if they want a Lawn Care quote (Silver bundle eligible). Tap below to flag for the office.',
};

describe('Visit Brief: Add-On Prompt', () => {
  it('shows the zero-price add-on banner and pre-fills Field Lead on click', () => {
    const onLead = vi.fn();
    render(
      <VisitBriefPanel
        stop={stop}
        detail={{ status: 'ready', byService: { 'svc-1': { estimate: null, brief: { brief: null, facts: { addon_prompt: LAWN_PROMPT } } } } }}
        request={vi.fn(async () => ({}))}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={onLead}
      />,
    );
    const box = screen.getByTestId('visit-brief-addon-prompt');
    expect(box).toHaveTextContent('No Lawn Care plan on file');
    expect(box.textContent).not.toMatch(/\$/);
    fireEvent.click(screen.getByRole('button', { name: /Flag Lawn Care Lead/i }));
    expect(onLead).toHaveBeenCalledWith(SERVICE, 'Lawn');
  });

  it('renders nothing when addon_prompt is absent', () => {
    render(
      <VisitBriefPanel
        stop={stop}
        detail={{ status: 'ready', byService: { 'svc-1': { estimate: null, brief: { brief: null, facts: {} } } } }}
        request={vi.fn(async () => ({}))}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('visit-brief-addon-prompt')).toBeNull();
  });
});
