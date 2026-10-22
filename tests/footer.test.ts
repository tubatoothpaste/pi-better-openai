import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI, { _test } from "../index.ts";
import { visibleWidth } from "../src/format.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;

type Harness = {
  ctx: ExtensionContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandHandler>;
  custom: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  getEntries: ReturnType<typeof vi.fn>;
  getLeafId: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  getSessionName: ReturnType<typeof vi.fn>;
  setFooter: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-footer-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(cwd: string, footerMode: "replace" | "status" | "off") {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: false,
        active: false,
        desiredActive: false,
        supportedModels: [],
        usage: { enabled: false },
        footer: { mode: footerMode },
        image: { enabled: false },
        pets: { enabled: false },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createHarness(cwd: string): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const custom = vi.fn();
  const notify = vi.fn();
  const getEntries = vi.fn(() => []);
  const getLeafId = vi.fn(() => "leaf-1");
  const getContextUsage = vi.fn(() => ({ contextWindow: 100_000, percent: 12.5 }));
  const getSessionName = vi.fn(() => undefined);
  const setFooter = vi.fn();
  const setStatus = vi.fn();

  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    model: undefined,
    ui: {
      custom,
      notify,
      setFooter,
      setStatus,
    },
    sessionManager: {
      getEntries,
      getLeafId,
      getCwd: vi.fn(() => cwd),
      getSessionName,
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
    },
    getContextUsage,
  } as unknown as ExtensionContext;

  betterOpenAI(pi);

  return {
    ctx,
    handlers,
    commands,
    custom,
    notify,
    getEntries,
    getLeafId,
    getContextUsage,
    getSessionName,
    setFooter,
    setStatus,
  };
}

async function emit(harness: Harness, event: string, payload: unknown = {}) {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("footer path formatting", () => {
  test("abbreviates only exact home and child paths", () => {
    expect(_test.abbreviateHomePath("/Users/alice/project", "/Users/alice")).toBe("~/project");
    expect(_test.abbreviateHomePath("/Users/alice", "/Users/alice")).toBe("~");
    expect(_test.abbreviateHomePath("/Users/alice2/project", "/Users/alice")).toBe(
      "/Users/alice2/project",
    );
    expect(_test.abbreviateHomePath("/Users/alice/project", undefined)).toBe(
      "/Users/alice/project",
    );
  });
});

describe("diagnostic text panel", () => {
  test("closes only for explicit close keys, not arrow escape sequences", () => {
    const done = vi.fn();
    const panel = _test.textPanel("Diagnostics", ["line"], done);

    panel.handleInput("\x1b[A");
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("footer pet layout", () => {
  test("keeps terminal-image pets on the left for inline-left placement", () => {
    const imageLine = "\x1b[1A\x1b_Ga=p,i=1\x1b\\\x1b[1B";

    const lines = _test.combineInlinePetFooter(
      ["", imageLine],
      ["path", "stats"],
      20,
      "inline-left",
      4,
    );

    expect(lines[0]).toBe("      path");
    expect(lines[1]).toMatch(/^ {6}stats/);
    expect(lines[1]).toContain("\x1b[0m\r\x1b[1A\x1b_Ga=p,i=1\x1b\\\x1b[1B");
    expect(lines[1]).not.toContain("\x1b[1A\x1b[1A");
    expect(lines[1]).not.toContain("\x1b[1B\x1b[1B");
  });
});

describe("footer mode ownership", () => {
  test("reuses context usage between renders and invalidates it on message changes", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );

    footer.render(100);
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(1);
    expect(harness.getSessionName).toHaveBeenCalledTimes(1);

    await emit(harness, "message_update");
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(2);

    harness.getLeafId.mockReturnValue("leaf-2");
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(3);
    expect(harness.getSessionName).toHaveBeenCalledTimes(2);
    footer.dispose();
  });

  test("keeps regular extension statuses left and right-suffixed statuses right", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {
        getExtensionStatuses: () =>
          new Map([
            ["mcp", "MCP: playwright"],
            ["disk-usage:right", "C:\\ 50%"],
          ]),
      },
    );

    const statusLine = footer.render(50).at(-1)!;
    expect(statusLine.startsWith("MCP: playwright")).toBe(true);
    expect(statusLine.endsWith("C:\\ 50%")).toBe(true);
    expect(statusLine).toHaveLength(50);
    footer.dispose();
  });

  test("keeps bottom-suffixed statuses on a dedicated final row", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {
        getExtensionStatuses: () =>
          new Map([
            ["mcp", "MCP: playwright"],
            ["resource-usage:00:right", "CPU 10%"],
            ["resource-usage:01:right", "GPU 20%"],
            ["resource-usage:02:right", "RAM 30%"],
            ["deepgram-usage:bottom", "Deepgram Aug 2m 4s · 3 reqs"],
          ]),
      },
    );

    const wideLines = footer.render(80);
    expect(wideLines.at(-2)).toContain("CPU 10% · GPU 20% · RAM 30%");
    expect(wideLines.at(-1)).toBe("Deepgram Aug 2m 4s · 3 reqs");

    const narrowLines = footer.render(24);
    const deepgramIndex = narrowLines.findIndex((line: string) => line.startsWith("Deepgram"));
    const resourceIndexes = narrowLines
      .map((line: string, index: number) => (/CPU|GPU|RAM/.test(line) ? index : -1))
      .filter((index: number) => index >= 0);
    expect(deepgramIndex).toBe(narrowLines.length - 1);
    expect(resourceIndexes.length).toBeGreaterThan(0);
    expect(resourceIndexes.every((index: number) => index < deepgramIndex)).toBe(true);
    footer.dispose();
  });

  test("renders Deepgram and Pi version as separate final rows after wrapped resources", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    await emit(harness, "session_start");
    const statuses = new Map([
      // Deliberately reversed: the status keys define the display order.
      ["pi-version:bottom", "Pi v0.80.6-session"],
      ["deepgram-usage:bottom", "Deepgram loading…"],
      ["mcp", "MCP: playwright"],
      ["resource-usage:00:right", "CPU 10%"],
      ["resource-usage:01:right", "GPU 20%"],
      ["resource-usage:02:right", "RAM 30%"],
    ]);
    const footer = harness.setFooter.mock.calls[0]?.[0](
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      { getExtensionStatuses: () => statuses },
    );
    for (const deepgram of [
      "Deepgram loading…",
      "Deepgram 6m · 4 reqs",
      "Deepgram request failed",
    ]) {
      statuses.set("deepgram-usage:bottom", deepgram);
      for (const width of [24, 80, 160]) {
        const lines = footer.render(width);
        expect(lines.slice(-2)).toEqual([deepgram, "Pi v0.80.6-session"]);
        expect(lines.slice(0, -2).join("\n")).toContain("CPU 10%");
        expect(lines.slice(0, -2).join("\n")).toContain("MCP: playwright");
        expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
      }
    }
    statuses.delete("deepgram-usage:bottom");
    statuses.delete("pi-version:bottom");
    expect(footer.render(80).join("\n")).not.toMatch(/Deepgram|Pi v/);
    footer.dispose();
  });

  test("adds completed-turn usage without rescanning the full session", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await emit(harness, "turn_end", {
      message: {
        role: "assistant",
        usage: {
          input: 1_200,
          output: 300,
          cacheRead: 400,
          cacheWrite: 50,
          cost: { total: 0.25 },
        },
      },
      toolResults: [],
    });

    expect(harness.getEntries).toHaveBeenCalledTimes(1);
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );
    expect(footer.render(100).join("\n")).toContain("↑1.2k ↓300 R400 W50 $0.250");
    footer.dispose();
  });

  test("does not install terminal-only UI in RPC mode", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, { mode: "rpc", hasUI: true });

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
  });

  test("does not open the custom settings component in RPC mode", async () => {
    const cwd = createTempProject();
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, { mode: "rpc", hasUI: true });

    await harness.commands.get("openai-settings")?.("", harness.ctx);

    expect(harness.custom).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(
      "Better OpenAI settings require interactive TUI mode.",
      "warning",
    );
  });

  test("off mode leaves existing footer customizations untouched on session start", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "off");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("status mode does not clear an external custom footer", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
  });

  test("off mode clears the Better OpenAI footer only after Better OpenAI installed it", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(1);
    expect(harness.setFooter).toHaveBeenLastCalledWith(expect.any(Function));

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    expect(harness.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("off mode does not clear a footer after Better OpenAI's footer was disposed", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    expect(footerFactory).toEqual(expect.any(Function));

    const footer = footerFactory(
      { requestRender: vi.fn() },
      {},
      { onBranchChange: vi.fn(() => vi.fn()) },
    );
    footer.dispose();

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(1);
  });
});
