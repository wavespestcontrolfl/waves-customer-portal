// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TechTruckCheckCard from './TechTruckCheckCard';
import { lastCheckedLabel } from './useTruckKit';

afterEach(cleanup);
const mount = (kit) => render(<MemoryRouter><TechTruckCheckCard kit={kit} base="/admin/today" visitSearch="?visit=stop-1" /></MemoryRouter>);
const kit = (overrides = {}) => ({ enabled: true, truck: { id: 'v1', name: 'Synthetic truck' }, kit: [{ id: 'e1' }, { id: 'e2' }], lastCheck: null, due: true, ...overrides });

describe('TechTruckCheckCard', () => {
  it('renders only while a check is due', () => {
    const { container } = mount(kit({ due: false }));
    expect(container).toBeEmptyDOMElement();
    mount({ enabled: false });
    expect(screen.queryByText('Truck check due')).not.toBeInTheDocument();
    mount(kit({ truck: null }));
    expect(screen.queryByText('Truck check due')).not.toBeInTheDocument();
  });

  it('names the truck, says when it was last checked and links to the check keeping the open visit', () => {
    mount(kit());
    expect(screen.getByText('Truck check due')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Synthetic truck' })).toBeInTheDocument();
    expect(screen.getByText('Never checked · 2 items on the list')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check truck' })).toHaveAttribute('href', '/admin/today/truck-check?visit=stop-1');
  });
});

describe('lastCheckedLabel', () => {
  const now = new Date('2026-10-23T15:00:00Z');
  it('reads in whole days', () => {
    expect(lastCheckedLabel(null, now)).toBe('Never checked');
    expect(lastCheckedLabel('garbage', now)).toBe('Never checked');
    expect(lastCheckedLabel('2026-10-23T09:00:00Z', now)).toBe('Checked today');
    expect(lastCheckedLabel('2026-10-22T09:00:00Z', now)).toBe('Checked yesterday');
    expect(lastCheckedLabel('2026-10-14T09:00:00Z', now)).toBe('Last checked 9 days ago');
  });
});
