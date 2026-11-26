// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WavesShell from './WavesShell';
import BackToAccountButton from './BackToAccount';

const env = vi.hoisted(() => ({ native: false, session: false }));
vi.mock('../../native/platform', () => ({
  isNativeApp: () => env.native,
  hasSessionToken: () => env.session,
  isWavesAdminApp: () => false,
  nativePlatform: () => (env.native ? 'ios' : 'web'),
}));
vi.mock('../BrandFooter', () => ({ default: () => null }));
vi.mock('./TrustFooter', () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  env.native = false;
  env.session = false;
});

const BACK = () => screen.queryByRole('link', { name: 'Back to my account' });

describe('Back to my account (header)', () => {
  it('shows in the native app with a customer session', () => {
    env.native = true; env.session = true;
    render(<WavesShell><p>page</p></WavesShell>);
    expect(BACK()).toBeInTheDocument();
    expect(BACK()).toHaveAttribute('href', '/');
  });

  it.each([
    ['on the web, signed in', false, true],
    ['in the native app, signed out', true, false],
    ['on the web, signed out', false, false],
  ])('is hidden %s', (_label, native, session) => {
    env.native = native; env.session = session;
    render(<WavesShell><p>page</p></WavesShell>);
    expect(BACK()).toBeNull();
  });

  it('is never shown in the locked hand-off shell, even native + signed in', () => {
    env.native = true; env.session = true;
    render(<WavesShell locked><p>page</p><BackToAccountButton /></WavesShell>);
    expect(BACK()).toBeNull();
    expect(screen.queryByText('Back to my account')).toBeNull();
  });

  it('navigates inside the SPA when a router is present', () => {
    env.native = true; env.session = true;
    render(
      <MemoryRouter initialEntries={['/pay/abc']}>
        <Routes>
          <Route path="/pay/:token" element={<WavesShell><p>pay page</p></WavesShell>} />
          <Route path="/" element={<p>account home</p>} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(BACK());
    expect(screen.getByText('account home')).toBeInTheDocument();
  });
});

describe('Back to my account (button)', () => {
  it('renders the full-width button only for native + session, outside a locked shell', () => {
    env.native = true; env.session = true;
    render(<WavesShell><BackToAccountButton /></WavesShell>);
    // One in the header bar, one full-width button in the page body.
    const links = screen.getAllByRole('link', { name: /Back to my account/ });
    expect(links).toHaveLength(2);
    expect(screen.getByText('Back to my account')).toHaveAttribute('href', '/');
  });

  it('renders nothing on the web', () => {
    env.session = true;
    render(<WavesShell><BackToAccountButton /></WavesShell>);
    expect(screen.queryByText('Back to my account')).toBeNull();
  });
});
