import { useEffect, useRef } from 'react';

// Shared focus management for the hand-rolled modals. On open: remembers the
// trigger, moves focus into the dialog, and keeps Tab / Shift+Tab cycling
// inside it. On close/unmount: restores focus to the remembered trigger.
// Pass an onEscape callback to add the standard keyboard-close behavior.

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

// Only the topmost modal owns the document-level keyboard contract when
// dialogs are stacked (for example, an error alert over a form).
const modalStack = [];

export default function useModalFocus(active = true, onEscape = null) {
  const dialogRef = useRef(null);
  const modalEntryRef = useRef({});
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // Capture the opener during render because an autoFocus child can move
  // focus before the passive effect runs.
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
    const modalEntry = modalEntryRef.current;
    modalStack.push(modalEntry);

    const getFocusable = () =>
      Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isAvailable);

    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    if (!dialog.contains(document.activeElement)) {
      dialog.focus({ preventScroll: true });
    }

    const onKeyDown = (event) => {
      if (modalStack[modalStack.length - 1] !== modalEntry) return;
      if (event.key === 'Escape' && onEscapeRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onEscapeRef.current();
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
      const stackIndex = modalStack.lastIndexOf(modalEntry);
      if (stackIndex !== -1) modalStack.splice(stackIndex, 1);
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
