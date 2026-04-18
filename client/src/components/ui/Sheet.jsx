import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

// Right-side slide-in panel. Customer Detail in spec §5.6 lives here.
// Same focus-trap strategy as Dialog — swap root for Radix if needed.
export function Sheet({ open, onClose, children, width = 'md', className }) {
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

  const widthClass =
    width === 'sm' ? 'max-w-md' : width === 'lg' ? 'max-w-2xl' : 'max-w-xl';

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-zinc-900/30" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'absolute top-0 right-0 h-full w-full bg-white',
          'border-l border-hairline border-zinc-200',
          'outline-none flex flex-col',
          widthClass,
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function SheetHeader({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'px-5 py-4 border-b border-hairline border-zinc-200 flex items-center justify-between',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SheetBody({ className, children, ...rest }) {
  return (
    <div className={cn('flex-1 overflow-y-auto p-5', className)} {...rest}>
      {children}
    </div>
  );
}

export function SheetFooter({ className, children, ...rest }) {
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
