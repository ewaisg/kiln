import type { Endpoint } from "@/lib/types";
import { errorText } from "@/lib/wire";

export async function requestImage(
  endpoint: Endpoint,
  prompt: string,
  signal: AbortSignal,
): Promise<{ mime: string; data: string }> {
  const response = await fetch("/api/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: endpoint.kind,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      prompt,
    }),
    signal,
  });
  if (!response.ok) throw new Error(await errorText(response));
  const json = (await response.json()) as { mime?: string; data?: string };
  if (!json.mime || !json.data) throw new Error("The provider did not return an image.");
  return { mime: json.mime, data: json.data };
}

export function base64ToBlob(mime: string, data: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}
