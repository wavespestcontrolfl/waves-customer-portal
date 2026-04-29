import React from 'react';
import { cn } from './cn';

// Role-based typography primitive for the Tier 1 V2 admin.
// One source of truth for size + weight + color + tracking per text role.
// See docs/design/typography-strategy.md for the full strategy.
//
// Usage: <Text role="label">Active Customers</Text>
// Override element with `as`: <Text role="h2" as="h3">Section</Text>
// Override color with `tone`: <Text role="metric" tone="alert">{value}</Text>

const ROLE_CLASS = {
  // Headings
  h2: 'text-18 font-medium tracking-tight text-ink-primary',
  h3: 'text-14 font-medium text-ink-primary',

  // Body
  body:           'text-14 font-normal text-ink-primary',
  'body-secondary': 'text-14 font-normal text-ink-secondary',
  'body-small':   'text-13 font-normal text-ink-secondary',

  // Chrome
  label:   'text-11 font-medium uppercase tracking-label text-ink-secondary',
  caption: 'text-12 font-normal text-ink-tertiary',

  // Numbers
  metric:    'text-22 font-medium tracking-tight text-ink-primary u-nums leading-none',
  'metric-sm': 'text-16 font-medium text-ink-primary u-nums',

  // Inline
  link:  'font-medium text-waves-blue hover:underline',
  alert: 'font-medium text-alert-fg',
};

const DEFAULT_ELEMENT = {
  h2: 'h2',
  h3: 'h3',
  body: 'p',
  'body-secondary': 'p',
  'body-small': 'p',
  label: 'div',
  caption: 'div',
  metric: 'div',
  'metric-sm': 'span',
  link: 'a',
  alert: 'span',
};

const TONE_CLASS = {
  primary:   'text-ink-primary',
  secondary: 'text-ink-secondary',
  tertiary:  'text-ink-tertiary',
  disabled:  'text-ink-disabled',
  alert:     'text-alert-fg',
  inherit:   '',
};

export function Text({ role = 'body', as, tone, className, children, ...rest }) {
  const Tag = as || DEFAULT_ELEMENT[role] || 'span';
  return (
    <Tag
      className={cn(
        ROLE_CLASS[role],
        tone && TONE_CLASS[tone],
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
