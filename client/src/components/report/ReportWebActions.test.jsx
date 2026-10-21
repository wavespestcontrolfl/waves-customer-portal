// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportWebActions, { REPORT_WEB_ACTIONS_CSS } from './ReportWebActions';

// GATE_REPORT_WEB_ACTIONS (owner 2026-10-20): the finding offer tile and the
// "Seen something since?" photo button. The server sends fixed sentences; the
// page shows them, runs the existing cross-sell tap, and shrinks and sends one photo.

const TAP = { serviceKey: 'lawn_care', serviceLabel: 'Lawn Care', optionId: 'lawn-enhanced', perApplication: 61.5, offerMode: 'priced', fingerprint: 'fp-1' };
const FINDING = {
  kind: 'weeds',
  sentence: 'We saw weeds on this visit.',
  body: 'Lawn Care can take care of this. Tap below to see your estimate. Nothing is booked or charged.',
  button: 'See your estimate',
  tap: TAP,
};
const PHONE = '(941) 297-5749';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the finding tile', () => {
  let assign;
  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://portal.example', assign, reload: vi.fn() });
  });
  const renderTile = (submitEvent, extra = {}) => render(
    <ReportWebActions actions={{ finding: FINDING }} token="tok" apiBase="/api" submitEvent={submitEvent} {...extra} />,
  );

  it('renders nothing without actions', () => {
    const { container } = render(<ReportWebActions actions={null} token="tok" apiBase="/api" submitEvent={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<ReportWebActions actions={{}} token="tok" apiBase="/api" submitEvent={vi.fn()} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('shows the fixed sentences and no price, and the tap data stays off the page', () => {
    const { container } = renderTile(vi.fn());
    expect(screen.getByRole('heading', { name: 'We saw weeds on this visit.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See your estimate' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$|61\.5|fp-1/);
  });

  it('a tap sends the existing cross_sell_requested event and opens the estimate page', async () => {
    const submitEvent = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true, estimateUrl: 'https://portal.example/estimate/abc' } }));
    renderTile(submitEvent);
    fireEvent.click(screen.getByRole('button', { name: 'See your estimate' }));
    await screen.findByText(/Request received/);
    expect(submitEvent).toHaveBeenCalledWith('tok', 'cross_sell_requested', TAP);
    expect(assign).toHaveBeenCalledWith('https://portal.example/estimate/abc');
  });

  it('never leaves the site for another origin', async () => {
    const submitEvent = vi.fn(async () => ({ ok: true, status: 200, body: { estimateUrl: 'https://evil.example/estimate' } }));
    renderTile(submitEvent);
    fireEvent.click(screen.getByRole('button', { name: 'See your estimate' }));
    await screen.findByText(/Request received/);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a failed tap says so and keeps the button; a 409 asks for a refresh', async () => {
    const submitEvent = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: null })
      .mockResolvedValueOnce({ ok: false, status: 409, body: null });
    renderTile(submitEvent);
    fireEvent.click(screen.getByRole('button', { name: 'See your estimate' }));
    await screen.findByText(new RegExp(`call ${PHONE.replace(/[()]/g, '\\$&')}`));
    fireEvent.click(screen.getByRole('button', { name: 'See your estimate' }));
    await screen.findByRole('button', { name: /Offer updated/ });
  });

  it('a staff preview cannot tap', () => {
    const submitEvent = vi.fn();
    renderTile(submitEvent, { readOnly: true });
    expect(screen.getByRole('button', { name: 'See your estimate' })).toBeDisabled();
  });
});

describe('the photo button', () => {
  let fetchMock;
  let decodeFails;
  beforeEach(() => {
    decodeFails = false;
    // jsdom cannot decode images: stand in for the Image and canvas the page uses to shrink a photo.
    vi.stubGlobal('Image', class {
      set src(_v) {
        this.naturalWidth = 4000; this.naturalHeight = 3000;
        setTimeout(() => (decodeFails ? this.onerror && this.onerror() : this.onload && this.onload()), 0);
      }
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type, quality) => {
      // a photo that only fits the size target below quality 0.6
      return `data:image/jpeg;base64,${'A'.repeat(quality > 0.6 ? 2_000_000 : 1000)}`;
    });
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ headline: 'Likely a ghost ant', message: 'Call us.', canRebook: false }) }));
    vi.stubGlobal('fetch', fetchMock);
  });
  const renderPhoto = (extra = {}) => render(
    <ReportWebActions actions={{ photo: { type: 'pest' } }} token="tok" apiBase="/api" submitEvent={vi.fn()} {...extra} />,
  );
  const pick = () => {
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'p.heic', { type: 'image/heic' })] } });
  };

  it('asks "Seen something since?" with one Add a photo button', () => {
    renderPhoto();
    expect(screen.getByRole('heading', { name: 'Seen something since?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]').getAttribute('accept')).toBe('image/*');
  });

  it('shrinks the photo under the size target and posts it once to the report token route', async () => {
    renderPhoto();
    pick();
    await screen.findByText('Likely a ghost ant');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reports/tok/photo-check');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.photos[0].length * 0.75).toBeLessThan(750 * 1024);
  });

  it('a not-covered answer shows the plain sentence and the office phone, with no booking button', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ headline: null, message: `Call us at ${PHONE} and we will help with next steps.`, canRebook: false }) });
    renderPhoto();
    pick();
    await screen.findByText(/we will help with next steps/);
    expect(screen.queryByRole('link', { name: /Book my free re-service/ })).toBeNull();
    expect(document.body.textContent).toContain(PHONE);
  });

  it('a no-action answer without a phone adds the call line', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ headline: null, message: 'Based on what we can see, no action is needed right now.', canRebook: false }) });
    renderPhoto();
    pick();
    await screen.findByText(/no action is needed/);
    expect(screen.getByText(`Questions? Call ${PHONE}.`)).toBeInTheDocument();
  });

  it('a covered answer offers one booking link to the signed-in Schedule tab', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ headline: 'Likely a ghost ant', message: 'Your plan covers this. You can book a free re-service in your Waves account.', canRebook: true }) });
    renderPhoto();
    pick();
    const link = await screen.findByRole('link', { name: 'Book my free re-service' });
    expect(link.getAttribute('href')).toBe('/?tab=schedule');
    expect(document.body.innerHTML).not.toMatch(/reservice\//);
  });

  it('the server limit message shows as sent; a dead network falls back to the phone line', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: `You've reached today's photo-check limit. Call our office at ${PHONE} if you need help right away.` }) });
    renderPhoto();
    pick();
    await screen.findByText(/today's photo-check limit/);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    pick();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(`Call ${PHONE}`));
  });

  it('a staff preview cannot add a photo', () => {
    renderPhoto({ readOnly: true });
    expect(screen.getByRole('button', { name: 'Staff preview' })).toBeDisabled();
  });

  const pickFile = (file) => fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
  const decodedBytes = (dataUrl) => (dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75;

  it('keeps reducing the dimensions after the quality floor until the photo fits, and sends only a fitting one', async () => {
    const widths = [];
    // fits only once the canvas is 1000px wide or less, whatever the quality
    HTMLCanvasElement.prototype.toDataURL.mockImplementation(function toDataURL() {
      widths.push(this.width);
      return `data:image/jpeg;base64,${'A'.repeat(this.width > 1000 ? 2_000_000 : 1000)}`;
    });
    renderPhoto();
    pickFile(new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await screen.findByText('Likely a ghost ant');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(decodedBytes(body.photos[0])).toBeLessThan(750 * 1024);
    expect(Math.min(...widths)).toBeLessThanOrEqual(1000);
    expect(new Set(widths).size).toBeGreaterThan(1); // it stepped the dimensions down
  });

  it('a photo that never fits is refused locally: nothing is sent', async () => {
    HTMLCanvasElement.prototype.toDataURL.mockImplementation(() => `data:image/jpeg;base64,${'A'.repeat(2_000_000)}`);
    renderPhoto();
    pickFile(new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await screen.findByText(new RegExp(`too large.*${PHONE.replace(/[()]/g, '\\$&')}`));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a HEIC the browser cannot decode is sent as the original when it is within the limit', async () => {
    decodeFails = true;
    renderPhoto();
    pickFile(new File([new Uint8Array(2000).fill(7)], 'IMG_1.HEIC', { type: 'image/heic' }));
    await screen.findByText('Likely a ghost ant');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.photos[0]).toMatch(/^data:image\/heic;base64,/);
    expect(Math.round(decodedBytes(body.photos[0]))).toBeGreaterThanOrEqual(2000);
    expect(Math.round(decodedBytes(body.photos[0]))).toBeLessThanOrEqual(2002);
  });

  it('an undecodable HEIC with no mime type is named by its extension; an oversized one or a non-HEIC is not sent', async () => {
    decodeFails = true;
    renderPhoto();
    pickFile(new File([new Uint8Array(500)], 'IMG_2.heif', { type: '' }));
    await screen.findByText('Likely a ghost ant');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).photos[0]).toMatch(/^data:image\/heif;base64,/);
    fetchMock.mockClear();
    pickFile(new File([new Uint8Array(800 * 1024)], 'IMG_3.heic', { type: 'image/heic' }));
    await screen.findByText(/could not read that photo/);
    pickFile(new File([new Uint8Array(500)], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not read that photo/));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('type sizes', () => {
  it('prose is 16px and fine print is 14px (the fine-print rule wins over the prose rule), from the theme tokens', () => {
    render(<ReportWebActions actions={{ photo: { type: 'pest' }, finding: FINDING }} token="tok" apiBase="/api" submitEvent={vi.fn()} readOnly />);
    const prose = document.querySelector('.web-action-card p');
    expect(getComputedStyle(prose).fontSize).toBe('16px');
    // an answer with no phone shows the 14px call line
    expect(REPORT_WEB_ACTIONS_CSS).toContain('font-size: 16px');
    expect(REPORT_WEB_ACTIONS_CSS).toMatch(/\.web-actions \.web-action-card p\.web-action-fine \{ font-size: 14px/);
    const fine = document.createElement('p');
    fine.className = 'web-action-fine';
    document.querySelector('.web-action-card').appendChild(fine);
    expect(getComputedStyle(fine).fontSize).toBe('14px');
    expect(getComputedStyle(document.querySelector('.web-action-btn')).fontSize).toBe('14px');
  });
});
