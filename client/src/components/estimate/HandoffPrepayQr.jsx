/**
 * "Prepay the year" in hand-off mode (Book at the Table, owner 2026-11-02): the
 * pay page never opens on the owner's phone. The customer scans this code and
 * finishes on their own phone, and nothing is charged here. `url` is the absolute
 * secure-page link; `onBack` returns to "Pay per application".
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

const NAVY = '#04395E';

export default function HandoffPrepayQr({ url, onBack, busy = false }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 220 })
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => { if (!cancelled) setSrc(''); });
    return () => { cancelled = true; };
  }, [url]);
  return (
    <div data-testid="handoff-prepay-qr" style={{ marginTop: 16, textAlign: 'center' }}>
      <p style={{ fontSize: 16, color: NAVY, lineHeight: 1.5, margin: '0 0 10px', fontWeight: 600 }}>
        Prepay is paid on your own phone. Scan this code with your phone&apos;s camera.
      </p>
      {src ? <img src={src} alt="QR code to prepay on your own phone" width={220} height={220} style={{ background: '#fff', borderRadius: 8 }} /> : null}
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        style={{
          display: 'block', width: '100%', minHeight: 48, marginTop: 12, padding: '0 20px',
          background: '#FFFFFF', color: NAVY, border: '1px solid #E7E2D7', borderRadius: 8,
          fontSize: 16, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1,
        }}
      >
        Pay per application
      </button>
    </div>
  );
}
