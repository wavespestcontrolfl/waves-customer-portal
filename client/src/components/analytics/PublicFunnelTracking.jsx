import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  isPublicFunnelPath,
  hasConsent,
  grantConsent,
  bootPostHog,
  POSTHOG_ENABLED,
} from '../../lib/analytics/posthog';

// Mounted once at the App root. Self-gates: it only does anything on the public
// funnel pages (/book, /estimate, /pay) and only when VITE_POSTHOG_KEY is set.
// On /admin, /tech, and the authenticated customer portal it renders null and
// never boots PostHog.
//
// Consent: if the visitor already accepted on the marketing site, the shared
// `.wavespestcontrol.com` cookie carries over and we boot silently. If they
// arrived directly (no cookie), we show a slim notice so direct-to-/book
// visitors are still covered. Dark by default — nothing shows until a key
// exists, so this can ship ahead of provisioning.
export default function PublicFunnelTracking() {
  const location = useLocation();
  const onFunnel = isPublicFunnelPath(location.pathname);
  const [needConsent, setNeedConsent] = useState(false);

  useEffect(() => {
    if (!POSTHOG_ENABLED || !onFunnel) {
      setNeedConsent(false);
      return;
    }
    if (hasConsent()) {
      bootPostHog();
      setNeedConsent(false);
    } else {
      setNeedConsent(true);
    }
  }, [onFunnel, location.pathname]);

  if (!POSTHOG_ENABLED || !onFunnel || !needConsent) return null;

  function accept() {
    grantConsent();
    bootPostHog();
    setNeedConsent(false);
  }

  return (
    <div
      role="dialog"
      aria-label="Cookie notice"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        background: 'rgba(27, 44, 91, 0.97)',
        backdropFilter: 'blur(4px)',
        borderTop: '1px solid rgba(255,255,255,0.12)',
        padding: '12px 18px',
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <p style={{ color: '#fff', fontSize: 13, margin: 0, lineHeight: 1.45, flex: '1 1 280px' }}>
          We use cookies to understand how this booking flow is used and improve it.{' '}
          <a
            href="https://wavespestcontrol.com/privacy-policy/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#FFD700', textDecoration: 'underline' }}
          >
            Privacy Policy
          </a>
        </p>
        <button
          type="button"
          onClick={accept}
          style={{
            flex: '0 0 auto',
            background: '#FFD700',
            color: '#1B2C5B',
            border: 'none',
            borderRadius: 8,
            padding: '9px 18px',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
