import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

// Hand-rolled modal. If focus-trap edge cases accumulate, swap the root
// for @radix-ui/react-dialog (see DECISIONS.md 2026-04-18 entry on primitives).
export function Dialog({ open, onClose, children, size = 'md', className }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose && onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement;
    setTimeout(() => panelRef.current && panelRef.current.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const sizeClass =
    size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-zinc-900/30"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative w-full bg-white rounded-md border-hairline border-zinc-200',
          'outline-none',
          sizeClass,
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function DialogHeader({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'px-5 py-4 border-b border-hairline border-zinc-200',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function DialogTitle({ className, children, ...rest }) {
  return (
    <h2
      className={cn('text-18 font-medium tracking-tight text-zinc-900', className)}
      {...rest}
    >
      {children}
    </h2>
  );
}

export function DialogBody({ className, children, ...rest }) {
  return (
    <div className={cn('p-5', className)} {...rest}>
      {children}
    </div>
  );
}

export function DialogFooter({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'px-5 py-3 border-t border-hairline border-zinc-200 flex justify-end gap-2',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
