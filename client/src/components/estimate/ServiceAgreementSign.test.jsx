// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceAgreementSign, { SIGN_AGREEMENT_LABEL } from './ServiceAgreementSign';

const TOKEN = 'estimatetoken123';
const PEST = { lane: 'pest', title: 'Residential Pest Service Agreement', state: 'none', canSign: true };
const LAWN = { lane: 'lawn', title: 'Lawn & Ornamental Service Agreement', state: 'none', canSign: true };

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ServiceAgreementSign (accepted estimate page)', () => {
  it('renders nothing without the server block (gate off = unchanged page)', () => {
    const { container } = render(<ServiceAgreementSign token={TOKEN} serviceAgreements={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(render(<ServiceAgreementSign token={TOKEN} serviceAgreements={[]} />).container).toBeEmptyDOMElement();
  });

  it('one lane: the tap posts its lane and hands the customer to the signing page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ signingUrl: 'https://portal.example.test/contract/abc' }));
    vi.stubGlobal('fetch', fetchMock);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });

    const { getByTestId, getByText } = render(<ServiceAgreementSign token={TOKEN} serviceAgreements={[PEST]} />);
    expect(getByTestId('service-agreement-sign')).toBeInTheDocument();
    fireEvent.click(getByText(SIGN_AGREEMENT_LABEL));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://portal.example.test/contract/abc'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/estimates/${TOKEN}/service-agreement`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ lane: 'pest' });
  });

  it('two lanes: one button per agreement, each posting its own lane; a signed lane reads as signed', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ signingUrl: 'https://portal.example.test/contract/lawn' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });

    const { getByTestId, queryByTestId } = render(
      <ServiceAgreementSign token={TOKEN} serviceAgreements={[{ ...PEST, state: 'signed', canSign: false }, LAWN]} />,
    );
    expect(getByTestId('service-agreement-pest-signed')).toHaveTextContent('Residential Pest Service Agreement: signed.');
    expect(queryByTestId('service-agreement-pest')).not.toBeInTheDocument();
    fireEvent.click(getByTestId('service-agreement-lawn'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ lane: 'lawn' });
  });

  it('every lane signed: the thank-you card, no button', () => {
    const { getByTestId, queryByRole } = render(
      <ServiceAgreementSign token={TOKEN} serviceAgreements={[{ ...PEST, state: 'signed', canSign: false }]} />,
    );
    expect(getByTestId('service-agreement-signed')).toHaveTextContent('Service agreement signed');
    expect(queryByRole('button')).not.toBeInTheDocument();
  });

  it('no account: says to call, no button', () => {
    const { getByTestId, queryByRole } = render(
      <ServiceAgreementSign token={TOKEN} serviceAgreements={[{ ...PEST, canSign: false, reason: 'no_account' }]} />,
    );
    expect(getByTestId('service-agreement-call')).toBeInTheDocument();
    expect(queryByRole('button')).not.toBeInTheDocument();
  });

  it('a server 409 shows its own wording; any other failure shows the generic line and the button works again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Your service agreement is already signed. Please reload the page.', code: 'already_signed' }, 409))
      .mockResolvedValueOnce(jsonResponse({ error: 'Estimate not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });

    const { getByRole, getByText } = render(<ServiceAgreementSign token={TOKEN} serviceAgreements={[PEST]} />);
    fireEvent.click(getByText(SIGN_AGREEMENT_LABEL));
    await waitFor(() => expect(getByRole('alert')).toHaveTextContent('already signed'));
    expect(getByRole('button')).not.toBeDisabled();
    fireEvent.click(getByText(SIGN_AGREEMENT_LABEL));
    await waitFor(() => expect(getByRole('alert')).toHaveTextContent(/couldn’t open your agreement/));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
