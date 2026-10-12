# Verification record

The rebuild was reviewed by separate product/UX, multimodal, and architecture/security agents. The lead integrated their work and repeated the application checks. No public deployment or paid provider operation was performed.

## Engineering gates

- `npm test`: 271 passing tests, including existing platform tests, credential-free workspace export/import, persistence migration, history preservation, stream framing/errors, code-block HTML escaping, provider/vision/reasoning payloads, media protocols, DNS/address rejection, and native companion integration.
- `npm run typecheck`: passes.
- `npm run lint`: passes without warnings.
- `npm run build`: passes. Nitro emits its normal bundler warnings for dependency `use client` directives; no application build errors.
- Dev and built-output browser smoke: visible content on desktop 1280×800 and mobile 390×844, no console/page errors, no horizontal overflow, no branding/auth warnings. Built output is compared against the dev verdict, then screenshots are inspected.

The test runner was made portable: the old quoted shell glob silently ran zero script tests on Windows. PWA fixture tests now use an isolated temporary workspace, so the real Kiln name/card cannot contaminate generic platform assertions.

## Real, live checks

- Hugging Face public catalog and repository-file discovery returned actual models and byte sizes.
- `scripts/local-runtime-qa.mjs` downloaded a real SmolLM2-135M-Instruct Q4_K_M GGUF (105,454,432 bytes), cancelled/retried a download, loaded CPU-only mode, generated a response, interrupted generation, generated again, unloaded, and generated under the acceleration-requested profile. No uncaught page errors. The test removes its saved model afterward.
- CPU output answered the arithmetic question correctly with extra explanation. The small model's accelerated-profile answer was fluent but incomplete; this test establishes functioning inference and interruption, not answer-quality parity with hosted frontier models.
- Wllama exposes requested GPU settings and modality/template information, but not a reliable count of actually offloaded layers. Diagnostics say `webgpu-requested`, not proof of GPU utilization. No historical corruption was reproduced in these brief trials, so the old blanket attribution to GPUs was removed. Other GPUs, browsers, quantizations, phones, and sustained workloads remain unverified. A GPU loading error triggers CPU fallback; Saver selects CPU explicitly.
- Companion tests launch a real mock stdio process and exercise tool discovery/execution, wrong-origin/token rejection, unknown-method rejection, timeout/cancellation, and event-only logs. This is real process transport with a test MCP server, not a live third-party integration.
- An unauthenticated HTTPS request to OpenAI returned its expected 401 over the DNS-pinned relay helper. That establishes connectivity only; it does not verify model entitlement or generation.

## Browser workflows with mocked providers

`scripts/ui-qa.mjs` passes eleven workflows on each of desktop and mobile: rendering/navigation, all workspace panels, provider form/discovery/model selection, streamed replies, Markdown tables, branches, preserved regeneration, edit/resend, rename, archive/restore, and saved prompt insertion. Source code, parsing, UI state and persistence execute normally; hosted replies/model discovery are intercepted mocks.

`scripts/media-qa.mjs` passes fourteen workflows on each viewport: independent routing, image generation/edit reference bytes, previews/downloads, uploaded audio bytes, editable transcripts, voice selection and speech playback/download, interruption, async video create/status/content/settings, video reload/IndexedDB recovery, PDF text, DOCX text, actual browser-encoded WebM frame decoding/timestamps, retained image contents on follow-up, and microphone/transcript/review/send/reply speech. It also verifies cloud image creation/download while local chat is selected. Browser recording uses Chromium's fake microphone; provider results are mocked. The PDF/DOCX parsers and video decoder process real fixture files. A successful mock does not prove live media account access, billing, quality, or provider codecs.

`scripts/tool-chat-qa.mjs` checks the model-driven MCP loop: granted schemas only, streamed argument assembly, actual arguments, execution results returned to the next model turn, and processing states. Both model and remote server are mocked.

`scripts/oauth-qa.mjs` checks RFC 7636 PKCE, resource/issuer binding, state/issuer/expiry rejection, authorization redirect/callback exchange, code removal from history, and session-only token persistence. Authorization endpoints and tokens are mocked.

`scripts/security-qa.mjs` sends real requests to six application routes to verify cross-origin rejection and private/metadata/credential-bearing MCP URL rejection. It makes no paid request.

## Setup required for live provider workflows

Configure your own provider keys/endpoints and exact model IDs in Providers and Media. Local server providers require an installed/running LM Studio or Ollama and suitable CORS/network permissions. Remote OAuth requires a registered public client ID and exact `/mcp/callback` URI. Native MCP needs Node and an installed stdio MCP server configured in the Windows companion. Browser microphone and local-network permissions may be required.

## Remaining limits

- Media targets the OpenAI media protocol; Azure-specific or non-compatible vendor media endpoints need additional adapters.
- Video understanding samples up to six frames; continuous motion/audio perception is not implemented. Transcribe a separate audio track for spoken content.
- Browser GGUF imports do not load split files or multimodal projectors. Larger/native models can use a configured LM Studio/Ollama endpoint.
- OAuth has no refresh-token renewal, dynamic registration, or confidential-client secret flow. Reauthorize expired tokens.
- MCP implements tools; resources/prompts, sampling, and elicitation are unavailable. The companion is not a native-process sandbox or a bundled inference engine.
- Device data is not account-synced. Workspace exports include conversation text and embedded vision inputs, but not model files or generated-media blobs. Browser storage can be evicted. Credentials remembered on the same origin are not a secure server vault.
- Production file relay preflight is 4 MB because of hosting request limits; direct/local uploads allow 24 MB. Large generated audio/video uses bounded streaming. See [media setup](MEDIA.md).
- `npm audit` reports three moderate advisories from Mammoth's unused CLI `argparse/sprintf-js` chain. Browser processing uses raw-text extraction; no high/critical advisories remain.

Browser workflow checks use Playwright because `agent-browser` is not installed in this Windows environment. QA artifacts are generated under `screenshots/` and intentionally ignored by Git.

The fourteen media workflows were repeated successfully against the final production build on both viewports. Those checks wait for client hydration before interaction. The final production smoke has no divergence from dev, and the development server remains running.
