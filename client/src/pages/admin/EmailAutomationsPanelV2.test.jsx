// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EmailAutomationsPanelV2 from './EmailAutomationsPanelV2';
import panelSource from './EmailAutomationsPanelV2.jsx?raw';

const TEMPLATE = {
  key: 'welcome',
  name: 'Welcome sequence',
  description: 'Sent after sign-up',
  asm_group: 'Onboarding',
  enabled: true,
  has_local_content: true,
  step_count: 1,
  enrollment_counts: { active: 2 },
};

const DETAIL = {
  template: TEMPLATE,
  steps: [{
    id: 'step-1',
    delay_hours: 0,
    subject: 'Hello there',
    preview_text: 'Hi',
    html_body: '<p>Hi</p>',
    text_body: 'Hi',
    enabled: true,
  }],
};

function response(body, ok = true, status = 200) {
  return { ok, status, json: vi.fn(async () => body) };
}

const DETAIL_URL = '/api/admin/automations/templates/welcome';

function detailCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url, options = {}]) => (
    url === DETAIL_URL && !options.method
  ));
}

// detailResponses: one entry per GET of the detail route, in order.
function stubFetch(detailResponses) {
  const queue = [...detailResponses];
  const fetchMock = vi.fn((url, options = {}) => {
    if (url === '/api/admin/automations/templates') {
      return Promise.resolve(response({ templates: [TEMPLATE] }));
    }
    if (url === DETAIL_URL && !options.method) {
      return Promise.resolve(queue.shift() || response(DETAIL));
    }
    return Promise.resolve(response({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openEditor() {
  const button = await screen.findByRole('button', { name: 'Edit steps' });
  button.focus();
  fireEvent.click(button);
  return button;
}

describe('Automations panel editor', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'admin-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('shows a failed template detail load with Retry, and Retry fetches again', async () => {
    const fetchMock = stubFetch([response({ error: 'Database unavailable' }, false, 500)]);
    render(<EmailAutomationsPanelV2 />);
    await openEditor();

    const dialog = await screen.findByRole('dialog');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load this automation');
    expect(alert).toHaveTextContent('Database unavailable');
    expect(within(alert).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(detailCalls(fetchMock)).toHaveLength(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await within(dialog).findByText('Sent after sign-up');
    expect(detailCalls(fetchMock)).toHaveLength(2);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Welcome sequence' })).toBeInTheDocument();
  });

  it('issues a fresh request when Edit steps is clicked again after a failed load', async () => {
    const fetchMock = stubFetch([response({ error: 'boom' }, false, 500)]);
    render(<EmailAutomationsPanelV2 />);
    await openEditor();

    const dialog = await screen.findByRole('dialog');
    const alert = await within(dialog).findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openEditor();
    expect(await screen.findByRole('dialog', { name: 'Welcome sequence' })).toBeInTheDocument();
    expect(detailCalls(fetchMock)).toHaveLength(2);
  });

  it('announces the editor as a named dialog, closes on Escape and restores focus', async () => {
    stubFetch([]);
    render(<EmailAutomationsPanelV2 />);
    const opener = await openEditor();

    // Loading state is already part of the labelled dialog surface.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    const dialog = await screen.findByRole('dialog', { name: 'Welcome sequence' });
    await within(dialog).findByText('Sent after sign-up');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('keeps Tab inside the editor', async () => {
    stubFetch([]);
    render(<EmailAutomationsPanelV2 />);
    await openEditor();
    const dialog = await screen.findByRole('dialog', { name: 'Welcome sequence' });
    await within(dialog).findByText('Sent after sign-up');

    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab' });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes only the step preview on Escape and leaves the editor open', async () => {
    stubFetch([]);
    render(<EmailAutomationsPanelV2 />);
    await openEditor();
    const editor = await screen.findByRole('dialog', { name: 'Welcome sequence' });
    await within(editor).findByText('Sent after sign-up');

    const previewButton = within(editor).getByRole('button', { name: 'Preview' });
    previewButton.focus();
    fireEvent.click(previewButton);
    const preview = await screen.findByRole('dialog', { name: 'Step preview' });
    expect(preview.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Step preview' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Welcome sequence' })).toBeInTheDocument();
    expect(previewButton).toHaveFocus();
  });

  it('renders no text below the 14px readability floor', () => {
    const source = panelSource;
    expect(source.match(/\btext-(?:11|12|13|xs)\b/g)).toBeNull();
    expect(source.match(/text-\[\d+px\]/g)).toBeNull();
  });

  it('renders the list and the open editor without sub-14px text classes', async () => {
    stubFetch([]);
    const { baseElement } = render(<EmailAutomationsPanelV2 />);
    await openEditor();
    const editor = await screen.findByRole('dialog', { name: 'Welcome sequence' });
    await within(editor).findByText('Sent after sign-up');
    const small = '[class~="text-11"], [class~="text-12"], [class~="text-13"]';
    expect(baseElement.querySelectorAll(small)).toHaveLength(0);
  });
});
