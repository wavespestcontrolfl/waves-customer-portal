// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubscribersView } from './NewsletterTabs';

const subscriber = {
  id: 'subscriber-1',
  email: 'reader@example.com',
  status: 'active',
  source: 'footer',
  subscribed_at: '2030-01-02T15:00:00.000Z',
  bounce_count: 0,
};

function response(body, ok = true, status = 200) {
  return { ok, status, json: vi.fn(async () => body) };
}

function subscriberList() {
  return response({
    subscribers: [subscriber],
    counts: { active: 1, pending: 0, unsubscribed: 0, bounced: 0, all: 1 },
  });
}

describe('Newsletter subscriber dialogs', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    vi.stubGlobal('prompt', vi.fn());
    vi.stubGlobal('confirm', vi.fn());
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('adds only after dialog confirmation and preserves the POST payload', async () => {
    let resolvePost;
    const postResponse = new Promise((resolve) => { resolvePost = resolve; });
    const fetchMock = vi.fn((url, options = {}) => {
      if (options.method === 'POST') return postResponse;
      return Promise.resolve(subscriberList());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SubscribersView />);

    await screen.findByText('reader@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subscriber' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add subscriber' });
    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, options = {}]) => options.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add Subscriber' }));
    dialog = await screen.findByRole('dialog', { name: 'Add subscriber' });
    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: 'new@example.com' },
    });
    const addButton = within(dialog).getByRole('button', { name: 'Add subscriber' });
    expect(addButton).toHaveAttribute('type', 'submit');
    fireEvent.submit(addButton.closest('form'));
    fireEvent.click(addButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/newsletter/subscribers',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@example.com' }),
      }),
    ));
    expect(fetchMock.mock.calls.filter(([, options = {}]) => options.method === 'POST')).toHaveLength(1);
    resolvePost(response({ success: true }));
    expect(await screen.findByText('Added new@example.com.')).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('confirms a CSV import with the selected consent mode and does not import on cancel', async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (options.method === 'POST') return Promise.resolve(response({ inserted: 1, skipped: 0 }));
      return Promise.resolve(subscriberList());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<SubscribersView />);
    await screen.findByText('reader@example.com');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Existing opt-in consent' }));
    const fileInput = container.querySelector('input[type="file"]');
    const csv = { text: vi.fn(async () => 'email,first_name,last_name\nimport@example.com,Import,Reader') };
    fireEvent.change(fileInput, { target: { files: [csv] } });
    let dialog = await screen.findByRole('dialog', { name: 'Import subscribers?' });
    expect(dialog).toHaveTextContent('1 subscriber rows as active and immediately mailable');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, options = {}]) => options.method === 'POST')).toBe(false);

    fireEvent.change(fileInput, { target: { files: [csv] } });
    dialog = await screen.findByRole('dialog', { name: 'Import subscribers?' });
    const importButton = within(dialog).getByRole('button', { name: 'Import subscribers' });
    expect(importButton).toHaveAttribute('type', 'submit');
    expect(importButton).toHaveFocus();
    fireEvent.submit(importButton.closest('form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/newsletter/subscribers/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          subscribers: [{ email: 'import@example.com', firstName: 'Import', lastName: 'Reader' }],
          source: 'admin_import',
          preConsented: true,
        }),
      }),
    ));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps unsubscribe failures in the dialog for a safe retry', async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (options.method === 'DELETE') {
        return Promise.resolve(response({ error: 'Synthetic failure' }, false, 500));
      }
      return Promise.resolve(subscriberList());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SubscribersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe' }));

    const dialog = await screen.findByRole('dialog', { name: 'Unsubscribe subscriber?' });
    expect(dialog).toHaveTextContent('Unsubscribe reader@example.com?');
    const unsubscribeButton = within(dialog).getByRole('button', { name: 'Unsubscribe' });
    expect(unsubscribeButton).toHaveAttribute('type', 'submit');
    expect(unsubscribeButton).toHaveFocus();
    fireEvent.submit(unsubscribeButton.closest('form'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Failed: Synthetic failure');
    expect(screen.getByRole('dialog', { name: 'Unsubscribe subscriber?' })).toBeInTheDocument();
    expect(alert).not.toHaveBeenCalled();
  });
});
