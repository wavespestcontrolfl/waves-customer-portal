// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TechPhotoMarksModal from './TechPhotoMarksModal';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PHOTO = { s3_key: 'staged/abc.jpg', url: 'https://cdn.example.com/abc.jpg' };

// This modal mounts INSIDE the photo manager, whose backdrop closes it on
// click. Without stopping propagation the first tap — the one placing a mark —
// bubbles out and unmounts the whole workflow before anything can be saved
// (codex P1). The guarantee is structural, so it gets a test.
describe('TechPhotoMarksModal click containment', () => {
  it('does not let interactions reach an enclosing backdrop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        supported: true,
        kinds: [{ kind: 'foam_injection', label: 'Drilled & foamed' }],
        defaultKind: 'foam_injection',
        maxMarks: 60,
        marksByS3Key: {},
      }),
    })));

    const backdropClick = vi.fn();
    const { container, findByText } = render(
      // Mirrors TechServicePhotosModal's backdrop, whose onClick is onClose.
      <div onClick={backdropClick}>
        <TechPhotoMarksModal serviceId="svc-1" photo={PHOTO} onClose={() => {}} />
      </div>,
    );

    // Wait for the lane probe to resolve so the chips exist.
    await findByText('Drilled & foamed');

    fireEvent.click(await findByText('Drilled & foamed'));
    expect(backdropClick).not.toHaveBeenCalled();

    const img = container.querySelector('img[src="https://cdn.example.com/abc.jpg"]');
    fireEvent.click(img);
    expect(backdropClick).not.toHaveBeenCalled();

    fireEvent.click(await findByText('Skip'));
    expect(backdropClick).not.toHaveBeenCalled();
  });

  it('stops accepting marks when the source photo fails to load', async () => {
    // A broken <img> keeps a nonzero rect, so without this the tech could
    // place and SAVE customer-facing coordinates against a frame they cannot
    // see. Live card and PDF already fail closed; this is the third surface.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        supported: true,
        kinds: [{ kind: 'foam_injection', label: 'Drilled & foamed' }],
        defaultKind: 'foam_injection',
        maxMarks: 60,
        marksByS3Key: {},
      }),
    })));
    const { container, findByText, getByText } = render(
      <TechPhotoMarksModal serviceId="svc-1" photo={PHOTO} onClose={() => {}} />,
    );
    await findByText('Drilled & foamed');
    const img = container.querySelector('img[src="https://cdn.example.com/abc.jpg"]');
    // jsdom reports a zero rect, and pointToNormalized rejects that — give the
    // image a real one so a click maps to a coordinate.
    img.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 200, height: 150, right: 200, bottom: 150, x: 0, y: 0,
    });

    fireEvent.click(img, { clientX: 100, clientY: 75 });
    expect(container.textContent).toMatch(/1 mark/);

    fireEvent.error(img);
    expect(container.textContent).toMatch(/could not be loaded/);
    expect(getByText('Save marks')).toBeDisabled();

    // Further clicks are ignored — the count must not move.
    fireEvent.click(img, { clientX: 120, clientY: 80 });
    expect(container.textContent).toMatch(/1 mark/);
  });
});
