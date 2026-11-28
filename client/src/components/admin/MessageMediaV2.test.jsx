// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageMediaV2 } from "./MessageMediaV2";

afterEach(cleanup);

describe("MessageMediaV2 URL scheme allowlist (C2-02)", () => {
  it("renders https: media items and drops javascript:, data:, and http: URLs", () => {
    const { container } = render(
      <MessageMediaV2
        media={[
          { key: "k1", url: "https://cdn.example.com/photo.jpg", fileName: "photo.jpg" },
          { key: "k2", url: "javascript:alert(1)", fileName: "xss.jpg" },
          { key: "k3", url: "data:text/html,<script>alert(1)</script>", fileName: "data.html" },
          { key: "k4", url: "http://insecure.example.com/photo.jpg", fileName: "http.jpg" },
        ]}
      />,
    );

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://cdn.example.com/photo.jpg");
  });

  it("renders nothing when all media URLs are disallowed", () => {
    const { container } = render(
      <MessageMediaV2
        media={[
          { key: "k1", url: "javascript:alert(1)" },
          { key: "k2", url: "not-a-url" },
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
