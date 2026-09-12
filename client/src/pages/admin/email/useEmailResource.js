import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "./emailApi";

// Keep independent request ordering and expose failure separately from data.
export default function useEmailResource(path, initialValue = null) {
  const [value, setValue] = useState(initialValue);
  const [state, setState] = useState({ loading: false, error: false });
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; }, [path]);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setState({ loading: true, error: false });
    try {
      const response = await adminFetch(path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.error) throw new Error("Resource unavailable");
      if (request === sequence.current) {
        setValue(data);
        setState({ loading: false, error: false });
      }
    } catch {
      if (request === sequence.current) setState({ loading: false, error: true });
    }
  }, [path]);
  return [value, reload, setValue, state];
}
