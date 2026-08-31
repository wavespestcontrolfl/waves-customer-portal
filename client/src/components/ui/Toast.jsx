import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

/**
 * Admin toast system (spec §3.9) — two tiers, one host:
 *
 *   showAdminToast('Preferences saved')                      // neutral tier
 *   showAdminToast('Visit deleted', { tier: 'alert',        // alert tier
 *                                     undo: () => restore() })
 *
 * Neutral: grayscale, top-right, 4000ms, no undo.
 * Alert:   red, bottom-right, 8000ms with undo else 5000ms.
 * Both: 40px tall, hairline border, radius-md, 13px body.
 * Stack limit 3 per tier — older toasts collapse into a "+N MORE" pill.
 *
 * Same architecture as CustomerDialogHost (the repo's precedent for
 * imperative fire-and-forget UI): module-level function -> CustomEvent ->
 * single portaled host that owns the queue. Call sites need no hook,
 * provider, or prop-drilling. <AdminToastHost /> mounts once in
 * AdminLayoutV2; showAdminToast is a safe no-op if no host is mounted.
 */
const TOAST_EVENT = 'waves:admin-toast';
let nextId = 1;

export function showAdminToast(message, options = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, {
    detail: { id: nextId++, message, ...options },
  }));
}

const VISIBLE_PER_TIER = 3;

function duration(toast) {
  if (toast.duration) return toast.duration;
  if (toast.tier === 'alert') return toast.undo ? 8000 : 5000;
  return 4000;
}

export function AdminToastHost() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  useEffect(() => {
    const dismiss = (id) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      setToasts((current) => current.filter((t) => t.id !== id));
    };
    const enqueue = (event) => {
      const toast = event.detail;
      timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), duration(toast)));
      setToasts((current) => [...current, toast]);
    };
    window.addEventListener(TOAST_EVENT, enqueue);
    const pending = timers.current;
    return () => {
      window.removeEventListener(TOAST_EVENT, enqueue);
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  if (typeof document === 'undefined') return null;

  const dismiss = (id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((t) => t.id !== id));
  };

  const renderTier = (tier) => {
    const all = toasts.filter((t) => (t.tier === 'alert') === (tier === 'alert'));
    if (all.length === 0) return null;
    const visible = all.slice(-VISIBLE_PER_TIER);
    const hidden = all.length - visible.length;
    const alert = tier === 'alert';
    return (
      <div
        role="status"
        aria-live={alert ? 'assertive' : 'polite'}
        className={cn(
          // z-[140]: above the modal contract (120) and its nested children
          // (130) so feedback stays visible over open dialogs; below the
          // palette/notification popovers (9998/9999).
          'fixed right-4 z-[140] flex flex-col gap-2 items-end',
          alert ? 'bottom-4' : 'top-4',
        )}
      >
        {hidden > 0 && (
          <div className="h-6 px-2.5 inline-flex items-center rounded-xs bg-zinc-100 border-hairline border-zinc-200 text-11 font-medium text-ink-secondary">
            +{hidden} MORE
          </div>
        )}
        {visible.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'min-h-[40px] max-w-[360px] px-3.5 py-2.5 rounded-md border-hairline shadow-lg',
              'flex items-center gap-3 text-13',
              alert
                ? 'bg-alert-bg text-alert-fg border-alert-fg/20'
                : 'bg-white text-zinc-900 border-zinc-200',
            )}
          >
            <span className="min-w-0">{toast.message}</span>
            {toast.undo && (
              <button
                type="button"
                className="shrink-0 text-11 font-medium uppercase tracking-label underline underline-offset-2 u-focus-ring"
                onClick={() => {
                  toast.undo();
                  dismiss(toast.id);
                }}
              >
                {toast.undoLabel || 'Undo'}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  };

  return createPortal(
    <>
      {renderTier('neutral')}
      {renderTier('alert')}
    </>,
    document.body,
  );
}
