// @vitest-environment jsdom
// "About this home": read, add, edit, the stale-save notice, and the quiet states. Staff only; the customer never sees it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomeNoteSection, { homeNoteFor } from './HomeNoteSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PATH = '/admin/schedule/svc-1/home-note';
const NOTE = { body: 'Side gate sticks. Dog stays inside.', updatedAt: '2026-11-26T15:00:00.000Z', updatedByFirstName: 'Ada' };
const refusal = (status, details, message = 'refused') => Object.assign(new Error(message), { status, details });

describe('HomeNoteSection', () => {
  it('shows the note with who changed it and when', async () => {
    render(<HomeNoteSection request={vi.fn(async () => ({ note: NOTE, editable: true }))} path={PATH} />);
    expect(await screen.findByText(NOTE.body)).toBeInTheDocument();
    expect(screen.getByText('About this home')).toBeInTheDocument();
    expect(screen.getByText(/Updated Nov 26, 2026 by Ada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('with no note shows one muted line and an Add note button', async () => {
    render(<HomeNoteSection request={vi.fn(async () => ({ note: null, editable: true }))} path={PATH} />);
    expect(await screen.findByText('No note yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
  });

  it('saves an edit with the time the editor last saw, shows Saved., and caps the text at 1000', async () => {
    const request = vi.fn(async (_path, options) => (options?.method === 'PUT'
      ? { note: { ...NOTE, body: 'New text', updatedAt: '2026-11-26T16:00:00.000Z' } }
      : { note: NOTE, editable: true }));
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('About this home');
    expect(box).toHaveValue(NOTE.body);
    fireEvent.change(box, { target: { value: 'x'.repeat(1200) } });
    expect(box.value).toHaveLength(1000);
    expect(screen.getByText('1000/1000')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByText('New text')).toBeInTheDocument();
    const put = request.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(put[0]).toBe(PATH);
    expect(JSON.parse(put[1].body)).toEqual({ body: 'New text', expectedUpdatedAt: NOTE.updatedAt });
  });

  it('on a stale save says someone else changed it and shows their text; Use their note takes it', async () => {
    const theirs = { ...NOTE, body: 'Their newer text', updatedByFirstName: 'Sam' };
    const request = vi.fn(async (_path, options) => {
      if (options?.method === 'PUT') throw refusal(409, { code: 'note_changed', note: theirs });
      return { note: NOTE, editable: true };
    });
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Someone else changed this note.')).toBeInTheDocument();
    expect(screen.getByText('Their newer text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use their note' }));
    await waitFor(() => expect(screen.queryByTestId('home-note-conflict')).toBeNull());
    expect(screen.getByText('Their newer text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('Keep editing mine saves against their time, so the next Save is not stale again', async () => {
    const theirs = { ...NOTE, body: 'Their newer text', updatedAt: '2026-11-26T15:30:00.000Z' };
    let calls = 0;
    const request = vi.fn(async (_path, options) => {
      if (options?.method !== 'PUT') return { note: NOTE, editable: true };
      calls += 1;
      if (calls === 1) throw refusal(409, { note: theirs });
      return { note: { ...NOTE, body: 'Mine', updatedAt: '2026-11-26T16:00:00.000Z' } };
    });
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep editing mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const puts = request.mock.calls.filter(([, options]) => options?.method === 'PUT');
    expect(JSON.parse(puts[1][1].body).expectedUpdatedAt).toBe(theirs.updatedAt);
  });

  it('shows the server\'s reason when a save is refused, and keeps the editor open', async () => {
    const request = vi.fn(async (_path, options) => {
      if (options?.method === 'PUT') throw refusal(400, {}, 'The note can be at most 1000 characters.');
      return { note: null, editable: true };
    });
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The note can be at most 1000 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('About this home')).toBeInTheDocument();
  });

  it('renders nothing when the visit is not the technician\'s (403) and offers Retry when the read fails', async () => {
    const { container } = render(<HomeNoteSection request={vi.fn(async () => { throw refusal(403, {}); })} path={PATH} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    cleanup();
    const flaky = vi.fn()
      .mockRejectedValueOnce(refusal(500, {}))
      .mockResolvedValueOnce({ note: NOTE, editable: true });
    render(<HomeNoteSection request={flaky} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(NOTE.body)).toBeInTheDocument();
  });

  it('tells the office that a customer with several homes needs a visit, and offers no editor', async () => {
    render(<HomeNoteSection request={vi.fn(async () => { throw refusal(422, {}, 'This customer has more than one home. Add the note from a visit at that home.'); })} path="/admin/customers/c1/home-note" />);
    expect(await screen.findByText(/more than one home/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
  });
});

describe('HomeNoteSection inside the Visit Brief', () => {
  it('shows the note the brief carried without asking the server, and refreshes the brief after a save', async () => {
    const request = vi.fn(async () => ({ note: { ...NOTE, body: 'New text' } }));
    const onSaved = vi.fn();
    const { rerender } = render(<HomeNoteSection request={request} path={PATH} note={NOTE} onSaved={onSaved} />);
    expect(screen.getByText(NOTE.body)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // The brief read again brings a newer note down.
    rerender(<HomeNoteSection request={request} path={PATH} note={{ ...NOTE, body: 'From the refreshed brief' }} onSaved={onSaved} />);
    expect(await screen.findByText('From the refreshed brief')).toBeInTheDocument();
  });

  it('an answer with note null reads No note yet; homeNoteFor takes the first member that carried the key', () => {
    render(<HomeNoteSection request={vi.fn()} path={PATH} note={null} />);
    expect(screen.getByText('No note yet.')).toBeInTheDocument();
    const services = [{ id: 'a' }, { id: 'b' }];
    expect(homeNoteFor(services, { a: { brief: { brief: null } }, b: { brief: { homeNote: NOTE } } })).toEqual({ id: 'b', note: NOTE });
    expect(homeNoteFor(services, { a: { brief: { homeNote: null } } })).toEqual({ id: 'a', note: null });
    expect(homeNoteFor(services, {})).toBeNull();
  });
});
