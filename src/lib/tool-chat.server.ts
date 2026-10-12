import { safeFetch } from "@/lib/relay-security.server";
import { assertRelayable, isProviderKind, errorText } from "@/lib/wire";

export async function relayToolChat(raw: string, signal: AbortSignal): Promise<Response> {
  if (raw.length > 4_000_000) throw new Error("Tool conversation is too large.");
  const input = JSON.parse(raw) as Record<string, unknown>;
  if (!isProviderKind(input.kind) || typeof input.baseUrl !== "string" || typeof input.model !== "string") throw new Error("Invalid tool provider.");
  const root = input.baseUrl.replace(/\/+$/, "").replace(/\/(chat\/completions|messages)$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = typeof input.apiKey === "string" ? input.apiKey.replace(/[\r\n]/g, "").slice(0, 500) : "";
  let url: string;
  if (input.kind === "anthropic") {
    headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01";
    url = `${root.endsWith("/v1") ? root : `${root}/v1`}/messages`;
  } else if (input.kind === "azure-openai") {
    headers["api-key"] = key;
    url = `${root.replace(/\/openai.*$/, "")}/openai/deployments/${encodeURIComponent(input.model)}/chat/completions?api-version=${encodeURIComponent(typeof input.apiVersion === "string" && input.apiVersion || "2024-10-21")}`;
  } else {
    if (input.kind === "azure-ai") headers["api-key"] = key;
    else if (key) headers.authorization = `Bearer ${key}`;
    url = `${root}/chat/completions`;
    if (input.kind === "azure-ai") url += `?api-version=${encodeURIComponent(typeof input.apiVersion === "string" && input.apiVersion || "2024-05-01-preview")}`;
  }
  if (!input.body || typeof input.body !== "object") throw new Error("Missing conversation.");
  const body = input.body as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length > 120 || !Array.isArray(body.tools) || body.tools.length > 64) throw new Error("Invalid tool conversation limits.");
  body.model = input.model; body.stream = true;
  if (body.max_completion_tokens !== undefined && input.kind !== "anthropic") { body.max_completion_tokens = Math.min(32768, Math.max(16, Number(body.max_completion_tokens) || 1600)); delete body.max_tokens; delete body.temperature; }
  else { body.max_tokens = Math.min(32768, Math.max(16, Number(body.max_tokens) || 1600)); body.temperature = Math.min(input.kind === "anthropic" ? 1 : 2, Math.max(0, Number(body.temperature) || 0)); }
  const upstream = await safeFetch(assertRelayable(url), { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!upstream.ok) throw new Error(await errorText(upstream));
  return new Response(upstream.body, { headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-store" } });
}
