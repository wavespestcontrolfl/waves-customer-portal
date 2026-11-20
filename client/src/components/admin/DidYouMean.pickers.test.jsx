// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrepGuideForm from './PrepGuideForm';
import ProjectFindingFieldInput from '../tech/ProjectFindingFieldInput';
import { renderWithDidYouMean } from './DidYouMean';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const exact = { id: 'e1', firstName: 'Orlan', lastName: 'Stompf', phone: '+19415550001', email: 'o@example.invalid' };
const sound = { id: 's1', firstName: 'Orlan', lastName: 'Stimpf', phone: '+19415550002', email: 's@example.invalid', approximate: true, matchReasons: [] };

function stubCustomers(customers) {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ customers }) }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const searchUrls = (fetcher) => fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/admin/customers?search='));
const order = (...texts) => texts.map((text) => document.body.textContent.indexOf(text));

describe('renderWithDidYouMean', () => {
  it('puts one divider before the first approximate row and keeps the exact rows first', () => {
    render(<div>{renderWithDidYouMean([exact, sound, { ...sound, id: 's2', lastName: 'Stampf' }], (row) => <p key={row.id}>{row.lastName}</p>)}</div>);
    expect(screen.getAllByTestId('did-you-mean')).toHaveLength(1);
    const [stompf, divider, stimpf] = order('Stompf', 'Did you mean', 'Stimpf');
    expect(stompf).toBeLessThan(divider);
    expect(divider).toBeLessThan(stimpf);
  });
  it('adds no divider when every row is exact', () => {
    render(<div>{renderWithDidYouMean([exact], (row) => <p key={row.id}>{row.lastName}</p>)}</div>);
    expect(screen.queryByTestId('did-you-mean')).toBeNull();
  });
});

describe('PrepGuideForm customer picker', () => {
  it('asks for suggestions and shows them under "Did you mean"', async () => {
    const fetcher = stubCustomers([exact, sound]);
    render(<PrepGuideForm active guide={{ pestType: 'flea', name: 'Flea treatment' }} initialSearch="Orlan Stompf" onSendingChange={() => {}} />);
    await screen.findByText('Orlan Stimpf');
    expect(searchUrls(fetcher)[0]).toContain('suggest=1');
    expect(screen.getAllByTestId('did-you-mean')).toHaveLength(1);
    const [stompf, divider, stimpf] = order('Orlan Stompf', 'Did you mean', 'Orlan Stimpf');
    expect(stompf).toBeLessThan(divider);
    expect(divider).toBeLessThan(stimpf);
  });
});

describe('PrepGuideForm how-to guide', () => {
  it('emails the guide with no channel choice, and offers the steps for the draft instead', async () => {
    const fetcher = stubCustomers([exact]);
    const onInsertSteps = vi.fn();
    render(<PrepGuideForm active guide={{ key: 'howto:alerts_iphone', name: 'Make app alerts show on iPhone', steps: ['Open Settings.'] }}
      initialSearch="Orlan Stompf" onSendingChange={() => {}} onInsertSteps={onInsertSteps} />);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(await screen.findByText('Orlan Stompf'));
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, message: 'Guide emailed.' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Send by email' }));
    await screen.findByText('Guide emailed.');
    const [url, init] = fetcher.mock.calls.at(-1);
    expect(String(url)).toContain('/admin/communications/send-howto');
    expect(JSON.parse(init.body)).toEqual({ customerId: 'e1', guideKey: 'alerts_iphone' });
    fireEvent.click(screen.getByRole('button', { name: 'Put the steps in my message instead' }));
    expect(onInsertSteps).toHaveBeenCalled();
  });
});

describe('ProjectFindingFieldInput customer search', () => {
  it('asks for suggestions and shows them under "Did you mean"', async () => {
    const fetcher = stubCustomers([exact, sound]);
    render(<ProjectFindingFieldInput field={{ key: 'customer', type: 'customer_search' }} id="c" name="c" value="Orlan Stompf" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole('textbox'));
    await screen.findByText('Orlan Stimpf', {}, { timeout: 2000 });
    expect(searchUrls(fetcher)[0]).toContain('suggest=1');
    expect(screen.getAllByTestId('did-you-mean')).toHaveLength(1);
    const [stompf, divider, stimpf] = order('Orlan Stompf', 'Did you mean', 'Orlan Stimpf');
    expect(stompf).toBeLessThan(divider);
    expect(divider).toBeLessThan(stimpf);
  });
});
