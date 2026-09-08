import React from 'react';
import { Button } from './Button';
import { cn } from './cn';

export function ActionFeedback({ children, error = false, onRetry, className }) {
  return <div role={error ? 'alert' : 'status'} className={cn('ui-action-feedback', error ? 'text-alert-fg' : 'text-ink-secondary', className)}>
    <span>{children}</span>
    {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
  </div>;
}
