import { create } from "zustand";
import type { SavedModel } from "@/lib/types";
export type ModelTransfer = {
  id: string;
  name: string;
  phase: "working" | "done" | "error" | "paused" | "cancelled";
  detail: string;
  ratio: number | null;
  model?: SavedModel;
  url?: string;
  abort?: AbortController;
};
type TransferState = {
  rows: ModelTransfer[];
  setRows: (update: ModelTransfer[] | ((rows: ModelTransfer[]) => ModelTransfer[])) => void;
};
const KEY = "kiln-model-transfers-v1";
function recover(): ModelTransfer[] {
  if (typeof window === "undefined") return [];
  try {
    return recoverTransfers(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
export function recoverTransfers(text: string): ModelTransfer[] {
  try {
    const data = JSON.parse(text) as ModelTransfer[];
    if (!Array.isArray(data)) return [];
    return data
      .slice(0, 100)
      .filter(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          ["working", "paused", "done", "error", "cancelled"].includes(item.phase),
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        ratio: item.ratio,
        model: item.model,
        phase: item.phase === "working" ? "paused" : item.phase,
        detail:
          item.phase === "working"
            ? item.model
              ? "Interrupted when Kiln closed. Retry to resume the download where supported."
              : "Import interrupted. Select the source file again to retry."
            : item.detail,
      }));
  } catch {
    return [];
  }
}
export const useModelTransfers = create<TransferState>((set, get) => ({
  rows: recover(),
  setRows: (update) => {
    const rows = typeof update === "function" ? update(get().rows) : update;
    set({ rows });
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify(
          rows.slice(0, 100).map(({ id, name, phase, detail, ratio, model }) => ({
            id,
            name,
            phase,
            detail,
            ratio,
            model: model ? { ...model, url: "" } : undefined,
          })),
        ),
      );
    } catch {
      /* Storage full or unavailable: current transfers remain usable in memory. */
    }
  },
}));
