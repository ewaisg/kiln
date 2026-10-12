import { useRef, useState } from "react";
import { callMcpTool, connectMcp, disconnectMcp, type McpToolInfo } from "@/lib/mcp";
import { useKiln } from "@/lib/store";
import { newId, type McpServer } from "@/lib/types";
import { startMcpOAuth } from "@/lib/mcp-oauth";

export function ToolsPanel({ onInsert }: { onInsert: (text: string) => void }) {
  const servers = useKiln((state) => state.mcpServers);
  const grants = useKiln((state) => state.toolGrants);
  const upsert = useKiln((state) => state.upsertMcp);
  const remove = useKiln((state) => state.removeMcp);
  const setGrant = useKiln((state) => state.setToolGrant);
  const [draft, setDraft] = useState<McpServer>({ id: "", name: "", url: "https://", token: "" });
  const [tools, setTools] = useState<Record<string, McpToolInfo[]>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const [args, setArgs] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const controller = useRef<AbortController | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const addLog = (event: string) => setLogs(current => [`${new Date().toLocaleTimeString()} · ${event}`, ...current].slice(0, 30));

  async function connect(server: McpServer) {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    setBusy(server.id);
    setStatus((current) => ({ ...current, [server.id]: "Connecting…" }));
    try {
      const result = await connectMcp(server, active.signal);
      addLog(`${server.name}: discovered ${result.tools.length} tools`);
      setTools((current) => ({ ...current, [server.id]: result.tools }));
      setStatus((current) => ({
        ...current,
        [server.id]: result.tools.length
          ? `Connected to ${result.label}. ${result.tools.length} tools. None run until you allow them.`
          : `Connected to ${result.label}. It published no tools.`,
      }));
    } catch (error) {
      setTools((current) => ({ ...current, [server.id]: [] }));
      setStatus((current) => ({
        ...current,
        [server.id]: error instanceof Error ? error.message : "Could not connect.",
      }));
    } finally {
      setBusy("");
    }
  }

  async function run(server: McpServer, tool: McpToolInfo) {
    const key = `${server.id}:${tool.name}`;
    if (!grants[key]) return;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(args[key]?.trim() || "{}");
    } catch {
      setOutput((current) => ({ ...current, [key]: "Arguments have to be JSON." }));
      return;
    }
    setBusy(key);
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    addLog(`${server.name}: ${tool.name} started`);
    setOutput((current) => ({ ...current, [key]: "Running…" }));
    try {
      const text = await callMcpTool(server, tool.name, parsed, active.signal);
      addLog(`${server.name}: ${tool.name} completed`);
      setOutput((current) => ({ ...current, [key]: text }));
    } catch (error) {
      setOutput((current) => ({ ...current, [key]: error instanceof Error ? error.message : "The tool failed." }));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Connect authenticated remote HTTP tools or a local Windows companion. Connect discovers the server's real
        tools. Explicitly allowed tools can run from conversations; leave sensitive tools disabled.
      </p>
      <details className="rounded-lg border border-line p-3 text-sm text-muted">
        <summary className="cursor-pointer font-medium">Windows local processes and connection security</summary>
        <p className="mt-2">Start the companion described in docs/desktop.md. Configure approved executable paths on disk,
          then enter http://127.0.0.1:4318/mcp/your-server and its pairing token below. Your exact site origin must be allowed.
          Remote servers support bearer tokens or public-client OAuth with PKCE.</p>
        <p className="mt-2">Tools may read or change data with your credentials. Grants apply to model-driven execution until
          revoked. Calls time out after 60 seconds. Tool results are treated as untrusted data.</p>
      </details>
      {busy ? <button type="button" className="press h-11 rounded-md border border-line px-3 text-sm" onClick={() => { controller.current?.abort(); addLog("Request cancelled"); }}>Cancel current request</button> : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          let parsed: URL;
          try {
            parsed = new URL(draft.url.trim());
          } catch {
            setStatus((current) => ({ ...current, draft: "Paste a full http or https URL." }));
            return;
          }
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            setStatus((current) => ({ ...current, draft: "Use an http or https URL." }));
            return;
          }
          if (draft.id) {
            disconnectMcp(draft.id);
            for (const key of Object.keys(grants)) if (key.startsWith(`${draft.id}:`)) setGrant(draft.id, key.slice(draft.id.length + 1), false);
            setTools(current => ({ ...current, [draft.id]: [] }));
          }
          upsert({
            id: draft.id || newId(),
            name: draft.name.trim() || parsed.host,
            url: parsed.toString(),
            token: draft.token,
            oauthClientId: draft.oauthClientId?.trim(),
          });
          setDraft({ id: "", name: "", url: "https://", token: "" });
          setStatus((current) => ({ ...current, draft: "" }));
        }}
      >
        <input
          aria-label="MCP server name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="Name"
          className="h-11 rounded-md border border-line bg-canvas px-3 text-base"
        />
        <input
          aria-label="MCP server URL"
          value={draft.url}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          placeholder="https://mcp.example.com/mcp"
          className="h-11 rounded-md border border-line bg-canvas px-3 text-base"
        />
        <input
          aria-label="MCP bearer token"
          value={draft.token}
          onChange={(event) => setDraft({ ...draft, token: event.target.value })}
          placeholder="Bearer token, if the server requires one"
          type="password"
          autoComplete="off"
          className="h-11 rounded-md border border-line bg-canvas px-3 text-base"
        />
        <label className="text-sm text-muted">OAuth public client ID (optional)
          <input aria-label="MCP OAuth client ID" value={draft.oauthClientId ?? ""} onChange={event => setDraft({ ...draft, oauthClientId: event.target.value })}
            placeholder="Client ID registered with your authorization server" className="mt-1 h-11 w-full rounded-md border border-line bg-canvas px-3 text-base" />
        </label>
        <p className="break-all text-xs text-faint">Register this redirect URL: {typeof window !== "undefined" ? `${window.location.origin}/mcp/callback` : "/mcp/callback"}. Use a public client with no client secret. Save the server, then Authorize. Expired tokens need authorization again.</p>
        <button type="submit" className="press h-11 rounded-md bg-accent text-sm font-medium text-accent-ink">
          Save server
        </button>
        {status.draft ? <p className="text-sm text-danger">{status.draft}</p> : null}
      </form>
      {servers.length === 0 ? <p className="text-sm text-faint">No MCP servers saved.</p> : null}
      {servers.map((server) => (
        <section key={server.id} className="rounded-lg border border-line px-3 py-3">
          <div className="font-medium">{server.name}</div>
          <p className="truncate text-xs text-faint">{server.url}</p>
          <p className="mt-1 text-xs text-faint">{server.token ? "Token saved in this browser." : "No token."}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="press h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink"
              disabled={busy === server.id}
              onClick={() => void connect(server)}
            >
              {busy === server.id ? "Connecting" : "Connect"}
            </button>
            <button type="button" className="press h-11 rounded-md px-3 text-sm text-danger" onClick={() => { disconnectMcp(server.id); remove(server.id); }}>
              Remove
            </button>
            <button type="button" className="press h-11 rounded-md px-3 text-sm" onClick={() => setDraft(server)}>Edit connection</button>
            {server.oauthClientId ? <button type="button" disabled={Boolean(busy)} className="press h-11 rounded-md border border-line px-3 text-sm" onClick={() => {
              setBusy(server.id); setStatus(current => ({ ...current, [server.id]: "Discovering secure authorization…" }));
              void startMcpOAuth(server).catch(error => { setStatus(current => ({ ...current, [server.id]: error instanceof Error ? error.message : "Authorization failed" })); setBusy(""); });
            }}>Authorize with OAuth</button> : null}
          </div>
          <p className={`mt-2 text-sm ${tone(status[server.id])}`}>{status[server.id] ?? "Not connected."}</p>
          {(tools[server.id] ?? []).map((tool) => {
            const key = `${server.id}:${tool.name}`;
            const allowed = Boolean(grants[key]);
            return (
              <div key={tool.name} className="mt-3 border-t border-line pt-3">
                <div className="font-mono text-sm">{tool.name}</div>
                {tool.description ? <p className="mt-1 text-sm text-muted">{tool.description}</p> : null}
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={allowed}
                    onChange={(event) => setGrant(server.id, tool.name, event.target.checked)}
                  />
                  Allow this tool in conversations and manual runs
                </label>
                {allowed ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <textarea
                      aria-label={`Arguments for ${tool.name}`}
                      value={args[key] ?? "{}"}
                      onChange={(event) => setArgs((current) => ({ ...current, [key]: event.target.value }))}
                      className="min-h-20 w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm"
                      spellCheck={false}
                    />
                    <p className="text-xs text-faint">Schema from the server. Edit the JSON above before running.</p>
                    <pre className="max-h-32 overflow-auto rounded-md bg-subtle px-3 py-2 font-mono text-xs">{tool.schema}</pre>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="press h-11 rounded-md bg-subtle px-3 text-sm"
                        disabled={busy === key}
                        onClick={() => void run(server, tool)}
                      >
                        {busy === key ? "Running" : "Run"}
                      </button>
                      {output[key] && output[key] !== "Running…" ? (
                        <button
                          type="button"
                          className="press h-11 rounded-md px-3 text-sm"
                          onClick={() => onInsert(`Tool ${tool.name} returned:\n${output[key]}`)}
                        >
                          Insert into message
                        </button>
                      ) : null}
                    </div>
                    {output[key] ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">{output[key]}</pre> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
      {logs.length ? <details className="rounded-lg border border-line p-3 text-sm"><summary className="cursor-pointer">Connection log</summary>
        <ol className="mt-2 space-y-1 text-xs text-muted">{logs.map((line, index) => <li key={index}>{line}</li>)}</ol>
      </details> : null}
    </div>
  );
}

function tone(line: string | undefined): string {
  if (!line || line === "Not connected." || line === "Connecting…" || line.startsWith("Connected")) return "text-muted";
  return "text-danger";
}
