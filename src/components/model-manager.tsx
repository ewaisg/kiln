import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  Search,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { catalogFiles, modelSize, searchCatalogPage } from "@/lib/catalog";
import {
  copyFileToFolder,
  deleteStoredModel,
  deleteModelRecord,
  downloadIntoStorage,
  fileForModel,
  isGguf,
  saveModel,
  scanModelFolder,
  setDefaultFolder,
  storageLocations,
  storeModelBlob,
  useBrowserStorage as switchToBrowserStorage,
} from "@/lib/library";
import { readGgufMetadata } from "@/lib/gguf";
import { useModelTransfers } from "@/lib/model-transfers";
import { getModelPreflight, localDiagnostics, planRuntime } from "@/lib/local-engine";
import { useKiln } from "@/lib/store";
import { newId, type CatalogItem, type SavedModel, type ModelConfig } from "@/lib/types";
import { explain, type LoadState } from "@/components/workspace-ui";
import "./model-manager.css";

type Props = {
  models: SavedModel[];
  activeId: string | null;
  load: LoadState;
  onUse: (model: SavedModel) => void;
  onChanged: () => void;
  onUnload: () => void;
  folder: string;
  onFolder: () => void;
  generationBusy?: boolean;
};
type Transfer = {
  id: string;
  name: string;
  phase: "working" | "done" | "error" | "paused" | "cancelled";
  detail: string;
  ratio: number | null;
  model?: SavedModel;
  url?: string;
  abort?: AbortController;
};
type Location = { id: string; name: string; isDefault: boolean; kind: "browser" | "folder" };
const quant = (model: SavedModel) =>
  model.metadata?.quantization ||
  model.file.match(/(?:IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|MXFP4|BF16|F16|F32)(?=\.|-)/i)?.[0] ||
  "GGUF";
const stored = (model: SavedModel) =>
  Boolean(model.opfsName || model.externalName || model.kind === "file");
const destination = (model: SavedModel) =>
  model.where ||
  (model.opfsName
    ? "Browser storage"
    : model.externalName
      ? "Selected folder"
      : model.kind === "file"
        ? "This visit only"
        : "Not downloaded");

export function ModelsTab({
  models,
  activeId,
  load,
  onUse,
  onChanged,
  onUnload,
  folder,
  onFolder,
  generationBusy = false,
}: Props) {
  const settings = useKiln((state) => state.settings);
  const [tab, setTab] = useState<"installed" | "discover" | "storage">("installed");
  const [importMode, setImportMode] = useState(false);
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [librarySort, setLibrarySort] = useState("recent");
  const transfers = useModelTransfers((state) => state.rows);
  const setTransfers = useModelTransfers((state) => state.setRows);
  const [locations, setLocations] = useState<Location[]>([]);
  const [scanning, setScanning] = useState(false);
  const scanAbort = useRef<AbortController | null>(null);
  const [configuring, setConfiguring] = useState<SavedModel | null>(null);
  const configurationRef = useRef<HTMLElement | null>(null);
  const [config, setConfig] = useState<ModelConfig>({
    context: settings.localCtx,
    profile: settings.performanceProfile ?? "auto",
  });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    if (configuring)
      configurationRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [configuring]);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void storageLocations()
      .then(setLocations)
      .catch((err) => setError(explain(err)));
  }, [folder, tab]);
  const patchTransfer = (id: string, patch: Partial<Transfer>) =>
    setTransfers((rows) => rows.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const [pendingLoad, setPendingLoad] = useState<SavedModel | null>(null);
  const active = models.find((model) => model.id === activeId);
  const busy = load.phase === "loading" || generationBusy;
  const visible = useMemo(
    () =>
      models
        .filter(
          (model) =>
            (statusFilter === "all" ||
              (statusFilter === "running"
                ? model.id === activeId && load.phase === "ready"
                : statusFilter === "installed"
                  ? stored(model)
                  : !stored(model))) &&
            `${model.name} ${model.repo} ${model.file} ${quant(model)}`
              .toLowerCase()
              .includes(query.toLowerCase()) &&
            (locationFilter === "all" ||
              (locationFilter === "pending"
                ? !stored(model)
                : destination(model) === locationFilter)),
        )
        .sort((a, b) =>
          librarySort === "name"
            ? a.name.localeCompare(b.name)
            : librarySort === "size"
              ? a.bytes - b.bytes
              : b.createdAt - a.createdAt,
        ),
    [models, query, locationFilter, librarySort, statusFilter, activeId, load.phase],
  );

  async function importFiles(files: File[]) {
    setError("");
    setNotice("");
    setTab("installed");
    const queue = files.map((file) => ({ file, id: newId(), abort: new AbortController() }));
    setTransfers((rows) => [
      ...queue.map(({ file, id, abort }) => ({
        id,
        name: file.name,
        phase: "working" as const,
        detail: "Queued for import…",
        ratio: null,
        abort,
      })),
      ...rows,
    ]);
    for (const { file, id, abort } of queue) {
      try {
        abort.signal.throwIfAborted();
        patchTransfer(id, { detail: "Validating GGUF file…" });
        if (!(await isGguf(file))) throw new Error("This is not a valid GGUF model file.");
        if (/mmproj|projector|\d{5}-of-\d{5}/i.test(file.name))
          throw new Error(
            "Split models and vision projectors need a separate loader. Import a single model GGUF file.",
          );
        const model: SavedModel = {
          id,
          name: file.name.replace(/\.gguf$/i, ""),
          kind: "file",
          repo: "",
          file: file.name,
          url: "",
          bytes: file.size,
          opfsName: "",
          createdAt: Date.now(),
        };
        model.metadata = await readGgufMetadata(file);
        abort.signal.throwIfAborted();
        patchTransfer(id, { detail: "Saving model to your library…", ratio: 0 });
        const placed = await storeModelBlob(
          file.name,
          file,
          (ratio) => patchTransfer(id, { ratio }),
          abort.signal,
        );
        Object.assign(model, placed);
        if (abort.signal.aborted) {
          await deleteStoredModel({ ...model, id: newId() }).catch(() => undefined);
          abort.signal.throwIfAborted();
        }
        await saveModel(model);
        if (abort.signal.aborted) {
          await deleteStoredModel(model).catch(() => undefined);
          onChanged();
          abort.signal.throwIfAborted();
        }
        onChanged();
        patchTransfer(id, {
          phase: "done",
          ratio: 1,
          model,
          abort: undefined,
          detail:
            model.where === "This visit only"
              ? "Imported for this visit only. Reimport after closing Kiln."
              : `Imported into ${destination(model)}. Ready to load.`,
        });
      } catch (err) {
        patchTransfer(id, {
          phase: abort.signal.aborted ? "cancelled" : "error",
          detail: abort.signal.aborted ? "Import cancelled. No model was added." : explain(err),
          ratio: null,
          abort: undefined,
        });
      }
    }
  }

  async function startDownload(model: SavedModel, source: string, reuseId?: string) {
    setNotice("");
    const id = reuseId || newId();
    const abort = new AbortController();
    const transfer: Transfer = {
      id,
      name: model.name,
      phase: "working",
      detail: `Downloading into ${folder || "browser storage"}…`,
      ratio: 0,
      abort,
      model,
      url: source,
    };
    if (reuseId) patchTransfer(id, transfer);
    else setTransfers((rows) => [transfer, ...rows]);
    try {
      await saveModel(model);
      onChanged();
      const placed = await downloadIntoStorage(
        source,
        model.file || `${model.name}.gguf`,
        abort.signal,
        (ratio) => patchTransfer(id, { ratio }),
      );
      const completed = { ...model, ...placed };
      try {
        completed.metadata = await readGgufMetadata(await fileForModel(completed));
      } catch (validationError) {
        await deleteStoredModel({ ...completed, id: newId() }).catch(() => undefined);
        throw validationError;
      }
      if (abort.signal.aborted) {
        await deleteStoredModel({ ...completed, id: newId() }).catch(() => undefined);
        abort.signal.throwIfAborted();
      }
      await saveModel(completed);
      if (abort.signal.aborted) {
        await deleteStoredModel(completed).catch(() => undefined);
        await saveModel(model);
        onChanged();
        abort.signal.throwIfAborted();
      }
      onChanged();
      patchTransfer(id, {
        phase: "done",
        detail: `Saved in ${destination(completed)}. Ready to load.`,
        ratio: 1,
        model: completed,
        abort: undefined,
      });
    } catch (err) {
      patchTransfer(id, {
        phase: abort.signal.aborted ? "paused" : "error",
        detail: abort.signal.aborted
          ? "Paused. Resume to continue where the server supports it."
          : explain(err),
        abort: undefined,
      });
    }
  }
  function downloadUrl() {
    try {
      const parsed = new URL(url.trim());
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error("Use an HTTP or HTTPS link without embedded credentials.");
      const name = decodeURIComponent(parsed.pathname.split("/").pop() || "model.gguf");
      if (!/\.gguf$/i.test(name)) throw new Error("Use a direct link to a .gguf file.");
      const model: SavedModel = {
        id: newId(),
        name: name.replace(/\.gguf$/i, ""),
        kind: "url",
        repo: "",
        file: name,
        url: parsed.href,
        bytes: 0,
        opfsName: "",
        createdAt: Date.now(),
      };
      setUrl("");
      setImportMode(false);
      setError("");
      void startDownload(model, parsed.href);
    } catch (err) {
      setError(explain(err));
    }
  }
  function downloadCatalog(item: CatalogItem) {
    const existing = models.find((model) => model.repo === item.repo && model.file === item.file);
    if (existing && stored(existing)) {
      setTab("installed");
      setQuery(existing.name);
      setNotice("This file is already in your library. Select Load & use to run it.");
      return;
    }
    const model: SavedModel = existing ?? {
      id: newId(),
      name: item.name,
      kind: "hf",
      repo: item.repo,
      file: item.file,
      url: "",
      bytes: item.bytes,
      opfsName: "",
      createdAt: Date.now(),
    };
    void startDownload(
      model,
      `https://huggingface.co/${item.repo}/resolve/main/${item.file.split("/").map(encodeURIComponent).join("/")}`,
    );
  }
  function loadModel(model: SavedModel) {
    setNotice("");
    model = models.find((saved) => saved.id === model.id) ?? model;
    if (generationBusy) {
      setError("Stop the current response before switching or reloading models.");
      return;
    }
    setError("");
    const preflight = getModelPreflight(
      model,
      planRuntime(
        model.config?.context ?? settings.localCtx,
        settings.maxTokens,
        settings.performanceProfile,
        model.config,
      ),
    );
    if (preflight.warnings.some((warning) => /memory|Large browser/.test(warning)))
      setPendingLoad(model);
    else onUse(model);
  }
  async function scan(id: string) {
    const abort = new AbortController();
    scanAbort.current = abort;
    setScanning(true);
    setError("");
    setNotice("Scanning folder for existing GGUF models…");
    try {
      const found = await scanModelFolder(id, (label) => setNotice(label), abort.signal);
      onChanged();
      setNotice(
        `Folder scanned. ${found.length} model${found.length === 1 ? "" : "s"} found. Browse Installed to load one.`,
      );
    } catch (err) {
      onChanged();
      if (abort.signal.aborted)
        setNotice("Scan cancelled. Models already found remain in the library.");
      else setError(explain(err));
    } finally {
      scanAbort.current = null;
      setScanning(false);
    }
  }
  async function remove(model: SavedModel) {
    if (generationBusy && model.id === activeId) {
      setError("Stop the current response before removing the running model.");
      return;
    }
    try {
      if (model.id === activeId) onUnload();
      if (model.linked) await deleteModelRecord(model.id);
      else await deleteStoredModel(model);
      if (model.id === useKiln.getState().localModelId) useKiln.getState().setLocalModelId(null);
      onChanged();
      setConfirmDelete(null);
      setTransfers((rows) => rows.filter((row) => row.model?.id !== model.id));
      setNotice(
        model.linked
          ? `Removed ${model.name} from Kiln. The original file is unchanged.`
          : `Deleted ${model.name} from its storage location.`,
      );
    } catch (err) {
      setError(explain(err));
    }
  }
  async function saveConfiguration(reload: boolean) {
    if (!configuring) return;
    try {
      const updated = { ...configuring, config };
      await saveModel(updated);
      onChanged();
      setConfiguring(null);
      setNotice(
        `Settings saved for ${updated.name}.${reload ? " Reloading now." : " They apply on the next load."}`,
      );
      if (reload) loadModel(updated);
    } catch (err) {
      setError(explain(err));
    }
  }
  return (
    <div
      className="model-manager"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (event.dataTransfer.files.length) void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="mm-heading">
        <div>
          <h3>Your model workspace</h3>
          <p>Install once. Choose a model. Tune how it runs.</p>
        </div>
        <HardDrive size={22} aria-hidden="true" />
      </div>
      <div className="mm-actions">
        <button className="mm-button primary" onClick={() => fileRef.current?.click()}>
          <Upload size={16} />
          Import files
        </button>
        <button className="mm-button" onClick={() => setImportMode((value) => !value)}>
          <Download size={16} />
          Download URL
        </button>
      </div>
      <input
        ref={fileRef}
        hidden
        type="file"
        multiple
        accept=".gguf,application/octet-stream"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          void importFiles(files);
        }}
      />
      <button className="mm-destination" onClick={() => setTab("storage")}>
        <FolderOpen size={16} />
        <span>
          Save to <strong>{folder || "Browser storage"}</strong>
        </span>
        <span>Change</span>
      </button>
      {importMode && (
        <form
          className="mm-url"
          onSubmit={(event) => {
            event.preventDefault();
            downloadUrl();
          }}
        >
          <label htmlFor="mm-url-input">Direct GGUF download link</label>
          <input
            id="mm-url-input"
            className="mm-input"
            type="url"
            required
            placeholder="https://…/model.gguf"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button className="mm-button primary" type="submit">
            Download to library
          </button>
          <p>The server must allow browser downloads. No model loads automatically.</p>
        </form>
      )}
      {configuring && (
        <section
          ref={configurationRef}
          className="mm-config"
          aria-label={`Settings for ${configuring.name}`}
        >
          <div className="mm-model-title">
            <h4>{configuring.name}</h4>
            <button
              className="mm-button"
              aria-label="Close model settings"
              onClick={() => setConfiguring(null)}
            >
              <X size={16} />
            </button>
          </div>
          <p>
            Saved per model. Load settings apply when the model loads; changes to a running model
            require reload.
          </p>
          <div className="mm-runtime-preview">
            <p>
              Effective runtime:{" "}
              {
                planRuntime(
                  config.context,
                  config.maxTokens ?? settings.maxTokens,
                  config.profile,
                  config,
                ).note
              }
            </p>
            <p>
              Estimated memory:{" "}
              {modelSize(
                getModelPreflight(
                  configuring,
                  planRuntime(
                    config.context,
                    config.maxTokens ?? settings.maxTokens,
                    config.profile,
                    config,
                  ),
                ).estimatedMemoryBytes,
              )}
              . Estimates include weights and context and may differ from actual usage.
            </p>
            {getModelPreflight(
              configuring,
              planRuntime(
                config.context,
                config.maxTokens ?? settings.maxTokens,
                config.profile,
                config,
              ),
            ).warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
          <div className="mm-filters">
            <label>
              Performance profile
              <select
                value={config.profile}
                onChange={(event) =>
                  setConfig({ ...config, profile: event.target.value as ModelConfig["profile"] })
                }
              >
                <option value="auto">Auto · detect hardware</option>
                <option value="balanced">Balanced</option>
                <option value="quality">Quality · more memory</option>
                <option value="saver">Battery saver · CPU</option>
              </select>
            </label>
            <NumberField
              label="Context length"
              value={config.context}
              min={512}
              max={131072}
              step={512}
              onChange={(value) => setConfig({ ...config, context: value ?? 2048 })}
            />
          </div>
          <details>
            <summary>Advanced load settings</summary>
            <div className="mm-filters">
              <NumberField
                label="GPU layers (0 = CPU)"
                value={config.gpuLayers}
                min={0}
                max={99999}
                onChange={(value) => setConfig({ ...config, gpuLayers: value })}
              />
              <NumberField
                label="CPU threads"
                value={config.threads}
                min={1}
                max={64}
                onChange={(value) => setConfig({ ...config, threads: value })}
              />
              <NumberField
                label="Batch size"
                value={config.batch}
                min={16}
                max={2048}
                step={16}
                onChange={(value) => setConfig({ ...config, batch: value })}
              />
            </div>
            <p>
              Blank uses automatic values. CPU threads are limited by browser isolation; GPU
              acceleration also depends on runtime and hardware support.
            </p>
          </details>
          <details>
            <summary>Generation defaults</summary>
            <div className="mm-filters">
              <NumberField
                label="Temperature"
                value={config.temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={(value) => setConfig({ ...config, temperature: value })}
              />
              <NumberField
                label="Response token limit"
                value={config.maxTokens}
                min={16}
                max={32768}
                step={64}
                onChange={(value) => setConfig({ ...config, maxTokens: value })}
              />
              <NumberField
                label="Top P"
                value={config.topP}
                min={0.01}
                max={1}
                step={0.05}
                onChange={(value) => setConfig({ ...config, topP: value })}
              />
              <NumberField
                label="Repeat penalty"
                value={config.repeatPenalty}
                min={1}
                max={2}
                step={0.05}
                onChange={(value) => setConfig({ ...config, repeatPenalty: value })}
              />
            </div>
          </details>
          <div className="mm-actions">
            <button className="mm-button primary" onClick={() => void saveConfiguration(false)}>
              Save settings
            </button>
            <button
              className="mm-button"
              disabled={busy || !stored(configuring)}
              onClick={() => void saveConfiguration(true)}
            >
              Save & reload
            </button>
            <button
              className="mm-button"
              onClick={() =>
                setConfig({
                  context: settings.localCtx,
                  profile: settings.performanceProfile ?? "auto",
                })
              }
            >
              Reset to workspace defaults
            </button>
          </div>
        </section>
      )}
      {pendingLoad && (
        <div className="mm-config" role="region" aria-label="Model load check">
          <h4>Before loading {pendingLoad.name}</h4>
          <p>
            Estimated memory: {modelSize(getModelPreflight(pendingLoad).estimatedMemoryBytes)}{" "}
            (weights and context; actual usage varies).
          </p>
          {getModelPreflight(pendingLoad).warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <div className="mm-actions">
            <button
              className="mm-button primary"
              onClick={() => {
                onUse(pendingLoad);
                setPendingLoad(null);
              }}
            >
              Load anyway
            </button>
            <button className="mm-button" onClick={() => setPendingLoad(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="mm-tabs" role="group" aria-label="Model workspace views">
        {(
          [
            ["installed", `Installed (${models.length})`],
            ["discover", "Discover"],
            ["storage", "Transfers & storage"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {generationBusy && (
        <p role="status">
          A response is running. Stop the current response before loading, reloading, or unloading a
          model.
        </p>
      )}
      {notice && (
        <div role="status" className="mm-notice">
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="mm-notice danger">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {load.phase === "error" && (
        <p role="alert" className="mm-error">
          {load.message}
        </p>
      )}
      {load.phase === "loading" && (
        <div className="mm-runtime" role="status">
          <Loader2 size={17} />
          <div>
            <strong>{load.label}</strong>
            <progress max={1} value={load.ratio ?? undefined} />
          </div>
          <button className="mm-button" onClick={onUnload}>
            Cancel load
          </button>
        </div>
      )}
      {load.phase === "ready" && (
        <div className="mm-runtime">
          <Check size={17} />
          <div>
            <strong>{load.name} is running</strong>
            <p>{load.note}</p>
            <details>
              <summary>Runtime details</summary>
              <p>
                Backend: {localDiagnostics().backend} · effective context{" "}
                {localDiagnostics().effectiveContext?.toLocaleString()} ·{" "}
                {localDiagnostics().threads} CPU threads · batch {localDiagnostics().batch} · GPU
                layers requested {localDiagnostics().gpuLayers}
              </p>
              {localDiagnostics().warnings?.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </details>
          </div>
          <button className="mm-button" disabled={generationBusy} onClick={onUnload}>
            Unload
          </button>
        </div>
      )}
      {transfers.length > 0 && tab === "installed" && (
        <div className="mm-transfer-compact" role="status" data-phase={transfers[0].phase}>
          <div>
            <strong title={transfers[0].name}>
              {transfers[0].phase === "done"
                ? "Installed"
                : transfers[0].phase === "working"
                  ? "In progress"
                  : transfers[0].phase}
              : {transfers[0].name}
            </strong>
            <p>
              {transfers[0].phase === "working"
                ? transfers[0].ratio === null
                  ? transfers[0].detail
                  : `${Math.round(transfers[0].ratio! * 100)}% complete`
                : transfers[0].phase === "done"
                  ? "Ready to load."
                  : transfers[0].detail}
            </p>
          </div>
          <div className="mm-actions">
            {transfers[0].phase === "done" && transfers[0].model && (
              <>
                <button
                  className="mm-button primary"
                  disabled={busy}
                  onClick={() => loadModel(transfers[0].model!)}
                >
                  Load now
                </button>
                <button
                  className="mm-button"
                  aria-label="Keep installed"
                  onClick={() =>
                    setTransfers((rows) => rows.filter((row) => row.id !== transfers[0].id))
                  }
                >
                  Later
                </button>
              </>
            )}
            {transfers[0].phase === "working" && transfers[0].abort && (
              <button className="mm-button" onClick={() => transfers[0].abort?.abort()}>
                {transfers[0].url ? "Pause download" : "Cancel import"}
              </button>
            )}
            <button
              className="mm-button"
              aria-label={`All transfers (${transfers.length})`}
              onClick={() => setTab("storage")}
            >
              Transfers ({transfers.length})
            </button>
            {transfers[0].phase !== "working" && transfers[0].phase !== "done" && (
              <button
                className="mm-button"
                onClick={() =>
                  setTransfers((rows) => rows.filter((row) => row.id !== transfers[0].id))
                }
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
      {transfers.length > 0 && tab !== "installed" && (
        <section aria-label="Model transfers" className="mm-transfers">
          {(tab === "storage" ? transfers : transfers.slice(0, 3)).map((item) => (
            <div className="mm-transfer" key={item.id}>
              <div className="mm-transfer-title">
                <strong>{item.name}</strong>
                <span>
                  {item.phase === "working"
                    ? item.ratio === null
                      ? "Working…"
                      : `${Math.round(item.ratio * 100)}%`
                    : item.phase === "done"
                      ? "Installed"
                      : item.phase}
                </span>
              </div>
              <p
                className={item.phase === "error" ? "mm-error" : ""}
                role={item.phase === "error" ? "alert" : "status"}
              >
                {item.detail}
              </p>
              {item.phase === "working" && <progress max={1} value={item.ratio ?? undefined} />}
              <div className="mm-actions">
                {item.phase === "working" && item.abort && (
                  <button className="mm-button" onClick={() => item.abort?.abort()}>
                    {item.url ? "Pause download" : "Cancel import"}
                  </button>
                )}
                {(item.phase === "paused" || item.phase === "error") &&
                  item.model &&
                  (item.url ||
                    item.model.repo ||
                    models.find((model) => model.id === item.model?.id)?.url) && (
                    <button
                      className="mm-button"
                      onClick={() =>
                        void startDownload(
                          item.model!,
                          item.url ||
                            models.find((model) => model.id === item.model?.id)?.url ||
                            `https://huggingface.co/${item.model!.repo}/resolve/main/${item.model!.file}`,
                          item.id,
                        )
                      }
                    >
                      Retry / resume
                    </button>
                  )}
                {item.phase === "done" && item.model && (
                  <>
                    <button
                      className="mm-button primary"
                      disabled={busy}
                      onClick={() => loadModel(item.model!)}
                    >
                      Load now
                    </button>
                    <button
                      className="mm-button"
                      onClick={() =>
                        setTransfers((rows) => rows.filter((row) => row.id !== item.id))
                      }
                    >
                      Keep installed
                    </button>
                  </>
                )}
                {item.phase !== "working" && item.phase !== "done" && (
                  <button
                    className="mm-button"
                    onClick={() => setTransfers((rows) => rows.filter((row) => row.id !== item.id))}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          ))}
          {tab !== "storage" && transfers.length > 3 && (
            <button className="mm-button" onClick={() => setTab("storage")}>
              View all {transfers.length} transfers
            </button>
          )}
        </section>
      )}
      {tab === "installed" && (
        <section aria-label="Installed model library">
          <div className="mm-search">
            <Search size={17} />
            <input
              aria-label="Search installed models"
              placeholder="Search your models…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="mm-filters">
            <label>
              Storage
              <select
                value={locationFilter}
                onChange={(event) => setLocationFilter(event.target.value)}
              >
                <option value="all">All locations</option>
                {Array.from(new Set(models.filter(stored).map(destination))).map((where) => (
                  <option key={where}>{where}</option>
                ))}
                <option value="pending">Not downloaded</option>
              </select>
            </label>
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="running">Running</option>
                <option value="installed">Installed files</option>
                <option value="pending">Not downloaded</option>
              </select>
            </label>
            <label>
              Sort
              <select value={librarySort} onChange={(event) => setLibrarySort(event.target.value)}>
                <option value="recent">Recently added</option>
                <option value="name">Name A–Z</option>
                <option value="size">Smallest first</option>
              </select>
            </label>
          </div>
          <p className="mm-caption">
            {visible.length} of {models.length} models ·{" "}
            {modelSize(models.reduce((sum, item) => sum + item.bytes, 0))} total
          </p>
          <div className="mm-list">
            {visible.map((model) => (
              <article
                className={`mm-model ${active?.id === model.id ? "selected" : ""}`}
                key={model.id}
              >
                <div className="mm-model-title">
                  <h4>{model.name}</h4>
                  {active?.id === model.id && load.phase === "ready" && (
                    <span className="mm-badge">Running</span>
                  )}
                </div>
                <p>
                  {quant(model)} · {modelSize(model.bytes)} · {destination(model)}
                </p>
                {model.metadata?.architecture && (
                  <p>
                    {model.metadata.architecture} ·{" "}
                    {model.metadata.contextLength
                      ? `${model.metadata.contextLength.toLocaleString()} native context`
                      : "Context configured below"}
                  </p>
                )}
                <div className="mm-actions">
                  <button
                    className="mm-button primary"
                    disabled={busy}
                    onClick={() =>
                      stored(model)
                        ? loadModel(model)
                        : void startDownload(
                            model,
                            model.url ||
                              `https://huggingface.co/${model.repo}/resolve/main/${model.file}`,
                          )
                    }
                  >
                    {stored(model)
                      ? active?.id === model.id && load.phase === "ready"
                        ? "Reload & use"
                        : "Load & use"
                      : "Download"}
                  </button>
                  <button
                    className="mm-button"
                    onClick={() => {
                      setConfiguring(model);
                      setConfig(
                        model.config || {
                          context: settings.localCtx,
                          profile: settings.performanceProfile ?? "auto",
                        },
                      );
                    }}
                  >
                    <Settings2 size={15} />
                    Settings
                  </button>
                  <details className="mm-more">
                    <summary>More</summary>
                    <div>
                      <button
                        className="mm-button"
                        disabled={!stored(model)}
                        onClick={() =>
                          void (async () => {
                            try {
                              const blob = await fileForModel(model);
                              const target = await copyFileToFolder(
                                new File([blob], model.file || `${model.name}.gguf`),
                              );
                              setNotice(`Copied ${model.name} to ${target}.`);
                            } catch (err) {
                              setError(explain(err));
                            }
                          })()
                        }
                      >
                        Copy to folder
                      </button>
                      <button
                        className="mm-button danger"
                        onClick={() => setConfirmDelete(model.id)}
                      >
                        {model.linked ? "Remove from library" : "Delete model"}
                      </button>
                    </div>
                  </details>
                </div>
                {confirmDelete === model.id && (
                  <div className="mm-confirm">
                    <p>
                      {model.linked
                        ? "Remove this model from Kiln? The original file stays in your folder."
                        : "Delete the saved file and library entry for this model? This cannot be undone."}
                    </p>
                    <div className="mm-actions">
                      <button className="mm-button danger" onClick={() => void remove(model)}>
                        {model.linked ? "Remove from library" : "Delete permanently"}
                      </button>
                      <button className="mm-button" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
          {!visible.length && (
            <div className="mm-empty">
              <HardDrive size={26} />
              <h4>{models.length ? "No matching models" : "Your library starts here"}</h4>
              <p>
                {models.length
                  ? "Try another search or storage filter."
                  : "Import your existing GGUF files, scan a model folder, or discover a model to download."}
              </p>
              <button
                className="mm-button"
                onClick={() =>
                  models.length
                    ? (setQuery(""), setLocationFilter("all"), setStatusFilter("all"))
                    : setTab("discover")
                }
              >
                {models.length ? "Clear filters" : "Discover models"}
              </button>
            </div>
          )}
        </section>
      )}
      {tab === "discover" && (
        <Discovery onDownload={downloadCatalog} models={models} transfers={transfers} />
      )}
      {tab === "storage" && (
        <section className="mm-storage">
          <h4>Model storage locations</h4>
          {scanning && (
            <button className="mm-button" onClick={() => scanAbort.current?.abort()}>
              Cancel folder scan
            </button>
          )}
          <p>
            Changing the default affects new imports and downloads. Existing files stay in their
            original location.
          </p>
          <button className="mm-button" onClick={onFolder}>
            <FolderOpen size={16} />
            Choose / add folder
          </button>
          {locations.map((location) => (
            <div className="mm-model" key={location.id}>
              <div className="mm-model-title">
                <strong>{location.name}</strong>
                {location.isDefault && <span className="mm-badge">Default</span>}
              </div>
              <p>
                {location.kind === "browser"
                  ? "Managed by this browser. Clearing site data removes these files."
                  : "A folder you selected. Kiln reads files only after you grant access."}
              </p>
              <div className="mm-actions">
                {!location.isDefault && (
                  <button
                    className="mm-button"
                    onClick={() =>
                      void (async () => {
                        try {
                          if (location.kind === "browser") await switchToBrowserStorage();
                          else await setDefaultFolder(location.id);
                          setLocations(await storageLocations());
                          setNotice(`${location.name} is now the default for new models.`);
                          onChanged();
                        } catch (err) {
                          setError(explain(err));
                        }
                      })()
                    }
                  >
                    Use as default
                  </button>
                )}
                {
                  <button
                    className="mm-button"
                    disabled={scanning}
                    onClick={() => void scan(location.id)}
                  >
                    {scanning ? "Scanning…" : "Find existing models"}
                  </button>
                }
              </div>
            </div>
          ))}
          {transfers.length === 0 && <p>No imports or downloads in progress.</p>}
        </section>
      )}
      <p className="mm-caption">
        Models run locally. Nothing is uploaded. Available memory, runtime support, and context
        length determine which models this device can run.
      </p>
    </div>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder="Auto"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
        onBlur={(event) => {
          if (event.target.value !== "")
            onChange(Math.max(min, Math.min(max, Number(event.target.value))));
        }}
      />
    </label>
  );
}

function Discovery({
  onDownload,
  models,
  transfers,
}: {
  onDownload: (item: CatalogItem) => void;
  models: SavedModel[];
  transfers: Transfer[];
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"downloads" | "lastModified" | "likes">("downloads");
  const [task, setTask] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [files, setFiles] = useState<CatalogItem[]>([]);
  const [quantFilter, setQuantFilter] = useState("all");
  const [size, setSize] = useState("all");
  const [fileSort, setFileSort] = useState("size");
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (repo) return;
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    setItems([]);
    setCursor(null);
    const timer = setTimeout(() => {
      void searchCatalogPage({ query, sort, task: task || undefined, limit: 20 }, abort.signal)
        .then((page) => {
          if (!abort.signal.aborted) {
            setItems(page.items);
            setCursor(page.nextCursor);
          }
        })
        .catch((err) => {
          if (!abort.signal.aborted) setError(explain(err));
        })
        .finally(() => {
          if (!abort.signal.aborted) setBusy(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, sort, task, repo]);
  async function more() {
    if (!cursor) return;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    try {
      const page = await searchCatalogPage(
        { query, sort, task: task || undefined, cursor, limit: 20 },
        abort.signal,
      );
      setItems((rows) =>
        Array.from(new Map([...rows, ...page.items].map((item) => [item.id, item])).values()),
      );
      setCursor(page.nextCursor);
    } catch (err) {
      if (!abort.signal.aborted) setError(explain(err));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  async function inspect(item: CatalogItem) {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setRepo(item.repo);
    setFiles([]);
    setError("");
    setBusy(true);
    setQuantFilter("all");
    setSize("all");
    setFileQuery("");
    try {
      setFiles(await catalogFiles(item.repo, abort.signal));
    } catch (err) {
      if (!abort.signal.aborted) setError(explain(err));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  const visible = files
    .filter(
      (item) =>
        (!compatibleOnly || item.compatible !== false) &&
        (quantFilter === "all" || item.quantization === quantFilter) &&
        (size === "all" || (item.bytes > 0 && item.bytes <= Number(size))) &&
        item.name.toLowerCase().includes(fileQuery.toLowerCase()),
    )
    .sort((a, b) => (fileSort === "name" ? a.name.localeCompare(b.name) : a.bytes - b.bytes));
  return (
    <section className="mm-discover" aria-label="Discover models">
      {repo ? (
        <>
          <button
            className="mm-button"
            onClick={() => {
              request.current?.abort();
              setRepo(null);
            }}
          >
            <ArrowLeft size={16} />
            Back to catalog
          </button>
          <h4 className="mm-repo">{repo}</h4>
          <p>
            Choose a quantization and size that fit your device. Downloads install the file; loading
            is a separate step.
          </p>
          <div className="mm-search">
            <Search size={16} />
            <input
              aria-label="Search repository files"
              placeholder="Filter filenames…"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
            />
          </div>
          <div className="mm-filters">
            <label>
              Quantization
              <select value={quantFilter} onChange={(event) => setQuantFilter(event.target.value)}>
                <option value="all">All quantizations</option>
                {Array.from(new Set(files.map((item) => item.quantization).filter(Boolean))).map(
                  (value) => (
                    <option key={value}>{value}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              Maximum file size
              <select value={size} onChange={(event) => setSize(event.target.value)}>
                <option value="all">Any size</option>
                <option value="1000000000">Up to 1 GB</option>
                <option value="4000000000">Up to 4 GB</option>
                <option value="8000000000">Up to 8 GB</option>
                <option value="16000000000">Up to 16 GB</option>
              </select>
            </label>
            <label>
              Sort files
              <select value={fileSort} onChange={(event) => setFileSort(event.target.value)}>
                <option value="size">Smallest first</option>
                <option value="name">Name A–Z</option>
              </select>
            </label>
            <label>
              Compatibility
              <select
                value={compatibleOnly ? "supported" : "all"}
                onChange={(event) => setCompatibleOnly(event.target.value === "supported")}
              >
                <option value="all">All GGUF files</option>
                <option value="supported">Single model files only</option>
              </select>
            </label>
          </div>
          <p className="mm-caption">
            {visible.length} of {files.length} GGUF files · smaller quantizations trade quality for
            memory
          </p>
          <div className="mm-list">
            {visible.map((item) => {
              const installed = models.some(
                (model) => model.repo === item.repo && model.file === item.file && stored(model),
              );
              const downloading = transfers.some(
                (row) =>
                  row.model?.repo === item.repo &&
                  row.model.file === item.file &&
                  row.phase === "working",
              );
              return (
                <article key={item.id} className="mm-model">
                  <h4>{item.name}</h4>
                  <p>
                    {item.quantization} · {item.size}
                  </p>
                  <p>{item.memory}</p>
                  <p>{item.blurb}</p>
                  <button
                    className="mm-button primary"
                    disabled={item.compatible === false || downloading}
                    onClick={() => onDownload(item)}
                  >
                    <Download size={15} />
                    {downloading ? "Downloading…" : installed ? "View installed model" : "Download"}
                  </button>
                </article>
              );
            })}
          </div>
          {!busy && !visible.length && (
            <div className="mm-empty">
              <p>
                {files.length
                  ? "No files match your filters."
                  : "No supported GGUF files in this repository."}
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <h4>Discover on Hugging Face</h4>
          <p>Live repositories with GGUF model files. Inspect files before choosing a download.</p>
          <div className="mm-search">
            <Search size={17} />
            <input
              aria-label="Search model catalog"
              placeholder="Search model or publisher…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="mm-filters">
            <label>
              Sort repositories
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                <option value="downloads">Most downloaded</option>
                <option value="lastModified">Recently updated</option>
                <option value="likes">Most liked</option>
              </select>
            </label>
            <label>
              Task
              <select value={task} onChange={(event) => setTask(event.target.value)}>
                <option value="">All tasks</option>
                <option value="text-generation">Text generation</option>
                <option value="text2text-generation">Text to text</option>
              </select>
            </label>
          </div>
          <div className="mm-list">
            {items.map((item) => (
              <button
                className="mm-model mm-repository"
                key={item.id}
                onClick={() => void inspect(item)}
              >
                <h4>{item.name}</h4>
                <p>{item.blurb}</p>
                <span>Inspect GGUF files →</span>
              </button>
            ))}
          </div>
          {cursor && (
            <button className="mm-button" disabled={busy} onClick={() => void more()}>
              {busy ? "Loading…" : "Load more models"}
            </button>
          )}
          {!busy && !items.length && !error && (
            <p>No repositories found. Try a different search or task.</p>
          )}
          {!cursor && items.length > 0 && !busy && (
            <p className="mm-caption">{items.length} repositories · end of results</p>
          )}
        </>
      )}
      {busy && (
        <p className="mm-loading" role="status">
          <Loader2 size={16} />
          Loading live catalog…
        </p>
      )}
      {error && (
        <p className="mm-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
