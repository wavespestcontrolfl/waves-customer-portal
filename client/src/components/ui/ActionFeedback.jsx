import React from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { useUiDensity } from './UiSurface';

export function ActionFeedback({ children, error = false, onRetry, className }) {
  const density = useUiDensity();
  return <div role={error ? 'alert' : 'status'} className={cn('ui-action-feedback', error ? 'text-alert-fg' : 'text-ink-secondary', className)}>
    <span>{children}</span>
    {onRetry && <Button variant="secondary" density={density === 'legacy' ? 'comfortable' : density} onClick={onRetry}>Try again</Button>}
  </div>;
}
