import { describe, it, expect, vi } from "vitest";
import {
  fitImagesToBudget,
  isCompressibleImage,
  formatBytes,
  totalBytes,
  MMS_TOTAL_BUDGET_BYTES,
  TWILIO_MMS_TOTAL_BYTES,
} from "./imageCompression";

const MB = 1024 * 1024;

// A stand-in for a picked File. jsdom has no canvas, so every test injects a
// fake encoder and asserts on the ladder/budget logic, which is where the
// behavior that matters lives.
function fakeFile(name, size, type = "image/jpeg") {
  return { name, size, type, lastModified: 0 };
}

// Encoder that shrinks by a fixed ratio per rung, mimicking the real ladder:
// later (lower-quality) rungs produce smaller output.
function encoderShrinkingByRung(ratios) {
  const seen = [];
  const encode = vi.fn(async (file, rung) => {
    let idx = seen.findIndex(
      (r) => r.maxEdge === rung.maxEdge && r.quality === rung.quality,
    );
    if (idx === -1) {
      seen.push(rung);
      idx = seen.length - 1;
    }
    const ratio = ratios[Math.min(idx, ratios.length - 1)];
    return {
      ...file,
      name: file.name.replace(/\.[^.]+$/, ".jpg"),
      type: "image/jpeg",
      size: Math.round(file.size * ratio),
    };
  });
  encode.rungs = seen;
  return encode;
}

describe("budget constants", () => {
  it("targets a budget strictly under Twilio’s hard 5MB ceiling", () => {
    expect(MMS_TOTAL_BUDGET_BYTES).toBeLessThan(TWILIO_MMS_TOTAL_BYTES);
    expect(TWILIO_MMS_TOTAL_BYTES).toBe(5 * MB);
  });
});

describe("isCompressibleImage", () => {
  it("accepts still raster images", () => {
    expect(isCompressibleImage(fakeFile("a.jpg", 1, "image/jpeg"))).toBe(true);
    expect(isCompressibleImage(fakeFile("a.png", 1, "image/png"))).toBe(true);
    expect(isCompressibleImage(fakeFile("a.webp", 1, "image/webp"))).toBe(true);
  });

  it("refuses GIFs — a canvas round-trip would flatten the animation", () => {
    expect(isCompressibleImage(fakeFile("a.gif", 1, "image/gif"))).toBe(false);
  });

  it("refuses non-images", () => {
    expect(isCompressibleImage(fakeFile("a.pdf", 1, "application/pdf"))).toBe(
      false,
    );
    expect(isCompressibleImage(null)).toBe(false);
  });
});

describe("fitImagesToBudget", () => {
  it("leaves a batch that already fits completely untouched", async () => {
    const encode = vi.fn();
    const files = [fakeFile("a.jpg", 1 * MB), fakeFile("b.jpg", 2 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: MMS_TOTAL_BUDGET_BYTES,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.compressed).toBe(false);
    expect(res.files).toEqual(files); // same objects, not re-encoded copies
    expect(encode).not.toHaveBeenCalled();
  });

  it("stops at the FIRST rung that fits rather than compressing all the way down", async () => {
    // Rung 0 gets it to 4.0MB, which is already under budget — we must not
    // walk further down the ladder and shed quality we did not need to.
    const encode = encoderShrinkingByRung([0.4, 0.2, 0.1]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.compressed).toBe(true);
    expect(res.finalBytes).toBe(4 * MB);
    expect(encode.rungs).toHaveLength(1); // only the top rung was tried
  });

  it("descends the ladder until it fits when the top rung is not enough", async () => {
    const encode = encoderShrinkingByRung([0.9, 0.6, 0.3]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBe(3 * MB); // 10MB at the third rung's 0.3
    expect(encode.rungs).toHaveLength(3);
  });

  it("keeps the original when a re-encode comes out bigger", async () => {
    // Small already-optimized images routinely inflate on re-encode. The
    // 4MB file shrinks, the 200KB one bloats and must be left alone.
    const encode = vi.fn(async (file) =>
      file.size > MB
        ? { ...file, size: Math.round(file.size * 0.3) }
        : { ...file, size: file.size * 3 },
    );
    const small = fakeFile("small.png", 200 * 1024, "image/png");
    const big = fakeFile("big.jpg", 4 * MB);

    const res = await fitImagesToBudget([small, big], {
      availableBytes: 2 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(small); // identity preserved — original kept
    expect(res.files[1].size).toBe(Math.round(4 * MB * 0.3));
  });

  it("passes GIFs through uncompressed but still counts them against the budget", async () => {
    const encode = vi.fn(async (file) => ({
      ...file,
      size: Math.round(file.size * 0.1),
    }));
    const gif = fakeFile("loop.gif", 3 * MB, "image/gif");
    const jpg = fakeFile("photo.jpg", 4 * MB);

    const res = await fitImagesToBudget([gif, jpg], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(gif);
    expect(encode).not.toHaveBeenCalledWith(gif, expect.anything());
    expect(res.finalBytes).toBe(3 * MB + Math.round(4 * MB * 0.1));
  });

  it("reports failure instead of silently overshooting when nothing fits", async () => {
    const gif = fakeFile("huge.gif", 9 * MB, "image/gif"); // never compressible

    const res = await fitImagesToBudget([gif], {
      availableBytes: 4.5 * MB,
      encodeImage: vi.fn(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("over-budget");
    expect(res.bestBytes).toBe(9 * MB);
  });

  it("treats an undecodable file (HEIC outside Safari) as pass-through, not a crash", async () => {
    const encode = vi.fn(async () => null);
    const heic = fakeFile("IMG_1.heic", 2 * MB, "image/heic");

    const res = await fitImagesToBudget([heic], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    // 2MB already fits, so it short-circuits before touching the encoder.
    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(heic);
  });

  it("accounts for already-attached bytes via the caller’s available budget", async () => {
    const encode = encoderShrinkingByRung([0.2]);
    const files = [fakeFile("a.jpg", 2 * MB)];

    // 4MB already attached out of a 4.5MB budget leaves only 0.5MB.
    const res = await fitImagesToBudget(files, {
      availableBytes: 0.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(0.5 * MB);
  });

  it("fails closed when the tray is already at budget", async () => {
    const res = await fitImagesToBudget([fakeFile("a.jpg", MB)], {
      availableBytes: 0,
      encodeImage: vi.fn(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-budget");
  });

  it("handles an empty selection", async () => {
    const res = await fitImagesToBudget([], {
      availableBytes: MMS_TOTAL_BUDGET_BYTES,
    });
    expect(res).toMatchObject({ ok: true, compressed: false, finalBytes: 0 });
  });

  it("returns files index-aligned with the input so callers can zip previews", async () => {
    const encode = encoderShrinkingByRung([0.2]);
    const files = [
      fakeFile("a.jpg", 3 * MB),
      fakeFile("b.gif", MB, "image/gif"),
      fakeFile("c.png", 3 * MB, "image/png"),
    ];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.files).toHaveLength(3);
    expect(res.files[1]).toBe(files[1]);
    expect(res.files[0].name).toBe("a.jpg");
    expect(res.files[2].name).toBe("c.jpg"); // re-encoded to JPEG
  });
});

describe("helpers", () => {
  it("sums sizes defensively", () => {
    expect(totalBytes([{ size: 10 }, { size: 5 }, {}, null])).toBe(15);
    expect(totalBytes()).toBe(0);
  });

  it("formats bytes at human scale", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(4.5 * MB)).toBe("4.5 MB");
  });
});
