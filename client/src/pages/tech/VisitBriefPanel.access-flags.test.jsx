// @vitest-environment jsdom
// GATE_VISIT_ACCESS_FLAGS=on: the tech's Visit Brief shows a "Before you go in" section above Access from the
// visit-brief answer's `accessFlags`. Each card quotes the customer's words and takes a Right / Wrong tap; the tap is
// POST /admin/schedule/:id/access-flags/:questionId. No key or no flags = no section.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SERVICE = {
  id: 'svc-1',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Quarterly Pest Control',
};
const stop = { key: 'row:svc-1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };

const EVID = '11111111-1111-4111-8111-111111111111';
const EVID2 = '22222222-2222-4222-8222-222222222222';
const EVID3 = '33333333-3333-4333-8333-333333333333';
const DOG = {
  questionId: 'dog_on_property', title: 'Dog or other animal may be loose', tone: 'amber', status: 'open',
  evidenceId: EVID, quote: 'Our dog Biscuit will be in the yard', source: 'Customer text', saveToFile: 'pets',
};
const CALL = {
  questionId: 'contact_before_arrival', title: 'Customer asked for a call or text before you arrive', tone: 'plain', status: 'open',
  evidenceId: EVID, quote: null, source: 'Read: customer text', saveToFile: null,
};

function renderWith(brief, request = vi.fn(async () => ({ status: 'right' })), onRetry = vi.fn()) {
  render(
    <VisitBriefPanel
      stop={stop}
      detail={{ status: 'ready', byService: { 'svc-1': { estimate: null, brief } } }}
      request={request}
      onRetry={onRetry} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />,
  );
  return request;
}

describe('Visit Brief: Before you go in', () => {
  it('shows each flag with its title, quote and source, labeled Read by AI with no time', () => {
    renderWith({ brief: null, accessFlags: [DOG, CALL] });
    const section = screen.getByTestId('visit-brief-access-flags');
    expect(section).toHaveTextContent('Before you go in');
    expect(section).toHaveTextContent('Read by AI');
    expect(section).not.toHaveTextContent(/\d:\d\d/);
    const dog = screen.getByTestId('access-flag-dog_on_property');
    expect(dog).toHaveTextContent('Dog or other animal may be loose');
    expect(dog).toHaveTextContent('“Our dog Biscuit will be in the yard”');
    expect(dog).toHaveTextContent('Customer text');
    expect(screen.getByTestId('access-flag-contact_before_arrival')).not.toHaveTextContent('“');
    expect(screen.getByRole('button', { name: 'Right · save to file' })).toHaveStyle({ minHeight: '44px' });
    expect(screen.getAllByRole('button', { name: 'Right' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Wrong' })).toHaveLength(2);
  });

  it('no key, or no flags: no section', () => {
    renderWith({ brief: null });
    expect(screen.queryByTestId('visit-brief-access-flags')).toBeNull();
    cleanup();
    renderWith({ brief: null, accessFlags: [] });
    expect(screen.queryByTestId('visit-brief-access-flags')).toBeNull();
  });

  it('sits above the Access section', () => {
    renderWith({ brief: { access: { pets: '1 dog' } }, accessFlags: [DOG] });
    const flags = screen.getByText('Before you go in');
    const access = screen.getByText('Access');
    expect(flags.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Right posts the verdict for that visit and flag, then shows one line instead of the buttons', async () => {
    const request = renderWith({ brief: null, accessFlags: [CALL] }, vi.fn(async () => ({ status: 'right' })));
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    await waitFor(() => expect(screen.getByText('Marked right. Thanks.')).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/access-flags/contact_before_arrival', { method: 'POST', body: JSON.stringify({ verdict: 'right', evidenceId: EVID }) });
    expect(screen.queryByRole('button', { name: 'Wrong' })).toBeNull();
  });

  it('Right on a dog flag that was saved says so', async () => {
    renderWith({ brief: null, accessFlags: [DOG] }, vi.fn(async () => ({ status: 'right', saved: true })));
    fireEvent.click(screen.getByRole('button', { name: 'Right · save to file' }));
    await waitFor(() => expect(screen.getByText('Saved to Pets. Thanks.')).toBeInTheDocument());
  });

  it('Wrong leaves the card as one line for this view', async () => {
    const request = renderWith({ brief: null, accessFlags: [DOG] }, vi.fn(async () => ({ status: 'wrong' })));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }));
    await waitFor(() => expect(screen.getByText('Marked wrong. Hidden for this visit.')).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/access-flags/dog_on_property', { method: 'POST', body: JSON.stringify({ verdict: 'wrong', evidenceId: EVID }) });
  });

  it('a flag already marked right shows its line on load, with no buttons', () => {
    renderWith({ brief: null, accessFlags: [{ ...CALL, status: 'right' }] });
    expect(screen.getByText('Marked right. Thanks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Right' })).toBeNull();
  });

  it('an empty or unreadable 2xx is not a success: the buttons stay and the tech is told to try again', async () => {
    renderWith({ brief: null, accessFlags: [CALL] }, vi.fn(async () => ({})));
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save. Try again.'));
    expect(screen.queryByText('Marked right. Thanks.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Wrong' })).not.toBeDisabled();
  });

  it('a refresh with new evidence starts a fresh card, and the server status decides what shows', async () => {
    const view = (flag) => (
      <VisitBriefPanel
        stop={stop}
        detail={{ status: 'ready', byService: { 'svc-1': { estimate: null, brief: { brief: null, accessFlags: [flag] } } } }}
        request={vi.fn(async () => ({ status: 'wrong' }))}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />
    );
    const { rerender } = render(view(CALL));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }));
    await waitFor(() => expect(screen.getByText('Marked wrong. Hidden for this visit.')).toBeInTheDocument());
    // New evidence (another hash) for the same question: the old answer does not hide the new card.
    rerender(view({ ...CALL, evidenceId: EVID2 }));
    expect(screen.queryByText('Marked wrong. Hidden for this visit.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Right' })).toBeInTheDocument();
    // The server now says right (answered elsewhere): no buttons, whatever this card held before.
    rerender(view({ ...CALL, evidenceId: EVID2, status: 'right' }));
    expect(screen.getByText('Marked right. Thanks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Right' })).toBeNull();
  });

  it('a card that moved (409) reads the brief again and says so, keeping the buttons', async () => {
    const onRetry = vi.fn();
    const changed = Object.assign(new Error('flag_changed'), { status: 409, code: 'flag_changed' });
    renderWith({ brief: null, accessFlags: [DOG] }, vi.fn(async () => { throw changed; }), onRetry);
    fireEvent.click(screen.getByRole('button', { name: 'Right · save to file' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This flag changed. Check it again.'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Wrong' })).not.toBeDisabled();
  });

  it('a failed tap says so and keeps the buttons so the tech can try again', async () => {
    renderWith({ brief: null, accessFlags: [CALL] }, vi.fn(async () => { throw new Error('Network down'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network down'));
    expect(screen.getByRole('button', { name: 'Wrong' })).not.toBeDisabled();
  });

  it('a grouped stop keeps each service\'s own flags: a confirmed flag on one never hides an open one on its sibling', async () => {
    const lawn = { ...SERVICE, id: 'svc-2', serviceType: 'Lawn Care' };
    const grouped = { key: 'row:svc-1', isVisit: true, services: [SERVICE, lawn], primary: SERVICE, liveCount: 2 };
    const request = vi.fn(async () => ({ status: 'wrong' }));
    render(
      <VisitBriefPanel
        stop={grouped}
        detail={{
          status: 'ready',
          byService: {
            'svc-1': { estimate: null, brief: { brief: null, accessFlags: [{ ...DOG, status: 'right' }] } },
            'svc-2': { estimate: null, brief: { brief: null, accessFlags: [{ ...DOG, evidenceId: EVID3 }] } },
          },
        }}
        request={request}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    const section = screen.getByTestId('visit-brief-access-flags');
    expect(section).toHaveTextContent('Quarterly Pest Control');
    expect(section).toHaveTextContent('Lawn Care');
    expect(screen.getAllByTestId('access-flag-dog_on_property')).toHaveLength(2);
    expect(screen.getByText('Marked right. Thanks.')).toBeInTheDocument();
    // the sibling is still open, and its tap goes to its own visit with its own evidence
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/admin/schedule/svc-2/access-flags/dog_on_property', { method: 'POST', body: JSON.stringify({ verdict: 'wrong', evidenceId: EVID3 }) }));
  });
});
