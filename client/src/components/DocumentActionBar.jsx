// Shared Download PDF / Share / Print row for tokened customer documents
// (owner ask 2026-07-09, live review screen) — the buttons-only twin of the
// report page's action bar (post-#2525: no title line). Self-contained so it
// drops into any of the customer style systems (data-glass inline, BrandCard
// pages, the Tailwind outline page) without page-local CSS.
import { useState } from 'react';
import { Download, Share2, Printer, Lock } from 'lucide-react';
import { canSaveNative, isNativeApp, saveUrlNative } from '../native/nativeFile';
import { COLORS as B } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';

const FONT_BODY = "'Inter', system-ui, sans-serif";

function buttonStyle() {
  return {
    minHeight: 48,
    padding: '0 18px',
    borderRadius: 10,
    border: `1px solid ${B.blueDeeper}`,
    background: B.blueDeeper,
    color: '#FFFFFF',
    fontFamily: FONT_BODY,
    fontWeight: 700,
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    boxShadow: 'none',
    textTransform: 'none',
    whiteSpace: 'nowrap',
  };
}

/**
 * @param {string|null} pdfUrl   Absolute/API URL of the document PDF; omit or
 *                               null to hide the Download button (pages with
 *                               no server-side PDF render).
 * @param {string} pdfFileName   Save-sheet filename in the native shell.
 * @param {string} shareTitle    navigator.share sheet title.
 * @param {string} shareUrl      Defaults to the current location.
 */
export default function DocumentActionBar({
  pdfUrl = null,
  pdfFileName = 'Waves_Document.pdf',
  shareTitle = 'Waves',
  shareUrl = null,
  style = null,
}) {
  const [copied, setCopied] = useState(false);

  // Mirrors the report page's share(): native sheet when available, clipboard
  // fallback with visible feedback; a canceled sheet or absent Clipboard API
  // (in-app webviews, non-secure contexts) is not an error and shows nothing.
  const share = async () => {
    // origin + pathname ONLY — after a Stripe redirect the pay/statement
    // pages carry payment_intent_client_secret/redirect_status query params,
    // which must never ride a shared link. Tokens live in the path.
    const url = shareUrl || `${window.location.origin}${window.location.pathname}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: shareTitle, url });
        return;
      }
    } catch {
      return; // share sheet canceled
    }
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') return;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section
      data-glass="card"
      className="doc-action-bar"
      aria-label="Document tools"
      style={{
        // Mirrors the report page's .report-action-bar geometry exactly
        // (owner 2026-07-09: same format as the report bar).
        background: '#FFFFFF',
        border: `1px solid ${CUSTOMER_SURFACE.border}`,
        borderRadius: 16,
        padding: '20px 22px',
        margin: '0 0 18px',
        ...style,
      }}
    >
      <style>{`
        @media print { .doc-action-bar { display: none !important; } }
        .doc-action-bar-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .doc-action-bar-buttons > a, .doc-action-bar-buttons > button { width: 100%; }
        @media (max-width: 640px) {
          .doc-action-bar { padding: 18px 16px; }
          .doc-action-bar-buttons { grid-template-columns: 1fr; }
        }
      `}</style>
      <div className="doc-action-bar-buttons">
        {pdfUrl ? (
          <a
            data-glass-accent=""
            href={pdfUrl}
            download
            onClick={(e) => {
              // In the Capacitor shell an <a download> dead-ends the webview —
              // route through the native share sheet (F-046). canSaveNative:
              // old installed binaries run this JS without the plugins — leave
              // their legacy tap behavior alone.
              if (canSaveNative()) {
                e.preventDefault();
                saveUrlNative(pdfUrl, pdfFileName)
                  .catch(() => window.alert('Could not save the PDF. Please try again.'));
              }
            }}
            style={buttonStyle()}
          ><Download size={16} /> Download PDF</a>
        ) : null}
        <button data-glass-accent="" type="button" onClick={share} style={buttonStyle()}>
          <Share2 size={16} /> {copied ? 'Link copied' : 'Share'}
        </button>
        {/* window.print() is a no-op in the Capacitor webview — hide the
            button there; the Download PDF share sheet carries Print on iOS. */}
        {isNativeApp() ? null : (
          <button data-glass-accent="" type="button" onClick={() => window.print()} style={buttonStyle()}>
            <Printer size={16} /> Print
          </button>
        )}
        <a data-glass-accent="" href="/login" style={buttonStyle()}>
          <Lock size={16} /> Portal Login
        </a>
      </div>
    </section>
  );
}
