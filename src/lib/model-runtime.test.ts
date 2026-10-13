import { test } from "node:test";
import assert from "node:assert/strict";
import { readGgufMetadata } from "./gguf";
import { planRuntime, getModelPreflight } from "./local-engine";
import type { SavedModel } from "./types";

function header(version: number, entries: [string, number, string | number][]) {
  const bytes: number[] = [];
  const u32 = (n: number) => {
    for (let i = 0; i < 4; i++) bytes.push((n >>> (i * 8)) & 255);
  };
  const u64 = (n: number) => {
    u32(n);
    u32(Math.floor(n / 2 ** 32));
  };
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    u64(b.length);
    bytes.push(...b);
  };
  u32(0x46554747);
  u32(version);
  u64(0);
  u64(entries.length);
  for (const [key, type, value] of entries) {
    str(key);
    u32(type);
    if (type === 8) str(String(value));
    else if (type === 10) u64(Number(value));
    else u32(Number(value));
  }
  return new Blob([new Uint8Array(bytes)]);
}

test("GGUF import reads actual architecture, MXFP4, 64-bit parameters and context", async () => {
  const file = header(3, [
    ["general.architecture", 8, "gpt-oss"],
    ["general.file_type", 4, 38],
    ["general.parameter_count", 10, 20_000_000_000],
    ["gpt-oss.context_length", 4, 131072],
  ]);
  assert.deepEqual(await readGgufMetadata(file), {
    architecture: "gpt-oss",
    quantization: "MXFP4",
    parameters: 20_000_000_000,
    contextLength: 131072,
  });
});
test("GGUF v2 and malformed headers have actionable results", async () => {
  assert.deepEqual(await readGgufMetadata(header(2, [])), {});
  await assert.rejects(readGgufMetadata(new Blob(["not a model"])), /not a GGUF/);
  await assert.rejects(readGgufMetadata(header(1, [])), /version 1/);
  await assert.rejects(readGgufMetadata(new Blob([new Uint8Array([71, 71, 85, 70])])), /truncated/);
});
test("metadata inspection slices a bounded header without reading model tensors", async () => {
  const file = header(3, [["general.architecture", 8, "llama"]]);
  const sliced: number[] = [];
  const original = file.slice.bind(file);
  file.slice = (start, end, type) => {
    sliced.push(end ?? 0);
    return original(start, end, type);
  };
  file.arrayBuffer = () => {
    throw new Error("Whole model read is forbidden");
  };
  assert.equal((await readGgufMetadata(file)).architecture, "llama");
  assert.deepEqual(sliced, [16 * 1024 * 1024]);
});
test("per-model load overrides apply while CPU-only remains explicit", () => {
  const plan = planRuntime(2048, 512, "auto", {
    context: 8192,
    profile: "saver",
    batch: 32,
    threads: 8,
    gpuLayers: 32,
    maxTokens: 128,
  });
  assert.equal(plan.ctx, 8192);
  assert.equal(plan.batch, 32);
  assert.equal(plan.gpuLayers, 0);
  assert.equal(plan.threads, 1);
  assert.equal(plan.maxTokens, 128);
  assert.match(plan.note, /CPU selected/);
  assert.doesNotMatch(plan.note, /WebGPU with CPU fallback/);
});
test("large MXFP4 model has memory warning, never fake support rejection", () => {
  const model = {
    bytes: 12 * 1024 ** 3,
    metadata: { quantization: "MXFP4", contextLength: 1024 },
  } as SavedModel;
  const result = getModelPreflight(model, planRuntime(2048, 512, "saver"));
  assert.ok(result.estimatedMemoryBytes > model.bytes);
  assert.ok(result.warnings.some((w) => /Large browser model/.test(w)));
  assert.ok(result.warnings.every((w) => !/unsupported.*MXFP4/i.test(w)));
});

test("untrusted GGUF rejects unsafe lengths and excessive metadata before iterating", async () => {
  const buffer = await header(3, []).arrayBuffer();
  const unsafe = new Uint8Array(buffer.slice(0));
  new DataView(unsafe.buffer).setBigUint64(16, 2n ** 63n, true);
  await assert.rejects(readGgufMetadata(new Blob([unsafe])), /unsafe length/);
  const excessive = new Uint8Array(buffer.slice(0));
  new DataView(excessive.buffer).setBigUint64(16, 100001n, true);
  await assert.rejects(readGgufMetadata(new Blob([excessive])), /too many entries/);
  const keyLength = new Uint8Array(32);
  keyLength.set(new Uint8Array(buffer));
  const keyView = new DataView(keyLength.buffer);
  keyView.setBigUint64(16, 1n, true);
  keyView.setBigUint64(24, 2n ** 63n, true);
  await assert.rejects(readGgufMetadata(new Blob([keyLength])), /unsafe length/);
});

test("untrusted GGUF arrays reject nested and excessive arrays and unknown types", async () => {
  // Append subtype/count to the helper's metadata value, which represents array subtype.
  for (const [subtype, count] of [
    [9, 1],
    [8, 1000001],
  ]) {
    const base = new Uint8Array(await header(3, [["untrusted.array", 9, subtype]]).arrayBuffer());
    const payload = new Uint8Array(base.length + 8);
    payload.set(base);
    new DataView(payload.buffer).setBigUint64(base.length, BigInt(count), true);
    await assert.rejects(readGgufMetadata(new Blob([payload])), /Unsupported GGUF metadata array/);
  }
  await assert.rejects(readGgufMetadata(header(3, [["untrusted.type", 99, 0]])), /type 99/);
});
