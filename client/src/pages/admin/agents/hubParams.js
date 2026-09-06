import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// URL = state for the Agents hub. The hub owns ?tab=; the Models tab and the
// hub's area strip read and write ?area= here, the Control center reads and
// writes ?window= / ?status=, so a deep link reproduces the exact view and a
// defaulted value never litters the URL. The hub's tab beacon keys on ?tab=
// only, so these params never re-fire it.

export const WINDOWS = ["today", "7d", "30d"];
export const STATUSES = ["all", "active", "attention", "idle"];
export const PARAM_DEFAULTS = { area: null, window: "7d", status: "all" };

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
  const windowParam = searchParams.get("window");
  const statusParam = searchParams.get("status");
  return {
    tab: searchParams.get("tab"),
    area: searchParams.get("area") || PARAM_DEFAULTS.area,
    window: WINDOWS.includes(windowParam) ? windowParam : PARAM_DEFAULTS.window,
    status: STATUSES.includes(statusParam) ? statusParam : PARAM_DEFAULTS.status,
    set,
  };
}
