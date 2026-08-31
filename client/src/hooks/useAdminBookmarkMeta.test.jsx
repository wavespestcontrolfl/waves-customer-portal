// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import useAdminBookmarkMeta from "./useAdminBookmarkMeta";

function Harness({ active }) {
  useAdminBookmarkMeta(active);
  return null;
}

function seedHead({ manifest, appTitle, description, themeColor, title }) {
  document.head.innerHTML = `
    <link rel="manifest" href="${manifest}">
    <meta name="apple-mobile-web-app-title" content="${appTitle}">
    <meta name="description" content="${description}">
    <meta name="theme-color" content="${themeColor}">
  `;
  document.title = title;
}

describe("useAdminBookmarkMeta", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    seedHead({
      manifest: "/manifest.json",
      appTitle: "Waves",
      description: "Customer portal",
      themeColor: "#111111",
      title: "Waves Customer Portal",
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.className = "";
  });

  it("applies the admin Safari bookmark identity and restores the snapshot on unmount", () => {
    const view = render(<Harness active />);
    expect(document.documentElement).toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/admin-manifest.json",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "Waves Admin");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#18181B",
    );
    expect(document.title).toBe("Waves Admin");

    view.unmount();
    expect(document.documentElement).not.toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.json",
    );
    expect(document.title).toBe("Waves Customer Portal");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#111111",
    );
  });

  it("is a TRUE no-op while inactive — never touches another route's identity", () => {
    // /tech installs its own manifest + apple title; a report page sets its
    // own document.title. Mounting the app-wide shell on those routes must
    // not overwrite any of it.
    seedHead({
      manifest: "/manifest.tech.json",
      appTitle: "Field Tools",
      description: "Tech portal",
      themeColor: "#0f1923",
      title: "Field Tools",
    });

    const view = render(<Harness active={false} />);
    expect(document.documentElement).not.toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.tech.json",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "Field Tools");
    expect(document.title).toBe("Field Tools");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#0f1923",
    );

    view.unmount();
    expect(document.title).toBe("Field Tools");
  });

  it("restores the SNAPSHOTTED identity on deactivate, not hardcoded customer defaults", () => {
    seedHead({
      manifest: "/manifest.tech.json",
      appTitle: "Field Tools",
      description: "Tech portal",
      themeColor: "#0f1923",
      title: "Field Tools",
    });

    const view = render(<Harness active={false} />);
    view.rerender(<Harness active />);
    expect(document.documentElement).toHaveClass("admin-app");
    expect(document.title).toBe("Waves Admin");

    view.rerender(<Harness active={false} />);
    expect(document.documentElement).not.toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.tech.json",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "Field Tools");
    expect(document.title).toBe("Field Tools");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#0f1923",
    );
  });

  it("falls back to customer defaults after a cold /admin load (first-paint script already applied admin)", () => {
    // The index.html inline script runs before React on a direct /admin
    // load: html.admin-app is set and the meta is already admin. There is
    // no pre-admin state to snapshot, so leaving /admin must produce the
    // customer defaults — never "restore" admin identity.
    document.documentElement.classList.add("admin-app");
    seedHead({
      manifest: "/admin-manifest.json",
      appTitle: "Waves Admin",
      description: "Admin portal",
      themeColor: "#18181B",
      title: "Waves Admin",
    });

    const view = render(<Harness active />);
    expect(document.documentElement).toHaveClass("admin-app");
    expect(document.title).toBe("Waves Admin");

    view.rerender(<Harness active={false} />);
    expect(document.documentElement).not.toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.json",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "Waves");
    expect(document.title).toBe("Waves Customer Portal");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#111111",
    );
  });
});
