import { useEffect, useState } from 'react';
import { COLORS as B, FONTS } from '../theme-brand';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const dismissed = sessionStorage.getItem('pwaPromptDismissed');
    if (dismissed) return;

    function handlePrompt(e) {
      e.preventDefault();
      setDeferredPrompt(e);
      // Show after 30 seconds
      setTimeout(() => setShow(true), 30000);
    }

    window.addEventListener('beforeinstallprompt', handlePrompt);
    return () => window.removeEventListener('beforeinstallprompt', handlePrompt);
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      setShow(false);
    }
    setDeferredPrompt(null);
  }

  function dismiss() {
    setShow(false);
    sessionStorage.setItem('pwaPromptDismissed', '1');
  }

  if (!show) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
      padding: '0 12px 12px',
      pointerEvents: 'none',
    }}>
      <div style={{
        maxWidth: 480,
        margin: '0 auto',
        background: B.blueDeeper,
        border: `1px solid ${B.blueDark}`,
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
        pointerEvents: 'auto',
      }}>
        {/* W logo tile — brand gold square, Anton W in navy */}
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: B.yellow,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 400, color: B.blueDeeper,
          fontFamily: FONTS.display,
          letterSpacing: '0.02em',
          lineHeight: 1,
        }}>W</div>

        {/* Text */}
        <div style={{ flex: 1 }}>
          <p style={{
            margin: 0, fontSize: 14, fontWeight: 700, color: B.white,
            fontFamily: FONTS.heading,
          }}>Add Waves to Home Screen</p>
          <p style={{
            margin: '2px 0 0', fontSize: 12,
            color: 'rgba(255,255,255,0.7)',
            fontFamily: FONTS.body,
          }}>
            Quick access to your portal
          </p>
        </div>

        {/* Install button — gold pill, navy text (matches LoginPage primary CTA) */}
        <button onClick={handleInstall} style={{
          background: B.yellow,
          color: B.blueDeeper,
          border: 'none',
          borderRadius: 8,
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 800,
          cursor: 'pointer',
          fontFamily: FONTS.ui,
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
        }}>Install</button>

        {/* Dismiss */}
        <button onClick={dismiss} style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.6)',
          fontSize: 18,
          cursor: 'pointer',
          padding: '0 4px',
          lineHeight: 1,
        }}>&times;</button>
      </div>
    </div>
  );
}
