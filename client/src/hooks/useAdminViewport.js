import { useEffect } from "react";

/**
 * Point --admin-vh at the visual viewport so the Safari-bookmark admin
 * shell tracks the URL bar, home-screen chrome, and the iOS keyboard.
 * position:fixed header/tab-bar then pin to --vv-offset-top /
 * --keyboard-inset instead of the layout viewport (which does not shrink).
 */
export function syncAdminViewportVars() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const root = document.documentElement;
  const vv = window.visualViewport;
  const layoutH = window.innerHeight;
  // Pinch zoom ALSO shrinks visualViewport.height (CSS px) while
  // innerHeight stays the layout height, so the height delta only means
  // "keyboard" at scale ≈ 1. When meaningfully zoomed, fall back to the
  // layout viewport — otherwise the zoom delta reads as a phantom keyboard
  // and shoves the fixed tab bar / action bars hundreds of px up the page.
  const usable = vv && !(vv.scale > 1.01);
  const height = usable ? vv.height : layoutH;
  const offsetTop = usable ? vv.offsetTop : 0;
  const keyboardInset = Math.max(0, layoutH - height - offsetTop);
  root.style.setProperty("--admin-vh", `${Math.round(height)}px`);
  root.style.setProperty("--vv-offset-top", `${Math.round(offsetTop)}px`);
  root.style.setProperty("--keyboard-inset", `${Math.round(keyboardInset)}px`);
}

export function clearAdminViewportVars() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.removeProperty("--admin-vh");
  root.style.removeProperty("--vv-offset-top");
  root.style.removeProperty("--keyboard-inset");
}

export default function useAdminViewport(active) {
  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    const vv = window.visualViewport;
    syncAdminViewportVars();
    window.addEventListener("resize", syncAdminViewportVars);
    vv?.addEventListener("resize", syncAdminViewportVars);
    vv?.addEventListener("scroll", syncAdminViewportVars);
    return () => {
      window.removeEventListener("resize", syncAdminViewportVars);
      vv?.removeEventListener("resize", syncAdminViewportVars);
      vv?.removeEventListener("scroll", syncAdminViewportVars);
      clearAdminViewportVars();
    };
  }, [active]);
}
