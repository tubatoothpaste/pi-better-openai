import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import {
  AUTH_FILE,
  type UsageSnapshot,
  formatResetCountdown,
  formatUsageSnapshot,
  readCodexAuth,
  usageScopeForModel,
} from "./usage.ts";
import { currentModelKey } from "./fast-controller.ts";
import { getCodexCredentials } from "./codex-auth.ts";
import {
  sharedUsage,
  usageAccountKey,
  LOCAL_CHECK_MS,
  type Credits,
  type CreditsUpdate,
} from "./shared-usage.ts";

export function isOpenAISubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    (isUsingOAuth ?? ctx.modelRegistry.isUsingOAuth(model))
  );
}

const STALE_EXTENSION_CONTEXT_MESSAGE = "This extension ctx is stale";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_MESSAGE);
}

type UsageRefreshOptions = { notify?: boolean; force?: boolean };

type QueuedUsageRefresh = {
  ctx: ExtensionContext;
  generation: number;
  modelId?: string;
  notify?: boolean;
  force?: boolean;
};

export class UsageController {
  private usageSnapshot: UsageSnapshot | undefined;
  private credits: Credits | null = null;
  private accountKey: string | undefined;
  private creditsUpdate: CreditsUpdate | undefined;
  private usageUpdatedAt: number | undefined;
  private usageError: string | undefined;
  private usageLastFetchAt: number | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private usageRefreshInFlight = false;
  private queuedUsageRefresh: QueuedUsageRefresh | undefined;
  private shuttingDown = false;
  private usageAbortController: AbortController | undefined;
  private sessionAbortSignal: AbortSignal | undefined;
  private sessionAbortHandler: (() => void) | undefined;
  private sessionGeneration = 0;
  private readonly getConfig: (ctx: ExtensionContext) => ResolvedConfig;
  private readonly updateFooter: (ctx: ExtensionContext) => void;
  private readonly publishCredits: (update: CreditsUpdate | undefined) => void;

  constructor(
    getConfig: (ctx: ExtensionContext) => ResolvedConfig,
    updateFooter: (ctx: ExtensionContext) => void,
    publishCredits: (update: CreditsUpdate | undefined) => void = () => undefined,
  ) {
    this.getConfig = getConfig;
    this.updateFooter = updateFooter;
    this.publishCredits = publishCredits;
  }

  republishCredits(): void {
    this.publishCredits(this.creditsUpdate);
  }

  private updateCredits(ctx: ExtensionContext): void {
    const cfg = this.getConfig(ctx);
    this.creditsUpdate =
      cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg)
        ? {
            version: 1,
            credits: this.credits,
            observedAt: this.usageUpdatedAt ?? null,
            stale:
              this.usageUpdatedAt !== undefined &&
              Date.now() - this.usageUpdatedAt > Math.max(120_000, cfg.usage.refreshIntervalMs * 2),
            error: Boolean(this.usageError),
          }
        : undefined;
    this.republishCredits();
  }

  get snapshot(): UsageSnapshot | undefined {
    return this.usageSnapshot;
  }

  statusLine(
    ctx: ExtensionContext,
    cfg = this.getConfig(ctx),
    isUsingOAuth?: boolean,
  ): string | undefined {
    return this.usageSnapshot &&
      this.usageSnapshot.scope === usageScopeForModel(ctx.model?.id) &&
      cfg.usage.enabled &&
      isOpenAISubscriptionModel(ctx, cfg, isUsingOAuth)
      ? `${formatUsageSnapshot(this.usageSnapshot, cfg.usage)}${this.usageError ? " | stale (refresh failed)" : Date.now() - this.usageSnapshot.capturedAt > Math.max(120_000, cfg.usage.refreshIntervalMs * 2) ? " | stale" : ""}`
      : undefined;
  }

  formatStatus(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return "Usage display is disabled.";
    if (!isOpenAISubscriptionModel(ctx, cfg))
      return "Usage hidden: current model is not an OpenAI subscription model.";
    if (this.usageError) return `Usage unavailable: ${this.usageError}`;
    if (!this.usageSnapshot || this.usageSnapshot.scope !== usageScopeForModel(ctx.model?.id))
      return "Usage unavailable.";
    const stale =
      this.usageUpdatedAt && Date.now() - this.usageUpdatedAt > cfg.usage.refreshIntervalMs * 2
        ? ` | stale ${formatResetCountdown((Date.now() - this.usageUpdatedAt) / 1000)}`
        : "";
    return `${formatUsageSnapshot(this.usageSnapshot, cfg.usage)}${stale}`;
  }

  formatDebug(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    const auth = readCodexAuth();
    return [
      `Usage enabled: ${cfg.usage.enabled}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Current model eligible: ${isOpenAISubscriptionModel(ctx, cfg)}`,
      `Requires subscription model: ${cfg.usage.showOnlyOnSubscriptionModels}`,
      `Auth: ${auth ? "found" : "missing"}`,
      `Account ID: ${maskIdentifier(auth?.accountId) ?? "none"}`,
      `Last local cache check: ${this.usageLastFetchAt ? new Date(this.usageLastFetchAt).toLocaleTimeString() : "never"}`,
      `Last successful update: ${this.usageUpdatedAt ? new Date(this.usageUpdatedAt).toLocaleTimeString() : "never"}`,
      `Last error: ${this.usageError ?? "none"}`,
      `Refresh interval: ${cfg.usage.refreshIntervalMs}ms`,
      `Endpoint: https://chatgpt.com/backend-api/wham/usage`,
    ].join("\n");
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.shuttingDown && generation === this.sessionGeneration;
  }

  private deactivateGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) return;
    this.shuttingDown = true;
    this.sessionGeneration++;
    this.queuedUsageRefresh = undefined;
    this.usageAbortController?.abort();
    this.usageAbortController = undefined;
    this.stopTimer();
    this.creditsUpdate = undefined;
    this.republishCredits();
  }

  private handleStaleContextError(error: unknown, generation: number): boolean {
    if (!isStaleExtensionContextError(error)) return false;
    this.deactivateGeneration(generation);
    return true;
  }

  async refresh(
    ctx: ExtensionContext,
    modelId?: string,
    options?: UsageRefreshOptions,
    generation = this.sessionGeneration,
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) return;

    let resolvedModelId = modelId;
    try {
      if (!ctx.hasUI) return;
      resolvedModelId ??= ctx.model?.id;
    } catch (error) {
      this.handleStaleContextError(error, generation);
      return;
    }

    if (this.usageRefreshInFlight) {
      const queued =
        this.queuedUsageRefresh?.generation === generation ? this.queuedUsageRefresh : undefined;
      this.queuedUsageRefresh = {
        ctx,
        generation,
        modelId: resolvedModelId,
        notify: queued?.notify || options?.notify,
        force: queued?.force || options?.force,
      };
      return;
    }

    this.usageRefreshInFlight = true;
    try {
      const cfg = this.getConfig(ctx);
      if (!this.isGenerationCurrent(generation)) return;

      if (!cfg.usage.enabled) {
        this.usageSnapshot = undefined;
        this.usageError = "Usage display is disabled.";
        this.updateCredits(ctx);
        this.updateFooter(ctx);
        if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
        return;
      }
      if (!isOpenAISubscriptionModel(ctx, cfg)) {
        this.updateCredits(ctx);
        this.updateFooter(ctx);
        if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
        return;
      }
      const shouldThrottle =
        !options?.force &&
        !options?.notify &&
        this.usageLastFetchAt !== undefined &&
        Date.now() - this.usageLastFetchAt < LOCAL_CHECK_MS;
      if (shouldThrottle) return;
      this.usageLastFetchAt = Date.now();
      this.usageAbortController = new AbortController();
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal, this.usageAbortController.signal])
        : AbortSignal.any([timeoutSignal, this.usageAbortController.signal]);
      const credentials = await getCodexCredentials(ctx, signal);
      if (!this.isGenerationCurrent(generation)) return;
      const accountKey = credentials ? usageAccountKey(credentials.accountId) : undefined;
      if (accountKey !== this.accountKey) {
        this.accountKey = accountKey;
        this.usageSnapshot = undefined;
        this.usageUpdatedAt = undefined;
        this.credits = null;
        this.updateCredits(ctx);
      }
      const data = credentials
        ? await sharedUsage(credentials, cfg.usage.refreshIntervalMs, signal, {
            force: options?.notify,
          })
        : undefined;
      if (!this.isGenerationCurrent(generation)) return;

      this.usageSnapshot = data?.sample?.[usageScopeForModel(resolvedModelId)];
      this.usageUpdatedAt = this.usageSnapshot?.capturedAt;
      this.credits = data?.sample?.credits ?? null;
      this.usageError = !credentials
        ? `Missing openai-codex OAuth credentials in ${AUTH_FILE}.`
        : data?.error
          ? "Shared usage refresh failed; retry is backed off."
          : undefined;
      this.updateCredits(ctx);
      this.updateFooter(ctx);
      if (options?.notify)
        ctx.ui.notify(
          this.formatStatus(ctx),
          this.usageSnapshot && !this.usageError ? "info" : "warning",
        );
    } catch (error) {
      if (this.handleStaleContextError(error, generation) || !this.isGenerationCurrent(generation))
        return;
      this.usageSnapshot = undefined;
      this.usageUpdatedAt = undefined;
      this.credits = null;
      this.usageError = sanitizeDiagnosticError(
        error instanceof Error ? error.message : String(error),
      );
      try {
        this.updateCredits(ctx);
        this.updateFooter(ctx);
        if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
      } catch (secondaryError) {
        if (!this.handleStaleContextError(secondaryError, generation)) {
          this.usageError = sanitizeDiagnosticError(
            secondaryError instanceof Error ? secondaryError.message : String(secondaryError),
          );
        }
      }
    } finally {
      this.usageAbortController = undefined;
      this.usageRefreshInFlight = false;
      const next = this.queuedUsageRefresh;
      this.queuedUsageRefresh = undefined;
      if (next && !this.shuttingDown && next.generation === this.sessionGeneration) {
        void this.refresh(
          next.ctx,
          next.modelId,
          { notify: next.notify, force: next.force },
          next.generation,
        );
      }
    }
  }

  private stopTimer(): void {
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.sessionAbortSignal && this.sessionAbortHandler) {
      this.sessionAbortSignal.removeEventListener("abort", this.sessionAbortHandler);
    }
    this.sessionAbortSignal = undefined;
    this.sessionAbortHandler = undefined;
  }

  start(ctx: ExtensionContext): void {
    this.usageAbortController?.abort();
    this.queuedUsageRefresh = undefined;
    this.stopTimer();
    const generation = ++this.sessionGeneration;
    this.shuttingDown = false;
    this.usageSnapshot = undefined;
    this.usageUpdatedAt = undefined;
    this.credits = null;
    this.usageError = undefined;
    this.updateCredits(ctx);

    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return;
    const sessionSignal = ctx.signal;
    if (sessionSignal?.aborted) {
      this.deactivateGeneration(generation);
      return;
    }
    this.sessionAbortSignal = sessionSignal;
    this.sessionAbortHandler = () => {
      this.deactivateGeneration(generation);
    };
    sessionSignal?.addEventListener("abort", this.sessionAbortHandler, { once: true });
    void this.refresh(ctx, undefined, { force: true }, generation);
    this.usageTimer = setInterval(() => {
      if (!this.isGenerationCurrent(generation)) return;
      if (sessionSignal?.aborted) {
        this.deactivateGeneration(generation);
        return;
      }
      void this.refresh(ctx, undefined, undefined, generation);
    }, LOCAL_CHECK_MS);
    this.usageTimer.unref?.();
  }

  restartAfterSettingsChange(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    this.usageAbortController?.abort();
    this.queuedUsageRefresh = undefined;
    this.stopTimer();
    this.sessionGeneration++;
    this.shuttingDown = false;
    if (cfg.usage.enabled) this.start(ctx);
    else {
      this.usageSnapshot = undefined;
      this.usageError = "Usage display is disabled.";
      this.updateCredits(ctx);
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.sessionGeneration++;
    this.queuedUsageRefresh = undefined;
    this.usageAbortController?.abort();
    this.usageAbortController = undefined;
    this.stopTimer();
    this.creditsUpdate = undefined;
    this.republishCredits();
  }
}
