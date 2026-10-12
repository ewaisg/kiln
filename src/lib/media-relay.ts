import { buildMediaRequest, type MediaAction, type MediaOptions } from "@/lib/media-protocol";
import type { Endpoint } from "@/lib/types";
import { safeFetch } from "@/lib/relay-security.server";
import { errorText } from "@/lib/wire";

const ACTIONS = new Set<MediaAction>([
  "transcription",
  "speech",
  "image",
  "video-create",
  "video-status",
  "video-content",
  "video-delete",
]);
export async function relayMedia(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 26 * 1024 * 1024) throw new Error("Upload exceeds 24 MB.");
  // Content-Length is optional; enforce limits while consuming chunked uploads too.
  const uploadBytes = await boundedBytes(new Response(request.body), 26 * 1024 * 1024);
  const form = await new Response(uploadBytes, {
    headers: { "content-type": request.headers.get("content-type") || "" },
  }).formData();
  const action = String(form.get("action")) as MediaAction;
  if (!ACTIONS.has(action)) throw new Error("Unsupported media operation.");
  const endpoint = JSON.parse(String(form.get("endpoint"))) as Endpoint;
  const options = JSON.parse(String(form.get("options"))) as MediaOptions;
  if (
    !endpoint ||
    typeof endpoint.baseUrl !== "string" ||
    typeof endpoint.kind !== "string" ||
    typeof endpoint.apiKey !== "string"
  )
    throw new Error("Invalid provider configuration.");
  if (!options || typeof options.model !== "string") throw new Error("Invalid media settings.");
  for (const value of Object.values(options))
    if (value !== undefined && (typeof value !== "string" || value.length > 10_000))
      throw new Error("Invalid media setting.");
  const upload = form.get("file");
  const file = upload instanceof File ? upload : undefined;
  if (file && file.size > 24 * 1024 * 1024) throw new Error("Upload exceeds 24 MB.");
  const upstream = buildMediaRequest(endpoint, action, options, file);
  const response = await safeFetch(upstream.url, { ...upstream.init, signal: request.signal });
  if (!response.ok) {
    const message = await errorText(response);
    throw new Error(endpoint.apiKey ? message.replaceAll(endpoint.apiKey, "[redacted]") : message);
  }
  if (action === "image") {
    const json = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 17_000_000))) as {
      data?: { b64_json?: string; url?: string }[];
    };
    const item = json.data?.[0];
    if (item?.b64_json && item.b64_json.length <= 16_000_000)
      return Response.json({ mime: "image/png", data: item.b64_json });
    if (item?.url) {
      const image = await safeFetch(item.url, { signal: request.signal });
      if (!image.ok) throw new Error("Could not download the generated image.");
      const mime = image.headers.get("content-type")?.split(";")[0] || "";
      if (!/^image\/(png|jpeg|webp)$/.test(mime))
        throw new Error("Provider returned an unsupported image type.");
      return Response.json({
        mime,
        data: Buffer.from(await boundedBytes(image, 12 * 1024 * 1024)).toString("base64"),
      });
    }
    throw new Error("Provider returned no image.");
  }
  if (["speech", "video-content"].includes(action)) {
    const limit = action === "speech" ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit || !response.body)
      throw new Error("Provider output is empty or exceeds the supported download size.");
    const reader = response.body.getReader();
    let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          size += chunk.value.byteLength;
          if (size > limit) throw new Error("Provider output exceeds the supported download size.");
          controller.enqueue(chunk.value);
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": action === "speech" ? "audio/mpeg" : "video/mp4",
        "cache-control": "no-store",
      },
    });
  }
  const bytes = await boundedBytes(response, 2 * 1024 * 1024);
  return new Response(bytes, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function boundedBytes(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error("Provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("Provider output exceeds the supported download size.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
