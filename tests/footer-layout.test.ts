import { describe, expect, test } from "vitest";
import {
  alignFooterStatusLine,
  combineInlinePetFooter,
  isInlinePetPlacement,
  isTerminalImageLine,
  layoutFooterStatusLines,
  petSizeCellsForPlacement,
} from "../src/footer-layout.ts";
import { stripAnsi, visibleWidth } from "../src/format.ts";

describe("footer layout helpers", () => {
  test("classifies inline placements and caps badge size", () => {
    expect(isInlinePetPlacement("inline-left")).toBe(true);
    expect(isInlinePetPlacement("inline-right")).toBe(true);
    expect(isInlinePetPlacement("badge")).toBe(true);
    expect(isInlinePetPlacement("stacked")).toBe(false);
    expect(isInlinePetPlacement("habitat")).toBe(false);
    expect(petSizeCellsForPlacement("badge", 10)).toBe(6);
    expect(petSizeCellsForPlacement("inline-right", 10)).toBe(10);
  });

  test("keeps text pets on the requested side and clips to the available width", () => {
    const left = combineInlinePetFooter(["P"], ["abcdefghijk"], 10, "inline-left", 2);
    const right = combineInlinePetFooter(["P"], ["abcdefghijk"], 10, "inline-right", 2);

    expect(stripAnsi(left[0]!)).toBe("P   abc...");
    expect(stripAnsi(right[0]!)).toBe("abc...  P ");
    expect(visibleWidth(left[0]!)).toBe(10);
    expect(visibleWidth(right[0]!)).toBe(10);
  });

  test("aligns ordinary statuses left and right-suffixed statuses right", () => {
    expect(alignFooterStatusLine("MCP: playwright", "C:\\ 50%", 30)).toBe(
      "MCP: playwright        C:\\ 50%",
    );
    expect(alignFooterStatusLine("", "C:\\ 50%", 12)).toBe("     C:\\ 50%");
    expect(stripAnsi(alignFooterStatusLine("MCP: playwright", "", 10))).toBe("MCP: pl...");
  });

  test("moves right statuses to their own row and wraps by segment", () => {
    const left = ["MCP"];
    const right = ["CPU 10%", "GPU 20%", "RAM 30%"];

    const wide = layoutFooterStatusLines(left, right, 40);
    expect(wide).toHaveLength(1);
    expect(wide[0]!.startsWith("MCP")).toBe(true);
    expect(wide[0]!.endsWith("CPU 10% · GPU 20% · RAM 30%")).toBe(true);

    const ownRow = layoutFooterStatusLines(left, right, 30);
    expect(ownRow).toEqual(["MCP", "CPU 10% · GPU 20% · RAM 30%"]);

    const wrapped = layoutFooterStatusLines(left, right, 18);
    expect(wrapped).toEqual(["MCP", "CPU 10% · GPU 20%", "RAM 30%"]);
    expect(wrapped.slice(1).every((line) => visibleWidth(line) <= 18)).toBe(true);
  });

  test("recognizes both supported terminal image protocols", () => {
    expect(isTerminalImageLine("\x1b_Ga=p,i=1\x1b\\")).toBe(true);
    expect(isTerminalImageLine("\x1b]1337;File=inline=1:AAAA\x07")).toBe(true);
    expect(isTerminalImageLine("plain text")).toBe(false);
  });
});
