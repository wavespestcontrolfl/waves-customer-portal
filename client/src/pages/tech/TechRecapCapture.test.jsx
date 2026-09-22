// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechRecapCapture from './TechRecapCapture';

const SERVICE_ONE = { id: 'service-one' };
const SERVICE_TWO = { id: 'service-two' };

const isListRequest = (path, options) => path.endsWith('/recap-media') && !options;
const pathsMatching = (request, fragment) => request.mock.calls.filter(([path]) => path.includes(fragment));

function pickPhoto(name = 'perimeter.jpg') {
  const input = document.querySelector('input[type="file"]');
  const file = new File(['fixture'], name, { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

async function tagPerimeter(name) {
  const file = pickPhoto(name);
  fireEvent.click(screen.getByRole('button', { name: 'Spray — perimeter' }));
  return file;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TechRecapCapture upload recovery', () => {
  it('retries a lost confirm response against the same media row without uploading twice', async () => {
    let confirmAttempts = 0;
    let confirmed = false;
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) {
        return { items: confirmed ? [{ id: 'media-one', role: 'perimeter', caption: 'Sealing your perimeter barrier', status: 'ready' }] : [] };
      }
      if (path.endsWith('/presign')) return { mediaId: 'media-one', uploadUrl: 'https://upload.test/media-one' };
      if (path.endsWith('/media-one/confirm')) {
        confirmAttempts += 1;
        confirmed = true;
        if (confirmAttempts === 1) throw new Error('Connection closed before confirmation arrived');
        return { ok: true, id: 'media-one', status: 'ready' };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('retry-me.jpg');

    expect(await screen.findByRole('alert')).toHaveTextContent('Connection closed before confirmation arrived');
    expect(screen.getByRole('alert')).toHaveTextContent('retry-me.jpg · Spray — perimeter');
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
    expect(pathsMatching(request, '/presign')).toHaveLength(1);
    expect(pathsMatching(request, '/media-one/confirm')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('deletes a row with an expired PUT URL before retry presigns a replacement', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValueOnce({ ok: true, status: 200 });
    let presignCount = 0;
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path.endsWith('/presign')) {
        presignCount += 1;
        return { mediaId: `media-expired-${presignCount}`, uploadUrl: `https://upload.test/expired-${presignCount}` };
      }
      if (path.endsWith('/media-expired-1') && options?.method === 'DELETE') return { ok: true };
      if (path.endsWith('/media-expired-2/confirm')) return { ok: true, id: 'media-expired-2', status: 'ready' };
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('expired-link.jpg');

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload link expired — retry to request a new link.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

    await waitFor(() => expect(pathsMatching(request, '/media-expired-2/confirm')).toHaveLength(1));
    expect(pathsMatching(request, '/presign')).toHaveLength(2);
    expect(pathsMatching(request, '/media-expired-1')).toHaveLength(1);
    const deleteOrder = request.mock.invocationCallOrder[request.mock.calls.findIndex(([path, options]) => path.endsWith('/media-expired-1') && options?.method === 'DELETE')];
    const presignIndexes = request.mock.calls.map(([path], index) => (path.endsWith('/presign') ? index : -1)).filter((index) => index >= 0);
    const replacementOrder = request.mock.invocationCallOrder[presignIndexes[1]];
    expect(deleteOrder).toBeLessThan(replacementOrder);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://upload.test/expired-1',
      'https://upload.test/expired-2',
    ]);
  });

  it('restarts from presign when transient confirm failure deleted the original row', async () => {
    let presignCount = 0;
    let confirmCount = 0;
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path.endsWith('/presign')) {
        presignCount += 1;
        return { mediaId: `media-missing-${presignCount}`, uploadUrl: `https://upload.test/missing-${presignCount}` };
      }
      if (path.endsWith('/media-missing-1/confirm')) {
        confirmCount += 1;
        const error = new Error('Upload not found — try again.');
        error.status = 409;
        throw error;
      }
      if (path.endsWith('/media-missing-2/confirm')) {
        confirmCount += 1;
        return { ok: true, id: 'media-missing-2', status: 'ready' };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('missing-row.jpg');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

    await waitFor(() => expect(confirmCount).toBe(2));
    expect(pathsMatching(request, '/presign')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not mint a replacement when confirm reconciliation returns a malformed list', async () => {
    let listCount = 0;
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) {
        listCount += 1;
        return listCount === 1 ? { items: [] } : { items: null };
      }
      if (path.endsWith('/presign')) return { mediaId: 'media-uncertain', uploadUrl: 'https://upload.test/media-uncertain' };
      if (path.endsWith('/media-uncertain/confirm')) throw new Error('Confirmation unavailable');
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('uncertain-row.jpg');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t verify the pending upload');
    expect(pathsMatching(request, '/presign')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('makes terminal size rejection discard-only', async () => {
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path.endsWith('/presign')) return { mediaId: 'media-terminal', uploadUrl: 'https://upload.test/media-terminal' };
      if (path.endsWith('/media-terminal/confirm')) {
        const error = new Error('Clip too large — keep it under ~20 seconds.');
        error.status = 413;
        throw error;
      }
      if (path.endsWith('/media-terminal') && options?.method === 'DELETE') {
        const error = new Error('media not found');
        error.status = 404;
        throw error;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('bad-duration.jpg');

    expect(await screen.findByRole('alert')).toHaveTextContent('Clip too large');
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('retains the selected file and role after a PUT failure and resumes with the same presign', async () => {
    fetch.mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce({ ok: true, status: 200 });
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path.endsWith('/presign')) return { mediaId: 'media-two', uploadUrl: 'https://upload.test/media-two' };
      if (path.endsWith('/media-two/confirm')) return { ok: true, id: 'media-two', status: 'ready' };
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    const file = await tagPerimeter('put-retry.jpg');

    expect(await screen.findByRole('alert')).toHaveTextContent('put-retry.jpg · Spray — perimeter');
    expect(screen.getByRole('button', { name: 'Resolve pending clip' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

    await waitFor(() => expect(pathsMatching(request, '/media-two/confirm')).toHaveLength(1));
    expect(pathsMatching(request, '/presign')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('https://upload.test/media-two');
    expect(fetch.mock.calls[1][0]).toBe('https://upload.test/media-two');
    expect(fetch.mock.calls[1][1].body).toBe(file);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('discards a failed upload and removes its pending server row', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path.endsWith('/presign')) return { mediaId: 'media-three', uploadUrl: 'https://upload.test/media-three' };
      if (path.endsWith('/media-three') && options?.method === 'DELETE') return { ok: true };
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('discard-me.jpg');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith(
      '/tech/services/service-one/recap-media/media-three',
      { method: 'DELETE' },
    ));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '+ Capture recap clip' })).toBeEnabled();
  });

  it('retains discard-only cleanup when a lost-confirm media delete fails', async () => {
    let confirmed = false;
    let deleteAttempts = 0;
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) {
        return { items: confirmed ? [{ id: 'media-ready', role: 'perimeter', caption: 'Sealing your perimeter barrier', status: 'ready' }] : [] };
      }
      if (path.endsWith('/presign')) return { mediaId: 'media-ready', uploadUrl: 'https://upload.test/media-ready' };
      if (path.endsWith('/media-ready/confirm')) {
        confirmed = true;
        throw new Error('Connection closed before confirmation arrived');
      }
      if (path.endsWith('/media-ready') && options?.method === 'DELETE') {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error('Delete unavailable');
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('discard-ready.jpg');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t discard this clip from the visit');
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry discard' })).toBeEnabled();
    expect(pathsMatching(request, '/presign')).toHaveLength(1);
    expect(pathsMatching(request, '/confirm')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry discard' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(deleteAttempts).toBe(2);
    expect(pathsMatching(request, '/presign')).toHaveLength(1);
    expect(pathsMatching(request, '/confirm')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops an in-flight file when the selected service changes', async () => {
    let finishPresign;
    const presign = new Promise((resolve) => { finishPresign = resolve; });
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path === '/tech/services/service-one/recap-media/presign') return presign;
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('old-visit.jpg');
    await waitFor(() => expect(pathsMatching(request, '/service-one/recap-media/presign')).toHaveLength(1));

    view.rerender(<TechRecapCapture service={SERVICE_TWO} request={request} />);
    await act(async () => finishPresign({ mediaId: 'old-media', uploadUrl: 'https://upload.test/old-media' }));

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/old-visit\.jpg/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Capture recap clip' })).toBeEnabled();
  });

  it('does not continue an in-flight upload after unmount', async () => {
    let finishPresign;
    const presign = new Promise((resolve) => { finishPresign = resolve; });
    const request = vi.fn(async (path, options) => {
      if (isListRequest(path, options)) return { items: [] };
      if (path.endsWith('/presign')) return presign;
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = render(<TechRecapCapture service={SERVICE_ONE} request={request} />);
    await tagPerimeter('unmounted.jpg');
    await waitFor(() => expect(pathsMatching(request, '/presign')).toHaveLength(1));

    view.unmount();
    await act(async () => finishPresign({ mediaId: 'unmounted-media', uploadUrl: 'https://upload.test/unmounted-media' }));

    expect(fetch).not.toHaveBeenCalled();
    expect(pathsMatching(request, '/confirm')).toHaveLength(0);
  });
});
