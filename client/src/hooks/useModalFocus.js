import { useEffect, useRef } from 'react';

// Shared focus management for the hand-rolled customer-surface modals
// (legacy inline-style pages — no Radix). On open: remembers the trigger,
// moves focus into the dialog, and keeps Tab / Shift+Tab cycling inside it.
// On close/unmount: restores focus to the remembered trigger.
//
// Usage:
//   const dialogRef = useModalFocus(open);        // `open` optional, defaults true
//   ...
//   <div ref={dialogRef} role="dialog" aria-modal="true" ...>
//
// For modals that only mount while open, call it with no argument.
// Pass an onEscape callback to give every modal the same keyboard-close
// contract without duplicating document listeners at each call site.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export default function useModalFocus(active = true, onEscape = null) {
  const dialogRef = useRef(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // Capture the opener during render on the closed→open transition. With an
  // autoFocus child (e.g. the chat input in PortalPage), React moves focus
  // INTO the dialog at commit — before the passive effect below runs — so
  // reading document.activeElement there records the modal's own child and
  // close never restores focus to the trigger. At render time focus is still
  // on the opener. `openedRef` flips inside the effect (not during render) so
  // a render that never commits can't strand it.
  const openerRef = useRef(null);
  const openedRef = useRef(false);
  if (active && !openedRef.current) {
    const el = document.activeElement;
    if (!(dialogRef.current && dialogRef.current.contains(el))) {
      openerRef.current = el;
    }
  }

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    openedRef.current = true;
    const previouslyFocused = openerRef.current;

    const getFocusable = () =>
      Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
      );

    // Make the container itself focusable so dialogs with zero focusable
    // children (or async-mounted content, e.g. Stripe elements) still work.
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    // Respect an autoFocus element inside the dialog (e.g. the chat input);
    // otherwise move focus to the dialog container itself.
    if (!dialog.contains(document.activeElement)) dialog.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && onEscapeRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        if (current === first || current === dialog || !dialog.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !dialog.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      openedRef.current = false;
      if (
        previouslyFocused &&
        typeof previouslyFocused.focus === 'function' &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [active]);

  return dialogRef;
}
