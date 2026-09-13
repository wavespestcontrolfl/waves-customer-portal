// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';
import ReceiptPage from './ReceiptPage';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
// PublicStateCard and BrandCard come through for real: they are leaf
// presentational components, and these suites assert on the terminal-state
// markup they produce. Everything heavier stays stubbed.
vi.mock('../components/brand', async (importOriginal) => ({
  ...(await importOriginal()),
  WavesShell: ({ children }) => <div>{children}</div>,
  CustomerColumn: ({ children, ...props }) => <div {...props}>{children}</div>,
  BrandCard: ({ children }) => <section>{children}</section>,
  BrandButton: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
  SerifHeading: ({ children }) => <h1>{children}</h1>,
  HelpPhoneLink: () => <span>call Waves</span>,
}));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/DocumentActionBar', () => ({ default: () => null }));

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function renderAt(path, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path={path.replace('deadbeef', ':token')} element={element} /></Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public billing-link load states', () => {
  it('shows a retryable invoice outage instead of saying the invoice is missing', async () => {
    const fetchMock = vi.fn(async () => response(503));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/pay/deadbeef', <PayPageV2 />);

    expect(await screen.findByText("We couldn't load that invoice")).toBeInTheDocument();
    expect(screen.queryByText("We couldn't find that invoice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('shows a retryable receipt outage instead of saying the receipt is missing', async () => {
    const fetchMock = vi.fn(async () => response(503));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/receipt/deadbeef', <ReceiptPage />);

    expect(await screen.findByText("We couldn't load that receipt")).toBeInTheDocument();
    expect(screen.queryByText("We couldn't find that receipt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
