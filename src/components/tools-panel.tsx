import { useState } from "react";
import { callMcpTool, connectMcp, type McpToolInfo } from "@/lib/mcp";
import { useKiln } from "@/lib/store";
import { newId, type McpServer } from "@/lib/types";

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

  async function connect(server: McpServer) {
    setBusy(server.id);
    setStatus((current) => ({ ...current, [server.id]: "Connecting…" }));
    try {
      const result = await connectMcp(server);
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
    setOutput((current) => ({ ...current, [key]: "Running…" }));
    try {
      const text = await callMcpTool(server, tool.name, parsed);
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
        Kiln does not start an MCP process on this device. Add a server that already speaks MCP over HTTP. Connect
        runs a real initialize handshake. A tool does nothing until you allow it, and it runs only when you press Run.
      </p>
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
          upsert({
            id: newId(),
            name: draft.name.trim() || parsed.host,
            url: parsed.toString(),
            token: draft.token,
          });
          setDraft({ id: "", name: "", url: "https://", token: "" });
          setStatus((current) => ({ ...current, draft: "" }));
        }}
      >
        <input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="Name"
          className="h-11 rounded-md border border-line bg-canvas px-3 text-base"
        />
        <input
          value={draft.url}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          placeholder="https://mcp.example.com/mcp"
          className="h-11 rounded-md border border-line bg-canvas px-3 text-base"
        />
        <input
          value={draft.token}
          onChange={(event) => setDraft({ ...draft, token: event.target.value })}
          placeholder="Bearer token, if the server requires one"
          type="password"
          autoComplete="off"
          className="h-11 rounded-md border border-line bg-canvas px-3 text-base"
        />
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
            <button type="button" className="press h-11 rounded-md px-3 text-sm text-danger" onClick={() => remove(server.id)}>
              Remove
            </button>
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
                  Allow this tool to run
                </label>
                {allowed ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <textarea
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
    </div>
  );
}

function tone(line: string | undefined): string {
  if (!line || line === "Not connected." || line === "Connecting…" || line.startsWith("Connected")) return "text-muted";
  return "text-danger";
}
