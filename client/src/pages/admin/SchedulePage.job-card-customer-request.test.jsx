// @vitest-environment jsdom
//
// Job card "Why they booked" box (GATE_JOB_CARD_CUSTOMER_CONTEXT, owner
// "ok go" 2026-10-03). Typed and texted words are quoted; a call's AI
// summary and the office's wording are not; nothing recorded renders nothing.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCardCustomerRequest, JobCardCustomerTexts, JobCardPrepPhotos } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const D = { text: '#111', muted: '#666', border: '#ccc' };
afterEach(cleanup);

describe('JobCardCustomerRequest', () => {
  it('quotes words the customer typed and lists the pests picked', () => {
    render(<JobCardCustomerRequest D={D} request={{ text: 'Roaches under the sink', source: 'picker', pests: ['german roach', 'ant'] }} />);
    expect(screen.getByText('Why they booked')).toBeTruthy();
    expect(screen.getByText('“Roaches under the sink”')).toBeTruthy();
    expect(screen.getByText('Customer wrote (re-service page):', { exact: false })).toBeTruthy();
    expect(screen.getByText('german roach, ant')).toBeTruthy();
  });

  it('never quotes a call summary', () => {
    render(<JobCardCustomerRequest D={D} request={{ text: 'Ants are back by the pool', source: 'call', pests: [] }} />);
    expect(screen.getByText('From the call (AI summary):', { exact: false })).toBeTruthy();
    expect(screen.getByText('Ants are back by the pool')).toBeTruthy();
    expect(screen.queryByText(/“/)).toBeNull();
  });

  it('renders nothing when nothing was recorded', () => {
    const { container } = render(<JobCardCustomerRequest D={D} request={null} />);
    expect(container.textContent).toBe('');
    const empty = render(<JobCardCustomerRequest D={D} request={{ text: null, source: 'office', pests: [] }} />);
    expect(empty.container.textContent).toBe('');
  });
});

describe('JobCardCustomerTexts', () => {
  it('quotes each text with its date', () => {
    render(<JobCardCustomerTexts D={D} texts={[{ date: '2026-09-02', text: 'Ants are back by the pool' }]} />);
    // Neutral: a first visit shows the last 30 days, so no visit is named.
    expect(screen.getByText('Recent customer texts')).toBeTruthy();
    expect(screen.getByText('\u201CAnts are back by the pool\u201D')).toBeTruthy();
    expect(screen.getByText('2026-09-02:', { exact: false })).toBeTruthy();
  });

  it('says so when the history could not be read, and shows nothing for none or gate off', () => {
    render(<JobCardCustomerTexts D={D} texts={null} />);
    expect(screen.getByText('Text history unavailable right now.')).toBeTruthy();
    cleanup();
    expect(render(<JobCardCustomerTexts D={D} texts={[]} />).container.textContent).toBe('');
    expect(render(<JobCardCustomerTexts D={D} />).container.textContent).toBe('');
  });
});

describe('JobCardPrepPhotos', () => {
  const submissions = [{ topic: 'pest', locationOnProperty: 'back_yard', note: 'Nest by the lanai', photoIds: ['p1', 'p2'] }];

  it('shows where, the note and thumbnails from the scoped photo endpoint', async () => {
    const request = vi.fn(async () => ({ photos: [{ id: 'p1', url: 'https://example.test/p1.jpg' }] }));
    render(<JobCardPrepPhotos D={D} serviceId="svc-1" submissions={submissions} request={request} />);
    expect(screen.getByText('Photos the customer sent')).toBeTruthy();
    expect(screen.getByText('Back yard · Pest')).toBeTruthy();
    expect(screen.getByText('\u201CNest by the lanai\u201D')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/visit-prep-photos');
    await waitFor(() => expect(screen.getByAltText('Customer photo 1').getAttribute('src')).toBe('https://example.test/p1.jpg'));
    // A photo the endpoint did not sign stays a placeholder.
    expect(screen.getByLabelText('Customer photo 2 loading')).toBeTruthy();
  });

  it('a failed photo fetch still shows the note; nothing sent renders nothing', async () => {
    const request = vi.fn(async () => { throw new Error('404'); });
    render(<JobCardPrepPhotos D={D} serviceId="svc-1" submissions={submissions} request={request} />);
    await waitFor(() => expect(screen.getByText('Photos unavailable right now.', { exact: false })).toBeTruthy());
    expect(screen.getByText('\u201CNest by the lanai\u201D')).toBeTruthy();
    expect(screen.getByLabelText('Customer photo 1 unavailable')).toBeTruthy();
    // Retry fetches again at once; a success clears the notice.
    request.mockImplementationOnce(async () => ({ photos: [{ id: 'p1', url: 'https://example.test/p1.jpg' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByAltText('Customer photo 1')).toBeTruthy());
    expect(screen.queryByText('Photos unavailable right now.', { exact: false })).toBeNull();
    cleanup();
    const none = vi.fn();
    expect(render(<JobCardPrepPhotos D={D} serviceId="svc-1" submissions={null} request={none} />).container.textContent).toBe('');
    expect(none).not.toHaveBeenCalled();
  });
});
