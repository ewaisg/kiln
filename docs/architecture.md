# Architecture review

Initial repository map, traced from implementation rather than prior descriptions:

| Boundary | Existing implementation | Rebuild direction |
| --- | --- | --- |
| App shell | React 19, TanStack Start/Router, Vite 8, Tailwind 4; one 1,800-line KilnApp | Focused workspace surfaces, responsive navigation, unified settings |
| Conversations/settings | Zustand `kiln-v1` localStorage; no account backend | Preserve storage key, migrate settings, preserve branches/history, redact exports |
| Model/media persistence | IndexedDB `kiln` v2 metadata/media/handles; GGUF OPFS or selected browser folder | Keep records and blobs; distinguish browser storage and folder permission |
| Browser inference | Wllama 3.8 WASM with permanently disabled GPU, fixed phone caps | Capability-aware profiles; honest WASM limits; native acceleration via external provider |
| Hosted inference | OpenAI-compatible and Anthropic adapters; direct local endpoints or stateless API relays | Explicit capability routing, streaming, errors, parameter validation |
| MCP | Initialize/list/manual call through HTTP only | Granted model-driven calls, cancellation, logs; native stdio companion |
| Multimodal | Text/image attachment input, hardcoded image models, browser speech only | Separate providers/defaults, actual media processing adapters |
| Deploy | Nitro Vercel preset; env wrapper, PWA branding/middleware; no application database migrations | Preserve platform hooks; supporting desktop service remains separate |
| Tests | Platform scaffolding tests; no chat/provider/MCP application tests | Workflow tests with provider mocks, native-process integration and browser verification |

Prioritized initial gaps:

1. **Security:** relay URL validation checked only literal host names, so public DNS could resolve privately. MCP and image fetches followed redirects. Keys and bearer tokens were persisted plaintext without an opt-out. Tool content lacked explicit trust boundaries. A portable configuration transfer workflow needed validation and secret redaction.
2. **Data loss:** creating/selecting mode dropped threads beyond 40; edit/regenerate truncated or replaced history. Images were only sent on the first turn; regeneration/history reconstructed role/text without image bytes. Folder model records depended on a single global selected-folder handle.
3. **Broken expectations:** audio/video attachments sent names only; no transcription, video pipeline or jobs. Image creation was tied to active chat provider. Windows installer created shortcuts, not a native runtime. MCP was manual-only.
4. **Inference reliability:** comments blamed GPUs without any recorded experiment. Hardware profiles guessed phone class from touch/screen and capped every device's output at 512/768. Repetition stop overwrote output with an error string, without diagnostics or generation cancellation.
5. **Product debt:** basic handwritten Markdown, no tables/math, limited settings/status, hardcoded four-entry model list, no resumable model downloads or authenticated connectors.

Security implementation in this rebuild: server-only `safeFetch` requires public HTTPS port 443, validates all resolved addresses and pins the chosen DNS address into the HTTPS socket lookup. Redirects are rejected so credentials cannot follow them. Requests are capped at 32 MB and expire after 180 seconds; consuming adapters apply response limits. MCP permits only explicitly granted tools, rechecks grants at call time, treats results as untrusted, times out and cancels requests. The Windows companion checks exact Origin/Host plus a pairing token, binds loopback, launches only disk-configured commands without a shell, and logs events without contents or secrets.

Remote MCP OAuth supports RFC 9728 protected-resource discovery, RFC 8414 authorization-server discovery and S256 PKCE using a registered public client ID. The callback binds exact state, resource, issuer and connection/client ID, removes the code from browser history, and never exports tokens. Refresh tokens and dynamic client registration are not implemented; expired tokens require authorization again. See [MCP authorization specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx).

Remaining platform boundaries: browser credentials are accessible to code running in the same origin, so encryption with an on-origin key is not a defense against XSS. Sensitive deployments need a trusted origin and an authenticated server vault. Confidential-client OAuth services require an independently secured gateway. Tools can exercise permissions of their service or Windows user; use narrowly scoped service keys and restricted folders. Local stdio servers are user-installed programs, not sandboxed by this companion.
