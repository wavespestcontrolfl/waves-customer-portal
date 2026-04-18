import React from 'react';
import { cn } from './cn';

export function Table({ className, children, ...rest }) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn('w-full border-collapse text-13 text-zinc-900', className)}
        {...rest}
      >
        {children}
      </table>
    </div>
  );
}

export function THead({ className, children, ...rest }) {
  return (
    <thead className={cn('bg-transparent', className)} {...rest}>
      {children}
    </thead>
  );
}

export function TBody({ className, children, ...rest }) {
  return <tbody className={className} {...rest}>{children}</tbody>;
}

export function TR({ className, children, ...rest }) {
  return (
    <tr
      className={cn(
        'border-b border-hairline border-zinc-200 hover:bg-zinc-50',
        className
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TH({ className, children, align = 'left', ...rest }) {
  return (
    <th
      className={cn(
        'px-3 py-2 text-11 uppercase tracking-label font-medium text-ink-secondary',
        'border-b border-hairline border-zinc-200',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TD({ className, children, align = 'left', nums = false, ...rest }) {
  return (
    <td
      className={cn(
        'px-3 py-2',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        nums && 'u-nums',
        className
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
