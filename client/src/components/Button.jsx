// Button.jsx — shared button primitive for customer and admin surfaces.
// Styles live in ../styles/buttons.css (imported via index.css).
//
// Usage:
//   <Button variant="primary">Get My Free Quote</Button>           → customer gold pill
//   <Button variant="secondary" as="a" href="/quote">Get Gold</Button>
//   <Button variant="primary" surface="admin">Save</Button>         → admin teal
//   <Button variant="primary" fullWidthMobile icon="→">…</Button>

import React from 'react';

const variantClassMap = {
  primary:   'btn btn-primary',
  secondary: 'btn btn-secondary',
  tertiary:  'btn btn-tertiary',
  nav:       'btn btn-nav',
  utility:   'btn btn-utility',
};

export function Button({
  variant = 'primary',
  surface = 'customer',
  fullWidthMobile = false,
  icon,
  iconPosition = 'right',
  as: Component = 'button',
  className,
  children,
  ...props
}) {
  const classes = [
    variantClassMap[variant] || variantClassMap.primary,
    fullWidthMobile && 'btn-block-mobile',
    className,
  ].filter(Boolean).join(' ');

  return (
    <Component {...props} data-surface={surface} className={classes}>
      {icon && iconPosition === 'left' && <span aria-hidden>{icon}</span>}
      {children}
      {icon && iconPosition === 'right' && <span aria-hidden>{icon}</span>}
    </Component>
  );
}

export default Button;
