import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FONTS } from '../theme-brand';

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
      {/* Glass card (owner 2026-07-07: match the glass UI) — frosted white
          gradient + blur, gold accent CTA, navy text; same recipe as the
          glass-components.css chips/CTAs, inlined because the login page
          isn't mounted under [data-glass-theme]. */}
      <div style={{
        maxWidth: 480,
        margin: '0 auto',
        background: 'linear-gradient(135deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34)), rgba(255,255,255,0.3)',
        border: '1px solid rgba(255,255,255,0.65)',
        backdropFilter: 'blur(14px) saturate(170%)',
        WebkitBackdropFilter: 'blur(14px) saturate(170%)',
        borderRadius: 16,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 12px 32px rgba(4,57,94,0.18), inset 0 1px 0 rgba(255,255,255,0.5)',
        pointerEvents: 'auto',
      }}>
        {/* Waves logo tile */}
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: 'rgba(255,255,255,0.55)',
          border: '1px solid rgba(255,255,255,0.7)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 24, maxWidth: 28, objectFit: 'contain' }} />
        </div>

        {/* Text */}
        <div style={{ flex: 1 }}>
          <p style={{
            margin: 0, fontSize: 14, fontWeight: 700, color: '#04395E',
            fontFamily: FONTS.heading,
          }}>Add Waves to Home Screen</p>
          <p style={{
            margin: '2px 0 0', fontSize: 14, fontWeight: 500,
            color: '#1B2C5B',
            fontFamily: FONTS.heading,
          }}>
            Quick access to your portal
          </p>
        </div>

        <button onClick={handleInstall} style={{
          background: 'linear-gradient(135deg, rgba(255,222,120,0.85), rgba(244,176,20,0.75)), rgba(240,165,0,0.5)',
          color: '#1B2C5B',
          border: '1px solid rgba(255,238,180,0.92)',
          borderRadius: 999,
          padding: '9px 16px',
          fontSize: 14,
          fontWeight: 800,
          cursor: 'pointer',
          fontFamily: FONTS.heading,
          letterSpacing: 0,
          whiteSpace: 'nowrap',
          boxShadow: '0 8px 20px rgba(180,110,0,0.22), inset 0 1px 0 rgba(255,255,255,0.4)',
        }}>Install</button>

        {/* Dismiss */}
        <button onClick={dismiss} aria-label="Dismiss install prompt" style={{
          background: 'none',
          border: 'none',
          color: '#1B2C5B',
          fontSize: 18,
          cursor: 'pointer',
          padding: '0 4px',
          lineHeight: 1,
        }}>&times;</button>
      </div>
    </div>
  );
}
