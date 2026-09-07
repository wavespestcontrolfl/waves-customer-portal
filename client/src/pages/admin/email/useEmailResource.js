import { useCallback, useRef, useState } from "react";
import { adminFetch } from "./emailApi";

// Each mailbox resource has its own request order. Re-entering Email or
// changing a filter may start another read before the previous one finishes.
export default function useEmailResource(
  path,
  initialValue = null,
  errorValue,
) {
  const [value, setValue] = useState(initialValue);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const response = await adminFetch(path);
      const data = await response.json();
      if (request === sequence.current) setValue(data);
    } catch {
      if (request === sequence.current && errorValue !== undefined)
        setValue(errorValue);
    }
  }, [path, errorValue]);
  return [value, reload, setValue];
}
