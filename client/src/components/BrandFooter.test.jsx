// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import BrandFooter from './BrandFooter';

afterEach(cleanup);

describe('BrandFooter', () => {
  it('gives social links and store badge links at least 44px touch dimensions and AA muted contrast', () => {
    render(<BrandFooter />);

    const appStore = screen.getByRole('link', { name: 'Download on the App Store' });
    const playStore = screen.getByRole('link', { name: 'Get it on Google Play' });
    expect(appStore.style.minHeight).toBe('44px');
    expect(playStore.style.minHeight).toBe('44px');

    const facebook = screen.getByRole('link', { name: 'Facebook' });
    expect(facebook.style.width).toBe('44px');
    expect(facebook.style.height).toBe('44px');

    const copyright = screen.getByText(/All rights reserved/i);
    expect(copyright.style.color).toBe('rgb(63, 74, 101)');
  });

  it('uses 44px social icon targets in compact contact variant', () => {
    render(<BrandFooter variant="contact" />);
    const instagram = screen.getByRole('link', { name: 'Instagram' });
    expect(instagram.style.width).toBe('44px');
    expect(instagram.style.height).toBe('44px');
  });
});
