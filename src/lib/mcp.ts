import { isPrivateHost, parseHttpUrl } from "@/lib/wire";
import type { McpServer } from "@/lib/types";

export type McpToolInfo = {
  name: string;
  description: string;
  schema: string;
};

type RelayResult = {
  ok: boolean;
  status: number;
  sessionId: string;
  payload: Rpc | null;
  raw?: string;
};

type Rpc = {
  error?: { message?: string };
  result?: {
    serverInfo?: { name?: string };
    tools?: { name?: string; description?: string; inputSchema?: unknown }[];
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
};

const sessions = new Map<string, string>();

export function sessionFor(serverId: string): string | null {
  return sessions.get(serverId) ?? null;
}

export async function connectMcp(server: McpServer): Promise<{ tools: McpToolInfo[]; label: string }> {
  const init = await rpc(server, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "Kiln", version: "1" },
    },
  });
  assertOk(init, "The server did not accept the connection.");
  if (init.sessionId) sessions.set(server.id, init.sessionId);
  await rpc(server, sessions.get(server.id) ?? null, { jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await rpc(server, sessions.get(server.id) ?? null, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assertOk(listed, "The server connected, but the tool list failed.");
  const tools = (listed.payload?.result?.tools ?? [])
    .filter((tool) => typeof tool.name === "string" && tool.name)
    .map((tool) => ({
      name: tool.name as string,
      description: typeof tool.description === "string" ? tool.description : "",
      schema: JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} }, null, 2),
    }));
  const label = listed.payload?.result?.serverInfo?.name || init.payload?.result?.serverInfo?.name || server.name;
  return { tools, label };
}

export async function callMcpTool(server: McpServer, name: string, args: unknown): Promise<string> {
  let session = sessions.get(server.id) ?? null;
  if (!session) {
    await connectMcp(server);
    session = sessions.get(server.id) ?? null;
  }
  const result = await rpc(server, session, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args ?? {} },
  });
  assertOk(result, "The tool call failed.");
  const content = result.payload?.result?.content ?? [];
  const text = content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  if (result.payload?.result?.isError) throw new Error(text || "The tool reported an error.");
  return text || JSON.stringify(result.payload?.result ?? {}, null, 2);
}

async function rpc(server: McpServer, sessionId: string | null, body: unknown): Promise<RelayResult> {
  const url = parseHttpUrl(server.url);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
  };
  if (server.token.trim()) headers.authorization = `Bearer ${server.token.trim()}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const direct = url.protocol === "http:" || isPrivateHost(url.hostname);
  if (direct) return rpcDirect(url.toString(), headers, body);
  const response = await fetch("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: url.toString(), token: server.token, sessionId, rpc: body }),
  });
  const json = (await response.json()) as RelayResult & { error?: string };
  if (!response.ok) throw new Error(json.error || "The MCP relay rejected that request.");
  if (json.sessionId) sessions.set(server.id, json.sessionId);
  return json;
}

async function rpcDirect(url: string, headers: Record<string, string>, body: unknown): Promise<RelayResult> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new Error(
      "This browser could not reach that MCP server. A local server has to allow this site in CORS. A public https server is relayed instead.",
    );
  }
  const text = await response.text();
  const payload = parseRpc(text);
  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? "",
    payload,
    raw: payload ? undefined : text.slice(0, 2000),
  };
}

function assertOk(result: RelayResult, fallback: string) {
  const message = result.payload?.error?.message || (!result.ok ? result.raw : "");
  if (result.payload?.error || !result.ok) throw new Error(message || `${fallback} (${result.status})`);
}

export function parseRpc(text: string): Rpc | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Rpc;
    } catch {
      return null;
    }
  }
  const blocks = trimmed
    .split(/\n\n/)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n"),
    )
    .filter(Boolean);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(blocks[index]) as Rpc;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
