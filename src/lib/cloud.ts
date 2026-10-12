import type { Endpoint, ProviderKind, WireMessage } from "@/lib/types";
import {
  buildChatRequest,
  buildModelsRequest,
  errorText,
  extractFull,
  parseModelIds,
  shouldDirect,
  tokensFromUpstream,
} from "@/lib/wire";

const DIRECT_FAIL =
  "The browser could not reach that endpoint. For LM Studio or Ollama, enable CORS and, from a phone, use the computer’s LAN address. For a cloud API, turn off “Call from this device”.";

export async function streamChat(args: {
  endpoint: Endpoint;
  messages: WireMessage[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  onDelta: (full: string) => void;
}): Promise<string> {
  if (shouldDirect(args.endpoint)) return streamDirect(args);
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: args.endpoint.kind,
      baseUrl: args.endpoint.baseUrl,
      apiKey: args.endpoint.apiKey,
      model: args.endpoint.model,
      apiVersion: args.endpoint.apiVersion,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      messages: args.messages,
    }),
    signal: args.signal,
  });
  return readRelay(response, args.onDelta);
}

async function streamDirect(args: {
  endpoint: Endpoint;
  messages: WireMessage[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  onDelta: (full: string) => void;
}): Promise<string> {
  const request = buildChatRequest(args.endpoint, args.messages, args.temperature, args.maxTokens);
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: args.signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error(DIRECT_FAIL);
  }
  if (!response.ok) throw new Error(await errorText(response));
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const full = extractFull(await response.json(), args.endpoint.kind);
    args.onDelta(full);
    return full;
  }
  let full = "";
  for await (const token of tokensFromUpstream(response, args.endpoint.kind)) {
    full += token;
    args.onDelta(full);
  }
  return full;
}

async function readRelay(response: Response, onDelta: (full: string) => void): Promise<string> {
  if (!response.ok) {
    throw new Error(await errorText(response));
  }
  if (!response.body) throw new Error("Empty response from the relay.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
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
      if (!data) continue;
      let json: { t?: string; error?: string };
      try {
        json = JSON.parse(data) as { t?: string; error?: string };
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error);
      if (json.t) {
        full += json.t;
        onDelta(full);
      }
    }
  }
  return full;
}

export async function listRemoteModels(endpoint: Endpoint, signal?: AbortSignal): Promise<string[]> {
  if (shouldDirect(endpoint)) {
    const request = buildModelsRequest(endpoint);
    let response: Response;
    try {
      response = await fetch(request.url, { headers: request.headers, signal });
    } catch {
      throw new Error(DIRECT_FAIL);
    }
    if (!response.ok) throw new Error(await errorText(response));
    return parseModelIds(await response.json());
  }
  const response = await fetch("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: endpoint.kind,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      apiVersion: endpoint.apiVersion,
    }),
    signal,
  });
  const json = (await response.json()) as { ids?: string[]; error?: string };
  if (!response.ok) throw new Error(json.error || "Could not list models.");
  return json.ids ?? [];
}

export function isAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "WllamaAbortError");
}

export function kindNeedsKey(kind: ProviderKind): boolean {
  return kind !== "lmstudio" && kind !== "ollama" && kind !== "custom";
}
