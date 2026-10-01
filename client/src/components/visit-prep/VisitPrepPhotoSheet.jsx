/**
 * "Send photos" sheet — the Waves app's own entry point for visit prep
 * photos (customer-visit-photos-scope-20260928.md PR 4, "app entry").
 * PortalPage.jsx's Next Visit card mounts this as a SEPARATE component
 * rather than growing that ~15k-line file further (scope §7). It wraps the
 * shared `VisitPrepPhotoForm` (note + camera/library pickers, send, and the
 * success/full/gone states — built transport-agnostic in PR 2 for the
 * appointment page) in the portal's own sheet/modal chrome, matching
 * PortalPage's hand-rolled dialog pattern (`ReportIssueOverlay`): the same
 * `useLockBodyScroll` / `useModalFocus` / `useIsMobile` hooks, the same
 * `data-glass="modal"` + `data-glass-scrim` full-screen-on-mobile /
 * centered-card-on-desktop shape, and the warm `CUSTOMER_SURFACE` tokens
 * PortalPage's own `PORTAL_SHELL` is sourced from (byte-identical values —
 * see theme-customer.js's file header).
 *
 * Posts through `api.sendVisitPrepPhotos`, the customer-authenticated twin
 * of the public appointment page's route, instead of an anonymous token —
 * everything else (caps, dedupe, response shape) is identical, so the form
 * itself needed no changes.
 */
import { useEffect, useRef } from 'react';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useModalFocus from '../../hooks/useModalFocus';
import useIsMobile from '../../hooks/useIsMobile';
import useSheetViewport from '../../hooks/useSheetViewport';
import { CUSTOMER_SURFACE as S } from '../../theme-customer';
import { FONTS } from '../../theme-brand';
import Icon from '../Icon';
import api from '../../utils/api';
import VisitPrepPhotoForm from './VisitPrepPhotoForm';

/**
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {string|number} scheduledServiceId - the Next Visit card's own id;
 *   posted to `POST /api/schedule/:id/prep-photos`.
 * @param {number} photosRemaining - from the card's `prepPhotos.photosRemaining`.
 * @param {(prepPhotos: object|null) => void} [onSent] - called with the
 *   server's fresh `prepPhotos` counts after a successful send, so the
 *   caller can update the card without a full re-fetch.
 */
export default function VisitPrepPhotoSheet({
  open, onClose, scheduledServiceId, photosRemaining, onSent,
}) {
  // Hooks run unconditionally (React rules) even though the sheet renders
  // nothing while closed — both no-op when `open` is false.
  useLockBodyScroll(open);
  const dialogRef = useModalFocus(open, onClose);
  // Keep the note field and Send above the iOS keyboard (Codex #5306 r2 P2).
  const viewport = useSheetViewport(open, dialogRef);
  const compact = useIsMobile(760);
  // The visit the sheet was opened for. Photos picked for it must never go
  // to a different visit: if the card's next visit changes while the sheet
  // is open (a refresh after the camera returns, the visit went en route or
  // was cancelled), the sheet closes and drops the picks (Codex #5306 r1 P1).
  const openedFor = useRef(null);
  useEffect(() => {
    if (!open) { openedFor.current = null; return; }
    if (openedFor.current == null) { openedFor.current = scheduledServiceId; return; }
    if (String(openedFor.current) !== String(scheduledServiceId)) onClose?.();
  }, [open, scheduledServiceId, onClose]);

  if (!open) return null;

  const handleSubmit = async (formData) => {
    const response = await api.sendVisitPrepPhotos(openedFor.current ?? scheduledServiceId, formData);
    onSent?.(response?.prepPhotos || null);
    return response;
  };

  return (
    <div
      data-glass-scrim={compact ? undefined : ''}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: compact ? S.page : 'rgba(15,23,42,0.48)',
        backdropFilter: compact ? 'none' : 'blur(5px)',
        display: 'flex',
        alignItems: compact ? 'stretch' : 'center',
        justifyContent: 'center',
        padding: compact ? 0 : 24,
        ...(compact && viewport ? { top: viewport.top, height: viewport.height, bottom: 'auto' } : {}),
      }}
    >
      <style>{`
        @keyframes visitPrepSheetIn { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) {
          [data-visit-prep-sheet] { animation: none !important; }
        }
      `}</style>

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Send photos"
        data-visit-prep-sheet
        data-glass="modal"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: compact ? 'none' : 520,
          height: compact ? '100%' : 'auto',
          maxHeight: compact ? 'none' : 'calc(100vh - 48px)',
          background: S.page,
          borderRadius: compact ? 0 : 8,
          boxShadow: compact ? 'none' : '0 24px 70px rgba(15,23,42,0.28)',
          border: compact ? 'none' : `1px solid ${S.border}`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'visitPrepSheetIn 0.22s ease',
        }}
      >
        <header
          style={{
            flexShrink: 0,
            background: 'rgba(255,255,255,0.96)',
            backdropFilter: 'blur(12px)',
            borderBottom: `1px solid ${S.border}`,
            // Full-screen on mobile: keep the header below the notch/status bar.
            padding: compact
              ? 'calc(12px + env(safe-area-inset-top, 0px)) calc(14px + env(safe-area-inset-right, 0px)) 12px calc(14px + env(safe-area-inset-left, 0px))'
              : '14px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: S.soft,
                color: S.text,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="camera" size={16} strokeWidth={2} />
            </span>
            <div style={{ fontSize: 18, fontWeight: 700, color: S.text, fontFamily: FONTS.heading }}>
              Send photos
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              // 48x48: the customer-surface touch-target floor.
              width: 48,
              height: 48,
              borderRadius: 8,
              border: `1px solid ${S.borderStrong}`,
              background: S.surface,
              color: S.text,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Icon name="close" size={16} strokeWidth={2} />
          </button>
        </header>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          <VisitPrepPhotoForm photosRemaining={photosRemaining} onSubmit={handleSubmit} />
        </div>
      </div>
    </div>
  );
}
