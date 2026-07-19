// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContractSignPage from './ContractSignPage';

vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/DocumentActionBar', () => ({ default: () => null }));
vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CONTRACT_A = {
  id: 'contract-a',
  token: 'a'.repeat(64),
  recipientName: 'Alice Anderson',
  status: 'sent',
  requiresSignature: true,
  contractType: 'service_agreement',
  serviceName: 'Quarterly Pest Control',
};
const CONTRACT_B = {
  ...CONTRACT_A,
  id: 'contract-b',
  token: 'b'.repeat(64),
  recipientName: 'Bob Booker',
};

function input(container, name) {
  return container.querySelector(`input[name="${name}"]`);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ContractSignPage token-change reset (audit P1)', () => {
  it('does not carry contract A signer input into contract B on a token change', async () => {
    const fetchMock = vi.fn(async (url) => {
      const path = String(url);
      if (path.includes(CONTRACT_A.token)) return jsonResponse({ contract: CONTRACT_A });
      if (path.includes(CONTRACT_B.token)) return jsonResponse({ contract: CONTRACT_B });
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    // In-app navigation from A to B on the SAME route keeps the component
    // instance mounted (the exact scenario the bug depends on). A <Link> click
    // changes only the :token param — MemoryRouter's initialEntries is
    // mount-only, so it can't drive this.
    const { container, getByText } = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Link to={`/contract/${CONTRACT_B.token}`}>go-to-B</Link>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(input(container, 'signedName')).toBeInTheDocument());
    // A's signer seeds from A's recipient, then types their own initials.
    expect(input(container, 'signedName')).toHaveValue('Alice Anderson');
    fireEvent.change(input(container, 'initials'), { target: { value: 'AA' } });
    fireEvent.change(input(container, 'signedName'), { target: { value: 'Alice Anderson' } });
    expect(input(container, 'initials')).toHaveValue('AA');

    fireEvent.click(getByText('go-to-B'));

    await waitFor(() => expect(input(container, 'signedName')).toHaveValue('Bob Booker'));
    // B starts clean: no leftover initials, and the signature seeds from B's
    // recipient, never A's typed name.
    expect(input(container, 'initials')).toHaveValue('');
    expect(input(container, 'signedName')).not.toHaveValue('Alice Anderson');
  });

  it('a sign POST that resolves after the token changed does not overwrite the new contract', async () => {
    let resolveSignA;
    const fetchMock = vi.fn(async (url, opts) => {
      const path = String(url);
      if (path.includes('/sign')) {
        // Hold contract A's sign response open until we release it.
        return new Promise((resolve) => {
          resolveSignA = () => resolve(jsonResponse({ contract: { ...CONTRACT_A, status: 'signed' } }));
        });
      }
      if (path.includes(CONTRACT_A.token)) return jsonResponse({ contract: CONTRACT_A });
      if (path.includes(CONTRACT_B.token)) return jsonResponse({ contract: CONTRACT_B });
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container, getByText } = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Link to={`/contract/${CONTRACT_B.token}`}>go-to-B</Link>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(input(container, 'signedName')).toHaveValue('Alice Anderson'));
    fireEvent.change(input(container, 'initials'), { target: { value: 'AA' } });
    fireEvent.change(input(container, 'signedName'), { target: { value: 'Alice Anderson' } });
    // Satisfy canSubmit: check every agreement box regardless of contract type.
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => { if (!cb.checked) fireEvent.click(cb); });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/sign'))).toBe(true));

    // Navigate to B while A's sign POST is still pending, then release A.
    fireEvent.click(getByText('go-to-B'));
    await waitFor(() => expect(input(container, 'signedName')).toHaveValue('Bob Booker'));
    if (resolveSignA) resolveSignA();

    // B must remain the shown, unsigned contract — A's late signed response
    // is discarded (the shell still shows B's signer field, not a signed
    // confirmation for A).
    await waitFor(() => expect(input(container, 'signedName')).toHaveValue('Bob Booker'));
    expect(input(container, 'signedName')).toBeInTheDocument();
  });
});
