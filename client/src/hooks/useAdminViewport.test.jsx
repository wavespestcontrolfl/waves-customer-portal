// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAdminViewport, {
  clearAdminViewportVars,
  syncAdminViewportVars,
} from "./useAdminViewport";

function Harness({ active }) {
  useAdminViewport(active);
  return null;
}

describe("useAdminViewport", () => {
  beforeEach(() => {
    clearAdminViewportVars();
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", {
      height: 520,
      offsetTop: 12,
      scale: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    clearAdminViewportVars();
    vi.unstubAllGlobals();
  });

  it("writes visual-viewport CSS vars so fixed chrome can track the keyboard", () => {
    syncAdminViewportVars();
    // --admin-vh is the layout-top → visual-bottom extent (offsetTop +
    // height = 12 + 520), not the bare visual height — shell consumers are
    // anchored at layout y=0, so a bare height would clip the bottom
    // offsetTop px of the visible range when iOS pans to a focused field.
    expect(document.documentElement.style.getPropertyValue("--admin-vh")).toBe(
      "532px",
    );
    expect(
      document.documentElement.style.getPropertyValue("--vv-offset-top"),
    ).toBe("12px");
    expect(
      document.documentElement.style.getPropertyValue("--keyboard-inset"),
    ).toBe("268px");
    // Keyboard-sized inset → the fixed tab bar hides (index.css keys off
    // this attribute) instead of lifting onto the keyboard.
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(true);
    clearAdminViewportVars();
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("keeps keyboard-open while iOS pans the visual viewport to a lower field", () => {
    // Same 280px keyboard, but the pan has grown to 250px: the layout-bottom
    // inset is now only 30px, yet the keyboard is still up.
    vi.stubGlobal("visualViewport", {
      height: 520,
      offsetTop: 250,
      scale: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    syncAdminViewportVars();
    expect(
      document.documentElement.style.getPropertyValue("--keyboard-inset"),
    ).toBe("30px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(true);
  });

  it("does not mistake pinch zoom for a keyboard — falls back to the layout viewport", () => {
    vi.stubGlobal("visualViewport", {
      height: 400,
      offsetTop: 30,
      scale: 2,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    syncAdminViewportVars();
    expect(document.documentElement.style.getPropertyValue("--admin-vh")).toBe(
      "800px",
    );
    expect(
      document.documentElement.style.getPropertyValue("--vv-offset-top"),
    ).toBe("0px");
    expect(
      document.documentElement.style.getPropertyValue("--keyboard-inset"),
    ).toBe("0px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  describe("document scroll from iOS revealing a focused field", () => {
    let shell;
    beforeEach(() => {
      shell = document.createElement("div");
      shell.className = "admin-shell-v2";
      document.body.appendChild(shell);
      vi.stubGlobal("scrollTo", vi.fn());
    });
    afterEach(() => shell.remove());

    it("stretches the shell over the scroll so no blank band shows above the keyboard", () => {
      // Owner 2026-10-25 screenshots: keyboard up, document scrolled ~220px,
      // shell cut off ~220px above the keyboard with blank page below.
      vi.stubGlobal("scrollY", 220);
      vi.stubGlobal("visualViewport", {
        height: 476,
        offsetTop: 0,
        pageTop: 220,
        scale: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      syncAdminViewportVars();
      const root = document.documentElement.style;
      expect(root.getPropertyValue("--admin-shell-vh")).toBe("696px");
      // Fixed panels and auth pages keep the visual extent.
      expect(root.getPropertyValue("--admin-vh")).toBe("476px");
      // Typing scrolls are left to iOS while the keyboard is up.
      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it("never stretches the shell past the keyboard height", () => {
      vi.stubGlobal("scrollY", 5000);
      vi.stubGlobal("visualViewport", {
        height: 476,
        offsetTop: 0,
        pageTop: 5000,
        scale: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      syncAdminViewportVars();
      expect(document.documentElement.style.getPropertyValue("--admin-shell-vh")).toBe("800px");
    });

    it("scrolls the document back to the top once the keyboard is down", () => {
      // Owner 2026-10-25: after the keyboard closed the scroll stayed and the
      // blank band stayed at the bottom of the page.
      vi.stubGlobal("scrollY", 216);
      vi.stubGlobal("visualViewport", {
        height: 800,
        offsetTop: 0,
        pageTop: 216,
        scale: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      syncAdminViewportVars();
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
      expect(document.documentElement.style.getPropertyValue("--admin-shell-vh")).toBe("800px");
    });

    it("leaves the document scroll alone on auth pages and while pinch-zoomed", () => {
      vi.stubGlobal("scrollY", 216);
      vi.stubGlobal("visualViewport", {
        height: 400,
        offsetTop: 30,
        pageTop: 246,
        scale: 2,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      syncAdminViewportVars();
      expect(window.scrollTo).not.toHaveBeenCalled();

      shell.remove();
      vi.stubGlobal("visualViewport", {
        height: 800,
        offsetTop: 0,
        pageTop: 216,
        scale: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      syncAdminViewportVars();
      expect(window.scrollTo).not.toHaveBeenCalled();
    });
  });

  it("subscribes while active and clears the vars on unmount", () => {
    const view = render(<Harness active />);
    expect(window.visualViewport.addEventListener).toHaveBeenCalledWith(
      "resize",
      syncAdminViewportVars,
    );
    view.unmount();
    expect(window.visualViewport.removeEventListener).toHaveBeenCalledWith(
      "resize",
      syncAdminViewportVars,
    );
    expect(document.documentElement.style.getPropertyValue("--admin-vh")).toBe(
      "",
    );
    expect(document.documentElement.style.getPropertyValue("--admin-shell-vh")).toBe("");
  });
});
