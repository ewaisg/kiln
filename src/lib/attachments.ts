import { newId, type Attachment } from "@/lib/types";

export type PreparedFile = {
  attachment: Attachment;
  text: string;
  image?: { mime: string; data: string };
  images?: { mime: string; data: string }[];
  source?: File;
  previewUrl?: string;
};
export type PrepareOptions = { signal?: AbortSignal; transcribe?: (file: File, signal?: AbortSignal) => Promise<string> };

const TEXT_EXT = new Set(["txt", "md", "json", "csv", "ts", "tsx", "js", "jsx", "py", "css", "html", "sql", "rs", "go", "yml", "yaml", "xml", "sh"]);

export function attachmentKind(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXT.has(ext) || file.type.startsWith("text/")) return "text";
  return "file";
}

export async function prepareFile(file: File, onProgress: (ratio: number) => void, options: PrepareOptions = {}): Promise<PreparedFile> {
  options.signal?.throwIfAborted();
  if (file.size > 24 * 1024 * 1024) throw new Error(`${file.name} exceeds the 24 MB attachment limit.`);
  const kind = attachmentKind(file);
  const id = newId();
  onProgress(0.2);
  if (kind === "image") {
    const image = await shrinkImage(file);
    onProgress(1);
    return {
      attachment: { id, name: file.name, kind, detail: "Image content prepared. Select a vision-capable provider to analyze it." },
      text: "",
      image,
      source: file,
    };
  }
  if (kind === "text") {
    const raw = await readSlice(file, 24_000, onProgress);
    return {
      attachment: { id, name: file.name, kind, detail: raw.length >= 24_000 ? "First 24,000 characters included." : "Text included in the message." },
      text: raw, source: file,
    };
  }
  if (kind === "audio") {
    if (!options.transcribe) throw new Error("Configure a transcription provider in Media before attaching audio.");
    const text = await options.transcribe(file, options.signal); onProgress(1);
    return { attachment: { id, name: file.name, kind, detail: "Transcript included; review the text before sending." }, text, source: file };
  }
  if (kind === "video") {
    const result = await extractVideoFrames(file, onProgress, options.signal);
    return { attachment: { id, name: file.name, kind, detail: "Sampled frames with timestamps included. Audio is not analyzed automatically." }, text: result.text, images: result.images, source: file };
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  let text = "";
  if (ext === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
    const loading = pdfjs.getDocument({ data: await file.arrayBuffer() });
    const document = await loading.promise;
    try { for (let page = 1; page <= Math.min(document.numPages, 100); page++) { options.signal?.throwIfAborted(); const content = await (await document.getPage(page)).getTextContent(); text += `\n[Page ${page}]\n` + content.items.map((item) => "str" in item ? item.str : "").join(" "); onProgress(page / document.numPages); if (text.length > 60_000) break; } }
    finally { await loading.destroy(); }
    if (!text.trim()) throw new Error("This PDF has no extractable text. Attach page images to a vision model instead.");
  } else if (ext === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); text = result.value;
  } else throw new Error(`Cannot extract ${file.name}. Use text, PDF, DOCX, image, audio, or video.`);
  onProgress(1);
  return { attachment: { id, name: file.name, kind, detail: text.length > 60_000 ? "First 60,000 extracted characters included." : "Document text extracted." }, text: text.slice(0, 60_000), source: file };
}

export function composeAttachmentText(items: PreparedFile[]): string {
  return items
    .map((item) => {
      if (item.text) return `\n\n<untrusted_attachment name=${JSON.stringify(item.attachment.name)}>\n${item.text}\n</untrusted_attachment>`;
      return `\n\n[Attached ${item.attachment.kind}: ${item.attachment.name}]`;
    })
    .join("");
}

export async function extractVideoFrames(file: File, onProgress: (ratio: number) => void, signal?: AbortSignal): Promise<{ images: { mime: string; data: string }[]; text: string }> {
  const video = document.createElement("video"); video.muted = true; video.preload = "auto";
  const url = URL.createObjectURL(file); video.src = url;
  function event(name: string) { return new Promise<void>((resolve, reject) => { const done = () => { clean(); resolve(); }; const failed = () => { clean(); reject(new Error("Could not decode this video. Try MP4/WebM supported by your browser.")); }; const aborted = () => { clean(); reject(new DOMException("Cancelled", "AbortError")); }; const timer = setTimeout(failed, 20_000); const clean = () => { clearTimeout(timer); video.removeEventListener(name, done); video.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted); }; video.addEventListener(name, done, { once: true }); video.addEventListener("error", failed, { once: true }); signal?.addEventListener("abort", aborted, { once: true }); }); }
  try {
    await event("loadeddata"); signal?.throwIfAborted();
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("This video has no readable duration.");
    const count = Math.min(6, Math.max(1, Math.ceil(video.duration / 10)));
    const canvas = document.createElement("canvas"); const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight)); canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Video frame extraction is unavailable.");
    const images: { mime: string; data: string }[] = []; const timestamps: string[] = [];
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted(); const time = Math.min(video.duration - 0.05, (index + 0.5) * video.duration / count); const waiting = event("seeked"); video.currentTime = Math.max(0.01, time); await waiting;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height); images.push({ mime: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.7).split(",")[1] }); timestamps.push(`Frame ${index + 1}: ${time.toFixed(1)} seconds`); onProgress((index + 1) / count);
    }
    return { images, text: `Video duration: ${video.duration.toFixed(1)} seconds. Sparse frame samples only; motion between samples and audio are not captured. Frame order/timestamps:\n${timestamps.join("\n")}` };
  } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

function readSlice(file: File, max: number, onProgress: (ratio: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      onProgress(1);
      resolve(String(reader.result ?? "").slice(0, max));
    };
    reader.readAsText(file.slice(0, max));
  });
}

function shrinkImage(file: File): Promise<{ mime: string; data: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 768 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      URL.revokeObjectURL(url);
      const data = dataUrl.split(",")[1] ?? "";
      if (data.length > 350_000) {
        reject(new Error("That image is still too large after shrinking."));
        return;
      }
      resolve({ mime: "image/jpeg", data });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}
