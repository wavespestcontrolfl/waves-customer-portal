// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let CustomerMap;
let markers;
let geocodeCalls;

function installGoogleMaps() {
  markers = [];
  geocodeCalls = 0;
  class Marker {
    constructor(options) { this.options = options; this.listeners = {}; markers.push(this); }
    addListener(name, fn) { this.listeners[name] = fn; }
    setMap() {}
  }
  class LatLngBounds {
    extend() {}
    getNorthEast() { return { equals: () => false }; }
    getSouthWest() { return {}; }
    getCenter() { return {}; }
  }
  window.google = {
    maps: {
      Map: class { fitBounds() {} setCenter() {} setZoom() {} },
      Marker,
      LatLngBounds,
      InfoWindow: class { close() {} },
      Geocoder: class { geocode() { geocodeCalls += 1; } },
      SymbolPath: { CIRCLE: 0 },
    },
  };
}

function row(id, overrides = {}) {
  return { id, firstName: `F${id}`, lastName: `L${id}`, address: '10 Palm Ave, Naples, FL', city: 'Naples', tier: 'Gold', ...overrides };
}

describe('CustomerMap', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
    localStorage.setItem('waves_admin_token', 'test-token');
    installGoogleMaps();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('CustomerMap must not fetch'))));
    ({ CustomerMap } = await import('./CustomersPage'));
  });

  afterEach(() => {
    cleanup();
    delete window.google;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('places markers from stored coordinates only and counts located, not-located and no-address rows apart', async () => {
    const rows = [
      row('a', { lat: 27.5, lng: -82.5 }),
      row('b', { lat: '27.6', lng: '-82.4' }),
      row('c', { lat: null, lng: null }),
      row('d'),
      row('e', { address: '', city: '', lat: null, lng: null }),
      row('f', { lat: 0, lng: 0 }),
    ];
    render(<CustomerMap customers={rows} total={6} onSelect={() => {}} />);
    expect(await screen.findByText('2 mapped · 3 not on the map yet · 1 no address')).toBeInTheDocument();
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.options.position)).toEqual([{ lat: 27.5, lng: -82.5 }, { lat: 27.6, lng: -82.4 }]);
    expect(geocodeCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it('never geocodes or fetches, whatever the row count', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => row(`r${i}`));
    render(<CustomerMap customers={rows} total={450} onSelect={() => {}} />);
    expect(await screen.findByText('0 mapped · 450 not on the map yet · 0 no address')).toBeInTheDocument();
    expect(markers).toHaveLength(0);
    expect(geocodeCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says how many of the matching customers it shows when the load hit its cap', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`, { lat: 27.5 + i / 100, lng: -82.5 }));
    render(<CustomerMap customers={rows} total={6200} onSelect={() => {}} />);
    expect(await screen.findByText(/5 mapped · 0 not on the map yet · 0 no address · Showing 5 of 6200 customers/)).toBeInTheDocument();
  });

  it('counts the tier and stage filter against the rows it was given', async () => {
    const rows = [row('a', { lat: 27.5, lng: -82.5, tier: 'Gold' }), row('b', { lat: 27.6, lng: -82.5, tier: 'Silver' })];
    render(<CustomerMap customers={rows} total={2} onSelect={() => {}} />);
    await screen.findByText('2 mapped · 0 not on the map yet · 0 no address');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Gold' } });
    expect(await screen.findByText('1 mapped · 0 not on the map yet · 0 no address')).toBeInTheDocument();
  });

  it('shows a loading note instead of counts while the Directory reloads rows', async () => {
    render(<CustomerMap customers={[]} total={0} loading onSelect={() => {}} />);
    expect(await screen.findByText('Loading customers…')).toBeInTheDocument();
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());
  });
});
