import type { Endpoint, ProviderKind, WireMessage } from "@/lib/types";
import { sseData } from "@/lib/sse";
import { reportedCapabilities } from "@/lib/provider-capabilities";
import type { Capability } from "@/lib/types";
const discoveredCapabilities = new Map<string, Record<string, Capability[]>>();
export function getDiscoveredCapabilities(endpointId: string, model: string): Capability[] | null {
  return discoveredCapabilities.get(endpointId)?.[model] ?? null;
}
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
      chatProfile: args.endpoint.chatProfile,
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
      redirect: "error",
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
  let full = "";
  for await (const data of sseData(response)) {
    const json = JSON.parse(data) as { t?: string; error?: string };
    if (json.error) throw new Error(json.error);
    if (json.t) {
      full += json.t;
      onDelta(full);
    }
  }
  return full;
}

export async function listRemoteModels(
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<string[]> {
  if (shouldDirect(endpoint)) {
    const request = buildModelsRequest(endpoint);
    let response: Response;
    try {
      response = await fetch(request.url, { headers: request.headers, signal, redirect: "error" });
    } catch {
      throw new Error(DIRECT_FAIL);
    }
    if (!response.ok) throw new Error(await errorText(response));
    const payload: unknown = await response.json();
    discoveredCapabilities.set(endpoint.id, reportedCapabilities(payload));
    return parseModelIds(payload);
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
  const json = (await response.json()) as {
    ids?: string[];
    error?: string;
    capabilities?: Record<string, Capability[]>;
  };
  if (!response.ok) throw new Error(json.error || "Could not list models.");
  discoveredCapabilities.set(endpoint.id, json.capabilities ?? {});
  return json.ids ?? [];
}

export function isAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "WllamaAbortError")
  );
}

export function kindNeedsKey(kind: ProviderKind): boolean {
  return kind !== "lmstudio" && kind !== "ollama" && kind !== "custom";
}
