// @vitest-environment jsdom
// The visit job card opens from the Today visit (owner 2026-11-04, C16).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TechFieldVisit from './TechFieldVisit';

afterEach(cleanup);

const SERVICE = { id: 'svc-1', status: 'confirmed', customerName: 'Pat Sample', address: '123 Example Lane, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control' };
const stop = { key: 'row:1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };
const idle = {};

function renderVisit(props = {}) {
  render(<TechFieldVisit stop={stop} loading={false} error={null} onBack={() => {}} onRetry={() => {}} busy={false}
    enRouteState={idle} onSiteState={idle} onEnRoute={() => {}} onSite={() => {}} onSync={() => {}} onMove={() => {}} {...props} />);
}

describe('Job card action on the Today visit', () => {
  it('opens the job card for the visit service', () => {
    const onJobCard = vi.fn();
    renderVisit({ onJobCard });
    fireEvent.click(screen.getByRole('button', { name: 'Job card' }));
    expect(onJobCard).toHaveBeenCalledWith(SERVICE);
  });

  it('shows no Job card button when the page gives no handler', () => {
    renderVisit();
    expect(screen.queryByRole('button', { name: 'Job card' })).not.toBeInTheDocument();
  });

  it('gives a grouped stop one Job card button per service, each opening its own card', () => {
    const lawn = { id: 'svc-2', status: 'confirmed', customerName: 'Pat Sample', address: SERVICE.address, serviceType: 'Lawn Care' };
    const grouped = { ...stop, services: [SERVICE, lawn], primary: SERVICE, liveCount: 2 };
    const onJobCard = vi.fn();
    renderVisit({ stop: grouped, onJobCard });
    expect(screen.queryByRole('button', { name: 'Job card' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Job card: Lawn Care' }));
    expect(onJobCard).toHaveBeenCalledWith(lawn);
    fireEvent.click(screen.getByRole('button', { name: 'Job card: Quarterly Pest Control' }));
    expect(onJobCard).toHaveBeenLastCalledWith(SERVICE);
  });
});
