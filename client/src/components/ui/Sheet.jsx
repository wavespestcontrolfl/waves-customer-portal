import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import useModalFocus from '../../hooks/useModalFocus';
import { cn } from './cn';

// Right-side slide-in panel. Customer Detail in spec §5.6 lives here.
// Same focus-trap strategy as Dialog — swap root for Radix if needed.
export function Sheet({ open, onClose, children, width = 'md', className, ariaLabel = 'Details' }) {
  const panelRef = useModalFocus(open, onClose);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  if (!open) return null;

  const widthClass =
    width === 'sm' ? 'max-w-md' : width === 'lg' ? 'max-w-2xl' : 'max-w-xl';

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="absolute inset-0 bg-zinc-900/30" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          height: '100dvh',
          maxHeight: '100dvh',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
        className={cn(
          'absolute top-0 right-0 w-full bg-white box-border',
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
        'px-5 py-4 border-b border-hairline border-zinc-200 flex items-center justify-between shrink-0',
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
        'px-5 py-3 border-t border-hairline border-zinc-200 flex flex-wrap justify-end gap-2 shrink-0',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
