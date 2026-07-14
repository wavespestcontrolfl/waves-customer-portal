// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthenticatedCallAudio from "./AuthenticatedCallAudio";

const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function restoreUrlMethod(name, descriptor) {
  if (descriptor) Object.defineProperty(URL, name, descriptor);
  else delete URL[name];
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:call-recording"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreUrlMethod("createObjectURL", createObjectURLDescriptor);
  restoreUrlMethod("revokeObjectURL", revokeObjectURLDescriptor);
});

describe("AuthenticatedCallAudio", () => {
  it("waits for explicit intent, then keeps the JWT in Authorization and uses a Blob URL", async () => {
    const token = "staff.header.payload.signature";
    const blob = new Blob(["audio-bytes"], { type: "audio/mpeg" });
    localStorage.setItem("waves_admin_token", token);
    fetch.mockResolvedValue({ ok: true, status: 200, blob: vi.fn().mockResolvedValue(blob) });

    const { container, unmount } = render(
      <AuthenticatedCallAudio recordingId="RE id/with spaces" className="w-full" />,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("audio")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load call recording" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [requestUrl, options] = fetch.mock.calls[0];
    expect(requestUrl).toBe("/api/admin/call-recordings/audio/RE%20id%2Fwith%20spaces");
    expect(requestUrl).not.toContain("?");
    expect(options.headers.Authorization).toBe(`Bearer ${token}`);
    expect(options.cache).toBe("no-store");
    expect(container.innerHTML).not.toContain(token);

    const player = await screen.findByLabelText("Call recording");
    await waitFor(() => expect(player).toHaveAttribute("src", "blob:call-recording"));
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("preload", "none");
    expect(player.parentElement).toHaveAttribute("data-audio-state", "ready");
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);

    const signal = options.signal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:call-recording");
  });

  it("does not issue an unauthenticated request and exposes an accessible retry", async () => {
    render(<AuthenticatedCallAudio recordingId="RE123" />);

    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load call recording" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Recording unavailable");
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry call recording" })).toBeInTheDocument();
  });

  it("retries a failed request once when the user asks", async () => {
    localStorage.setItem("waves_admin_token", "staff-jwt");
    const blob = new Blob(["audio-bytes"], { type: "audio/mpeg" });
    fetch
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(blob),
      });

    render(<AuthenticatedCallAudio recordingId="RE123" />);
    fireEvent.click(screen.getByRole("button", { name: "Load call recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recording unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Retry call recording" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading recording");
    await screen.findByLabelText("Call recording");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
