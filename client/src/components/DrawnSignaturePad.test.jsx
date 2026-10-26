// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DrawnSignaturePad from './DrawnSignaturePad';

// jsdom has no 2D canvas: stand in a recording context and a fixed PNG export.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let ctx;
beforeEach(() => {
  ctx = { clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => PNG);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stroke = (canvas) => {
  fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
  fireEvent.mouseMove(canvas, { clientX: 60, clientY: 40 });
  fireEvent.mouseUp(canvas);
};

describe('DrawnSignaturePad', () => {
  it('starts empty (onChange null), reports the PNG after a stroke, and null again after Clear', () => {
    const onChange = vi.fn();
    const { getByTestId, getByText } = render(<DrawnSignaturePad onChange={onChange} resetKey="a" />);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(getByText('Clear')).toBeDisabled();

    stroke(getByTestId('drawn-signature-canvas'));
    expect(ctx.stroke).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(PNG);
    expect(getByText('Clear')).not.toBeDisabled();

    fireEvent.click(getByText('Clear'));
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(getByText('Clear')).toBeDisabled();
  });

  it('a mouse-up with no stroke reports nothing new; a disabled pad takes no ink', () => {
    const onChange = vi.fn();
    const { getByTestId, rerender } = render(<DrawnSignaturePad onChange={onChange} resetKey="a" />);
    onChange.mockClear();
    fireEvent.mouseUp(getByTestId('drawn-signature-canvas'));
    expect(onChange).not.toHaveBeenCalled();

    rerender(<DrawnSignaturePad onChange={onChange} resetKey="a" disabled />);
    stroke(getByTestId('drawn-signature-canvas'));
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalledWith(PNG);
  });

  it('a new resetKey (another contract) wipes the ink and reports null', () => {
    const onChange = vi.fn();
    const { getByTestId, rerender } = render(<DrawnSignaturePad onChange={onChange} resetKey="a" />);
    stroke(getByTestId('drawn-signature-canvas'));
    expect(onChange).toHaveBeenLastCalledWith(PNG);
    rerender(<DrawnSignaturePad onChange={onChange} resetKey="b" />);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('a narrower pad (a rotation to portrait) restores the whole signature scaled to fit, never cropped', async () => {
    let resize = null;
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { resize = cb; } observe() {} disconnect() {} });
    // The snapshot taken on the 600px-wide pad comes back as a 600×150 image.
    vi.stubGlobal('Image', class { set src(_value) { this.width = 600; this.height = 150; Promise.resolve().then(() => this.onload?.()); } });
    vi.stubGlobal('devicePixelRatio', 1);
    let boxWidth = 600;
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 0, width: boxWidth, height: 150 }));
    const { getByTestId } = render(<DrawnSignaturePad onChange={vi.fn()} resetKey="a" />);
    stroke(getByTestId('drawn-signature-canvas'));

    boxWidth = 300;
    resize([{ contentRect: { width: 300 } }]);
    await Promise.resolve();
    await Promise.resolve();
    // min(300 / 600, 150 / 150) = 0.5: the full signature at half size, inside the 300×150 box.
    expect(ctx.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 300, 75);
    vi.unstubAllGlobals();
  });

  it('renders nothing where the canvas has no 2D context (the typed signature still signs)', () => {
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => null);
    const { queryByTestId } = render(<DrawnSignaturePad onChange={vi.fn()} resetKey="a" />);
    expect(queryByTestId('drawn-signature-pad')).not.toBeInTheDocument();
  });
});
