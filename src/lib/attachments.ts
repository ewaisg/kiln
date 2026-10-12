import { newId, type Attachment } from "@/lib/types";

export type PreparedFile = {
  attachment: Attachment;
  text: string;
  image?: { mime: string; data: string };
};

const TEXT_EXT = new Set(["txt", "md", "json", "csv", "ts", "tsx", "js", "jsx", "py", "css", "html", "sql", "rs", "go", "yml", "yaml", "xml", "sh"]);

export function attachmentKind(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXT.has(ext) || file.type.startsWith("text/")) return "text";
  return "file";
}

export async function prepareFile(file: File, onProgress: (ratio: number) => void): Promise<PreparedFile> {
  const kind = attachmentKind(file);
  const id = newId();
  onProgress(0.2);
  if (kind === "image") {
    const image = await shrinkImage(file);
    onProgress(1);
    return {
      attachment: { id, name: file.name, kind, detail: "Sent as a picture to providers that accept images. Local models only see the file name." },
      text: "",
      image,
    };
  }
  if (kind === "text") {
    const raw = await readSlice(file, 24_000, onProgress);
    return {
      attachment: { id, name: file.name, kind, detail: raw.length >= 24_000 ? "First 24,000 characters included." : "Text included in the message." },
      text: raw,
    };
  }
  onProgress(1);
  const detail =
    kind === "audio"
      ? "Not transcribed. The model only sees the file name."
      : kind === "video"
        ? "Not watched. The model only sees the file name."
        : "Binary file. The model only sees the file name.";
  return { attachment: { id, name: file.name, kind, detail }, text: "" };
}

export function composeAttachmentText(items: PreparedFile[]): string {
  return items
    .map((item) => {
      if (item.text) return `\n\n[${item.attachment.name}]\n${item.text}`;
      return `\n\n[${item.attachment.kind}: ${item.attachment.name}. ${item.attachment.detail}]`;
    })
    .join("");
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
