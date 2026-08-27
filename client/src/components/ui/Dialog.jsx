import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import useModalFocus from '../../hooks/useModalFocus';
import { cn } from './cn';

const DialogTitleContext = createContext(null);

// Hand-rolled modal. If focus-trap edge cases accumulate, swap the root
// for @radix-ui/react-dialog (see DECISIONS.md 2026-04-18 entry on primitives).
export function Dialog({
  open,
  onClose,
  children,
  size = 'md',
  className,
  style,
  'aria-label': ariaLabel,
}) {
  const panelRef = useModalFocus(open, onClose);
  const titleId = useId();
  // aria-labelledby must reference an element that actually exists. Some
  // dialogs (e.g. bare confirmation prompts) render only a DialogBody, so
  // the ID is only wired up once a DialogTitle registers itself — otherwise
  // screen readers announce a dialog with a dangling label reference.
  // Callers without a title can pass an explicit aria-label instead.
  const [hasTitle, setHasTitle] = useState(false);
  const registerTitle = useCallback(() => {
    setHasTitle(true);
    return () => setHasTitle(false);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  if (!open) return null;

  // `sm` dialogs are short confirmation prompts and stay a centered card at
  // every width. `md`/`lg` carry real content, so below the `sm` breakpoint
  // they fill the phone viewport (the same treatment the completion sheet
  // gets). Only `max-sm:` classes are added for that — the ≥640px classes
  // are unchanged, so a caller's own `className` sizing (e.g. the customer
  // preview's `h-[calc(100dvh-2rem)] max-w-6xl`) still wins on desktop.
  const isCompact = size === 'sm';
  const sizeClass =
    size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  const mobileFullScreenClass = isCompact
    ? ''
    : cn(
        'max-sm:h-full max-sm:max-w-none max-sm:rounded-none max-sm:box-border',
        // The overlay's safe-area padding is zeroed below `sm`, so the panel
        // carries the insets itself (all four sides — landscape notches too).
        'max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)]',
        'max-sm:pl-[env(safe-area-inset-left)] max-sm:pr-[env(safe-area-inset-right)]',
      );

  return createPortal(
    <div
      className={cn(
        // z-[100] clears the admin shell's fixed mobile header (90) and tab bar (95).
        'fixed inset-0 z-[100] flex items-center justify-center p-4',
        // `!` beats the inline safe-area padding below; that padding stays for
        // every card layout (compact dialogs, and content dialogs from `sm` up).
        !isCompact && 'max-sm:!p-0',
      )}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={!ariaLabel && hasTitle ? titleId : undefined}
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
          mobileFullScreenClass,
          className
        )}
      >
        <DialogTitleContext.Provider value={{ titleId, registerTitle }}>
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
  const context = useContext(DialogTitleContext);
  // Tell the parent Dialog a title exists so it can point aria-labelledby
  // at us; registerTitle returns its own cleanup for unmount.
  useEffect(
    () => (context?.registerTitle ? context.registerTitle() : undefined),
    [context],
  );
  return (
    <h2
      id={rest.id || context?.titleId}
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
