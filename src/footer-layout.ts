import { sep } from "node:path";
import type { PetPlacement } from "./config.ts";
import { truncateToWidth, visibleWidth } from "./format.ts";

export function abbreviateHomePath(
  path: string,
  home = process.env.HOME || process.env.USERPROFILE,
): string {
  if (!home) return path;
  if (path === home) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
}

export function isInlinePetPlacement(placement: PetPlacement): boolean {
  return placement === "inline-left" || placement === "inline-right" || placement === "badge";
}

export function petSizeCellsForPlacement(placement: PetPlacement, sizeCells: number): number {
  return placement === "badge" ? Math.min(6, sizeCells) : sizeCells;
}

function spaces(width: number): string {
  return " ".repeat(Math.max(0, width));
}

function padTextToWidth(value: string, width: number): string {
  return value + spaces(width - visibleWidth(value));
}

export function alignFooterStatusLine(left: string, right: string, width: number): string {
  const availableWidth = Math.max(0, width);
  if (availableWidth === 0) return "";

  const clippedRight = truncateToWidth(right, availableWidth, "");
  const rightWidth = visibleWidth(clippedRight);
  if (!left) return spaces(availableWidth - rightWidth) + clippedRight;
  if (!clippedRight) return truncateToWidth(left, availableWidth, "...");

  const maxLeftWidth = Math.max(0, availableWidth - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, maxLeftWidth, maxLeftWidth >= 3 ? "..." : "");
  const leftWidth = visibleWidth(clippedLeft);
  if (leftWidth === 0) return spaces(availableWidth - rightWidth) + clippedRight;

  return clippedLeft + spaces(availableWidth - leftWidth - rightWidth) + clippedRight;
}

export function layoutFooterStatusLines(
  leftStatuses: string[],
  rightStatuses: string[],
  width: number,
  separator = " · ",
): string[] {
  const availableWidth = Math.max(0, width);
  if (availableWidth === 0) return [];

  const left = leftStatuses.filter(Boolean).join(" ");
  const rightSegments = rightStatuses.filter(Boolean);
  if (rightSegments.length === 0) {
    const line = truncateToWidth(left, availableWidth, "...");
    return line ? [line] : [];
  }

  const right = rightSegments.join(separator);
  if (
    visibleWidth(right) <= availableWidth &&
    (!left || visibleWidth(left) + 1 + visibleWidth(right) <= availableWidth)
  ) {
    return [alignFooterStatusLine(left, right, availableWidth)];
  }

  const lines: string[] = [];
  if (left) lines.push(truncateToWidth(left, availableWidth, "..."));

  let current = "";
  for (const segment of rightSegments) {
    const clippedSegment = truncateToWidth(segment, availableWidth, "...");
    const candidate = current ? `${current}${separator}${clippedSegment}` : clippedSegment;
    if (current && visibleWidth(candidate) > availableWidth) {
      lines.push(current);
      current = clippedSegment;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines;
}

export function isTerminalImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function petLineCell(line: string, width: number): string {
  if (!line) return spaces(width);
  if (isTerminalImageLine(line)) return `\x1b[0m${line}`;
  const clipped = truncateToWidth(line, width, "");
  return clipped + spaces(width - visibleWidth(clipped));
}

function stripLeadingCursorUp(line: string): string {
  if (!line.startsWith("\x1b[")) return line;
  const end = line.indexOf("A", 2);
  if (end === -1) return line;
  return /^\d+$/.test(line.slice(2, end)) ? line.slice(end + 1) : line;
}

function stripTrailingCursorDown(line: string): string {
  if (!line.endsWith("B")) return line;
  const start = line.lastIndexOf("\x1b[");
  if (start === -1) return line;
  return /^\d+$/.test(line.slice(start + 2, -1)) ? line.slice(0, start) : line;
}

function terminalImageInlineLeftSequence(line: string, totalRows: number): string {
  const moveUp = totalRows > 1 ? `\x1b[${totalRows - 1}A` : "";
  const moveDown = totalRows > 1 ? `\x1b[${totalRows - 1}B` : "";
  const balancedLine = stripTrailingCursorDown(stripLeadingCursorUp(line));
  return `\x1b[0m\r${moveUp}${balancedLine}${moveDown}`;
}

export function combineInlinePetFooter(
  petLines: string[],
  textLines: string[],
  width: number,
  placement: PetPlacement,
  petWidth: number,
): string[] {
  const gap = 2;
  const textWidth = Math.max(1, width - petWidth - gap);
  const totalRows = Math.max(petLines.length, textLines.length);
  const hasTerminalImageLine = petLines.some(isTerminalImageLine);
  const leftImageLine =
    placement === "inline-left" ? petLines.find(isTerminalImageLine) : undefined;
  const renderPetOnRight =
    placement === "inline-right" || (placement !== "inline-left" && hasTerminalImageLine);
  const lines: string[] = [];

  for (let row = 0; row < totalRows; row++) {
    const petLine = petLines[row] ?? "";
    const textLine = textLines[row] ?? "";
    const textPart = truncateToWidth(textLine, textWidth, "...");
    const petPart = leftImageLine ? spaces(petWidth) : petLineCell(petLine, petWidth);
    if (renderPetOnRight) {
      lines.push(`${padTextToWidth(textPart, textWidth)}${spaces(gap)}${petPart}`);
    } else {
      lines.push(`${petPart}${spaces(gap)}${textPart}`);
    }
  }

  if (leftImageLine && lines.length > 0) {
    lines[lines.length - 1] += terminalImageInlineLeftSequence(leftImageLine, totalRows);
  }

  return lines;
}
