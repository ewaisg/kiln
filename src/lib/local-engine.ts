import { fileForModel } from "@/lib/library";
import type { ModelConfig, PerformanceProfile, SavedModel, WireMessage } from "@/lib/types";
import { useKiln } from "@/lib/store";

type Engine = import("@wllama/wllama").Wllama;

class LoadCancelled extends Error {
  constructor() {
    super("Load cancelled.");
    this.name = "LoadCancelled";
  }
}

let engine: Engine | null = null;
let loadedKey = "";
let ticket = 0;
let chain: Promise<void> = Promise.resolve();
let inflight: { key: string; promise: Promise<void> } | null = null;
let generating = false;
let gpuFailed = false;
let loadedConfig: ModelConfig | undefined;
let diagnostic: {
  backend: "cpu" | "webgpu-requested";
  reason?: string;
  model?: string;
  chatTemplate?: boolean;
  modelId?: string;
  effectiveContext?: number;
  threads?: number;
  batch?: number;
  gpuLayers?: number;
  gpuAvailable?: boolean;
  warnings?: string[];
} = { backend: "cpu" };
export function localDiagnostics() {
  return { ...diagnostic, generating, loaded: Boolean(engine?.isModelLoaded()) };
}

export function isLoadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "LoadCancelled";
}

export type RuntimePlan = {
  threads: number;
  batch: number;
  ctx: number;
  maxTokens: number;
  note: string;
  gpuLayers: number;
};

export function getModelPreflight(
  model: SavedModel,
  plan = planRuntime(2048, 512, undefined, model.config),
) {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const reportedMemory = (nav as (Navigator & { deviceMemory?: number }) | null)?.deviceMemory;
  // An estimate, not a measurement: model weights + runtime and approximate KV workspace.
  const estimatedMemoryBytes = Math.ceil(model.bytes * 1.25 + plan.ctx * 256 * 1024);
  const warnings: string[] = [];
  if (model.bytes >= 4 * 1024 ** 3)
    warnings.push(
      "Large browser model: GPU offload still retains weights in system memory. LM Studio or Ollama is recommended if this browser runs out of memory.",
    );
  if (reportedMemory && estimatedMemoryBytes > reportedMemory * 1024 ** 3 * 0.75)
    warnings.push(
      "Estimated memory exceeds much of the browser-reported RAM. That report may be rounded or capped; close other apps, reduce context/batch, or choose a smaller quantization.",
    );
  if (!(typeof crossOriginIsolated === "boolean" && crossOriginIsolated))
    warnings.push(
      "This page can use one CPU thread. Multiple threads require a cross-origin-isolated host; native providers can use your available CPU cores.",
    );
  if (model.metadata?.contextLength && plan.ctx > model.metadata.contextLength)
    warnings.push(
      `Requested context exceeds this model's ${model.metadata.contextLength.toLocaleString()} trained context and may reduce output quality.`,
    );
  return {
    estimatedMemoryBytes,
    reportedMemoryBytes: reportedMemory ? reportedMemory * 1024 ** 3 : null,
    warnings,
  };
}

export function planRuntime(
  requestedCtx: number,
  requestedTokens: number,
  profile: PerformanceProfile = useKiln.getState().settings.performanceProfile ?? "auto",
  config?: ModelConfig,
): RuntimePlan {
  profile = config?.profile ?? profile;
  requestedCtx = config?.context ?? requestedCtx;
  requestedTokens = config?.maxTokens ?? requestedTokens;
  const nav = typeof navigator === "undefined" ? null : navigator;
  const cores = nav?.hardwareConcurrency || 2;
  const memory = (nav as (Navigator & { deviceMemory?: number }) | null)?.deviceMemory ?? 4;
  // SharedArrayBuffer is required for more than one wasm thread, and this site
  // does not isolate the origin, so extra cores would not actually run.
  const threads =
    typeof crossOriginIsolated === "boolean" && crossOriginIsolated
      ? Math.min(config?.threads ?? (profile === "quality" ? 8 : 4), Math.max(1, cores))
      : 1;
  const ctxCap =
    profile === "quality"
      ? 16384
      : profile === "saver"
        ? 1024
        : memory <= 3
          ? 2048
          : memory >= 8
            ? 8192
            : 4096;
  const ctx = Math.max(512, Math.min(requestedCtx, config?.context ? 131072 : ctxCap));
  const maxTokens = Math.max(16, Math.min(requestedTokens, profile === "saver" ? 512 : ctx - 128));
  const gpuLayers =
    profile !== "saver" && !gpuFailed && !!nav && "gpu" in nav
      ? Math.max(0, Math.min(config?.gpuLayers ?? (profile === "quality" ? 99999 : 16), 99999))
      : 0;
  const note = `${gpuLayers ? "GPU offload requested (verified during load)" : "CPU selected"}, ${threads} thread${threads > 1 ? "s" : ""}, ${ctx.toLocaleString()} context`;
  return {
    threads,
    batch: Math.max(16, Math.min(config?.batch ?? (profile === "saver" ? 64 : 128), 2048)),
    ctx,
    maxTokens,
    note,
    gpuLayers,
  };
}

async function getEngine(): Promise<Engine> {
  if (typeof window === "undefined") throw new Error("Local models run in the browser.");
  if (!engine) {
    const { Wllama } = await import("@wllama/wllama");
    engine = new Wllama(
      { default: "/wllama/wllama.wasm" },
      { suppressNativeLog: true, allowOffline: true },
    );
  }
  return engine;
}

export async function unloadLocal(): Promise<void> {
  ticket += 1;
  loadedKey = "";
  inflight = null;
  loadedConfig = undefined;
  diagnostic = { backend: "cpu" };
  const current = engine;
  engine = null;
  if (current) await current.exit().catch(() => undefined);
}

export function ensureLocal(
  model: SavedModel,
  nCtx: number,
  onProgress: (label: string, ratio: number | null) => void,
  profile?: PerformanceProfile,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new LoadCancelled());
  const plan = planRuntime(nCtx, 512, profile, model.config);
  const key = `${model.id}:${plan.ctx}:${plan.threads}:${plan.gpuLayers}:${plan.batch}`;
  if (engine?.isModelLoaded() && loadedKey === key) {
    loadedConfig = model.config;
    return Promise.resolve();
  }
  if (inflight?.key === key) return cancellableLoad(inflight.promise, signal);
  const mine = ++ticket;
  const promise = chain.then(() => runLoad(model, plan, key, mine, onProgress));
  chain = promise.then(
    () => undefined,
    () => undefined,
  );
  inflight = { key, promise };
  return cancellableLoad(
    promise.finally(() => {
      if (inflight?.promise === promise) inflight = null;
    }),
    signal,
  );
}

function cancellableLoad(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      void unloadLocal();
      reject(new LoadCancelled());
    };
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}

async function runLoad(
  model: SavedModel,
  plan: RuntimePlan,
  key: string,
  mine: number,
  onProgress: (label: string, ratio: number | null) => void,
): Promise<void> {
  if (mine !== ticket) throw new LoadCancelled();
  onProgress("Preparing runtime", null);
  if (engine?.isModelLoaded()) {
    await engine.exit().catch(() => undefined);
    engine = null;
    loadedKey = "";
  }
  if (mine !== ticket) throw new LoadCancelled();
  loadedConfig = undefined;
  diagnostic = { backend: "cpu", model: model.name, modelId: model.id };
  const current = await getEngine();
  const params = {
    n_ctx: plan.ctx,
    n_threads: plan.threads,
    n_gpu_layers: plan.gpuLayers,
    flash_attn: false,
    n_batch: Math.min(plan.batch, plan.ctx),
    progressCallback: ({ loaded, total }: { loaded: number; total: number }) => {
      if (mine !== ticket) return;
      onProgress("Downloading", total > 0 ? loaded / total : null);
    },
  };
  onProgress(model.kind === "file" ? "Loading from this device" : "Downloading model", 0);
  const load = async (runtime: Engine, gpuLayers: number) => {
    if (model.opfsName || model.externalName || model.kind === "file") {
      const blob = await fileForModel(model);
      onProgress("Loading into memory", null);
      await runtime.loadModel([blob], { ...params, n_gpu_layers: gpuLayers });
    } else if (model.kind === "hf")
      await runtime.loadModelFromHF(
        { repo: model.repo, file: model.file },
        { ...params, n_gpu_layers: gpuLayers },
      );
    else await runtime.loadModelFromUrl(model.url, { ...params, n_gpu_layers: gpuLayers });
  };
  let runtime = current;
  let gpuLayers = plan.gpuLayers;
  let reason: string | undefined;
  let gpuAvailable = false;
  if (gpuLayers) {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      gpuAvailable = Boolean(await gpu?.requestAdapter());
    } catch {
      gpuAvailable = false;
    }
    if (!gpuAvailable) {
      gpuLayers = 0;
      reason = "No usable WebGPU adapter; loaded on CPU.";
    }
  }
  try {
    await load(runtime, gpuLayers);
  } catch (error) {
    if (mine !== ticket) throw new LoadCancelled();
    if (!gpuLayers) {
      await runtime.exit().catch(() => undefined);
      engine = null;
      loadedKey = "";
      throw new Error(
        `Could not load ${model.name}: ${error instanceof Error ? error.message : "runtime load failed"}. Try a smaller model or use LM Studio/Ollama for large models.`,
      );
    }
    gpuFailed = true;
    reason = `GPU load failed; CPU fallback used. ${error instanceof Error ? error.message.slice(0, 200) : ""}`;
    await runtime.exit().catch(() => undefined);
    engine = null;
    onProgress("GPU unavailable; trying CPU", null);
    runtime = await getEngine();
    gpuLayers = 0;
    try {
      await load(runtime, 0);
    } catch (error) {
      await runtime.exit().catch(() => undefined);
      engine = null;
      loadedKey = "";
      throw error;
    }
  }
  if (mine !== ticket) throw new LoadCancelled();
  if (!runtime.isModelLoaded())
    throw new Error(
      "The runtime did not confirm a loaded model. Try a compatible GGUF or a native provider.",
    );
  const context = runtime.getLoadedContextInfo();
  diagnostic = {
    // Wllama exposes requested layers, not a confirmed tensor allocation count.
    backend: gpuLayers && runtime.isSupportWebGPU() ? "webgpu-requested" : "cpu",
    reason,
    gpuAvailable,
    gpuLayers,
    model: model.name,
    modelId: model.id,
    effectiveContext: context.n_ctx,
    batch: context.n_batch,
    threads: runtime.getNumThreads(),
    chatTemplate: Boolean(runtime.getChatTemplate()),
    warnings: getModelPreflight(model, plan).warnings,
  };
  loadedConfig = model.config;
  loadedKey = key;
  onProgress("Ready", 1);
}

export async function completeLocal(
  messages: WireMessage[],
  temperature: number,
  maxTokens: number,
  signal: AbortSignal,
  onDelta: (full: string) => void,
): Promise<string> {
  if (!engine?.isModelLoaded()) throw new Error("Load a model first.");
  if (generating)
    throw new Error("A local generation is already in progress. Stop it before starting another.");
  if (signal.aborted) throw new DOMException("Generation stopped.", "AbortError");
  generating = true;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let full = "";
  try {
    await engine.createChatCompletion({
      messages,
      stream: true,
      temperature: loadedConfig?.temperature ?? temperature,
      max_tokens: Math.min(
        loadedConfig?.maxTokens ?? maxTokens,
        (diagnostic.effectiveContext ?? 2048) - 128,
      ),
      top_k: 40,
      top_p: loadedConfig?.topP ?? 0.9,
      min_p: 0.05,
      penalty_repeat: loadedConfig?.repeatPenalty ?? 1.15,
      penalty_last_n: 128,
      abortSignal: controller.signal,
      onData: (chunk) => {
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text !== "string" || !text) return;
        full += text;
        onDelta(full);
        if (isDegenerate(full)) {
          controller.abort();
          throw new Error(
            "The model entered a repetition loop. Output was stopped. Try a lower temperature or a different quantization. CPU mode can help isolate GPU issues.",
          );
        }
      },
    });
    return full;
  } finally {
    generating = false;
    signal.removeEventListener("abort", abort);
  }
}

function isDegenerate(text: string): boolean {
  const tail = text.slice(-180);
  return tail.length >= 36 && /(.{2,16}?)\1{5,}$/.test(tail);
}

/** Native Wllama tool-call API. Only supplied, permitted schemas reach the model. */
export async function localToolTurn(
  messages: import("@wllama/wllama").ChatCompletionParams["messages"],
  tools: import("@wllama/wllama").ChatCompletionParams["tools"],
  temperature: number,
  maxTokens: number,
  signal: AbortSignal,
) {
  if (!engine?.isModelLoaded()) throw new Error("Load a local model before using tools.");
  if (generating) throw new Error("A local generation is already in progress.");
  signal.throwIfAborted();
  generating = true;
  try {
    return await engine.createChatCompletion({
      messages,
      tools,
      temperature: loadedConfig?.temperature ?? temperature,
      max_tokens: Math.min(
        loadedConfig?.maxTokens ?? maxTokens,
        (diagnostic.effectiveContext ?? 2048) - 128,
      ),
      top_p: loadedConfig?.topP ?? 0.9,
      penalty_repeat: loadedConfig?.repeatPenalty ?? 1.15,
      abortSignal: signal,
    });
  } finally {
    generating = false;
  }
}
