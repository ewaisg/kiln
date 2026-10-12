import { fileForModel } from "@/lib/library";
import type { SavedModel, WireMessage } from "@/lib/types";

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

export function isLoadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "LoadCancelled";
}

export type RuntimePlan = {
  threads: number;
  batch: number;
  ctx: number;
  maxTokens: number;
  note: string;
};

export function planRuntime(requestedCtx: number, requestedTokens: number): RuntimePlan {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const cores = nav?.hardwareConcurrency || 2;
  const memory = (nav as (Navigator & { deviceMemory?: number }) | null)?.deviceMemory ?? 4;
  const phone =
    !!nav &&
    window.matchMedia("(pointer: coarse)").matches &&
    Math.min(window.screen.width, window.screen.height) < 900;
  // SharedArrayBuffer is required for more than one wasm thread, and this site
  // does not isolate the origin, so extra cores would not actually run.
  const threads = typeof crossOriginIsolated === "boolean" && crossOriginIsolated && !phone ? Math.min(2, Math.max(1, cores - 1)) : 1;
  const ctxCap = memory <= 3 ? 1024 : phone ? 2048 : memory >= 8 ? 4096 : 3072;
  const ctx = Math.max(512, Math.min(requestedCtx, ctxCap));
  const maxTokens = Math.max(64, Math.min(requestedTokens, phone ? 512 : 768));
  const note = phone
    ? "One CPU core, so the rest of the phone stays cool. The GPU is idle because it was scrambling replies."
    : threads > 1
      ? `${threads} CPU cores. The GPU is idle so replies stay coherent.`
      : "One CPU core. The GPU is idle so replies stay coherent.";
  return { threads, batch: phone ? 64 : 128, ctx, maxTokens, note };
}

async function getEngine(): Promise<Engine> {
  if (typeof window === "undefined") throw new Error("Local models run in the browser.");
  if (!engine) {
    const { Wllama } = await import("@wllama/wllama");
    engine = new Wllama({ default: "/wllama/wllama.wasm" }, { suppressNativeLog: true, allowOffline: true });
  }
  return engine;
}

export async function unloadLocal(): Promise<void> {
  ticket += 1;
  loadedKey = "";
  inflight = null;
  const current = engine;
  engine = null;
  if (current) await current.exit().catch(() => undefined);
}

export function ensureLocal(
  model: SavedModel,
  nCtx: number,
  onProgress: (label: string, ratio: number | null) => void,
): Promise<void> {
  const plan = planRuntime(nCtx, 512);
  const key = `${model.id}:${plan.ctx}:${plan.threads}`;
  if (engine?.isModelLoaded() && loadedKey === key) return Promise.resolve();
  if (inflight?.key === key) return inflight.promise;
  const mine = ++ticket;
  const promise = chain.then(() => runLoad(model, plan, key, mine, onProgress));
  chain = promise.then(
    () => undefined,
    () => undefined,
  );
  inflight = { key, promise };
  return promise.finally(() => {
    if (inflight?.promise === promise) inflight = null;
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
  const current = await getEngine();
  const params = {
    n_ctx: plan.ctx,
    n_threads: plan.threads,
    // WebGPU corrupts sampling on phones and also runs the GPU hot.
    n_gpu_layers: 0,
    flash_attn: false,
    n_batch: Math.min(plan.batch, plan.ctx),
    progressCallback: ({ loaded, total }: { loaded: number; total: number }) => {
      if (mine !== ticket) return;
      onProgress("Downloading", total > 0 ? loaded / total : null);
    },
  };
  onProgress(model.kind === "file" ? "Loading from this device" : "Downloading model", 0);
  if (model.kind === "hf") {
    await current.loadModelFromHF({ repo: model.repo, file: model.file }, params);
  } else if (model.kind === "url") {
    await current.loadModelFromUrl(model.url, params);
  } else {
    const blob = await fileForModel(model);
    onProgress("Loading into memory", null);
    await current.loadModel([blob], params);
  }
  if (mine !== ticket) throw new LoadCancelled();
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
  const stream = await engine.createChatCompletion({
    messages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
    top_k: 40,
    top_p: 0.9,
    min_p: 0.05,
    penalty_repeat: 1.15,
    penalty_last_n: 128,
    abortSignal: signal,
  });
  let full = "";
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) {
      full += text;
      if (isDegenerate(full)) {
        full = "That reply collapsed into a repeated loop, so it was stopped. Reload this page, open the model again, and resend.";
        onDelta(full);
        break;
      }
      onDelta(full);
    }
  }
  return full;
}

function isDegenerate(text: string): boolean {
  const tail = text.slice(-180);
  return tail.length >= 36 && /(.{2,16}?)\1{5,}$/.test(tail);
}
