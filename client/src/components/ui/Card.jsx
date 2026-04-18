import React from 'react';
import { cn } from './cn';

export function Card({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'bg-white border-hairline border-zinc-200 rounded-md',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'px-4 py-3 border-b border-hairline border-zinc-200',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }) {
  return (
    <h3
      className={cn('text-12 uppercase tracking-label font-medium text-ink-secondary', className)}
      {...rest}
    >
      {children}
    </h3>
  );
}

export function CardBody({ className, children, ...rest }) {
  return (
    <div className={cn('p-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }) {
  return (
    <div
      className={cn(
        'px-4 py-3 border-t border-hairline border-zinc-200',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
