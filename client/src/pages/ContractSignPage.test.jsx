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

describe('ContractSignPage contract text', () => {
  it('prints a line wrapped in ** in bold, without the markers (F.S. 482.227 bold statements)', async () => {
    const contract = {
      ...CONTRACT_A,
      contractTextSnapshot: '**RETREATMENT ONLY. THIS WARRANTY DOES NOT COVER DAMAGE REPAIR.**\nPlain clause.',
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ contract })));
    const { findByText, getByText, queryByText } = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );
    const bold = await findByText('RETREATMENT ONLY. THIS WARRANTY DOES NOT COVER DAMAGE REPAIR.');
    expect(bold.style.fontWeight).not.toBe('');
    expect(getByText('Plain clause.').style.fontWeight).toBe('');
    expect(queryByText(/\*\*/)).toBeNull();
  });
});

describe('ContractSignPage "Back to your estimate" (Florida consumer notice)', () => {
  const NOTICE = {
    ...CONTRACT_A,
    contractType: 'document_template',
    documentTemplateKey: 'consumer_notice.fdacs_13692',
    fromEstimate: true,
    title: 'Consumer Notice Form (FDACS-13692)',
  };
  const BACK = 'Back to your estimate';

  async function signContract(contract, { historyLength = 2 } = {}) {
    Object.defineProperty(window.history, 'length', { configurable: true, value: historyLength });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/sign')
      ? jsonResponse({ contract: { ...contract, status: 'signed', signedAt: '2026-10-25T14:00:00.000Z', signedName: 'Pat Owner' }, signed: true })
      : jsonResponse({ contract }))));
    const view = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(input(view.container, 'signedName')).toBeInTheDocument());
    fireEvent.change(input(view.container, 'initials'), { target: { value: 'PO' } });
    fireEvent.change(input(view.container, 'signedName'), { target: { value: 'Pat Owner' } });
    view.container.querySelectorAll('input[type="checkbox"]').forEach((cb) => { if (!cb.checked) fireEvent.click(cb); });
    fireEvent.submit(view.container.querySelector('form'));
    await waitFor(() => expect(view.getByText('Document signed')).toBeInTheDocument());
    return { ...view, back };
  }

  it('is not offered before the signature', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ contract: NOTICE })));
    const { container, queryByText } = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(input(container, 'signedName')).toBeInTheDocument());
    expect(queryByText(BACK)).toBeNull();
  });

  it('after signing a notice opened from the estimate, the button goes back in history', async () => {
    const { getByRole, back } = await signContract(NOTICE);
    fireEvent.click(getByRole('button', { name: BACK }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('is hidden when there is no history to go back to', async () => {
    const { queryByText } = await signContract(NOTICE, { historyLength: 1 });
    expect(queryByText(BACK)).toBeNull();
  });

  it('is hidden for a consumer notice staff issued by hand (no estimate marker)', async () => {
    const { fromEstimate: _drop, ...staffIssued } = NOTICE;
    const { queryByText } = await signContract(staffIssued);
    expect(queryByText(BACK)).toBeNull();
  });

  it('is hidden for any other document, even one carrying the marker', async () => {
    const { queryByText } = await signContract({ ...NOTICE, documentTemplateKey: 'service_agreement.commercial_pest' });
    expect(queryByText(BACK)).toBeNull();
  });
});

describe('ContractSignPage Auto Pay next step (commercial agreement, GATE_COMMERCIAL_AUTOPAY)', () => {
  const AGREEMENT = {
    ...CONTRACT_A,
    contractType: 'document_template',
    documentTemplateKey: 'service_agreement.commercial_pest',
    title: 'Commercial Pest Service Agreement',
  };

  async function signWith(signResponseExtra) {
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/sign')
      ? jsonResponse({ contract: { ...AGREEMENT, status: 'signed', signedAt: '2026-10-25T14:00:00.000Z', signedName: 'Pat Owner' }, signed: true, ...signResponseExtra })
      : jsonResponse({ contract: AGREEMENT }))));
    const view = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(input(view.container, 'signedName')).toBeInTheDocument());
    expect(view.queryByTestId('autopay-next-step')).toBeNull();
    fireEvent.change(input(view.container, 'initials'), { target: { value: 'PO' } });
    fireEvent.change(input(view.container, 'signedName'), { target: { value: 'Pat Owner' } });
    view.container.querySelectorAll('input[type="checkbox"]').forEach((cb) => { if (!cb.checked) fireEvent.click(cb); });
    fireEvent.submit(view.container.querySelector('form'));
    await waitFor(() => expect(view.getByText('Document signed')).toBeInTheDocument());
    return view;
  }

  it('offers "Save your card or bank account", which opens the Auto Pay setup link the server minted', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { getByRole, getByTestId } = await signWith({ autopaySetup: { state: 'setup', url: 'https://portal.example/secure/tok' } });
    expect(getByTestId('autopay-next-step')).toHaveTextContent('Save a card or bank account and each completed service is paid automatically. Nothing is charged today.');
    fireEvent.click(getByRole('button', { name: 'Save your card or bank account' }));
    expect(assign).toHaveBeenCalledWith('https://portal.example/secure/tok');
  });

  it('says Auto Pay is set up when the account is already on Auto Pay', async () => {
    const { getByTestId, queryByRole } = await signWith({ autopaySetup: { state: 'on' } });
    expect(getByTestId('autopay-next-step')).toHaveTextContent(/^Auto Pay is set up\. Nothing was charged today/);
    expect(queryByRole('button', { name: 'Save your card or bank account' })).toBeNull();
  });

  it('shows nothing new when the sign response carries no next step (Net 30, or any other contract)', async () => {
    const { queryByTestId } = await signWith({});
    expect(queryByTestId('autopay-next-step')).toBeNull();
  });
});

describe('ContractSignPage drawn signature', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const ctx = { clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), drawImage: vi.fn() };

  async function signWith({ draw }) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => PNG);
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ contract: { ...CONTRACT_A, status: 'signed', signedName: 'Alice Anderson', signedAt: '2026-10-26T12:00:00Z' }, signed: true });
      return jsonResponse({ contract: CONTRACT_A });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, getByTestId, getByRole } = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(input(container, 'signedName')).toBeInTheDocument());
    if (draw) {
      const canvas = getByTestId('drawn-signature-canvas');
      fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
      fireEvent.mouseMove(canvas, { clientX: 60, clientY: 40 });
      fireEvent.mouseUp(canvas);
    }
    fireEvent.change(input(container, 'initials'), { target: { value: 'AA' } });
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    boxes.forEach((box) => fireEvent.click(box));
    fireEvent.click(getByRole('button', { name: /Sign Document/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST');
    return JSON.parse(init.body);
  }

  it('sends the drawn PNG with the sign POST when something was drawn', async () => {
    const body = await signWith({ draw: true });
    expect(body).toMatchObject({ initials: 'AA', signedName: 'Alice Anderson', signatureImage: PNG, agreeElectronic: true, agreeDocumentTerms: true });
  });

  it('omits signatureImage when the pad was left blank (typed signature only, as before)', async () => {
    const body = await signWith({ draw: false });
    expect(body).toMatchObject({ initials: 'AA', signedName: 'Alice Anderson' });
    expect(body).not.toHaveProperty('signatureImage');
  });
});

describe('ContractSignPage layout and printing', () => {
  it('keeps the earlier web layout (no Field paper body) and prints the whole terms box', async () => {
    const contract = { ...CONTRACT_A, contractTextSnapshot: 'First clause.\nSecond clause.' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ contract })));
    const { findByText, container } = render(
      <MemoryRouter initialEntries={[`/contract/${CONTRACT_A.token}`]}>
        <Routes><Route path="/contract/:token" element={<ContractSignPage />} /></Routes>
      </MemoryRouter>,
    );
    await findByText(/First clause\./);
    expect(container.querySelector('.waves-field-document-body, .field-document-masthead')).toBeNull();
    expect(container.querySelector('.waves-contract-terms')).not.toBeNull();
    const printRules = Array.from(container.querySelectorAll('style')).map((el) => el.textContent).join(' ');
    expect(printRules).toContain('@media print');
    expect(printRules).toContain('.waves-contract-terms { max-height: none !important; overflow: visible !important; }');
  });
});
