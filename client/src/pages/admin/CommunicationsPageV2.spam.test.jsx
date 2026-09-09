// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

const line = "+19415550199";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ["+442079460958", "+12079460958"],
  ["+12079460958", "+442079460958"],
])("blocking %s preserves the unrelated %s thread and counts", async (blocked, ordinary) => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const messages = [
    { id: "blocked", from: blocked, to: line, channel: "sms", direction: "inbound", body: "Blocked vendor pitch", createdAt: "2024-01-01T12:00:00Z" },
    { id: "ordinary", from: ordinary, to: line, channel: "sms", direction: "inbound", body: "Please quote pest control", createdAt: "2024-01-01T12:01:00Z" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const data = path.endsWith("/log") ? { messages }
      : path.endsWith("/blocked-numbers") ? { numbers: [{ number: blocked }] }
      : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<SmsTab active />, { wrapper: MemoryRouter });
  expect(await screen.findByText("Please quote pest control")).toBeInTheDocument();
  expect(screen.queryByText("Blocked vendor pitch")).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Unanswered (1)" })).toBeInTheDocument();
});
