// @vitest-environment jsdom
// The address box's state filter: by default a pick outside Florida is
// ignored (service-area forms); with anyState (the moving page) it reaches
// onSelect, so the parent never keeps stale typed text for a picked address.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddressAutocomplete from './AddressAutocomplete';

let placeChanged;
let place;

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  placeChanged = null;
  window.google = {
    maps: {
      places: {
        Autocomplete: vi.fn(function Autocomplete() {
          this.addListener = (event, fn) => { if (event === 'place_changed') placeChanged = fn; return { remove() {} }; };
          this.getPlace = () => place;
          this.unbindAll = () => {};
        }),
      },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete window.google;
});

const component = (types, long, short = long) => ({ types, long_name: long, short_name: short });
const georgia = {
  formatted_address: '12 Peach St, Atlanta, GA 30303, USA',
  address_components: [
    component(['street_number'], '12'),
    component(['route'], 'Peach Street', 'Peach St'),
    component(['locality'], 'Atlanta'),
    component(['administrative_area_level_1'], 'Georgia', 'GA'),
    component(['postal_code'], '30303'),
  ],
};

describe('AddressAutocomplete state filter', () => {
  it('ignores a pick outside Florida by default', () => {
    const onSelect = vi.fn();
    render(<AddressAutocomplete value="" onChange={() => {}} onSelect={onSelect} />);
    expect(placeChanged).toEqual(expect.any(Function));
    place = georgia;
    placeChanged();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('passes a pick outside Florida through with anyState', () => {
    const onSelect = vi.fn();
    render(<AddressAutocomplete value="" onChange={() => {}} onSelect={onSelect} anyState />);
    place = georgia;
    placeChanged();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      formatted: '12 Peach St, Atlanta, GA 30303, USA', city: 'Atlanta', state: 'GA', zip: '30303', source: 'suggestion',
    }));
  });
});
