// @vitest-environment jsdom
// The open visit screen (TechFieldVisit + VisitBriefPanel) follows the Waves
// Admin look: one Directions button, the address once, line icons instead of
// emoji, and a labelled flag button (owner 2026-10-05).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TechFieldVisit from './TechFieldVisit';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(cleanup);

const ADDRESS = '123 Example Lane, Bradenton, FL 34205';
const SERVICE = {
  id: '22222222-2222-4222-8222-222222222222',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: ADDRESS,
  serviceType: 'Quarterly Pest Control',
};
const stop = { key: 'row:1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };
const detail = { status: 'ready', byService: {} };
const idle = {};

function renderVisit(props = {}) {
  const handlers = { onPhotos: vi.fn(), onProject: vi.fn(), onZone: vi.fn(), onLead: vi.fn() };
  render(
    <TechFieldVisit
      stop={stop} loading={false} error={null} onBack={() => {}} onRetry={() => {}} busy={false}
      enRouteState={idle} onSiteState={idle} onEnRoute={() => {}} onSite={() => {}} onSync={() => {}} onMove={() => {}}
    >
      <VisitBriefPanel stop={stop} detail={detail} {...handlers} {...props} />
    </TechFieldVisit>,
  );
  return handlers;
}

describe('open visit screen — admin look', () => {
  it('shows one Directions link and no second Navigate button', () => {
    renderVisit();
    expect(screen.getAllByRole('link', { name: /Directions/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Navigate/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Navigate/)).not.toBeInTheDocument();
  });

  it('shows the address once', () => {
    renderVisit();
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
  });

  it('labels the flag button and keeps it opening the lead modal handler', () => {
    const { onLead } = renderVisit();
    const flag = screen.getByRole('button', { name: 'Flag opportunity' });
    expect(flag).toHaveTextContent('Flag opportunity');
    fireEvent.click(flag);
    expect(onLead).toHaveBeenCalledWith(SERVICE);
  });

  it('uses line icons, not emoji, on every action and contact button', () => {
    renderVisit({ onOutcome: vi.fn() });
    const panel = screen.getByTestId('visit-brief-panel');
    const controls = [...panel.querySelectorAll('button, a')];
    expect(controls.map((el) => el.textContent.trim())).toEqual(
      expect.arrayContaining(['Call', 'Text', 'Report', 'Photos', 'Zone', 'Flag opportunity']),
    );
    controls.forEach((el) => {
      expect(el.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(el.querySelector('svg')).not.toBeNull();
      expect(el.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });
    expect(screen.getByRole('button', { name: 'Trace treatment zone' })).toBeInTheDocument();
  });

  it('draws section labels in sentence case, not UPPERCASE', () => {
    const withAlert = { ...SERVICE, propertyAlerts: [{ text: 'Dog in back yard' }] };
    const alertStop = { ...stop, services: [withAlert], primary: withAlert };
    render(<VisitBriefPanel stop={alertStop} detail={detail} onPhotos={() => {}} onProject={() => {}} onZone={() => {}} onLead={() => {}} />);
    const label = screen.getByText('Access');
    expect(label.style.textTransform).toBe('');
    expect(label.style.letterSpacing).toBe('');
    expect(screen.getByText('Actions').style.textTransform).toBe('');
  });
});
