import type { ProviderKind, WireMessage } from "@/lib/types";
import { safeFetch } from "@/lib/relay-security.server";
import { reportedCapabilities } from "@/lib/provider-capabilities";
import {
  assertRelayable,
  buildChatRequest,
  buildModelsRequest,
  errorText,
  extractFull,
  isProviderKind,
  parseModelIds,
  shouldDirect,
  tokensFromUpstream,
  type UpstreamRequest,
} from "@/lib/wire";

export type RelayChatBody = {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiVersion: string;
  temperature: number;
  maxTokens: number;
  messages: WireMessage[];
  chatProfile?: "auto" | "standard" | "reasoning";
};

export function readChatBody(raw: string): RelayChatBody {
  if (raw.length > 16_000_000) throw new Error("That conversation exceeds 16 MB. Start a branch with fewer images.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Invalid request.");
  }
  if (!json || typeof json !== "object") throw new Error("Invalid request.");
  const body = json as Record<string, unknown>;
  if (!isProviderKind(body.kind)) throw new Error("Unknown provider.");
  if (typeof body.baseUrl !== "string" || typeof body.model !== "string") throw new Error("Missing endpoint.");
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const apiVersion = typeof body.apiVersion === "string" ? body.apiVersion : "";
  const temperature = clamp(body.temperature, 0, 2, 0.4);
  const maxTokens = Math.round(clamp(body.maxTokens, 16, 32768, 1600));
  if (!Array.isArray(body.messages)) throw new Error("Missing messages.");
  const messages: WireMessage[] = [];
  if (body.messages.length > 128) throw new Error("The context exceeds 128 messages. Start a new conversation or shorten the context.");
  for (const item of body.messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as { role?: unknown; content?: unknown; images?: unknown };
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string") continue;
    if (Array.isArray(message.images) && message.images.length > 24) throw new Error("A message supports up to 24 images or sampled frames.");
    const images = Array.isArray(message.images)
      ? message.images
          .map((image) => {
            if (!image || typeof image !== "object") return null;
            const row = image as { mime?: unknown; data?: unknown };
            if (row.mime !== "image/jpeg" && row.mime !== "image/png" && row.mime !== "image/webp") return null;
            if (typeof row.data !== "string" || row.data.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.data)) throw new Error("An image is invalid or exceeds the supported size. Reattach it to resize.");
            return { mime: row.mime, data: row.data };
          })
          .filter((image): image is { mime: string; data: string } => image !== null)
      : undefined;
    messages.push({ role: message.role, content: message.content.slice(0, 100_000), images });
  }
  if (!messages.some((message) => message.role === "user")) throw new Error("Write a message first.");
  return {
    kind: body.kind,
    baseUrl: body.baseUrl.slice(0, 500),
    apiKey: apiKey.slice(0, 500),
    model: body.model.slice(0, 200),
    apiVersion: apiVersion.slice(0, 40),
    temperature,
    maxTokens,
    messages,
    chatProfile: body.chatProfile === "reasoning" || body.chatProfile === "standard" ? body.chatProfile : "auto",
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function relayChat(payload: RelayChatBody, signal: AbortSignal): Promise<Response> {
  const endpoint = {
    id: "relay",
    name: "relay",
    kind: payload.kind,
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    model: payload.model,
    apiVersion: payload.apiVersion,
    direct: false,
    chatProfile: payload.chatProfile,
  };
  if (shouldDirect(endpoint)) {
    return Response.json(
      { error: "That endpoint is local or private. Kiln calls it from this device, not through the relay." },
      { status: 400 },
    );
  }
  const request = buildChatRequest(endpoint, payload.messages, payload.temperature, payload.maxTokens);
  assertRelayable(request.url);
  return pipeUpstream(request, payload.kind, signal);
}

export async function relayModels(raw: string, signal: AbortSignal): Promise<Response> {
  const payload = readChatBody(JSON.stringify({ ...(JSON.parse(raw) as object), messages: [{ role: "user", content: "ok" }], temperature: 0, maxTokens: 16 }));
  const endpoint = {
    id: "relay",
    name: "relay",
    kind: payload.kind,
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    model: payload.model,
    apiVersion: payload.apiVersion,
    direct: false,
  };
  if (shouldDirect(endpoint)) {
    return Response.json({ error: "List models for this endpoint from the device directly." }, { status: 400 });
  }
  const request = buildModelsRequest(endpoint);
  assertRelayable(request.url);
  let upstream: Response;
  try {
    upstream = await safeFetch(request.url, { headers: request.headers, signal, redirect: "manual" });
  } catch {
    return Response.json({ error: "Could not reach that endpoint." }, { status: 502 });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return Response.json({ error: "The endpoint redirected. Refusing to follow it." }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: await errorText(upstream) }, { status: 502 });
  const models: unknown = await upstream.json();
  const ids = parseModelIds(models);
  return Response.json({ ids, capabilities: reportedCapabilities(models) });
}

async function pipeUpstream(request: UpstreamRequest, kind: ProviderKind, signal: AbortSignal): Promise<Response> {
  const cancellation = new AbortController();
  signal = AbortSignal.any([signal, cancellation.signal]);
  let upstream: Response;
  try {
    upstream = await safeFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
      redirect: "manual",
    });
  } catch {
    return Response.json({ error: "Could not reach that endpoint." }, { status: 502 });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return Response.json({ error: "The endpoint redirected. Refusing to follow it." }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: await errorText(upstream) }, { status: 502 });
  const type = upstream.headers.get("content-type") ?? "";
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      try {
        if (type.includes("application/json")) {
          send({ t: extractFull(await upstream.json(), kind) });
        } else {
          for await (const token of tokensFromUpstream(upstream, kind)) send({ t: token });
        }
        send({ done: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The provider closed the stream.";
        send({ error: message.slice(0, 500) });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; cancellation.abort(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
