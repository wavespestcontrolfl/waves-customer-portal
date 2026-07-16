import React, { createContext, useContext, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import useModalFocus from '../../hooks/useModalFocus';
import { cn } from './cn';

const DialogTitleContext = createContext(null);

// Hand-rolled modal. If focus-trap edge cases accumulate, swap the root
// for @radix-ui/react-dialog (see DECISIONS.md 2026-04-18 entry on primitives).
export function Dialog({ open, onClose, children, size = 'md', className, style }) {
  const panelRef = useModalFocus(open, onClose);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  if (!open) return null;

  const sizeClass =
    size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{
        paddingTop: 'max(16px, env(safe-area-inset-top, 0px))',
        paddingRight: 'max(16px, env(safe-area-inset-right, 0px))',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))',
        paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))',
        ...style,
      }}
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
          'outline-none max-h-full flex flex-col',
          sizeClass,
          className
        )}
      >
        <DialogTitleContext.Provider value={titleId}>
          {children}
        </DialogTitleContext.Provider>
      </div>
    </div>,
    document.body
  );
}

export function DialogHeader({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'px-5 py-4 border-b border-hairline border-zinc-200 shrink-0',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function DialogTitle({ className, children, ...rest }) {
  const titleId = useContext(DialogTitleContext);
  return (
    <h2
      id={rest.id || titleId}
      className={cn('text-18 font-medium tracking-tight text-zinc-900', className)}
      {...rest}
    >
      {children}
    </h2>
  );
}

export function DialogBody({ className, children, ...rest }) {
  return (
    <div className={cn('p-5 min-h-0 overflow-y-auto overscroll-contain', className)} {...rest}>
      {children}
    </div>
  );
}

export function DialogFooter({ className, children, ...rest }) {
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
