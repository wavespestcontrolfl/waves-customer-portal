import React, { createContext, forwardRef, useContext } from 'react';
import { cn } from './cn';

// Unmigrated consumers retain their existing presentation. New admin surfaces
// opt into the documented density once, including controls rendered in portals.
const UiDensityContext = createContext('legacy');

export function useUiDensity(density) {
  const inherited = useContext(UiDensityContext);
  return density ?? inherited;
}

export const UiSurface = forwardRef(function UiSurface(
  { as: Component = 'div', density = 'comfortable', className, children, ...rest }, ref,
) {
  return <UiDensityContext.Provider value={density}>
    <Component ref={ref} data-ui-density={density} className={cn('ui-surface', className)} {...rest}>
      {children}
    </Component>
  </UiDensityContext.Provider>;
});

export const CONTROL_DENSITIES = {
  comfortable: 'ui-control-comfortable',
  compact: 'ui-control-compact',
  touch: 'ui-control-touch',
};
