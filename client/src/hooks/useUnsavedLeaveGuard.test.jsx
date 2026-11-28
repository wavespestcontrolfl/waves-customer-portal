// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUnsavedLeaveGuard } from "./useUnsavedLeaveGuard";
import { confirmLeaveIfGuarded } from "../lib/navigation-guard";

function Harness({ dirty, message }) {
  useUnsavedLeaveGuard(dirty, message);
  return <a href="/admin/other">Other</a>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useUnsavedLeaveGuard", () => {
  it("guards beforeunload, registerLeaveGuard, and in-app link clicks only when dirty", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { rerender } = render(<Harness dirty={false} message="Leave?" />);

    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    expect(confirmLeaveIfGuarded()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();

    rerender(<Harness dirty message="Leave this page?" />);

    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    expect(confirmLeaveIfGuarded()).toBe(false);
    expect(confirmSpy).toHaveBeenCalledWith("Leave this page?");

    const link = document.querySelector("a");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);

    rerender(<Harness dirty={false} message="Leave this page?" />);
    expect(confirmLeaveIfGuarded()).toBe(true);
  });
});
