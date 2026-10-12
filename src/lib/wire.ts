import { presetByKind, type Endpoint, type ProviderKind, type WireMessage } from "@/lib/types";

const KINDS = new Set<string>([
  "grok",
  "openai",
  "anthropic",
  "azure-openai",
  "azure-ai",
  "lmstudio",
  "ollama",
  "custom",
]);

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && KINDS.has(value);
}

export function cleanLine(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

export function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(cleanLine(input));
  } catch {
    throw new Error("Enter a full URL, including https:// or http://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https endpoints are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Put the API key in the key field, not inside the URL.");
  }
  if (/^\d+$/.test(url.hostname)) {
    throw new Error("Use a hostname, not a raw numeric address.");
  }
  return url;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function shouldDirect(endpoint: Pick<Endpoint, "direct" | "baseUrl">): boolean {
  try {
    const url = parseHttpUrl(endpoint.baseUrl);
    if (endpoint.direct || url.protocol === "http:") return true;
    return isPrivateHost(url.hostname);
  } catch {
    return endpoint.direct;
  }
}

export function assertRelayable(input: string): URL {
  const url = parseHttpUrl(input);
  if (url.protocol !== "https:") {
    throw new Error("The relay only forwards public https endpoints. Local addresses are called from this device.");
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error("That address is private. Kiln calls it from this device instead.");
  }
  return url;
}

function rootUrl(base: string): string {
  return cleanLine(base)
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/messages$/i, "");
}

function openAiChatUrl(base: string): string {
  return `${rootUrl(base)}/chat/completions`;
}

function anthropicUrl(base: string): string {
  const trimmed = rootUrl(base);
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function azureOpenAiUrl(base: string, deployment: string, apiVersion: string): string {
  const trimmed = cleanLine(base)
    .replace(/\/+$/, "")
    .replace(/\/openai\/deployments\/.*$/i, "")
    .replace(/\/openai$/i, "");
  const version = apiVersion || "2024-10-21";
  return `${trimmed}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(version)}`;
}

function withVersion(url: string, apiVersion: string): string {
  const parsed = new URL(url);
  if (apiVersion && !parsed.searchParams.has("api-version")) {
    parsed.searchParams.set("api-version", apiVersion);
  }
  return parsed.toString();
}

function coalesce(messages: WireMessage[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content.trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === message.role) prev.content += `\n\n${content}`;
    else out.push({ role: message.role, content });
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: "Continue." });
  return out;
}

export type UpstreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export function buildChatRequest(
  endpoint: Endpoint,
  messages: WireMessage[],
  temperature: number,
  maxTokens: number,
): UpstreamRequest {
  const kind = endpoint.kind;
  const apiKey = cleanLine(endpoint.apiKey);
  const model = cleanLine(endpoint.model);
  const direct = shouldDirect(endpoint);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const temp = kind === "anthropic" ? Math.min(1, temperature) : temperature;

  if (kind === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    if (direct) headers["anthropic-dangerous-direct-browser-access"] = "true";
    const system = messages
      .filter((message) => message.role === "system" && message.content.trim())
      .map((message) => message.content.trim())
      .join("\n\n");
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature: temp,
      stream: true,
      messages: coalesce(messages),
    };
    if (system) body.system = system;
    return { url: anthropicUrl(endpoint.baseUrl), headers, body };
  }

  if (kind === "azure-openai" || kind === "azure-ai") {
    if (apiKey) headers["api-key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const chatMessages = messages
    .filter((message) => message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }));

  if (kind === "azure-openai") {
    const deployment = model || "deployment";
    return {
      url: azureOpenAiUrl(endpoint.baseUrl, deployment, endpoint.apiVersion),
      headers,
      body: {
        messages: chatMessages,
        temperature: temp,
        max_tokens: maxTokens,
        stream: true,
      },
    };
  }

  const url =
    kind === "azure-ai"
      ? withVersion(openAiChatUrl(endpoint.baseUrl), endpoint.apiVersion || "2024-05-01-preview")
      : openAiChatUrl(endpoint.baseUrl);

  return {
    url,
    headers,
    body: {
      model,
      messages: chatMessages,
      temperature: temp,
      max_tokens: maxTokens,
      stream: true,
    },
  };
}

export function buildModelsRequest(endpoint: Endpoint): { url: string; headers: Record<string, string> } {
  const apiKey = cleanLine(endpoint.apiKey);
  const headers: Record<string, string> = {};
  if (endpoint.kind === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    if (shouldDirect(endpoint)) headers["anthropic-dangerous-direct-browser-access"] = "true";
    const trimmed = rootUrl(endpoint.baseUrl);
    const url = trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
    return { url, headers };
  }
  if (endpoint.kind === "azure-openai" || endpoint.kind === "azure-ai") {
    if (apiKey) headers["api-key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (endpoint.kind === "azure-openai") {
    const trimmed = cleanLine(endpoint.baseUrl)
      .replace(/\/+$/, "")
      .replace(/\/openai\/deployments\/.*$/i, "")
      .replace(/\/openai$/i, "");
    const version = endpoint.apiVersion || "2024-10-21";
    return {
      url: `${trimmed}/openai/models?api-version=${encodeURIComponent(version)}`,
      headers,
    };
  }
  const url =
    endpoint.kind === "azure-ai"
      ? withVersion(`${rootUrl(endpoint.baseUrl)}/models`, endpoint.apiVersion || "2024-05-01-preview")
      : `${rootUrl(endpoint.baseUrl)}/models`;
  return { url, headers };
}

export function parseModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const record = json as { data?: unknown; models?: unknown };
  const rows = record.data ?? record.models;
  if (!Array.isArray(rows)) return [];
  const ids = rows
    .map((row) => {
      if (typeof row === "string") return row;
      if (!row || typeof row !== "object") return "";
      const item = row as { id?: unknown; name?: unknown };
      if (typeof item.id === "string") return item.id;
      if (typeof item.name === "string") return item.name.replace(/:latest$/, "");
      return "";
    })
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)].slice(0, 80);
}

export function fitMessages(messages: WireMessage[], maxChars: number): WireMessage[] {
  const system = messages.filter((message) => message.role === "system" && message.content.trim());
  const rest = messages.filter((message) => message.role !== "system" && message.content.trim());
  const kept: WireMessage[] = [];
  let used = system.reduce((total, message) => total + message.content.length, 0);
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const message = rest[index];
    if (!message) continue;
    if (kept.length > 0 && used + message.content.length > maxChars) break;
    kept.push(message);
    used += message.content.length;
  }
  kept.reverse();
  return [...system, ...kept];
}

export function openAiDelta(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const record = json as {
    error?: { message?: string };
    choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
  };
  if (record.error?.message) throw new Error(record.error.message);
  const choice = record.choices?.[0];
  return textOf(choice?.delta?.content) || textOf(choice?.message?.content);
}

export function anthropicDelta(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const record = json as {
    type?: string;
    delta?: { text?: string };
    error?: { message?: string };
    message?: { content?: unknown };
  };
  if (record.type === "error") throw new Error(record.error?.message || "The provider returned an error.");
  if (record.type === "content_block_delta" && record.delta?.text) return record.delta.text;
  return "";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

export function extractFull(json: unknown, kind: ProviderKind): string {
  if (kind === "anthropic") {
    if (!json || typeof json !== "object") return "";
    const content = (json as { content?: unknown; error?: { message?: string } }).content;
    const error = (json as { error?: { message?: string } }).error?.message;
    if (error) throw new Error(error);
    return textOf(content);
  }
  return openAiDelta(json);
}

export async function* tokensFromUpstream(response: Response, kind: ProviderKind): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pull = kind === "anthropic" ? anthropicDelta : openAiDelta;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const text = pull(json);
      if (text) yield text;
    }
  }
}

export async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof json.error === "string" && json.error) return json.error.slice(0, 500);
    if (json.error && typeof json.error === "object" && json.error.message) return json.error.message.slice(0, 500);
    if (json.message) return json.message.slice(0, 500);
  } catch {
    /* plain text */
  }
  const clipped = text.replace(/\s+/g, " ").trim().slice(0, 500);
  return clipped || `Request failed (${response.status}).`;
}

export function endpointLabel(endpoint: Endpoint | undefined, localName: string | null, activeId: string): string {
  if (activeId === "local") return localName ? `Local · ${localName}` : "Local model";
  if (!endpoint) return "No model";
  const preset = presetByKind(endpoint.kind);
  return `${endpoint.name || preset.name} · ${endpoint.model || "model"}`;
}
