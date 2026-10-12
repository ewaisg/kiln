import { assertRelayable } from "@/lib/wire";
import { parseRpc } from "@/lib/mcp";

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
  if (typeof body.token === "string" && body.token.trim()) headers.authorization = `Bearer ${body.token.trim().slice(0, 500)}`;
  if (typeof body.sessionId === "string" && body.sessionId.trim()) headers["mcp-session-id"] = body.sessionId.trim().slice(0, 200);
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body.rpc), signal });
  const text = await response.text();
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
