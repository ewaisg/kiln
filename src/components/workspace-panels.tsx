import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { exportWorkspace, importWorkspace } from "@/lib/workspace-transfer";
import { searchCatalog, catalogFiles } from "@/lib/catalog";
import { listRemoteModels, getDiscoveredCapabilities } from "@/lib/cloud";
import {
  copyFileToFolder,
  deleteStoredModel,
  fileForModel,
  holdSessionFile,
  isGguf,
  saveModel,
  storeModelBlob,
} from "@/lib/library";
import { unloadLocal } from "@/lib/local-engine";
import { downloadText } from "@/lib/preview-doc";
import { useKiln } from "@/lib/store";
import { stopSpeaking } from "@/lib/speech";
import {
  CHAT_SYSTEM,
  DEFAULT_SYSTEM,
  PRESETS,
  newId,
  presetByKind,
  type CatalogItem,
  type Capability,
  type Endpoint,
  type ProviderKind,
  type SavedModel,
} from "@/lib/types";
import { shouldDirect } from "@/lib/wire";
import { downloadWindowsInstaller } from "@/lib/windows-install";
import {
  blankEndpoint,
  explain,
  fieldClass,
  type LoadState,
  type InstallPrompt,
} from "@/components/workspace-ui";

function footprint(bytes: number): string {
  const ram = Math.max(1, Math.ceil((bytes * 2) / 1_000_000_000));
  return `About ${Math.round(bytes / 1_000_000)} MB on disk. Leave roughly ${ram} GB free for weights and context. Acceleration depends on the browser and performance profile.`;
}

export function When({ at }: { at: number }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(formatDistanceToNow(at, { addSuffix: true }));
  }, [at]);
  return <span className="tabular-nums">{label}</span>;
}

export function ModelsTab({
  models,
  activeId,
  load,
  onUse,
  onChanged,
  onUnload,
  folder,
  onFolder,
}: {
  models: SavedModel[];
  activeId: string | null;
  load: LoadState;
  onUse: (model: SavedModel) => void;
  onChanged: () => void;
  onUnload: () => void;
  folder: string;
  onFolder: () => void;
}) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [copyNote, setCopyNote] = useState("");
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogNote, setCatalogNote] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setCatalogBusy(true);
      setCatalogNote("");
      void searchCatalog(modelQuery, abort.signal)
        .then(setCatalog)
        .catch((error) => {
          if (!abort.signal.aborted) setCatalogNote(explain(error));
        })
        .finally(() => {
          if (!abort.signal.aborted) setCatalogBusy(false);
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [modelQuery]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [armed, setArmed] = useState<string | null>(null);

  async function importFile(file: File) {
    setNote("");
    if (!(await isGguf(file))) {
      setNote("That file is not a GGUF model.");
      return;
    }
    const id = newId();
    const model: SavedModel = {
      id,
      name: file.name.replace(/\.gguf$/i, ""),
      kind: "file",
      repo: "",
      file: file.name,
      url: "",
      bytes: file.size,
      opfsName: `${id}.gguf`,
      createdAt: Date.now(),
    };
    try {
      await navigator.storage?.persist?.();
      const placed = await storeModelBlob(file.name, file, () => undefined);
      model.opfsName = placed.opfsName;
      model.externalName = placed.externalName || undefined;
      model.where = placed.where;
      if (!placed.opfsName && !placed.externalName) throw new Error("Could not store that file.");
    } catch {
      model.opfsName = "";
      holdSessionFile(id, file);
      setNote("Saved for this visit only. This browser could not keep the file.");
    }
    await saveModel(model);
    onChanged();
    onUse(model);
  }

  async function addUrl() {
    setNote("");
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setNote("Paste a full https link to a .gguf file.");
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setNote("Use an http or https link.");
      return;
    }
    const name = decodeURIComponent(parsed.pathname.split("/").pop() || "model.gguf");
    const model: SavedModel = {
      id: newId(),
      name: name.replace(/\.gguf$/i, ""),
      kind: "url",
      repo: "",
      file: "",
      url: parsed.toString(),
      bytes: 0,
      opfsName: "",
      createdAt: Date.now(),
    };
    await saveModel(model);
    setUrl("");
    onChanged();
    onUse(model);
  }

  async function addCatalog(item: CatalogItem) {
    if (!item.file) {
      setCatalogBusy(true);
      try {
        setCatalog(await catalogFiles(item.repo));
        setCatalogNote(`Choose a GGUF file from ${item.repo}.`);
      } catch (error) {
        setCatalogNote(explain(error));
      } finally {
        setCatalogBusy(false);
      }
      return;
    }
    const existing = models.find(
      (model) => model.kind === "hf" && model.repo === item.repo && model.file === item.file,
    );
    const model: SavedModel =
      existing ??
      ({
        id: item.id,
        name: item.name,
        kind: "hf",
        repo: item.repo,
        file: item.file,
        url: "",
        bytes: item.bytes,
        opfsName: "",
        createdAt: Date.now(),
      } satisfies SavedModel);
    if (!existing) await saveModel(model);
    onChanged();
    onUse(model);
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        Kiln runs GGUF files in this browser with llama.cpp. Nothing is uploaded. Phones do best
        around 400 MB. Downloads go to {folder || "browser-managed storage"}. Hardware support and
        memory determine performance.
      </p>
      <button type="button" className="press h-11 rounded-md bg-subtle text-sm" onClick={onFolder}>
        {folder ? `Download folder: ${folder}` : "Choose download folder"}
      </button>
      {load.phase === "loading" ? (
        <button
          type="button"
          className="press h-11 rounded-md bg-subtle text-sm"
          onClick={() => {
            void unloadLocal();
            onUnload();
          }}
        >
          Cancel download
        </button>
      ) : null}
      {load.phase === "ready" ? (
        <button
          type="button"
          className="press h-11 rounded-md bg-subtle text-sm"
          onClick={onUnload}
        >
          Unload model and free memory
        </button>
      ) : null}
      <div>
        <h3 className="text-sm font-medium">Discover on Hugging Face</h3>
        <input
          value={modelQuery}
          onChange={(event) => setModelQuery(event.target.value)}
          placeholder="Search models"
          className="mt-2 h-11 w-full rounded-md border border-line bg-canvas px-3 text-base"
        />
        {catalogBusy ? (
          <p role="status" className="mt-2 text-sm text-muted">
            Searching live catalog?
          </p>
        ) : null}
        {catalogNote ? (
          <p role="status" className="mt-2 text-sm text-muted">
            {catalogNote}
          </p>
        ) : null}
        <div className="mt-2 flex flex-col gap-2">
          {catalog.map((item) => (
            <button
              key={item.id}
              type="button"
              className="press rounded-lg border border-line px-3 py-3 text-left"
              disabled={item.compatible === false}
              onClick={() => void addCatalog(item)}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{item.name}</span>
                <span className="shrink-0 font-mono text-xs text-faint">{item.size}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{item.blurb}</p>
              <p className="mt-1 text-xs text-faint">
                {item.file
                  ? `${item.quantization ?? "GGUF"} ? ${item.memory ?? footprint(item.bytes)}`
                  : "Select to inspect formats, quantization, and memory requirements"}
              </p>
            </button>
          ))}
          {catalog.length === 0 ? (
            <p className="text-sm text-faint">No results yet. Search a model name or repository.</p>
          ) : null}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium">On this device</h3>
        <div className="mt-2 flex flex-col gap-2">
          <button
            type="button"
            className="press h-11 rounded-md bg-subtle text-sm font-medium"
            onClick={() => fileRef.current?.click()}
          >
            Import a GGUF file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".gguf,application/octet-stream"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…/model.gguf"
              className="h-11 min-w-0 flex-1 rounded-md border border-line bg-canvas px-3 text-base"
            />
            <button
              type="button"
              className="press h-11 rounded-md bg-subtle px-3 text-sm font-medium"
              onClick={() => void addUrl()}
            >
              Use link
            </button>
          </div>
          {note ? <p className="text-sm text-danger">{note}</p> : null}
          {copyNote ? <p className="text-sm text-muted">{copyNote}</p> : null}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {models.length === 0 ? <p className="text-sm text-faint">No models saved yet.</p> : null}
          {models.map((model) => (
            <div
              key={model.id}
              className={`rounded-md border border-line px-3 py-3 ${model.id === activeId ? "bg-subtle" : ""}`}
            >
              <div className="font-medium">{model.name}</div>
              <div className="text-xs text-faint">
                {model.where ||
                  (model.opfsName
                    ? "Browser storage"
                    : model.kind === "file"
                      ? "This visit only"
                      : "Not downloaded yet")}
                {model.bytes ? ` · ${Math.round(model.bytes / 1_000_000)} MB` : ""}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="press h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink"
                  onClick={() => onUse(model)}
                >
                  Use
                </button>
                <button
                  type="button"
                  className="press h-11 rounded-md bg-subtle px-3 text-sm"
                  onClick={() => {
                    void (async () => {
                      try {
                        const blob = await fileForModel(model);
                        const file = new File([blob], model.file || `${model.name}.gguf`);
                        const folder = await copyFileToFolder(file);
                        setCopyNote(
                          `Copied into ${folder}. The running copy stays in browser storage.`,
                        );
                      } catch (error) {
                        setCopyNote(
                          error instanceof Error ? error.message : "Could not copy that file.",
                        );
                      }
                    })();
                  }}
                >
                  Copy to folder
                </button>
                <button
                  type="button"
                  className="press h-11 rounded-md px-3 text-sm text-danger"
                  onClick={() => {
                    if (armed !== model.id) {
                      setArmed(model.id);
                      return;
                    }
                    void (async () => {
                      try {
                        if (activeId === model.id) onUnload();
                        await deleteStoredModel(model);
                        onChanged();
                        setNote("Model deleted from its saved storage location.");
                      } catch (error) {
                        setNote(explain(error));
                      }
                    })();
                  }}
                >
                  {armed === model.id ? "Confirm" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function EndpointsTab({
  endpoints,
  activeId,
  editing,
  onEdit,
  onUse,
  onSave,
  onDelete,
}: {
  endpoints: Endpoint[];
  activeId: string;
  editing: Endpoint | null;
  onEdit: (endpoint: Endpoint | null) => void;
  onUse: (id: string) => void;
  onSave: (endpoint: Endpoint) => void;
  onDelete: (id: string) => void;
}) {
  const [choices, setChoices] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [checking, setChecking] = useState(false);

  async function check(endpoint: Endpoint) {
    setStatus("Checking…");
    setChoices([]);
    try {
      const ids = await listRemoteModels(endpoint);
      setChoices(ids);
      setStatus(
        ids.length
          ? `${ids.length} models`
          : "Connected. No model list came back — type the name yourself.",
      );
    } catch (error) {
      setStatus(explain(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Cloud calls are relayed so the provider accepts them. The key is sent with the request and
        not stored on the server. LM Studio and Ollama are called from this device.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.kind}
            type="button"
            className="press h-11 rounded-md border border-line text-sm font-medium"
            onClick={() => {
              const next = blankEndpoint(preset);
              onEdit(next);
              setChoices([]);
              setStatus("");
            }}
          >
            {preset.name}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {endpoints.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`press rounded-md px-3 py-3 text-left text-sm ${item.id === activeId ? "bg-subtle" : "border border-line"}`}
            onClick={() => {
              onEdit(item);
              setChoices([]);
              setStatus("");
            }}
          >
            <span className="font-medium">{item.name}</span>
            <span className="mt-1 block truncate text-xs text-faint">{item.model}</span>
          </button>
        ))}
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-3 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(editing);
            setStatus("Saved.");
          }}
        >
          <Field label="Name">
            <input
              className={fieldClass}
              value={editing.name}
              onChange={(event) => onEdit({ ...editing, name: event.target.value })}
            />
          </Field>
          <Field label="Provider">
            <select
              className={fieldClass}
              value={editing.kind}
              onChange={(event) => onEdit({ ...editing, kind: event.target.value as ProviderKind })}
            >
              {PRESETS.map((preset) => (
                <option key={preset.kind} value={preset.kind}>
                  {preset.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-sm text-muted">{presetByKind(editing.kind).hint}</p>
          {editing.kind !== "anthropic" ? (
            <Field label="Chat request profile">
              <select
                className={fieldClass}
                value={editing.chatProfile ?? "auto"}
                onChange={(event) =>
                  onEdit({ ...editing, chatProfile: event.target.value as Endpoint["chatProfile"] })
                }
              >
                <option value="auto">Automatic</option>
                <option value="standard">Standard · temperature and max_tokens</option>
                <option value="reasoning">
                  Reasoning · max_completion_tokens, provider sampling
                </option>
              </select>
              <span className="mt-1 block text-xs text-muted">
                Automatic recognizes OpenAI reasoning model families. For custom or Azure deployment
                names, choose the profile your model requires. Reasoning budgets include internal
                thinking; sampling uses provider defaults.
              </span>
            </Field>
          ) : null}
          <Field label="Base URL">
            <input
              className={fieldClass}
              value={editing.baseUrl}
              onChange={(event) => onEdit({ ...editing, baseUrl: event.target.value })}
            />
          </Field>
          <Field label={editing.kind === "azure-openai" ? "Deployment name" : "Model"}>
            <input
              className={fieldClass}
              value={editing.model}
              list="provider-discovered-models"
              onChange={(event) => onEdit({ ...editing, model: event.target.value })}
            />
          </Field>
          {editing.kind === "azure-openai" || editing.kind === "azure-ai" ? (
            <Field label="API version">
              <input
                className={fieldClass}
                value={editing.apiVersion}
                onChange={(event) => onEdit({ ...editing, apiVersion: event.target.value })}
              />
            </Field>
          ) : null}
          <fieldset className="rounded-md border border-line p-3">
            <legend className="px-1 text-sm">Confirmed capabilities</legend>
            <p className="mb-2 text-xs text-muted">
              Discovery metadata is shown when your provider reports it. Select only capabilities
              you have verified; media uses separate model defaults.
            </p>
            <div className="flex flex-wrap gap-3">
              {(
                ["chat", "vision", "image", "transcription", "speech", "video"] as Capability[]
              ).map((capability) => (
                <label key={capability} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.capabilities?.includes(capability) ?? false}
                    onChange={(event) =>
                      onEdit({
                        ...editing,
                        capabilities: event.target.checked
                          ? [...(editing.capabilities ?? []), capability]
                          : editing.capabilities?.filter((c) => c !== capability),
                      })
                    }
                  />
                  {capability}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              Provider metadata:{" "}
              {getDiscoveredCapabilities(editing.id, editing.model)?.join(", ") ||
                "Not reported. Support is unknown until a request or explicit confirmation."}
            </p>
          </fieldset>
          <Field label="API key">
            <div className="flex gap-2">
              <input
                className={fieldClass}
                type={showKey ? "text" : "password"}
                autoComplete="off"
                value={editing.apiKey}
                onChange={(event) => onEdit({ ...editing, apiKey: event.target.value })}
              />
              <button
                type="button"
                className="press h-11 rounded-md bg-subtle px-3 text-sm"
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-accent"
              checked={editing.direct || shouldDirect(editing)}
              onChange={(event) => onEdit({ ...editing, direct: event.target.checked })}
            />
            <span>
              Call from this device
              <span className="mt-1 block text-faint">
                {shouldDirect(editing)
                  ? "This address is reached from the browser. Turn on CORS if it is LM Studio or Ollama."
                  : "Off, so Kiln relays the call. Turn on for servers that already allow browsers."}
              </span>
            </span>
          </label>
          <datalist id="provider-discovered-models">
            {choices.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {choices.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {choices.slice(0, 12).map((id) => (
                <button
                  key={id}
                  type="button"
                  className="press h-11 rounded-md bg-subtle px-3 text-sm"
                  onClick={() => onEdit({ ...editing, model: id })}
                >
                  {id}
                </button>
              ))}
            </div>
          ) : null}
          {status ? <p className="text-sm text-muted">{status}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="press h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink"
            >
              Save and use
            </button>
            <button
              type="button"
              disabled={checking}
              className="press h-11 rounded-md bg-subtle px-3 text-sm"
              onClick={() => void check(editing)}
            >
              {checking ? "Connecting?" : "Test & discover models"}
            </button>
            {endpoints.some((item) => item.id === editing.id) ? (
              <button
                type="button"
                className="press h-11 rounded-md px-3 text-sm text-danger"
                onClick={() => onDelete(editing.id)}
              >
                Delete
              </button>
            ) : null}
            {endpoints.some((item) => item.id === editing.id) ? (
              <button
                type="button"
                className="press h-11 rounded-md px-3 text-sm"
                onClick={() => onUse(editing.id)}
              >
                Use
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-faint">{label}</span>
      {children}
    </label>
  );
}

export function StudioTab({
  install,
  onInstall,
  windows,
  standalone,
}: {
  install: InstallPrompt | null;
  onInstall: () => void;
  windows?: boolean;
  standalone?: boolean;
}) {
  const settings = useKiln((state) => state.settings);
  const update = useKiln((state) => state.updateSettings);
  const [transferNote, setTransferNote] = useState("");
  const [promptName, setPromptName] = useState("");
  const [promptText, setPromptText] = useState("");
  const [clearArmed, setClearArmed] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-faint">
        Keyboard shortcuts: Ctrl / Cmd K to search, Ctrl / Cmd N for a new conversation, Ctrl / Cmd
        , for settings.
      </p>
      <p className="text-sm text-muted">
        Chat is a conversation. Build writes software, and an HTML or JavaScript block can be
        previewed in a sandbox on this page.
      </p>
      <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={settings.rememberCredentials ?? false}
          onChange={(event) => update({ rememberCredentials: event.target.checked })}
        />
        <span>
          Remember API credentials on this device
          <span className="mt-1 block text-muted">
            When off, keys and tokens last for this session only. Remembered credentials use browser
            storage; use a trusted device.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="press h-11 rounded-md bg-subtle px-3 text-sm"
          onClick={() => downloadText("kiln-workspace.json", exportWorkspace())}
        >
          Export workspace
        </button>
        <button
          type="button"
          className="press h-11 rounded-md bg-subtle px-3 text-sm"
          onClick={() => importRef.current?.click()}
        >
          Import workspace
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file)
              void file
                .text()
                .then((text) => {
                  const result = importWorkspace(text);
                  setTransferNote(
                    `Imported ${result.threads} conversations and ${result.endpoints} providers. Credentials excluded.`,
                  );
                })
                .catch((error) => setTransferNote(explain(error)));
          }}
        />
      </div>
      {transferNote ? (
        <p role="status" className="text-sm text-muted">
          {transferNote}
        </p>
      ) : null}
      <Field label="Appearance">
        <div className="flex gap-2">
          {(["dark", "light"] as const).map((theme) => (
            <button
              key={theme}
              type="button"
              className={`press h-11 flex-1 rounded-md text-sm font-medium ${(settings.theme ?? "dark") === theme ? "bg-accent text-accent-ink" : "bg-subtle"}`}
              onClick={() => update({ theme })}
            >
              {theme === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </Field>
      <button
        type="button"
        className="press h-11 self-start rounded-md bg-subtle px-3 text-sm"
        onClick={() => {
          if (!clearArmed) {
            setClearArmed(true);
            return;
          }
          stopSpeaking();
          const fresh = useKiln.getState().newThread();
          useKiln.setState({
            threads: useKiln.getState().threads.filter((item) => item.id === fresh),
            folders: [],
          });
        }}
      >
        {clearArmed ? "Confirm clear all conversations" : "Clear chats on this device"}
      </button>
      <button
        type="button"
        className="press h-11 self-start rounded-md bg-subtle px-3 text-sm"
        onClick={() => {
          const threads = useKiln.getState().threads;
          downloadText(
            "kiln-chats.md",
            threads
              .map(
                (item) =>
                  `# ${item.title}\n\n${item.messages.map((message) => `## ${message.role}\n\n${message.content}`).join("\n\n")}`,
              )
              .join("\n\n"),
          );
        }}
      >
        Export chats
      </button>
      <button
        type="button"
        className="press h-11 self-start rounded-md px-3 text-sm text-danger"
        onClick={() => useKiln.getState().clearSecrets()}
      >
        Forget API keys and MCP tokens
      </button>
      <div className="rounded-md border border-line px-3 py-3 text-sm text-muted">
        <p className="font-medium text-ink">Storage & privacy</p>
        <p className="mt-2">
          Conversations and settings stay on this device. Browser model storage can be cleared by
          your browser; a selected folder uses filesystem permission where supported. Provider
          requests include the content you choose to send. Remote tools run only with your
          permission.
        </p>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={settings.reducedMotion ?? false}
          onChange={(event) => update({ reducedMotion: event.target.checked })}
        />
        Reduce motion
      </label>
      <Field label="Performance profile">
        <select
          className={fieldClass}
          value={settings.performanceProfile ?? "auto"}
          onChange={(event) =>
            update({
              performanceProfile: event.target.value as "auto" | "balanced" | "quality" | "saver",
            })
          }
        >
          <option value="auto">Auto ? detect hardware</option>
          <option value="balanced">Balanced</option>
          <option value="quality">Quality ? longer context</option>
          <option value="saver">Battery saver</option>
        </select>
      </Field>
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="font-medium">Reusable prompts</h3>
        <p className="text-xs text-muted">
          Saved prompts appear above your composer. Edit the draft before sending.
        </p>
        <Field label="Prompt name">
          <input
            className={fieldClass}
            value={promptName}
            onChange={(event) => setPromptName(event.target.value)}
          />
        </Field>
        <Field label="Prompt text">
          <textarea
            className="min-h-24 w-full rounded-md border border-line bg-canvas p-3"
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
          />
        </Field>
        <button
          type="button"
          disabled={!promptName.trim() || !promptText.trim()}
          className="press h-11 self-start rounded-md bg-accent px-3 text-sm text-accent-ink disabled:opacity-40"
          onClick={() => {
            update({
              promptTemplates: [
                ...(settings.promptTemplates ?? []),
                { id: newId(), name: promptName.trim(), text: promptText.trim() },
              ],
            });
            setPromptName("");
            setPromptText("");
          }}
        >
          Save reusable prompt
        </button>
        {settings.promptTemplates?.map((prompt) => (
          <div
            key={prompt.id}
            className="flex items-center gap-2 rounded-md border border-line p-3"
          >
            <span className="min-w-0 flex-1 truncate text-sm">{prompt.name}</span>
            <button
              type="button"
              className="press h-11 px-2 text-xs"
              onClick={() => {
                setPromptName(`${prompt.name} copy`);
                setPromptText(prompt.text);
              }}
            >
              Duplicate & edit
            </button>
            <button
              type="button"
              className="press h-11 px-2 text-xs text-danger"
              onClick={() =>
                update({
                  promptTemplates: settings.promptTemplates?.filter((p) => p.id !== prompt.id),
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <Field label="Text size">
        <select
          className={fieldClass}
          value={settings.fontSize ?? "normal"}
          onChange={(event) => update({ fontSize: event.target.value as "normal" | "large" })}
        >
          <option value="normal">Default</option>
          <option value="large">Large ? easier reading</option>
        </select>
      </Field>
      <p className="text-xs text-muted">
        Context tokens are estimates. Provider usage and billing remain in your provider dashboard;
        Kiln does not estimate prices when reliable rate data is unavailable.
      </p>
      <Field label="Chat prompt">
        <textarea
          value={settings.chatPrompt ?? CHAT_SYSTEM}
          onChange={(event) => update({ chatPrompt: event.target.value })}
          className="min-h-32 w-full rounded-md border border-line bg-canvas px-3 py-3 text-base"
        />
      </Field>
      <Field label="Build prompt">
        <textarea
          value={settings.systemPrompt}
          onChange={(event) => update({ systemPrompt: event.target.value })}
          className="min-h-32 w-full rounded-md border border-line bg-canvas px-3 py-3 text-base"
        />
      </Field>
      <button
        type="button"
        className="press h-11 self-start rounded-md px-3 text-sm text-muted"
        onClick={() => update({ systemPrompt: DEFAULT_SYSTEM, chatPrompt: CHAT_SYSTEM })}
      >
        Reset prompts
      </button>
      <Field label={`Temperature ${settings.temperature.toFixed(1)}`}>
        <input
          type="range"
          min={0}
          max={1.2}
          step={0.1}
          value={settings.temperature}
          onChange={(event) => update({ temperature: Number(event.target.value) })}
          className="w-full"
        />
      </Field>
      <Field label={`Max tokens ${settings.maxTokens}`}>
        <input
          type="range"
          min={128}
          max={4096}
          step={64}
          value={settings.maxTokens}
          onChange={(event) => update({ maxTokens: Number(event.target.value) })}
          className="w-full"
        />
      </Field>
      <Field label="Local context">
        <select
          className={fieldClass}
          value={settings.localCtx}
          onChange={(event) => update({ localCtx: Number(event.target.value) })}
        >
          <option value={1024}>1024 — lighter</option>
          <option value={2048}>2048 — default</option>
          <option value={4096}>4096 — more memory</option>
        </select>
      </Field>
      <InstallActions
        install={install}
        onInstall={onInstall}
        windows={windows}
        standalone={standalone}
      />
    </div>
  );
}

export function InstallActions({
  install,
  onInstall,
  windows,
  standalone,
  compact,
}: {
  install: InstallPrompt | null;
  onInstall: () => void;
  windows?: boolean;
  standalone?: boolean;
  compact?: boolean;
}) {
  if (standalone) {
    return <p className="text-xs text-faint">Kiln is running as an installed app.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {install ? (
        <button
          type="button"
          className="press h-11 rounded-md bg-accent text-sm font-medium text-accent-ink"
          onClick={onInstall}
        >
          Install Kiln
        </button>
      ) : null}
      <button
        type="button"
        className="press h-11 rounded-md bg-subtle text-sm font-medium"
        onClick={downloadWindowsInstaller}
      >
        {windows ? "Install on Windows" : "Download Windows installer"}
      </button>
      {compact ? null : (
        <p className="text-sm text-muted">
          On Windows, the download is Install-Kiln.bat. Double-click it. Edge or Chrome opens Kiln
          in its own window, and a Kiln shortcut is added to the Start menu and the desktop. If the
          browser offers Install Kiln, that is the same app without the extra file.
        </p>
      )}
    </div>
  );
}
