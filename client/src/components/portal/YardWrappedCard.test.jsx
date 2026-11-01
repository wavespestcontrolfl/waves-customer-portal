// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import YardWrappedCard from './YardWrappedCard';
import { LINE_LABELS, YARD_WRAPPED_COPY as COPY } from './yardWrappedCopy';
import { buildShare, drawPicture } from './yardWrappedShare';

const FULL = {
  enabled: true,
  year: 2026,
  visits: { total: 9, byLine: [{ line: 'pest', count: 6 }, { line: 'lawn', count: 3 }, { line: 'mystery', count: 1 }] },
  lawnScore: { first: 61, last: 78 },
  treatedFor: ['Ghost ants', 'Chinch bugs'],
  technicianFirstName: 'Jordan',
  photoUrl: 'https://signed.example/lawn.jpg?sig=1',
  businessName: 'Waves Pest Control, LLC',
};
const MIN = { enabled: true, year: 2026, visits: { total: 3, byLine: [{ line: 'pest', count: 3 }] }, treatedFor: [], businessName: 'Waves Pest Control, LLC' };

const setNavigator = (props) => {
  for (const key of ['share', 'canShare', 'clipboard']) Object.defineProperty(navigator, key, { value: props[key], configurable: true });
};

beforeEach(() => {
  vi.clearAllMocks();
  HTMLCanvasElement.prototype.getContext = () => null;
  setNavigator({});
});
afterEach(() => cleanup());

describe('YardWrappedCard render rules', () => {
  it('renders nothing for { enabled: false }, no read yet (null) or a read the Home tab withheld', () => {
    const { container, rerender } = render(<YardWrappedCard data={{ enabled: false }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<YardWrappedCard data={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<YardWrappedCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the counts, the registered name and the approved words', async () => {
    render(<YardWrappedCard data={FULL} />);
    expect(await screen.findByTestId('yard-wrapped-card')).toBeInTheDocument();
    expect(screen.getByText('Yard Wrapped')).toBeInTheDocument();
    expect(screen.getByText('Your 2026 with Waves')).toBeInTheDocument();
    expect(screen.getByTestId('yard-wrapped-visits')).toHaveTextContent('9 visits');
    expect(screen.getByText('Pest control · 6')).toBeInTheDocument();
    expect(screen.getByText('Lawn care · 3')).toBeInTheDocument();
    expect(screen.queryByText(/mystery/i)).not.toBeInTheDocument();
    expect(screen.getByText('61 to 78')).toBeInTheDocument();
    expect(screen.getByText('Ghost ants')).toBeInTheDocument();
    expect(screen.getByText('Chinch bugs')).toBeInTheDocument();
    expect(screen.getByText('Jordan')).toBeInTheDocument();
    expect(screen.getByAltText('Your lawn in 2026')).toHaveAttribute('src', FULL.photoUrl);
    expect(screen.getByTestId('yard-wrapped-business')).toHaveTextContent('Waves Pest Control, LLC');
    expect(screen.getByText('Thank you for letting us look after your home in 2026.')).toBeInTheDocument();
  });

  it('leaves out the lawn score, treated-for, technician and photo when the server sends none', async () => {
    render(<YardWrappedCard data={MIN} />);
    expect(await screen.findByTestId('yard-wrapped-visits')).toHaveTextContent('3 visits');
    expect(screen.queryByText('Lawn score')).not.toBeInTheDocument();
    expect(screen.queryByText('What we treated for')).not.toBeInTheDocument();
    expect(screen.queryByText('Your technician')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('says "1 visit" for one visit', async () => {
    expect(COPY.visitsValue(1)).toBe('1 visit');
    expect(COPY.visitsValue(0)).toBe('0 visits');
  });
});

describe('customer copy rules', () => {
  it('no word of the card, share text or picture says safe, free, or gives a time figure', () => {
    const words = [
      ...Object.values(LINE_LABELS),
      COPY.kicker, COPY.title(2026), COPY.visitsValue(9), COPY.visitsNote(2026), COPY.lawnLabel, COPY.lawnValue(61, 78),
      COPY.lawnNote(2026), COPY.treatedLabel, COPY.technicianLabel, COPY.technicianNote(2026), COPY.photoAlt(2026), COPY.thanks(2026),
      COPY.shareButton, COPY.copyButton, COPY.copiedStatus, COPY.copyFailedStatus, COPY.shareTitle(2026),
      COPY.shareText({ year: 2026, businessName: 'Waves Pest Control, LLC', total: 9, lines: [{ label: 'Pest control', count: 6 }], lawnScore: { first: 61, last: 78 } }),
      COPY.picture.kicker, COPY.picture.title(2026), COPY.picture.visitsWord(9), COPY.picture.lawn(61, 78),
    ].join(' | ');
    expect(words).not.toMatch(/\bsafe|\bfree\b|\bminutes?\b|\bmins?\b|\bhours?\b|\bhrs?\b|guarantee|infest|toxic|poison/i);
  });
});

describe('sharing', () => {
  it('builds the share text with the registered company name and the website', () => {
    const share = buildShare(FULL);
    expect(share.title).toBe('My 2026 with Waves');
    expect(share.text).toBe('My 2026 with Waves Pest Control, LLC: 9 visits (6 pest control, 3 lawn care). Lawn score 61 to 78.');
    expect(share.url).toBe('https://wavespestcontrol.com');
    expect(buildShare(MIN).text).toBe('My 2026 with Waves Pest Control, LLC: 3 visits (3 pest control).');
  });

  it('Share opens the phone share sheet with the text and the website', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share });
    render(<YardWrappedCard data={FULL} />);
    fireEvent.click(await screen.findByTestId('yard-wrapped-share'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('yard-wrapped-share')).toHaveTextContent('Share');
    expect(share.mock.calls[0][0]).toMatchObject({ title: 'My 2026 with Waves', url: 'https://wavespestcontrol.com' });
    expect(share.mock.calls[0][0].text).toContain('Waves Pest Control, LLC');
    expect(share.mock.calls[0][0].files).toBeUndefined();
  });

  it('attaches the stats picture when the phone can share files', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    HTMLCanvasElement.prototype.getContext = () => ctx;
    HTMLCanvasElement.prototype.toBlob = (cb) => cb(new Blob(['png'], { type: 'image/png' }));
    setNavigator({ share, canShare: ({ files }) => Array.isArray(files) && files.length === 1 });
    render(<YardWrappedCard data={FULL} />);
    const button = await screen.findByTestId('yard-wrapped-share');
    // Give the picture time to draw before the tap.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(button);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const files = share.mock.calls[0][0].files;
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/png');
  });

  it('a cancelled share does nothing more; a failed share falls back to Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' })).mockRejectedValueOnce(new Error('boom'));
    setNavigator({ share, clipboard: { writeText } });
    render(<YardWrappedCard data={FULL} />);
    const button = await screen.findByTestId('yard-wrapped-share');
    fireEvent.click(button);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toBe(`${buildShare(FULL).text} https://wavespestcontrol.com`);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('without share support the button is Copy; with neither it is hidden', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    const first = render(<YardWrappedCard data={FULL} />);
    const button = await screen.findByTestId('yard-wrapped-share');
    expect(button).toHaveTextContent('Copy');
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    first.unmount();

    setNavigator({});
    render(<YardWrappedCard data={FULL} />);
    expect(await screen.findByTestId('yard-wrapped-card')).toBeInTheDocument();
    expect(screen.queryByTestId('yard-wrapped-share')).not.toBeInTheDocument();
  });

  it('the picture draws the counts and the registered name only: no photo, no address, no customer name', () => {
    const drawn = [];
    const ctx = new Proxy({}, {
      get: (_t, prop) => (prop === 'fillText' ? (text) => drawn.push(String(text)) : () => {}),
      set: () => true,
    });
    drawPicture(ctx, { ...FULL, customerName: 'Jane Doe', address: '1 Palm Way' });
    const text = drawn.join(' | ');
    expect(text).toContain('Waves Pest Control, LLC');
    expect(text).toContain('9');
    expect(text).toContain('Lawn score 61 to 78');
    expect(text).not.toMatch(/Jane|Palm Way|Jordan|Ghost|http/);
  });
});
