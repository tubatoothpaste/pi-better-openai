import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readdir, open, writeFile, rename, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodexCredentials } from "./codex-auth.ts";
import { piAgentDir } from "./paths.ts";
import {
  parseUsageSnapshot,
  requestCodexUsageWithCredentials,
  UsageRequestError,
  USAGE_URL,
  type CodexUsageResponse,
  type UsageSnapshot,
} from "./usage.ts";

export const LOCAL_CHECK_MS = 5_000;
const ORPHAN_MS = 30_000;
const MAX_CACHE_BYTES = 16_384;
export type Credits = { balance: string | null; unlimited: boolean };
export type CreditsUpdate = {
  version: 1;
  credits: Credits | null;
  observedAt: number | null;
  stale: boolean;
  error: boolean;
};
export type SharedSample = { default: UsageSnapshot; spark: UsageSnapshot; credits: Credits };
export type SharedUsage = {
  version: 1;
  accountKey: string;
  attemptedAt: number;
  retryAt: number;
  failures: number;
  sample: SharedSample | null;
};
export type SharedResult = { sample: SharedSample | null; error: boolean };

export function usageAccountKey(accountId: string): string {
  return createHash("sha256").update(`v1:${USAGE_URL}:${accountId}`).digest("hex");
}

export function normalizeCredits(value: CodexUsageResponse["credits"]): Credits {
  return {
    balance:
      typeof value?.balance === "string" && /^\d{1,20}(?:\.\d{1,20})?$/.test(value.balance)
        ? value.balance
        : null,
    unlimited: value?.unlimited === true,
  };
}

function snapshot(value: unknown, scope: "default" | "spark"): UsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const nullableNumber = (n: unknown) =>
    n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (
    v.scope !== scope ||
    typeof v.capturedAt !== "number" ||
    !Number.isFinite(v.capturedAt) ||
    typeof v.isLimited !== "boolean" ||
    !nullableNumber(v.fiveHourLeftPercent) ||
    !nullableNumber(v.sevenDayLeftPercent) ||
    !nullableNumber(v.fiveHourResetInSeconds) ||
    !nullableNumber(v.sevenDayResetInSeconds)
  )
    return null;
  return {
    capturedAt: v.capturedAt,
    scope,
    isLimited: v.isLimited,
    fiveHourLeftPercent: v.fiveHourLeftPercent as number | null,
    sevenDayLeftPercent: v.sevenDayLeftPercent as number | null,
    fiveHourResetInSeconds: v.fiveHourResetInSeconds as number | null,
    sevenDayResetInSeconds: v.sevenDayResetInSeconds as number | null,
  };
}

async function readCache(file: string, key: string, now: number): Promise<SharedUsage | null> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_BYTES) return null;
    const fd = await open(file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CACHE_BYTES) return null;
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await fd.close();
    }
    const v = JSON.parse(text) as SharedUsage;
    if (
      v.version !== 1 ||
      v.accountKey !== key ||
      !Number.isFinite(v.attemptedAt) ||
      v.attemptedAt > now + 5000 ||
      !Number.isFinite(v.retryAt) ||
      v.retryAt < v.attemptedAt ||
      v.retryAt > v.attemptedAt + 3_600_000 ||
      !Number.isInteger(v.failures) ||
      v.failures < 0 ||
      v.failures > 10
    )
      return null;
    const base = snapshot(v.sample?.default, "default"),
      spark = snapshot(v.sample?.spark, "spark");
    if (
      v.sample !== null &&
      (!base || !spark || base.capturedAt !== spark.capturedAt || base.capturedAt > v.attemptedAt)
    )
      return null;
    return {
      version: 1,
      accountKey: key,
      attemptedAt: v.attemptedAt,
      retryAt: v.retryAt,
      failures: v.failures,
      sample:
        base && spark
          ? { default: base, spark, credits: normalizeCredits(v.sample?.credits) }
          : null,
    };
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Ownership is the unique file, not just the directory. Reapers unlink only a
// dead owner's file; rmdir cannot delete a successor's nonempty lock. Never
// expire a live owner: its request has a separate timeout. Empty crash windows
// recover after ORPHAN_MS. No recursive lock deletion or unfenced stale writes.
export async function acquireUsageLock(
  lock: string,
  now = Date.now(),
): Promise<(() => Promise<void>) | null> {
  const own = `${process.pid}-${randomUUID()}`;
  const release = async () => {
    try {
      await unlink(join(lock, own));
    } catch {
      return;
    }
    await rmdir(lock).catch(() => undefined);
  };
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await lstat(lock).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
    const owners = await readdir(lock).catch(() => null);
    if (!owners) return null;
    if (!owners.length && now - stat.mtimeMs > ORPHAN_MS) {
      await rmdir(lock).catch(() => undefined);
    } else {
      for (const owner of owners) {
        const match = /^([1-9]\d{0,9})-[a-f0-9-]{36}$/.exec(owner);
        if (!match || alive(Number(match[1]))) return null;
        try {
          await unlink(join(lock, owner));
        } catch {
          return null;
        }
      }
      if (!owners.length) return null;
      await rmdir(lock).catch(() => undefined);
    }
    // Let the next attempt contend normally, never recurse under contention.
    return null;
  }
  try {
    await writeFile(join(lock, own), "", { flag: "wx", mode: 0o600 });
    const owners = await readdir(lock);
    if (owners.length !== 1 || owners[0] !== own) {
      await release();
      return null;
    }
    return release;
  } catch {
    await release();
    return null;
  }
}

type Options = {
  directory?: string;
  now?: () => number;
  collect?: (credentials: CodexCredentials, signal?: AbortSignal) => Promise<CodexUsageResponse>;
  force?: boolean;
};

export async function sharedUsage(
  credentials: CodexCredentials,
  intervalMs: number,
  signal?: AbortSignal,
  options: Options = {},
): Promise<SharedResult> {
  const clock = options.now ?? Date.now;
  const directory = options.directory ?? join(piAgentDir(), "cache", "openai-usage-v1");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (process.getuid && dir.uid !== process.getuid()) ||
    (process.platform !== "win32" && (dir.mode & 0o077) !== 0)
  )
    throw new Error("Usage cache must be private");
  const key = usageAccountKey(credentials.accountId),
    file = join(directory, `${key}.json`);
  const minimum = options.force ? LOCAL_CHECK_MS : Math.max(LOCAL_CHECK_MS, intervalMs);
  const usable = (entry: SharedUsage | null) =>
    entry && (entry.failures ? clock() < entry.retryAt : clock() - entry.attemptedAt < minimum);
  const result = (entry: SharedUsage | null): SharedResult => ({
    sample: entry?.sample ?? null,
    error: (entry?.failures ?? 0) > 0,
  });
  let cached = await readCache(file, key, clock());
  if (usable(cached)) return result(cached);
  signal?.throwIfAborted();
  const release = await acquireUsageLock(join(directory, `${key}.lock`), clock());
  if (!release) return result(cached);
  try {
    cached = await readCache(file, key, clock());
    if (usable(cached)) return result(cached);
    signal?.throwIfAborted();
    let next: SharedUsage;
    try {
      const raw = await (options.collect ?? requestCodexUsageWithCredentials)(credentials, signal);
      signal?.throwIfAborted();
      if (
        !raw ||
        typeof raw !== "object" ||
        (!raw.rate_limit && !raw.credits && !raw.additional_rate_limits)
      )
        throw new Error("Invalid usage response");
      const at = clock();
      next = {
        version: 1,
        accountKey: key,
        attemptedAt: at,
        retryAt: at,
        failures: 0,
        sample: {
          default: parseUsageSnapshot(raw, undefined, at),
          spark: parseUsageSnapshot(raw, "gpt-5.3-codex-spark", at),
          credits: normalizeCredits(raw.credits),
        },
      };
    } catch (error) {
      if (signal?.aborted && (signal.reason as Error)?.name !== "TimeoutError") throw error;
      const at = clock(),
        failures = Math.min(10, (cached?.failures ?? 0) + 1);
      const delay = Math.max(
        Math.min(300_000, 60_000 * 2 ** (failures - 1)),
        error instanceof UsageRequestError ? error.retryAfterMs : 0,
      );
      next = {
        version: 1,
        accountKey: key,
        attemptedAt: at,
        retryAt: at + delay,
        failures,
        sample: cached?.sample ?? null,
      };
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return result(next);
  } finally {
    await release();
  }
}
