import type { SavedModel } from "@/lib/types";

const DB_NAME = "kiln";
const STORE = "models";

const sessionFiles = new Map<string, File>();

export function holdSessionFile(id: string, file: File) {
  sessionFiles.set(id, file);
}

export function sessionFile(id: string): File | undefined {
  return sessionFiles.get(id);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listModels(): Promise<SavedModel[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => {
      const rows = (request.result as SavedModel[]).sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveModel(model: SavedModel): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(model);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteModelRecord(id: string): Promise<void> {
  sessionFiles.delete(id);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function writeOpfs(name: string, file: File, onProgress: (ratio: number) => void): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const reader = file.stream().getReader();
  let loaded = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      await writable.write(step.value);
      loaded += step.value.byteLength;
      if (file.size > 0) onProgress(loaded / file.size);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

export async function readOpfs(name: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  return handle.getFile();
}

export async function deleteOpfs(name: string): Promise<void> {
  if (!name) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    /* already gone */
  }
}

export async function fileForModel(model: SavedModel): Promise<Blob> {
  const held = sessionFiles.get(model.id);
  if (held) return held;
  if (model.opfsName) return readOpfs(model.opfsName);
  throw new Error("That file is no longer on this device. Import it again.");
}

export function isGguf(file: File): Promise<boolean> {
  return file
    .slice(0, 4)
    .arrayBuffer()
    .then((buffer) => String.fromCharCode(...new Uint8Array(buffer)) === "GGUF");
}
