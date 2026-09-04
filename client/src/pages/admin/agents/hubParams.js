import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// URL = state for the Agents hub. The hub owns ?tab=; the Models tab and the
// hub's area strip read and write ?area= here so a deep link reproduces the
// exact view and a defaulted value never litters the URL. The hub's tab
// beacon keys on ?tab= only, so this param never re-fires it.

export const PARAM_DEFAULTS = { area: null };

export function useHubParams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const set = useCallback(
    (patch) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value == null || value === "" || value === PARAM_DEFAULTS[key]) params.delete(key);
            else params.set(key, String(value));
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return {
    tab: searchParams.get("tab"),
    area: searchParams.get("area") || PARAM_DEFAULTS.area,
    set,
  };
}
