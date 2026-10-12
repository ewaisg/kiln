import { assertRelayable } from "@/lib/wire";

const OPENAI_MODEL = "gpt-image-1";
const GROK_MODEL = "grok-imagine-image-2.0";

export async function relayImage(raw: string, signal: AbortSignal): Promise<Response> {
  if (raw.length > 20_000) throw new Error("That request is too large.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Invalid request.");
  }
  if (!json || typeof json !== "object") throw new Error("Invalid request.");
  const body = json as { kind?: unknown; baseUrl?: unknown; apiKey?: unknown; prompt?: unknown };
  if (body.kind !== "openai" && body.kind !== "grok") {
    throw new Error("Picture generation is available on a saved OpenAI or Grok endpoint.");
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length < 2) throw new Error("Describe the picture first.");
  if (typeof body.baseUrl !== "string" || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
    throw new Error("Save an API key on that endpoint first.");
  }
  const root = body.baseUrl.replace(/\/+$/, "").replace(/\/images\/generations$/i, "").replace(/\/v1$/i, "");
  const url = assertRelayable(`${root}/v1/images/generations`);
  const model = body.kind === "grok" ? GROK_MODEL : OPENAI_MODEL;
  const prompt = body.prompt.trim().slice(0, 2000);
  const first = await postImage(url, body.apiKey.trim(), { model, prompt, n: 1, response_format: "b64_json" }, signal);
  const image = first.ok ? await readImage(first.response, signal) : null;
  if (image) return Response.json(image);
  if (!first.ok && first.status !== 400) throw new Error(first.message);
  const second = await postImage(url, body.apiKey.trim(), { model, prompt, n: 1 }, signal);
  if (!second.ok) throw new Error(second.message || (!first.ok ? first.message : "The provider did not return an image."));
  const fallback = await readImage(second.response, signal);
  if (!fallback) throw new Error("The provider did not return an image.");
  return Response.json(fallback);
}

async function postImage(
  url: URL,
  apiKey: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ ok: true; response: Response } | { ok: false; status: number; message: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (response.ok) return { ok: true, response };
  const message = (await response.text()).slice(0, 400) || `Image request failed (${response.status}).`;
  return { ok: false, status: response.status, message };
}

async function readImage(response: Response, signal: AbortSignal): Promise<{ mime: string; data: string } | null> {
  const json = (await response.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (!item) return null;
  if (typeof item.b64_json === "string" && item.b64_json) {
    const packed = item.b64_json.startsWith("data:") ? item.b64_json.split(",")[1] ?? "" : item.b64_json;
    if (packed.length < 32 || packed.length > 8_000_000) throw new Error("The image came back in an unexpected size.");
    return { mime: "image/png", data: packed };
  }
  if (typeof item.url === "string" && item.url) {
    const fileUrl = assertRelayable(item.url);
    const file = await fetch(fileUrl, { signal });
    if (!file.ok) throw new Error("The image link could not be fetched.");
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength < 32 || buffer.byteLength > 8_000_000) throw new Error("The image came back in an unexpected size.");
    const mime = (file.headers.get("content-type") ?? "image/png").split(";")[0];
    return { mime: mime.startsWith("image/") ? mime : "image/png", data: Buffer.from(buffer).toString("base64") };
  }
  return null;
}
