# Browser model diagnostics

Kiln separates a requested runtime plan from a successfully loaded runtime. `Ready` appears only after Wllama reports `isModelLoaded()`. Runtime details use Wllama's loaded context and batch values and actual CPU thread count.

WebGPU presence alone does not prove usable acceleration. Kiln requests an adapter before trying offload and retries CPU after an accelerated load fails. Wllama 3.8.1 does not expose a confirmed tensor allocation count, so the UI reports **GPU offload requested**, not measured GPU utilization. CPU fallback records its reason. CPU-only profiles skip GPU initialization. Changing context, threads, GPU layers or batch reloads the model; sampling changes apply to the next generation.

The former “WebGPU with CPU fallback · 1 thread … More CPU threads require cross-origin isolation” string was a planning description, not an error. Single-threaded CPU execution is expected on hosts without cross-origin isolation. It is surfaced as a runtime note rather than a failed load. Native LM Studio or Ollama providers can use available CPU cores independently of browser isolation.

GGUF import inspects the file's v2/v3 metadata, including architecture, file type (quantization), parameter count when present and training context. Inspection is bounded to the first 16 MiB, skips array values and never reads model tensor data into JavaScript. Metadata is not evidence of executable compatibility: Wllama must still load the model. Malformed and unsupported header versions return actionable errors.

The 20B GPT-OSS MXFP4 model is not categorically rejected. Upstream llama.cpp supports GPT-OSS/MXFP4, but a successful native load does not prove the browser backend works for a particular device. The installed Wllama v3 uses Memory64; a universal 4 GiB browser limit would be incorrect. Kiln estimates model memory plus runtime/context overhead and warns for large models. Browser `deviceMemory` may be absent, rounded, or capped and is never displayed as measured free memory. WebGPU offload still retains model weights in system memory. For models around 12 GiB, native inference is often the practical choice.

Sources: installed `@wllama/wllama/src/wllama.ts`, `src/types/types.ts`, and `README-dev.md`; [Wllama upstream](https://github.com/ngxson/wllama); [llama.cpp GPT-OSS announcement](https://github.com/ggml-org/llama.cpp/discussions/15095); [GGUF specification](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md); [llama.cpp file type definitions](https://github.com/ggml-org/llama.cpp/blob/master/include/llama.h).

Verification: `src/lib/model-runtime.test.ts` checks real header decoding, version/format failures, bounded reads, saved load settings and large-model warning behavior. `scripts/local-runtime-qa.mjs` exercises a downloaded SmolLM2 GGUF with CPU generation, interruption, recovery and acceleration/fallback. Its result is a live test of that model/device only, not certification of GPT-OSS or every GPU.
