// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ActionQueuePane from './ActionQueuePane';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('retries a failed alert hydration and shows the recovered queue', async () => {
  let finishRetry;
  fetch
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockReturnValueOnce(new Promise((resolve) => { finishRetry = resolve; }));
  render(<ActionQueuePane feedbackRetryEnabled />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load alerts: HTTP 503');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Loading alerts…')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

  await act(async () => finishRetry({ ok: true, json: async () => ({ alerts: [] }) }));
  expect(await screen.findByText('No active alerts.')).toBeInTheDocument();
});

it('keeps the existing static alert error when feedback retries are off', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 503 });
  render(<ActionQueuePane />);

  expect(await screen.findByText('Failed to load alerts: HTTP 503')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});
