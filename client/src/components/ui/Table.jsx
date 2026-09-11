import React from 'react';
import { cn } from './cn';
import { useUiDensity } from './UiSurface';

export function Table({ className, containerClassName, overflow = 'auto', layout = 'scroll', children, ...rest }) {
  return (
    <div className={cn('w-full', layout === 'records' && 'ui-records-table', overflow === 'visible' ? 'overflow-visible' : 'overflow-x-auto', containerClassName)}>
      <table
        className={cn('ui-table w-full border-collapse text-zinc-900', className)}
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
        'ui-table-row border-b border-hairline border-zinc-200 hover:bg-zinc-50',
        className
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TH({ className, children, align = 'left', ...rest }) {
  const density = useUiDensity();
  return (
    <th
      className={cn(
        density === 'legacy' ? 'px-3 py-2 text-11 uppercase tracking-label font-medium' : 'ui-table-heading',
        'text-ink-secondary',
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
  const density = useUiDensity();
  return (
    <td
      className={cn(
        density === 'legacy' ? 'px-3 py-2' : 'ui-table-cell',
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
