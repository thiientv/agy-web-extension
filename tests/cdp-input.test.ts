import { describe, expect, it } from "vitest";
import {
  isPageZoomShortcut,
  mapScreenshotToViewport,
  parseKeyChordSequence,
  parseModifierBitmask
} from "../src/shared/cdp-input.js";

describe("cdp-input helpers", () => {
  it("computes CDP modifier bitmasks accurately", () => {
    expect(parseModifierBitmask("alt")).toBe(1);
    expect(parseModifierBitmask("ctrl")).toBe(2);
    expect(parseModifierBitmask("cmd+shift")).toBe(4 | 8);
    expect(parseModifierBitmask(undefined)).toBe(0);
  });

  it("rejects browser page zoom shortcuts with an explicit check", () => {
    expect(isPageZoomShortcut("cmd+=")).toBe(true);
    expect(isPageZoomShortcut("ctrl+-")).toBe(true);
    expect(isPageZoomShortcut("cmd+0")).toBe(true);
    expect(isPageZoomShortcut("cmd+a")).toBe(false);
  });

  it("parses space-separated key chords into CDP key descriptors", () => {
    const seq = parseKeyChordSequence("cmd+a Backspace Enter");
    expect(seq).toHaveLength(3);
    expect(seq[0]?.key).toBe("a");
    expect(seq[0]?.modifiers).toBe(4);
    expect(seq[1]?.key).toBe("Backspace");
    expect(seq[1]?.windowsVirtualKeyCode).toBe(8);
    expect(seq[2]?.key).toBe("Enter");
    expect(seq[2]?.windowsVirtualKeyCode).toBe(13);
  });

  it("maps coordinates from full-resolution screenshot frame to CSS viewport pixels", () => {
    const mapped = mapScreenshotToViewport([500, 300], {
      viewportWidth: 1000,
      viewportHeight: 600,
      screenshotWidth: 2000,
      screenshotHeight: 1200
    });
    expect(mapped).toEqual({ x: 250, y: 150 });
  });
});
