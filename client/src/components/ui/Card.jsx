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
      // Card title per the consistency contract + redesign-spec type scale
      // (`text-h3`: 14px / 500 / sentence case). The original foundation PR
      // shipped this as a 12px uppercase overline — a drift the spec reserves
      // for section dividers/column headers, not card titles.
      className={cn('text-14 leading-[1.4] font-medium text-zinc-900', className)}
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
