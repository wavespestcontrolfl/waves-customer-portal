// @vitest-environment jsdom
// Customer soft exit — the "Not what you expected?" sheet. Three exits: a
// change request (note required), a still-deciding signal (one tap), and a
// reason-tagged decline (chip required; "Other" needs a note; competitor
// gets name + price fields). Every exit talks to the server exactly once.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoftExitSheet, SOFT_EXIT_REASONS } from './EstimateViewPage';

afterEach(() => cleanup());

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, method: init.method, body: JSON.parse(init.body) };
}

describe('SoftExitSheet', () => {
  it('opens on the chooser with the three exits and no server call', () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Not what you expected?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change something/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /still deciding/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /isn’t for me/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still deciding is one tap → one POST, and a Done that never declines', async () => {
    const onDeclined = vi.fn();
    const onClose = vi.fn();
    render(<SoftExitSheet token="tok" expiresAt="2026-09-15T04:00:00.000Z" onClose={onClose} onDeclined={onDeclined} />);
    fireEvent.click(screen.getByRole('button', { name: /still deciding/i }));
    await waitFor(() => expect(screen.getByText(/stays open through September 1[45]/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall()).toMatchObject({ url: expect.stringMatching(/\/estimates\/tok\/change-request$/), method: 'POST', body: { kind: 'still_deciding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDeclined).not.toHaveBeenCalled();
  });

  it('a change request needs a note and sends topics + note', async () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /change something/i }));
    const submit = screen.getByRole('button', { name: 'Request a revised estimate' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'The price' }));
    fireEvent.change(screen.getByLabelText('What should be different?'), { target: { value: 'Drop mosquito, keep pest.' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/send an updated estimate/i)).toBeInTheDocument());
    expect(lastCall()).toMatchObject({ method: 'POST', body: { kind: 'change', topics: ['price'], note: 'Drop mosquito, keep pest.' } });
  });

  it('a decline needs a reason; competitor reveals name + price; the commit PUTs /decline and reloads on Done', async () => {
    const onDeclined = vi.fn();
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={onDeclined} />);
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    const submit = screen.getByRole('button', { name: 'Close this estimate' });
    expect(submit).toBeDisabled();
    for (const { label } of SOFT_EXIT_REASONS) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    expect(screen.queryByLabelText('Who did you go with?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Going with someone else' }));
    fireEvent.change(screen.getByLabelText('Who did you go with?'), { target: { value: 'Bugs-R-Us' } });
    fireEvent.change(screen.getByLabelText('Their price'), { target: { value: '39' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/closed this estimate/i)).toBeInTheDocument());
    expect(lastCall()).toMatchObject({
      url: expect.stringMatching(/\/estimates\/tok\/decline$/),
      method: 'PUT',
      body: { reason: 'competitor', competitorName: 'Bugs-R-Us', competitorPrice: '39' },
    });
    expect(onDeclined).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDeclined).toHaveBeenCalledTimes(1);
  });

  it('"Something else" stays disabled until a note is typed', () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Something else' }));
    const submit = screen.getByRole('button', { name: 'Close this estimate' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tell us a little more'), { target: { value: 'moving' } });
    expect(submit).toBeEnabled();
  });

  it('surfaces the server error and stays on the step', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Tell us a little more so we can do better next time.' }) });
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Too expensive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close this estimate' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/little more/));
    expect(screen.getByRole('button', { name: 'Close this estimate' })).toBeInTheDocument();
  });
});
