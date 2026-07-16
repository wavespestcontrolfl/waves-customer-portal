// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MobileServiceLibrary from "./MobileServiceLibrary";

afterEach(cleanup);

describe("MobileServiceLibrary", () => {
  it("exposes Protocol & Readiness from the mobile Services menu", () => {
    const onOpenProtocols = vi.fn();
    render(<MobileServiceLibrary onOpenProtocols={onOpenProtocols} />);

    fireEvent.click(
      screen.getByRole("button", { name: /Protocol & Readiness/i }),
    );

    expect(onOpenProtocols).toHaveBeenCalledTimes(1);
  });
});
