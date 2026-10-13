# Model management review

Independent review of the actual repository for the October 12, 2026 model-management follow-up. This is a flow checklist, not a claim that untested integrations work.

## Initial gaps and priorities

1. **Acquisition and ownership are mixed.** The old panel placed a live catalog before imports and installed files, conflated download with load, imported only the first selected file, ignored import progress, and loaded immediately. Installed must be the default surface; Add, discover, transfers, locations, and runtime must remain reachable without scrolling past catalog results.
2. **Discovery truncates invisibly.** Search requested 20 repositories, without pagination, sort controls, or file filters. Repository inspection replaced search with no explicit navigation. Filtering quantization and size belongs to inspected files, because repository search does not provide that metadata.
3. **Storage is difficult to reason about.** Choosing a new download folder does not mean existing files move there. Already saved GGUFs should be indexed without copying, bound to their original folder, deduplicated on rescans, and recoverable after permission denial. Imported references must not delete a user's original file through an ambiguous Remove action.
4. **Runtime feedback overstates requests.** The readiness text came from the requested plan, not the loaded runtime. A successful single-thread CPU load is not an error. WebGPU availability does not prove hardware utilization. Details should expose actual fallback and actionable diagnostics separately from concise ready status.
5. **Settings are global only.** Different installed models need persisted load defaults, visible pending changes, explicit load/reload, and unload. Context, CPU threads, batch and acceleration need range validation and truthful capability limits. Existing history/settings/files must remain intact.

## Acceptance checklist

- Installed library appears first; Add file/link is available near the heading on desktop and mobile.
- Multiple imports produce separate validation/copy/completion/error states, auto-refresh the library, and offer an explicit load action without forcing inference.
- Invalid GGUF, failed storage, session-only fallback, duplicate input, interrupted import and canceled picker have useful outcomes. Unmounting must not produce stale state or leave files unexpectedly acquired.
- Installed search/filter/sort and selected model details distinguish downloaded, available this visit, missing, loading, loaded, and saved link not downloaded.
- Catalog pagination preserves results and query/filter state, deduplicates appended rows, handles end-of-results/errors/cancellation, and never forwards arbitrary next-page URLs.
- File inspection provides quantization, size, approximate memory, unsupported split/projector explanation, and return to repositories. Filters state their scope.
- Transfers support cancellation and retry/resume where backend supports it, retain failure details, and never claim a download succeeded before commit.
- Browser storage and user-selected folders are clearly separate; selecting another target preserves old records; scanning a previously populated folder adds readable files once without copying them.
- Permission denial and missing files preserve records and explain recovery; removing an indexed original means unregistering it unless destructive deletion is explicit and confirmed.
- Per-model load defaults survive reload; editing settings does not falsely report them already applied; cancellation cannot later emit ready for an old model.
- Loaded state, unload, CPU fallback and isolation diagnostics are consistent with chat's selected model and actual runtime. Mobile limits follow hardware/runtime detection rather than a fixed phone model-size rule.
- Keyboard labels, visible focus, 44-pixel touch controls, readable contrast and 390-pixel no-overflow layouts hold for all surfaces and error states.
- URLs with embedded credentials are rejected before persisting; queries containing secrets are not echoed in logs or exported. Model names and catalog metadata are rendered as text.

## Reference behavior

LM Studio documents [per-model defaults and pre-load configuration](https://lmstudio.ai/docs/app/advanced/per-model), [load/unload, context, GPU offload and memory estimation](https://lmstudio.ai/docs/cli/local-models/load), and [runtime-specific loading parameters](https://lmstudio.ai/docs/developer/rest/load). Kiln should match the clarity of these workflows while exposing only controls its own browser runtime can honor. Native filesystem and native GPU support cannot be inferred from a web browser setting.

## Verification record

Independent review requested and verified fixes for unsafe repository traversal, misleading requested-runtime success labels, import progress and cancellation, original-file removal, same filenames across folder roots, nested OPFS paths, and completed-transfer cards obscuring the installed library. The lead and implementation agents own the engineering gates and real inference results.

- `node --import tsx --test scripts/model-management.test.mjs`: five independent catalog tests pass, including bounded page size/query/sort/task, cursor host/path rejection, rate-limit/malformed schema handling, MXFP4 metadata and unsafe repository rejection. Fetch responses in these tests are mocks.
- `node --import tsx --test src/lib/model-runtime.test.ts`: seven runtime/parser tests pass, including genuine GGUF header inspection, bounded reads, unsupported/truncated versions, malicious 64-bit lengths, excessive metadata/arrays and nested arrays. Runtime planning tests establish configuration behavior; they do not prove inference hardware compatibility.
- `node scripts/models-qa.mjs`: 22 workflows pass on each of desktop 1280×900 and mobile 390×844 with no page errors or horizontal overflow. Imports use tiny valid GGUF headers for validation/storage, not executable model weights. Hosted catalog, pagination, errors and URL download responses are intercepted fixtures. Inference is not mocked or falsely claimed by this script.
- `node scripts/models-qa.mjs http://127.0.0.1:8081 --built`: all 13 UI workflows also pass on each desktop/mobile viewport against the production build. Nine source-module storage checks are explicitly skipped in production because the built application does not expose development module URLs; real UI storage and configuration persistence still execute. Results are in `screenshots/models-built-qa.json`.
- The UI checks exercise visible top-level import controls, multi-file success and invalid file, explicit load offers without automatic inference, auto-refresh, installed search, per-model settings, pagination/deduplication, quantization/size filters, rate-limit/empty states, credential URL rejection, URL download, retry after 503 and import cancellation without a saved record.
- Storage checks use **real browser IndexedDB and OPFS handles**, with a mocked directory picker and permission responses. They verify preexisting-folder indexing, rescan deduplication, identical filenames in distinct folder roots, default switching without moving old files, unregister without deleting originals, permission denial, missing files with retained records, nested OPFS read/delete and canceled scans. They do not prove a real Windows file-picker grant or every browser's permission persistence.
- Desktop/mobile installed screenshots were inspected together, then transfer card placement was refined following the independent review. Final production import-success screenshots were also inspected together: model selection/settings and installed filters are visible on mobile, import actions stay at the top, and completed imports no longer occupy the full library. Full details remain in `screenshots/models-qa.json`, `screenshots/models-built-*-import-success.png`, and installed/storage screenshots.

No paid API calls or public deployment were performed. Live gpt-oss 20B loading requires the user's actual GGUF and sufficient memory; a synthetic GGUF import is not evidence that this model loads or that a specific GPU supports it. Native filesystem dialogs, phone hardware and cross-origin embedded multithreading remain environment-specific live checks.
