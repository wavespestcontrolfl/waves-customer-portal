// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

let pestRecapEnabled = false;
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: (name) => ({
    enabled: name === 'pest-recap-v1' && pestRecapEnabled,
    ready: true,
  }),
}));

const service = {
  id: 'completion-shell-visit',
  customerId: 'completion-shell-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Pest Control',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 100,
};

const draftKey = `waves_completion_draft_${service.id}`;
const notes = () => screen.getByPlaceholderText('Notes about this service...');

function ShellHarness({ onClosed = vi.fn(), ...panelProps }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open completion</button>
      {open && (
        <CompletionPanel
          service={service}
          products={[]}
          onClose={(completed) => {
            onClosed(completed);
            setOpen(false);
          }}
          onSubmit={vi.fn().mockResolvedValue({})}
          {...panelProps}
        />
      )}
    </>
  );
}

async function renderPanel(props = {}) {
  let view;
  await act(async () => {
    view = render(
      <CompletionPanel
        service={service}
        products={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue({})}
        {...props}
      />,
    );
  });
  return view;
}

beforeEach(() => {
  pestRecapEnabled = false;
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ customer: {}, actions: [], available: false }),
  })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('CompletionPanel dialog shell', () => {
  it('opens as a named dialog, preserves the draft on Escape, and restores the opener', async () => {
    const onClosed = vi.fn();
    render(<ShellHarness onClosed={onClosed} />);
    const opener = screen.getByRole('button', { name: 'Open completion' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: /Complete Service/i });
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.position).toBe('fixed');

    fireEvent.change(notes(), { target: { value: 'Keep this unfinished visit note' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /Complete Service/i })).toBeNull();
    expect(onClosed).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.position).toBe('');
    expect(JSON.parse(localStorage.getItem(draftKey))).toMatchObject({
      notes: 'Keep this unfinished visit note',
    });
  });

  it('moves the modal focus boundary to the completion result', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue({
      completionAdvisories: ['Synthetic follow-up advisory'],
    });
    await renderPanel({ onClose, onSubmit });

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));

    const result = await screen.findByRole('dialog', { name: 'Completion result' });
    expect(document.activeElement).toBe(result);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    notes().focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(result.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('does not let a stale success timer close another visit after Escape', async () => {
    const onClosed = vi.fn();
    render(<ShellHarness onClosed={onClosed} onSubmit={vi.fn().mockResolvedValue({})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open completion' }));

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    vi.useFakeTimers();
    await act(async () => fireEvent.click(submit));
    expect(screen.getByRole('dialog', { name: 'Completion result' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog', { name: 'Completion result' })).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the treatment-zone mapper before the completion dialog', async () => {
    const onClosed = vi.fn();
    render(<ShellHarness onClosed={onClosed} />);
    const opener = screen.getByRole('button', { name: 'Open completion' });
    opener.focus();
    fireEvent.click(opener);

    await screen.findByRole('dialog', { name: /Complete Service/i });
    fireEvent.change(notes(), { target: { value: 'Draft survives the mapper' } });
    const launcher = screen.getByRole('button', { name: 'Trace where we sprayed' });
    launcher.focus();
    fireEvent.click(launcher);

    const mapper = await screen.findByRole('dialog', { name: 'Treatment Zone' });
    expect(document.activeElement).toBe(mapper);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Treatment Zone' })).toBeNull();
    expect(screen.getByRole('dialog', { name: /Complete Service/i })).toBeTruthy();
    expect(notes().value).toBe('Draft survives the mapper');
    expect(document.activeElement).toBe(launcher);
    expect(onClosed).not.toHaveBeenCalled();
    expect(document.body.style.position).toBe('fixed');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(opener);
    expect(JSON.parse(localStorage.getItem(draftKey))).toMatchObject({
      notes: 'Draft survives the mapper',
    });
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('Escape closes the mobile recap role picker before the completion dialog', async () => {
    pestRecapEnabled = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    const onClosed = vi.fn();
    render(<ShellHarness onClosed={onClosed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open completion' }));

    await screen.findByRole('dialog', { name: /Complete service/i });
    const launcher = await screen.findByRole('button', { name: '+ Capture clip' });
    launcher.focus();
    fireEvent.click(launcher);
    const input = document.querySelector('input[type="file"][capture="environment"]');
    const file = new File(['synthetic image'], 'treatment.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });

    const picker = await screen.findByRole('dialog', { name: 'What were you doing?' });
    expect(document.activeElement).toBe(picker);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'What were you doing?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: /Complete service/i })).toBeTruthy();
    expect(document.activeElement).toBe(launcher);
    expect(onClosed).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledWith(false);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('keeps prepared-form edits after a failed save, focuses the inline error, and retries', async () => {
    const onPrepared = vi.fn()
      .mockRejectedValueOnce(new Error('Synthetic form storage failure'))
      .mockResolvedValueOnce(undefined);
    await renderPanel({ onPrepared });

    const field = notes();
    fireEvent.change(field, { target: { value: 'Retain this prepared report note' } });
    const save = await screen.findByRole('button', { name: /^Save service form/i });
    await waitFor(() => expect(save.disabled).toBe(false));
    await act(async () => fireEvent.click(save));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Failed to save service form: Synthetic form storage failure');
    expect(document.activeElement).toBe(error);
    expect(field.value).toBe('Retain this prepared report note');

    await act(async () => fireEvent.click(save));
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field.value).toBe('Retain this prepared report note');
    expect(onPrepared.mock.calls[1][1]).toMatchObject({
      technicianNotes: 'Retain this prepared report note',
    });
  });
});
