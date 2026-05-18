import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { COLORS as B, FONTS } from '../theme-brand';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [show, setShow] = useState(false);
  const [mobileEligible, setMobileEligible] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => setMobileEligible(media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, []);

  useEffect(() => {
    const dismissed = sessionStorage.getItem('pwaPromptDismissed');
    if (dismissed) return;

    function handlePrompt(e) {
      e.preventDefault();
      setDeferredPrompt(e);
      // Show after 30 seconds on login only; the authenticated portal has
      // fixed navigation and support actions at the bottom of the screen.
      setTimeout(() => {
        if (window.location.pathname !== '/login') return;
        if (!window.matchMedia('(max-width: 900px)').matches) return;
        setShow(true);
      }, 30000);
    }

    window.addEventListener('beforeinstallprompt', handlePrompt);
    return () => window.removeEventListener('beforeinstallprompt', handlePrompt);
  }, []);

  useEffect(() => {
    if (pathname !== '/login') setShow(false);
  }, [pathname]);

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

  if (!show || !mobileEligible || pathname !== '/login') return null;

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
        background: B.white,
        border: '1px solid #E7E2D7',
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 -4px 24px rgba(27,44,91,0.14)',
        pointerEvents: 'auto',
      }}>
        {/* Waves logo tile */}
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: '#F8FCFE',
          border: '1px solid #CFE7F5',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 24, maxWidth: 28, objectFit: 'contain' }} />
        </div>

        {/* Text */}
        <div style={{ flex: 1 }}>
          <p style={{
            margin: 0, fontSize: 14, fontWeight: 700, color: B.blueDeeper,
            fontFamily: FONTS.heading,
          }}>Add Waves to Home Screen</p>
          <p style={{
            margin: '2px 0 0', fontSize: 12, fontWeight: 500,
            color: B.textCaption,
            fontFamily: FONTS.heading,
          }}>
            Quick access to your portal
          </p>
        </div>

        <button onClick={handleInstall} style={{
          background: B.blueDeeper,
          color: B.white,
          border: 'none',
          borderRadius: 8,
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 800,
          cursor: 'pointer',
          fontFamily: FONTS.heading,
          letterSpacing: 0,
          whiteSpace: 'nowrap',
        }}>Install</button>

        {/* Dismiss */}
        <button onClick={dismiss} style={{
          background: 'none',
          border: 'none',
          color: B.textCaption,
          fontSize: 18,
          cursor: 'pointer',
          padding: '0 4px',
          lineHeight: 1,
        }}>&times;</button>
      </div>
    </div>
  );
}
