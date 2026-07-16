import { useEffect, useRef } from 'react';

// Shared focus management for hand-rolled modals. On open: remembers the
// trigger, moves focus into the dialog, and keeps Tab / Shift+Tab cycling
// inside it. On close/unmount: restores focus to the remembered trigger.
// An optional second argument adds Escape dismissal for admin overlays.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isAvailable(element) {
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  let current = element;
  while (current instanceof HTMLElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

export default function useModalFocus(active = true, onClose) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Capture the opener during render on the closed→open transition. An
  // autoFocus child can otherwise move focus before the passive effect runs.
  const openerRef = useRef(null);
  const openedRef = useRef(false);
  if (active && !openedRef.current) {
    const element = document.activeElement;
    if (!(dialogRef.current && dialogRef.current.contains(element))) {
      openerRef.current = element;
    }
  }

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    openedRef.current = true;
    const previouslyFocused = openerRef.current;
    const getFocusable = () =>
      Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isAvailable);

    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });

    const onKeyDown = (event) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || current === dialog || !dialog.contains(current)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (current === last || !dialog.contains(current)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      openedRef.current = false;
      if (
        previouslyFocused
        && typeof previouslyFocused.focus === 'function'
        && document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [active]);

  return dialogRef;
}
