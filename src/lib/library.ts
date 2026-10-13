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
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains("workspace")) db.createObjectStore("workspace");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () =>
      reject(new Error("Close older Kiln tabs so the model library can upgrade safely."));
    request.onerror = () => {
      reject(request.error);
    };
  });
}

export async function listModels(): Promise<SavedModel[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => {
      const rows = (request.result as SavedModel[]).sort((a, b) => b.createdAt - a.createdAt);
      db.close();
      resolve(rows);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function saveModel(model: SavedModel): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(model);
    tx.oncomplete = () => {
      db.close();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("kiln-models-changed"));
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("The model record was not saved."));
    };
  });
}

export async function deleteModelRecord(id: string): Promise<void> {
  sessionFiles.delete(id);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("kiln-models-changed"));
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("The model record was not removed."));
    };
  });
}

export async function writeOpfs(
  name: string,
  file: File,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const reader = file.stream().getReader();
  let loaded = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const step = await reader.read();
      if (step.done) break;
      await writable.write(step.value);
      loaded += step.value.byteLength;
      if (file.size > 0) onProgress(loaded / file.size);
    }
    signal?.throwIfAborted();
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    await root.removeEntry(name).catch(() => undefined);
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readOpfs(name: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const handle = await modelFileHandle(root, name);
  return handle.getFile();
}

export async function deleteOpfs(name: string): Promise<void> {
  if (!name) return;
  try {
    const root = await navigator.storage.getDirectory();
    const parts = name.split("/");
    const file = parts.pop();
    if (!file || file === "." || file === ".." || file.includes("\\"))
      throw new Error("Invalid model path.");
    let parent = root;
    for (const part of parts) {
      if (!part || part === "." || part === ".." || part.includes("\\"))
        throw new Error("Invalid model path.");
      parent = await parent.getDirectoryHandle(part);
    }
    await parent.removeEntry(file);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

export async function fileForModel(model: SavedModel): Promise<Blob> {
  if (model.externalName) {
    const db = await openDb();
    const folder = model.folderKey
      ? await get<FileSystemDirectoryHandle>(db, HANDLES, `location:${model.folderKey}`)
      : ((await get<FileSystemDirectoryHandle>(db, HANDLES, `folder:${model.externalName}`)) ??
        (await rememberedFolder()));
    db.close();
    if (!folder)
      throw new Error("Choose the model folder again. Kiln no longer has permission to read it.");
    const allowed = await permit(folder, "read");
    if (!allowed) throw new Error("Kiln needs permission to read the model folder.");
    const handle = await modelFileHandle(folder, model.externalName);
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
    throw new Error(
      "This browser cannot pick a folder. Chrome or Edge on a computer can. The model still runs from browser storage.",
    );
  }
  const directory = await picker({ mode: "readwrite" });
  const handle = await directory.getFileHandle(
    `${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`,
    { create: true },
  );
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  return directory.name;
}

export async function rememberFolder(): Promise<string> {
  const picker = directoryPicker();
  if (!picker)
    throw new Error("This browser cannot pick a folder. Downloads stay in browser storage.");
  const directory = await picker({ mode: "readwrite" });
  const db = await openDb();
  // Pin legacy records to their original folder before changing the selection.
  const oldFolder = await rememberedFolder();
  if (oldFolder)
    for (const model of await listModels()) {
      if (model.externalName && !(await get(db, HANDLES, `folder:${model.externalName}`)))
        await put(db, HANDLES, `folder:${model.externalName}`, oldFolder);
    }
  await put(db, HANDLES, "model-folder", directory);
  const location = await registerModelFolder(directory);
  await put(db, HANDLES, "default-location", location.id);
  db.close();
  return directory.name;
}

export async function rememberedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb();
    const handle = await get<FileSystemDirectoryHandle>(db, HANDLES, "model-folder");
    db.close();
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
): Promise<{
  bytes: number;
  opfsName: string;
  externalName: string;
  where: string;
  folderKey?: string;
}> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Use a model URL without embedded credentials.");
  const db = await openDb();
  const checkpointKey = `download:${url}`;
  type Checkpoint = {
    opfsName: string;
    externalName: string;
    where: string;
    etag?: string;
    folder?: FileSystemDirectoryHandle;
  };
  const checkpoint = await get<Checkpoint>(db, HANDLES, checkpointKey);
  const folder = checkpoint?.folder ?? (await rememberedFolder());
  const useFolder = Boolean(folder && (await permit(folder, "readwrite")));
  if (folder && !useFolder)
    throw new Error(
      "Allow access to the selected folder or choose browser storage before downloading.",
    );
  if (checkpoint?.externalName && !useFolder)
    throw new Error("Choose or allow access to the original download folder to resume this model.");
  const uniqueName = `${crypto.randomUUID().slice(0, 8)}-${safeName(fileName)}`;
  const externalName = checkpoint?.externalName ?? (useFolder ? uniqueName : "");
  const opfsName = checkpoint?.opfsName ?? (useFolder ? "" : `${crypto.randomUUID()}.gguf`);
  const handle = useFolder
    ? await folder!.getFileHandle(externalName, { create: true })
    : await (await navigator.storage.getDirectory()).getFileHandle(opfsName, { create: true });
  const existing = await handle.getFile();
  const offset = checkpoint ? existing.size : 0;
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      headers:
        offset > 0
          ? {
              Range: `bytes=${offset}-`,
              ...(checkpoint?.etag ? { "If-Range": checkpoint.etag } : {}),
            }
          : {},
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("The download did not start. Check the link and try again.");
  }
  if (!response.ok || !response.body)
    throw new Error(
      response.ok ? "The download came back empty." : `Download failed (${response.status}).`,
    );
  const resumed = offset > 0 && response.status === 206;
  if (resumed && !response.headers.get("content-range")?.startsWith(`bytes ${offset}-`))
    throw new Error("The server returned an invalid resume range. Import the file manually.");
  const total = (Number(response.headers.get("content-length")) || 0) + (resumed ? offset : 0);
  if (!useFolder && total) {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && total - (resumed ? offset : 0) > estimate.quota - (estimate.usage ?? 0))
      throw new Error("Not enough browser storage. Choose a model folder or a smaller model.");
  }
  await put(db, HANDLES, checkpointKey, {
    opfsName,
    externalName,
    where: useFolder ? folder!.name : "browser storage",
    etag: response.headers.get("etag") ?? undefined,
    folder: useFolder ? folder! : undefined,
  } satisfies Checkpoint);
  if (externalName) await put(db, HANDLES, `folder:${externalName}`, folder);
  const writable = await handle.createWritable({ keepExistingData: resumed });
  if (resumed) await writable.seek(offset);
  const reader = response.body.getReader();
  let loaded = resumed ? offset : 0;
  let magic = resumed
    ? String.fromCharCode(...new Uint8Array(await existing.slice(0, 4).arrayBuffer()))
    : "";
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Download paused.", "AbortError");
      const step = await reader.read();
      if (step.done) break;
      if (magic.length < 4) magic += String.fromCharCode(...step.value.slice(0, 4 - magic.length));
      if (magic.length >= 4 && magic !== "GGUF")
        throw new Error("The download was not a GGUF file.");
      await writable.write(step.value);
      loaded += step.value.byteLength;
      onProgress(total > 0 ? Math.min(1, loaded / total) : null);
    }
    if (magic !== "GGUF") throw new Error("The download was not a GGUF file.");
    if (total && loaded !== total)
      throw new Error("The download was interrupted. Use the model again to resume.");
    await writable.close();
    await remove(db, HANDLES, checkpointKey);
  } catch (error) {
    // Commit partial bytes; retry uses Range when the host permits it.
    if (magic === "GGUF") await writable.close().catch(() => undefined);
    else {
      await writable.abort().catch(() => undefined);
      await remove(db, HANDLES, checkpointKey);
      if (opfsName) await deleteOpfs(opfsName);
    }
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    bytes: loaded,
    opfsName,
    externalName,
    where: useFolder ? folder!.name : "browser storage",
    folderKey: useFolder ? (await registerModelFolder(folder!)).id : undefined,
  };
}

export async function storeModelBlob(
  name: string,
  blob: Blob,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<{ opfsName: string; externalName: string; where: string; folderKey?: string }> {
  signal?.throwIfAborted();
  const folder = await rememberedFolder();
  if (folder && !(await permit(folder, "readwrite")))
    throw new Error(
      "Allow access to the selected folder or choose browser storage before importing.",
    );
  if (folder) {
    const fileName = `${crypto.randomUUID().slice(0, 8)}-${safeName(name)}`;
    const handle = await folder.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const reader = blob.stream().getReader();
    let copied = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        await writable.write(chunk.value);
        copied += chunk.value.byteLength;
        onProgress(blob.size ? copied / blob.size : 0);
      }
      signal?.throwIfAborted();
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      await folder.removeEntry(fileName).catch(() => undefined);
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    await put(await openDb(), HANDLES, `folder:${fileName}`, folder);
    const location = await registerModelFolder(folder);
    onProgress(1);
    return { opfsName: "", externalName: fileName, where: folder.name, folderKey: location.id };
  }
  const opfsName = `${crypto.randomUUID()}.gguf`;
  await writeOpfs(opfsName, new File([blob], safeName(name)), onProgress, signal);
  return { opfsName, externalName: "", where: "browser storage" };
}

function directoryPicker():
  ((options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>) | undefined {
  return (
    window as Window & {
      showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
}

async function permit(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite",
): Promise<boolean> {
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
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Storage write interrupted."));
  });
}

function remove(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function deleteStoredModel(model: SavedModel): Promise<void> {
  if (model.externalName) {
    const db = await openDb();
    const folder = model.folderKey
      ? await get<FileSystemDirectoryHandle>(db, HANDLES, `location:${model.folderKey}`)
      : ((await get<FileSystemDirectoryHandle>(db, HANDLES, `folder:${model.externalName}`)) ??
        (await rememberedFolder()));
    if (!folder || !(await permit(folder, "readwrite")))
      throw new Error("Allow access to the original model folder before deleting the file.");
    const parts = model.externalName.split("/");
    const filename = parts.pop()!;
    let parent = folder;
    for (const segment of parts) {
      if (!segment || segment === "." || segment === "..") throw new Error("Invalid model path.");
      parent = await parent.getDirectoryHandle(segment);
    }
    await parent.removeEntry(filename).catch((error: DOMException) => {
      if (error.name !== "NotFoundError") throw error;
    });
    await remove(db, HANDLES, `folder:${model.externalName}`);
  } else await deleteOpfs(model.opfsName);
  await deleteModelRecord(model.id);
}

function get<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export type ModelStorageLocation = {
  id: string;
  name: string;
  kind: "browser" | "folder";
  isDefault: boolean;
};
type FolderRecord = { id: string; name: string };
async function registerModelFolder(handle: FileSystemDirectoryHandle): Promise<FolderRecord> {
  const db = await openDb();
  try {
    const records = (await get<FolderRecord[]>(db, HANDLES, "model-locations")) ?? [];
    for (const record of records) {
      const existing = await get<FileSystemDirectoryHandle>(db, HANDLES, `location:${record.id}`);
      if (existing && (await existing.isSameEntry(handle).catch(() => false))) return record;
    }
    const record = { id: crypto.randomUUID(), name: handle.name };
    await put(db, HANDLES, `location:${record.id}`, handle);
    await put(db, HANDLES, "model-locations", [...records, record]);
    return record;
  } finally {
    db.close();
  }
}

/** Migrate existing folder handles without moving or copying any model file. */
export async function storageLocations(): Promise<ModelStorageLocation[]> {
  const db = await openDb();
  try {
    const current = await rememberedFolder();
    let defaultId = (await get<string>(db, HANDLES, "default-location")) ?? "browser";
    if (current && defaultId === "browser") {
      defaultId = (await registerModelFolder(current)).id;
      await put(db, HANDLES, "default-location", defaultId);
    }
    for (const model of await listModels()) {
      if (!model.externalName || model.folderKey) continue;
      const handle =
        (await get<FileSystemDirectoryHandle>(db, HANDLES, `folder:${model.externalName}`)) ??
        current;
      if (!handle) continue;
      const location = await registerModelFolder(handle);
      await saveModel({ ...model, folderKey: location.id });
    }
    const records = (await get<FolderRecord[]>(db, HANDLES, "model-locations")) ?? [];
    return [
      {
        id: "browser",
        name: "Browser storage",
        kind: "browser",
        isDefault: defaultId === "browser",
      },
      ...records.map((record) => ({
        ...record,
        kind: "folder" as const,
        isDefault: defaultId === record.id,
      })),
    ];
  } finally {
    db.close();
  }
}

async function switchToBrowserStorage(): Promise<void> {
  await storageLocations(); // pin legacy paths before changing the default
  const db = await openDb();
  try {
    await remove(db, HANDLES, "model-folder");
    await put(db, HANDLES, "default-location", "browser");
  } finally {
    db.close();
  }
}
export { switchToBrowserStorage as useBrowserStorage };

export async function setDefaultFolder(id: string): Promise<void> {
  if (id === "browser") return switchToBrowserStorage();
  await storageLocations();
  const db = await openDb();
  try {
    const handle = await get<FileSystemDirectoryHandle>(db, HANDLES, `location:${id}`);
    if (!handle || !(await permit(handle, "readwrite")))
      throw new Error("Allow access to this folder or choose it again.");
    await put(db, HANDLES, "model-folder", handle);
    await put(db, HANDLES, "default-location", id);
  } finally {
    db.close();
  }
}

async function modelFileHandle(
  folder: FileSystemDirectoryHandle,
  relative: string,
): Promise<FileSystemFileHandle> {
  const parts = relative.split("/");
  const name = parts.pop();
  if (!name || name === "." || name === ".." || name.includes("\\"))
    throw new Error("Invalid model path.");
  let directory = folder;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("\\"))
      throw new Error("Invalid model path.");
    directory = await directory.getDirectoryHandle(part);
  }
  return directory.getFileHandle(name);
}

/** Index existing files in a granted folder; linked originals are never copied. */
export async function scanModelFolder(
  id: string,
  onProgress?: (label: string, ratio?: number) => void,
  signal?: AbortSignal,
): Promise<SavedModel[]> {
  const db = await openDb();
  const added: SavedModel[] = [];
  let examined = 0,
    skipped = 0;
  try {
    const folder =
      id === "browser"
        ? await navigator.storage.getDirectory()
        : await get<FileSystemDirectoryHandle>(db, HANDLES, `location:${id}`);
    if (!folder || (id !== "browser" && !(await permit(folder, "read"))))
      throw new Error("Allow access to the folder before scanning it.");
    const installed = await listModels();
    const pendingNames = new Set<string>();
    const entries = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(HANDLES).objectStore(HANDLES).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const entry of entries)
      if (entry && typeof entry === "object" && "opfsName" in entry)
        pendingNames.add(String(entry.opfsName));
    const scan = async (
      directory: FileSystemDirectoryHandle,
      path = "",
      depth = 0,
    ): Promise<void> => {
      const iterator = directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      };
      if (!iterator.entries)
        throw new Error(
          "This browser cannot browse folders. Use Chrome or Edge, or import files directly.",
        );
      for await (const [name, handle] of iterator.entries()) {
        signal?.throwIfAborted();
        if (++examined > 2000)
          throw new Error(
            "Scan reached 2,000 entries. Choose a smaller folder; files already found remain indexed.",
          );
        const relative = `${path}${name}`;
        if (handle.kind === "directory") {
          if (depth < 4) await scan(handle as FileSystemDirectoryHandle, `${relative}/`, depth + 1);
          continue;
        }
        if (!/\.gguf$/i.test(name) || pendingNames.has(relative)) continue;
        if (/mmproj|projector|[-.]\d{5}-of-\d{5}/i.test(name)) {
          skipped++;
          continue;
        }
        if (
          installed.some((model) =>
            id === "browser"
              ? model.opfsName === relative
              : model.folderKey === id && model.externalName === relative,
          )
        )
          continue;
        onProgress?.(`Inspecting ${relative}`);
        const file = await (handle as FileSystemFileHandle).getFile();
        if (!(await isGguf(file))) {
          skipped++;
          continue;
        }
        let metadata: SavedModel["metadata"];
        try {
          metadata = await (await import("@/lib/gguf")).readGgufMetadata(file);
        } catch {
          skipped++;
          continue;
        }
        signal?.throwIfAborted();
        const model: SavedModel = {
          id: crypto.randomUUID(),
          name: name.replace(/\.gguf$/i, ""),
          kind: "file",
          repo: "",
          file: name,
          url: "",
          bytes: file.size,
          opfsName: id === "browser" ? relative : "",
          externalName: id === "browser" ? undefined : relative,
          folderKey: id === "browser" ? undefined : id,
          where: id === "browser" ? "browser storage" : folder.name,
          linked: id !== "browser",
          metadata,
          createdAt: Date.now(),
        };
        await saveModel(model);
        installed.push(model);
        added.push(model);
      }
    };
    await scan(folder);
    onProgress?.(
      `Scan complete: ${added.length} added${skipped ? `, ${skipped} invalid or unsupported files skipped` : ""}.`,
      1,
    );
    return added;
  } finally {
    db.close();
  }
}
