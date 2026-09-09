import React, { Children, cloneElement, useId } from 'react';
import { cn } from './cn';

// One labelable control per field. Keep caller-owned values, events and
// descriptions; add only the associations for the content rendered here.
export function Field({ id, label, help, error, required, className, children }) {
  const generatedId = useId();
  const control = Children.only(children);
  const controlId = id || control.props.id || generatedId;
  const describedBy = [control.props['aria-describedby'], help && `${controlId}-help`, error && `${controlId}-error`].filter(Boolean).join(' ') || undefined;
  return <div className={cn('ui-field', className)}>
    <label className="ui-label" htmlFor={controlId}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {cloneElement(control, {
      id: controlId,
      required: required ?? control.props.required,
      'aria-describedby': describedBy,
      'aria-invalid': error ? true : control.props['aria-invalid'],
    })}
    {help && <div id={`${controlId}-help`} className="text-ui-caption text-ink-secondary">{help}</div>}
    {error && <div id={`${controlId}-error`} role="alert" className="text-ui-caption text-alert-fg">{error}</div>}
  </div>;
}
