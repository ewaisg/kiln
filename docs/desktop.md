# Windows companion

The web app handles conversations, browser-managed GGUF storage and cloud APIs. Local executable MCP servers need this separate Node.js 22+ companion. The existing browser shortcut installer is a window launcher, not a native inference runtime.

1. Run `node desktop/companion.mjs desktop/companion.config.json --init` once.
2. Edit the generated configuration. Set `allowedOrigins` to the exact Kiln site origin (including scheme and port). Add named servers with an absolute executable `command`, an `args` array, and optional `cwd` and `env`. On Windows prefer `node.exe` plus a script path rather than shell commands or `.cmd` launchers.
3. Run `powershell -File desktop/start-companion.ps1` and leave it running.
4. In Kiln's Tools settings add `http://127.0.0.1:4318/mcp/NAME` and paste the generated pairing token into the bearer-token field. Connect to discover tools. Explicitly allow only tools you trust; allowed tools may be invoked by the selected hosted chat model.

Example server entry: `"filesystem": { "command": "C:\\Program Files\\nodejs\\node.exe", "args": ["C:\\tools\\filesystem-mcp\\index.js", "D:\\Documents\\Allowed"] }`. Install and verify the chosen MCP server separately. Configuration contains secrets and is excluded from source control. Set permissions on it to your Windows account only. Do not add broad origins or expose the loopback port to your network.

The companion uses MCP JSON-lines stdio, never invokes a shell, and only launches commands predefined on disk. It checks the request Host, exact Origin and pairing token before execution. Calls time out, receive cancellation notifications, and expose content-free event logs through authenticated `/status`. It rejects sampling/elicitation requests. A server can still execute anything its Windows account can access: restrict its folders and credentials. MCP resources/prompts are not implemented; HTTP tools support bearer tokens and remote public-client OAuth PKCE.

For a remote OAuth MCP server, register a public client with its authorization server using `YOUR_KILN_ORIGIN/mcp/callback` as the exact redirect URL. Enter the public client ID in Tools, save, and choose Authorize with OAuth. Kiln discovers protected-resource and authorization-server metadata, requires S256, binds state/resource/issuer and exchanges the authorization code. No client secret is accepted. Tokens remain in the current browser session unless credential persistence is explicitly enabled. Token expiry requires authorization again; refresh tokens and dynamic client registration are not implemented. Servers requiring confidential clients need an independently secured gateway.

Browsers may require Local Network Access approval for loopback HTTP. Firefox/Safari or managed browsers may block it; use Edge/Chrome with the explicit site permission. A phone's loopback is the phone: this companion intentionally cannot be reached across your LAN. Use a properly secured remote MCP server for other devices. Native GPU inference can be configured as a separate LM Studio or Ollama provider; the companion does not bundle an inference engine.
