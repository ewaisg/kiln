import type { SavedModel } from "@/lib/types";

const DB_NAME = "kiln";
const STORE = "models";
const MEDIA = "media";
const HANDLES = "handles";

const sessionFiles = new Map<string, File>();

export function holdSessionFile(id: string, file: File) {
  sessionFiles.set(id, file);
}

export function sessionFile(id: string): File | undefined {
  return sessionFiles.get(id);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
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
  if (model.externalName) {
    const folder = await rememberedFolder();
    if (!folder) throw new Error("Choose the model folder again. Kiln no longer has permission to read it.");
    const allowed = await permit(folder, "read");
    if (!allowed) throw new Error("Kiln needs permission to read the model folder.");
    const handle = await folder.getFileHandle(model.externalName);
    return handle.getFile();
  }
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

export async function copyFileToFolder(file: File): Promise<string> {
  const picker = directoryPicker();
  if (!picker) {
    throw new Error("This browser cannot pick a folder. Chrome or Edge on a computer can. The model still runs from browser storage.");
  }
  const directory = await picker({ mode: "readwrite" });
  const handle = await directory.getFileHandle(safeName(file.name), { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  return directory.name;
}

export async function rememberFolder(): Promise<string> {
  const picker = directoryPicker();
  if (!picker) throw new Error("This browser cannot pick a folder. Downloads stay in browser storage.");
  const directory = await picker({ mode: "readwrite" });
  const db = await openDb();
  await put(db, HANDLES, "model-folder", directory);
  return directory.name;
}

export async function rememberedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb();
    const handle = await get<FileSystemDirectoryHandle>(db, HANDLES, "model-folder");
    return handle ?? null;
  } catch {
    return null;
  }
}

export async function folderLabel(): Promise<string> {
  const folder = await rememberedFolder();
  return folder?.name ?? "";
}

export async function saveMedia(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await put(db, MEDIA, id, blob);
}

export async function loadMedia(id: string): Promise<Blob | null> {
  const db = await openDb();
  return (await get<Blob>(db, MEDIA, id)) ?? null;
}

export async function downloadIntoStorage(
  url: string,
  fileName: string,
  signal: AbortSignal,
  onProgress: (ratio: number | null) => void,
): Promise<{ bytes: number; opfsName: string; externalName: string; where: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("The download did not start. Check the link and try again.");
  }
  if (!response.ok || !response.body) throw new Error(response.ok ? "The download came back empty." : `Download failed (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || 0;
  const folder = await rememberedFolder();
  const useFolder = Boolean(folder && (await permit(folder, "readwrite")));
  const externalName = useFolder ? safeName(fileName) : "";
  const opfsName = useFolder ? "" : `${crypto.randomUUID()}.gguf`;
  const handle = useFolder
    ? await folder!.getFileHandle(externalName, { create: true })
    : await (await navigator.storage.getDirectory()).getFileHandle(opfsName, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let loaded = 0;
  let magic = "";
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      if (magic.length < 4) magic += String.fromCharCode(...step.value.slice(0, 4 - magic.length));
      if (magic.length >= 4 && magic !== "GGUF") throw new Error("The download was not a GGUF file.");
      await writable.write(step.value);
      loaded += step.value.byteLength;
      onProgress(total > 0 ? Math.min(1, loaded / total) : null);
    }
    if (magic !== "GGUF") throw new Error("The download was not a GGUF file.");
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    if (opfsName) await deleteOpfs(opfsName);
    throw error;
  }
  return { bytes: loaded, opfsName, externalName, where: useFolder ? folder!.name : "browser storage" };
}

export async function storeModelBlob(
  name: string,
  blob: Blob,
  onProgress: (ratio: number) => void,
): Promise<{ opfsName: string; externalName: string; where: string }> {
  const folder = await rememberedFolder();
  if (folder && (await permit(folder, "readwrite"))) {
    const fileName = safeName(name);
    const handle = await folder.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    onProgress(1);
    return { opfsName: "", externalName: fileName, where: folder.name };
  }
  const opfsName = `${crypto.randomUUID()}.gguf`;
  await writeOpfs(opfsName, new File([blob], safeName(name)), onProgress);
  return { opfsName, externalName: "", where: "browser storage" };
}

function directoryPicker(): ((options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>) | undefined {
  return (window as Window & { showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
}

async function permit(handle: FileSystemDirectoryHandle, mode: "read" | "readwrite"): Promise<boolean> {
  const capable = handle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  };
  const query = await capable.queryPermission?.({ mode });
  if (query === "granted") return true;
  const asked = await capable.requestPermission?.({ mode });
  return asked === "granted";
}

function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() || "model.gguf";
  return base.replace(/[^\w.\- ()]+/g, "_").slice(0, 120);
}

function put(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readwrite").objectStore(store).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function get<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
