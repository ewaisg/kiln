import type { CatalogItem } from "@/lib/types";

const API = "https://huggingface.co/api/models";
const cache = new Map<string, CatalogItem[]>();
type HubModel = {
  id: string;
  downloads?: number;
  gated?: boolean;
  siblings?: { rfilename: string; size?: number; lfs?: { size?: number } }[];
};

export function modelSize(bytes: number): string {
  return bytes
    ? bytes >= 1e9
      ? `${(bytes / 1e9).toFixed(2)} GB`
      : `${Math.round(bytes / 1e6)} MB`
    : "Size available after inspection";
}
export function parseCatalogFiles(
  repo: string,
  rows: NonNullable<HubModel["siblings"]>,
): CatalogItem[] {
  return rows
    .filter((row) => /\.gguf$/i.test(row.rfilename))
    .map((row) => {
      const file = row.rfilename;
      const bytes = row.lfs?.size ?? row.size ?? 0;
      const quantization =
        file.match(/(?:IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|BF16|F16|F32)(?=\.|-)/i)?.[0] ?? "Unspecified";
      const compatible = !/mmproj|vision|projector|\d{5}-of-\d{5}/i.test(file);
      return {
        id: `${repo}/${file}`,
        name: file.replace(/\.gguf$/i, ""),
        repo,
        file,
        bytes,
        size: modelSize(bytes),
        format: "GGUF",
        quantization,
        memory: bytes
          ? `≈ ${((bytes * 1.25 + 512e6) / 1e9).toFixed(1)} GB RAM + context`
          : "RAM depends on file and context",
        compatible,
        blurb: compatible
          ? "GGUF candidate · architecture compatibility checked when loading"
          : "Requires a projector or split model loader; not supported by this importer",
      };
    })
    .sort((a, b) => a.bytes - b.bytes);
}
export async function catalogFiles(repo: string, signal?: AbortSignal): Promise<CatalogItem[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid model repository.");
  if (cache.has(repo)) return cache.get(repo)!;
  const response = await fetch(`${API}/${repo}?blobs=true`, { signal });
  if (!response.ok)
    throw new Error(
      `Model inspection failed (${response.status}). Gated models require downloading with your Hugging Face account.`,
    );
  const model = (await response.json()) as HubModel;
  const files = parseCatalogFiles(repo, model.siblings ?? []);
  cache.set(repo, files);
  return files;
}
export async function searchCatalog(query = "", signal?: AbortSignal): Promise<CatalogItem[]> {
  const params = new URLSearchParams({
    filter: "gguf",
    search: query.trim(),
    sort: "downloads",
    direction: "-1",
    limit: "20",
  });
  const response = await fetch(`${API}?${params}`, { signal });
  if (!response.ok)
    throw new Error(
      `Hugging Face catalog unavailable (${response.status}). You can still import a downloaded GGUF file.`,
    );
  const models = (await response.json()) as HubModel[];
  if (!Array.isArray(models)) throw new Error("Unexpected model catalog response.");
  return models.map((model) => ({
    id: model.id,
    name: model.id.split("/").pop() ?? model.id,
    repo: model.id,
    file: "",
    bytes: 0,
    size: "Inspect available files",
    blurb: `${model.id} · ${(model.downloads ?? 0).toLocaleString()} downloads${model.gated ? " · gated" : ""}`,
    format: "GGUF",
  }));
}
