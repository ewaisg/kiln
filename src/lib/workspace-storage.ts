import type { StateStorage } from "zustand/middleware";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kiln", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("models"))
        db.createObjectStore("models", { keyPath: "id" });
      for (const name of ["media", "handles", "workspace"])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () =>
      reject(
        new Error("Close older Kiln tabs so the saved workspace can upgrade safely, then reload."),
      );
    request.onerror = () => reject(request.error);
  });
}
let writes: Promise<void> = Promise.resolve();
export const workspaceStorage: StateStorage = {
  async getItem(name) {
    const db = await database();
    try {
      const value = await new Promise<string | undefined>((resolve, reject) => {
        const request = db.transaction("workspace").objectStore("workspace").get(name);
        request.onsuccess = () => resolve(request.result as string | undefined);
        request.onerror = () => reject(request.error);
      });
      // First hydration consumes the existing v1 data without changing any IDs.
      return value ?? localStorage.getItem(name);
    } finally {
      db.close();
    }
  },
  setItem(name, value) {
    const operation = writes
      .catch(() => undefined)
      .then(async () => {
        const db = await database();
        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction("workspace", "readwrite");
            transaction.objectStore("workspace").put(value, name);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () =>
              reject(transaction.error ?? new Error("Workspace storage interrupted."));
          });
          // Only remove the legacy copy after durable IndexedDB commit.
          localStorage.removeItem(name);
        } catch (error) {
          window.dispatchEvent(
            new CustomEvent("kiln-storage-error", {
              detail:
                "Your latest changes could not be saved. Export the workspace before closing this page.",
            }),
          );
          throw error;
        } finally {
          db.close();
        }
      });
    writes = operation;
    // The visible storage error is actionable; avoid an unhandled promise from persist.
    return operation.catch(() => undefined);
  },
  async removeItem(name) {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("workspace", "readwrite");
        transaction.objectStore("workspace").delete(name);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      localStorage.removeItem(name);
    } finally {
      db.close();
    }
  },
};
