import { useEffect, useState } from 'react';

const DARK = {
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

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
        background: DARK.card,
        border: `1px solid ${DARK.border}`,
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
        pointerEvents: 'auto',
      }}>
        {/* Logo */}
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: `linear-gradient(135deg, ${DARK.teal}, #2563eb)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 800, color: '#fff',
          fontFamily: "'Montserrat', sans-serif",
        }}>W</div>

        {/* Text */}
        <div style={{ flex: 1 }}>
          <p style={{
            margin: 0, fontSize: 14, fontWeight: 700, color: DARK.text,
            fontFamily: "'Montserrat', sans-serif",
          }}>Add Waves to Home Screen</p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: DARK.muted }}>
            Quick access to your portal
          </p>
        </div>

        {/* Install button */}
        <button onClick={handleInstall} style={{
          background: DARK.teal,
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: "'Montserrat', sans-serif",
          whiteSpace: 'nowrap',
        }}>Install</button>

        {/* Dismiss */}
        <button onClick={dismiss} style={{
          background: 'none',
          border: 'none',
          color: DARK.muted,
          fontSize: 18,
          cursor: 'pointer',
          padding: '0 4px',
          lineHeight: 1,
        }}>&times;</button>
      </div>
    </div>
  );
}
