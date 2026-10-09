// @vitest-environment jsdom
// The lawn report's "Add your weekly inches in your portal" button points at /?tab=property#irrigation
// (GATE_LAWN_REPORT_POLISH). The Irrigation section carries id="irrigation" and scrolls into view on arrival with that
// hash; a visit without the hash scrolls nothing. The Weekly Inches field is there for a lawn customer.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    getWateringPlan: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab } from './PortalPage';

const lawnCustomer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Gold', property: {} };
const scrolled = [];
const irrigationSection = () => waitFor(() => { const el = document.getElementById('irrigation'); expect(el).not.toBeNull(); return el; }).then(() => document.getElementById('irrigation'));

beforeEach(() => {
  vi.clearAllMocks();
  scrolled.length = 0;
  api.getWateringPlan.mockResolvedValue({ available: false });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: true });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  Element.prototype.scrollIntoView = function scrollIntoView(options) { scrolled.push({ id: this.id, options }); };
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  delete Element.prototype.scrollIntoView;
  vi.restoreAllMocks();
});

describe('the portal Irrigation section is the target of the report button', () => {
  it('has id="irrigation" and scrolls to it once the tab has loaded, when the URL carries #irrigation', async () => {
    window.history.replaceState(null, '', '/?tab=property#irrigation');
    render(<PropertyTab customer={lawnCustomer} />);
    const target = await irrigationSection();
    expect(target.tagName).toBe('SECTION');
    expect(target).toHaveTextContent('Irrigation system');
    await waitFor(() => expect(scrolled.filter((entry) => entry.id === 'irrigation').length).toBeGreaterThanOrEqual(1));
    expect(scrolled[0].options).toMatchObject({ block: 'start' });
  });

  it('scrolls nothing on a plain /?tab=property visit, and no other section is scrolled to', async () => {
    window.history.replaceState(null, '', '/?tab=property');
    render(<PropertyTab customer={lawnCustomer} />);
    await irrigationSection();
    await new Promise((resolve) => { setTimeout(resolve, 900); }); // past the one late re-scroll
    expect(scrolled).toEqual([]);
  });

  it('a different hash scrolls nothing', async () => {
    window.history.replaceState(null, '', '/?tab=property#billing-autopay');
    render(<PropertyTab customer={lawnCustomer} />);
    await irrigationSection();
    await new Promise((resolve) => { setTimeout(resolve, 900); }); // past the one late re-scroll
    expect(scrolled).toEqual([]);
  });

  it('the Weekly Inches field is in that section for a lawn customer', async () => {
    window.history.replaceState(null, '', '/?tab=property#irrigation');
    render(<PropertyTab customer={lawnCustomer} />);
    await irrigationSection();
    expect(document.getElementById('irrigation')).toHaveTextContent('Weekly Inches');
  });

  it('a customer the server does not count as lawn care sees no Weekly Inches field (the report button cannot help them)', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false });
    window.history.replaceState(null, '', '/?tab=property#irrigation');
    render(<PropertyTab customer={{ ...lawnCustomer, tier: null }} />);
    await irrigationSection();
    expect(document.getElementById('irrigation')).not.toHaveTextContent('Weekly Inches');
  });
});
