import type { Endpoint } from "@/lib/types";
import { errorText } from "@/lib/wire";
import { mediaRequest, configuredMedia, type MediaOptions } from "@/lib/media";

export async function requestImage(
  endpoint: Endpoint,
  prompt: string,
  signal: AbortSignal,
  options?: Partial<MediaOptions> & { reference?: File },
): Promise<{ mime: string; data: string }> {
  const configured = configuredMedia("image");
  const response = await mediaRequest(configured.endpoint || endpoint, "image", { model: options?.model || configured.model, input: prompt, size: options?.size, quality: options?.quality }, options?.reference, signal);
  if (!response.ok) throw new Error(await errorText(response));
  const json = (await response.json()) as { mime?: string; data?: string | { b64_json?: string }[] };
  const data = typeof json.data === "string" ? json.data : json.data?.[0]?.b64_json;
  if (!data) throw new Error("The provider did not return an embedded image. Use Media for URL-based image outputs.");
  return { mime: json.mime || "image/png", data };
}

export function base64ToBlob(mime: string, data: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}
