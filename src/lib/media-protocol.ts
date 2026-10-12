import type { Endpoint } from "./types";
export type MediaAction = "transcription" | "speech" | "image" | "video-create" | "video-status" | "video-content" | "video-delete";
export type VideoJob = { id: string; status: string; progress?: number; error?: { message?: string }; endpointId?: string; prompt?: string };
export type MediaOptions = { model: string; input?: string; voice?: string; size?: string; quality?: string; seconds?: string; jobId?: string };

export function buildMediaRequest(endpoint: Endpoint, action: MediaAction, options: MediaOptions, file?: File): { url: string; init: RequestInit } {
  if (!["openai", "custom", "lmstudio", "ollama", "grok"].includes(endpoint.kind)) throw new Error("This media adapter requires an OpenAI-compatible endpoint. Add a separate media provider.");
  const root = endpoint.baseUrl.replace(/\/+$/, "").replace(/\/(chat\/completions|images\/generations)$/i, "");
  const headers: Record<string, string> = endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey.replace(/[\r\n]/g, "").trim()}` } : {};
  const form = new FormData();
  const job = encodeURIComponent(options.jobId || "");
  let path = "";
  let body: BodyInit | undefined;
  let method = "POST";
  if (action === "transcription") {
    if (!file) throw new Error("Select an audio file first.");
    path = "audio/transcriptions"; form.set("model", options.model); form.set("file", file); form.set("response_format", "json"); body = form;
  } else if (action === "speech") {
    if (!options.input?.trim()) throw new Error("Enter text to read aloud.");
    path = "audio/speech"; headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model: options.model, input: options.input.slice(0, 4096), voice: options.voice || "alloy", response_format: "mp3" });
  } else if (action === "image") {
    if (!options.input?.trim()) throw new Error("Describe the image first.");
    const payload = { model: options.model, prompt: options.input.slice(0, 8000), n: 1, ...(options.size ? { size: options.size } : {}), ...(options.quality ? { quality: options.quality } : {}) };
    path = file ? "images/edits" : "images/generations";
    if (file) { Object.entries(payload).forEach(([key, value]) => form.set(key, String(value))); form.set("image[]", file); body = form; }
    else { headers["Content-Type"] = "application/json"; body = JSON.stringify(payload); }
  } else if (action === "video-create") {
    if (!options.input?.trim() || !options.model.trim()) throw new Error("Enter a video model and prompt.");
    path = "videos"; form.set("model", options.model); form.set("prompt", options.input.slice(0, 8000)); form.set("size", options.size || "1280x720"); form.set("seconds", options.seconds || "4");
    if (file) form.set("input_reference", file); body = form;
  } else {
    if (!options.jobId || !/^[\w-]{1,200}$/.test(options.jobId)) throw new Error("Invalid video job ID.");
    path = `videos/${job}${action === "video-content" ? "/content" : ""}`; method = action === "video-delete" ? "DELETE" : "GET";
  }
  return { url: `${root}/${path}`, init: { method, headers, body, redirect: "error" } };
}


