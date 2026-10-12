import { PRESETS, newId, type Endpoint } from "@/lib/types";

export type LoadState =
  | { phase: "idle" }
  | { phase: "loading"; label: string; ratio: number | null }
  | { phase: "ready"; name: string; note: string }
  | { phase: "error"; message: string };

export type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

export function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (/quota|not enough space|storage/i.test(message))
    return "Not enough free space on this device.";
  if (/out of memory|oom|aborted\(\)|memory access/i.test(message)) {
    return "This device ran out of memory. Try a smaller model and close other tabs.";
  }
  return message;
}

export function blankEndpoint(preset = PRESETS[0]): Endpoint {
  return {
    id: newId(),
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.model,
    apiVersion: preset.apiVersion,
    direct: preset.direct,
  };
}

export const fieldClass = "h-11 w-full rounded-md border border-line bg-canvas px-3 text-base";
