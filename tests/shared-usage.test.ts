import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { sharedUsage, acquireUsageLock, usageAccountKey } from "../src/shared-usage.ts";
import { UsageRequestError, formatUsageSnapshot } from "../src/usage.ts";

const dirs: string[] = [];
const credentials = { accessToken: "private-test-access", accountId: "private-test-account" };
const raw = () => ({
  rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 600 } },
  additional_rate_limits: [
    { limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 50 } } },
  ],
  credits: { balance: "1234.567", unlimited: false, secret: "DO NOT CACHE" },
  account_id: "DO NOT CACHE",
});
async function directory() {
  const p = await mkdtemp(join(tmpdir(), "pi-shared-usage-"));
  dirs.push(p);
  return p;
}
afterEach(async () => {
  for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true });
});

function worker(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
  });
}
const moduleUrl = new URL("../src/shared-usage.ts", import.meta.url).href;

test("simultaneous readers share one account request and normalized quota/credit data", async () => {
  const dir = await directory();
  const collect = vi.fn(async () => raw());
  await Promise.all(
    Array.from({ length: 20 }, () =>
      sharedUsage(credentials, 60_000, undefined, { directory: dir, collect }),
    ),
  );
  const result = await sharedUsage(credentials, 60_000, undefined, { directory: dir, collect });
  expect(collect).toHaveBeenCalledTimes(1);
  expect(result.sample?.credits.balance).toBe("1234.567");
  expect(result.sample?.default.fiveHourLeftPercent).toBe(90);
  expect(result.sample?.spark.fiveHourLeftPercent).toBe(50);
  const cache = join(dir, usageAccountKey(credentials.accountId) + ".json");
  const text = await readFile(cache, "utf8");
  expect(text).not.toMatch(/private-test|DO NOT CACHE|accessToken|account_id/);
  if (process.platform !== "win32") expect((await stat(cache)).mode & 0o777).toBe(0o600);
});

test("separate OS processes contend without multiplying API requests", async () => {
  const dir = await directory(),
    calls = join(dir, "calls");
  const code = `import {sharedUsage} from ${JSON.stringify(moduleUrl)}; import {appendFileSync} from 'node:fs';
    await sharedUsage(${JSON.stringify(credentials)},60000,undefined,{directory:${JSON.stringify(dir)}, collect:async()=>{
      appendFileSync(${JSON.stringify(calls)},'read\\n'); await new Promise(r=>setTimeout(r,100)); return ${JSON.stringify(raw())};
    }});`;
  await Promise.all(Array.from({ length: 6 }, () => worker(code)));
  expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("account isolation, refresh interval and manual refresh cooldown preserve timestamps", async () => {
  const dir = await directory();
  let now = Date.now();
  const collect = vi.fn(async () => raw()),
    options = { directory: dir, collect, now: () => now };
  const first = await sharedUsage(credentials, 60_000, undefined, options);
  now += 2000;
  const cached = await sharedUsage(credentials, 60_000, undefined, { ...options, force: true });
  expect(cached.sample?.default.capturedAt).toBe(first.sample?.default.capturedAt);
  expect(formatUsageSnapshot(cached.sample!.default, { showResetTimes: true }, now)).toContain(
    "9m",
  );
  expect(collect).toHaveBeenCalledTimes(1);
  await sharedUsage({ ...credentials, accountId: "different-account" }, 60_000, undefined, options);
  expect(collect).toHaveBeenCalledTimes(2);
  now += 4000;
  await sharedUsage(credentials, 60_000, undefined, { ...options, force: true });
  expect(collect).toHaveBeenCalledTimes(3);
});

test("crashed owners and empty orphan locks recover; live owners are never evicted by age", async () => {
  const dir = await directory(),
    lock = join(dir, usageAccountKey(credentials.accountId) + ".lock");
  expect(
    await worker(
      `import {acquireUsageLock} from ${JSON.stringify(moduleUrl)}; console.log(Boolean(await acquireUsageLock(${JSON.stringify(lock)})));`,
    ),
  ).toContain("true");
  const collect = vi.fn(async () => raw());
  await sharedUsage(credentials, 60_000, undefined, { directory: dir, collect }); // Reap dead owner.
  await sharedUsage(credentials, 60_000, undefined, { directory: dir, collect });
  expect(collect).toHaveBeenCalledTimes(1);
  const release = await acquireUsageLock(lock);
  await utimes(lock, new Date(0), new Date(0));
  expect(await acquireUsageLock(lock)).toBeNull();
  await release!();
  await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  expect(await acquireUsageLock(lock)).toBeNull();
  const recovered = await acquireUsageLock(lock);
  expect(recovered).toBeTypeOf("function");
  await recovered!();
});

test("shared backoff retains last good data and even manual refresh respects Retry-After", async () => {
  const dir = await directory();
  let now = Date.now();
  const collect = vi.fn(async () => raw()),
    options = { directory: dir, collect, now: () => now };
  const first = await sharedUsage(credentials, 60_000, undefined, options);
  now += 60_000;
  collect.mockRejectedValue(new UsageRequestError(180_000));
  const failed = await sharedUsage(credentials, 60_000, undefined, options);
  expect(failed.error).toBe(true);
  expect(failed.sample).toEqual(first.sample);
  now += 120_000;
  await sharedUsage(credentials, 60_000, undefined, { ...options, force: true });
  expect(collect).toHaveBeenCalledTimes(2);
  now += 60_000;
  await sharedUsage(credentials, 60_000, undefined, options);
  expect(collect).toHaveBeenCalledTimes(3);
});

test("aborted collection releases ownership without publishing an error/backoff snapshot", async () => {
  const dir = await directory(),
    controller = new AbortController();
  const collect = vi.fn(async () => {
    controller.abort();
    throw controller.signal.reason;
  });
  await expect(
    sharedUsage(credentials, 60_000, controller.signal, { directory: dir, collect }),
  ).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
  const result = await sharedUsage(credentials, 60_000, undefined, {
    directory: dir,
    collect: async () => raw(),
  });
  expect(result.sample?.credits.balance).toBe("1234.567");
});

test("malformed, foreign-account and future cache data cannot masquerade as current", async () => {
  const dir = await directory(),
    file = join(dir, usageAccountKey(credentials.accountId) + ".json");
  const collect = vi.fn(async () => raw());
  for (const text of [
    "broken",
    JSON.stringify({ version: 1, accountKey: "foreign" }),
    " ".repeat(17000),
  ]) {
    await writeFile(file, text);
    await sharedUsage(credentials, 60_000, undefined, { directory: dir, collect });
  }
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.attemptedAt += 3600000;
  await writeFile(file, JSON.stringify(stored));
  await sharedUsage(credentials, 60_000, undefined, { directory: dir, collect });
  expect(collect).toHaveBeenCalledTimes(4);
});
