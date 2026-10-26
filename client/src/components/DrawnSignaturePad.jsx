import { useCallback, useEffect, useRef, useState } from 'react';
import { DOC, DOC_EYEBROW, FS, LH, RADIUS, SP } from '../theme-doc';

/**
 * Customer signature pad for the /contract/:token signing page. Controlled by the
 * page: `onChange(dataUrl | null)` fires with the PNG data URL after each
 * completed stroke and with null after Clear, so the page sends the image with
 * the sign POST (`signatureImage`) only when something was drawn. The typed
 * signature on the page stays required; this is optional, additional evidence.
 *
 * Canvas sizing follows the tech portal's WDO licensee pad: the bitmap is sized
 * from the rendered box × devicePixelRatio so the exported PNG is neither
 * stretched nor blurry on a phone, and the ink survives a rotation or an iOS
 * URL-bar collapse mid-signature.
 */
const CANVAS_CSS_HEIGHT = 150;
const EXPORT_MAX_W = 1200;

export default function DrawnSignaturePad({ onChange, disabled = false, resetKey }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);
  const inkSnapshot = useRef(null);
  const initGen = useRef(0);
  const [drawn, setDrawn] = useState(false);
  const [supported, setSupported] = useState(true);

  // The PNG the page sends: the bitmap downscaled to EXPORT_MAX_W so a wide desktop pad at 2× still lands
  // well under the sign route's size cap (the resize snapshot keeps the full bitmap).
  const exportDataUrl = (c) => {
    if (c.width <= EXPORT_MAX_W) return c.toDataURL('image/png');
    const scale = EXPORT_MAX_W / c.width;
    const out = document.createElement('canvas');
    out.width = EXPORT_MAX_W;
    out.height = Math.max(1, Math.round(c.height * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return c.toDataURL('image/png');
    ctx.drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };

  const emit = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !hasDrawn.current) { onChange?.(null); return; }
    try {
      inkSnapshot.current = c.toDataURL('image/png');
      onChange?.(exportDataUrl(c));
    } catch {
      inkSnapshot.current = null;
      onChange?.(null);
    }
  }, [onChange]);

  const initCanvas = useCallback(({ preserveInk = false } = {}) => {
    const c = canvasRef.current;
    if (!c) return;
    const gen = ++initGen.current;
    const ctx = c.getContext ? c.getContext('2d') : null;
    if (!ctx) { setSupported(false); return; }
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (rect.width > 0) {
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(CANVAS_CSS_HEIGHT * dpr);
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.2 * (rect.width > 0 ? dpr : 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1B2C5B';
    hasDrawn.current = false;
    setDrawn(false);
    if (!preserveInk) {
      inkSnapshot.current = null;
      return;
    }
    const snapshot = inkSnapshot.current;
    if (!snapshot) return;
    const img = new Image();
    img.onload = () => {
      const cur = canvasRef.current;
      if (!cur || initGen.current !== gen) return;
      const scale = cur.height / (img.height || 1);
      cur.getContext('2d').drawImage(img, 0, 0, img.width * scale, cur.height);
      hasDrawn.current = true;
      setDrawn(true);
    };
    img.src = snapshot;
  }, []);

  // A fresh canvas on mount and whenever the page moves to another contract (resetKey).
  // onChange is deliberately not a dependency: a parent re-render with a new handler must not wipe the ink.
  useEffect(() => {
    initCanvas();
    onChange?.(null);
  }, [resetKey, initCanvas]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = c.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect?.width || 0;
      if (width > 0 && Math.abs(width - lastWidth) > 1) {
        lastWidth = width;
        initCanvas({ preserveInk: true });
      }
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [initCanvas]);

  function pointFor(e) {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const t = e.touches?.[0];
    const cx = t ? t.clientX : e.clientX;
    const cy = t ? t.clientY : e.clientY;
    return { x: (cx - rect.left) * (c.width / (rect.width || c.width)), y: (cy - rect.top) * (c.height / (rect.height || c.height)) };
  }
  function startDraw(e) {
    if (disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext?.('2d');
    if (!ctx) return;
    drawing.current = true;
    const p = pointFor(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function moveDraw(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFor(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasDrawn.current) {
      hasDrawn.current = true;
      setDrawn(true);
    }
  }
  function endDraw() {
    if (!drawing.current) return;
    drawing.current = false;
    emit();
  }
  function clear() {
    initCanvas();
    onChange?.(null);
  }

  if (!supported) return null;

  return (
    <div data-testid="drawn-signature-pad" style={{ marginBottom: SP.md }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={DOC_EYEBROW}>Draw your signature (optional)</div>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || !drawn}
          style={{
            background: 'none', border: 'none', padding: 0, color: drawn ? DOC.brand : DOC.muted, fontSize: FS.body,
            fontWeight: 600, cursor: drawn ? 'pointer' : 'default', minHeight: 44,
          }}
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="drawn-signature-canvas"
        aria-label="Signature pad"
        width={520}
        height={CANVAS_CSS_HEIGHT}
        style={{
          width: '100%', height: CANVAS_CSS_HEIGHT, display: 'block', border: `1px dashed ${DOC.border}`,
          borderRadius: RADIUS.input, background: DOC.surface, touchAction: 'none', cursor: disabled ? 'default' : 'crosshair',
        }}
        onMouseDown={startDraw}
        onMouseMove={moveDraw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={moveDraw}
        onTouchEnd={endDraw}
        onTouchCancel={endDraw}
      />
      <div style={{ marginTop: 4, fontSize: FS.body, color: DOC.muted, lineHeight: LH.snug }}>
        Sign with your finger or mouse. Your typed signature below is still required.
      </div>
    </div>
  );
}
