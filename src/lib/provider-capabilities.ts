import type { Capability } from "@/lib/types";

export function reportedCapabilities(json: unknown): Record<string, Capability[]> {
  if (!json || typeof json !== "object") return {};
  const payload = json as { data?: unknown; models?: unknown };
  const rows = payload.data ?? payload.models;
  if (!Array.isArray(rows)) return {};
  const result: Record<string, Capability[]> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const model = row as {
      id?: unknown;
      name?: unknown;
      capabilities?: unknown;
      input_modalities?: unknown;
      output_modalities?: unknown;
      type?: unknown;
    };
    const id =
      typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
    if (!id) continue;
    const capabilities = new Set<Capability>();
    const raw = model.capabilities;
    const flags = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? Object.entries(raw)
            .filter(([, allowed]) => allowed === true)
            .map(([key]) => key)
        : [];
    const mapping: Record<string, Capability> = {
      chat: "chat",
      completion: "chat",
      vision: "vision",
      image: "image",
      image_generation: "image",
      transcription: "transcription",
      speech_to_text: "transcription",
      speech: "speech",
      text_to_speech: "speech",
      video: "video",
      video_generation: "video",
    };
    for (const flag of flags)
      if (typeof flag === "string" && mapping[flag]) capabilities.add(mapping[flag]);
    if (Array.isArray(model.input_modalities) && model.input_modalities.includes("image"))
      capabilities.add("vision");
    if (Array.isArray(model.output_modalities))
      for (const modality of model.output_modalities) {
        if (modality === "image") capabilities.add("image");
        if (modality === "audio") capabilities.add("speech");
        if (modality === "video") capabilities.add("video");
      }
    if (capabilities.size) result[id] = [...capabilities];
  }
  return result;
}
