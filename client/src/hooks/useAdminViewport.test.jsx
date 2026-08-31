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
    expect(document.documentElement.style.getPropertyValue("--admin-vh")).toBe(
      "520px",
    );
    expect(
      document.documentElement.style.getPropertyValue("--vv-offset-top"),
    ).toBe("12px");
    expect(
      document.documentElement.style.getPropertyValue("--keyboard-inset"),
    ).toBe("268px");
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
  });
});
