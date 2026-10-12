import { assertRelayable } from "@/lib/wire";
import { parseRpc, readMcpResponse } from "@/lib/mcp";
import { safeFetch } from "@/lib/relay-security.server";

export async function relayMcp(raw: string, signal: AbortSignal): Promise<Response> {
  if (raw.length > 200_000) throw new Error("That MCP request is too large.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Invalid request.");
  }
  if (!json || typeof json !== "object") throw new Error("Invalid request.");
  const body = json as { url?: unknown; token?: unknown; sessionId?: unknown; rpc?: unknown };
  if (typeof body.url !== "string" || !body.rpc || typeof body.rpc !== "object") throw new Error("Missing MCP request.");
  const url = assertRelayable(body.url);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
  };
  if (typeof body.token === "string" && body.token.trim()) {
    if (body.token.length > 8192 || /[\r\n]/.test(body.token)) throw new Error("Invalid MCP bearer token.");
    headers.authorization = `Bearer ${body.token.trim()}`;
  }
  if (typeof body.sessionId === "string" && body.sessionId.trim()) headers["mcp-session-id"] = body.sessionId.trim().slice(0, 200);
  const response = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body.rpc), signal });
  const text = await readMcpResponse(response);
  if (text.length > 1_000_000) throw new Error("The MCP server response is too large.");
  const payload = parseRpc(text);
  return Response.json({
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? "",
    payload,
    raw: payload ? undefined : text.slice(0, 2000),
  });
}
