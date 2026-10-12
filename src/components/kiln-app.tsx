import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { Markdown } from "@/components/markdown-view";
import { isAbort, kindNeedsKey, listRemoteModels, streamChat } from "@/lib/cloud";
import {
  deleteModelRecord,
  deleteOpfs,
  holdSessionFile,
  isGguf,
  listModels,
  saveModel,
  writeOpfs,
} from "@/lib/library";
import { completeLocal, ensureLocal, isLoadCancelled, planRuntime, unloadLocal } from "@/lib/local-engine";
import { copyText } from "@/lib/preview-doc";
import { useKiln, threadMode } from "@/lib/store";
import {
  CATALOG,
  CHAT_SYSTEM,
  DEFAULT_SYSTEM,
  PRESETS,
  newId,
  presetByKind,
  type Endpoint,
  type ProviderKind,
  type SavedModel,
  type Thread,
  type WorkMode,
} from "@/lib/types";
import { endpointLabel, fitMessages, shouldDirect } from "@/lib/wire";
import { downloadWindowsInstaller, isWindowsDevice } from "@/lib/windows-install";

type Panel = "threads" | "library" | null;
type Tab = "endpoints" | "models" | "studio";
type LoadState =
  | { phase: "idle" }
  | { phase: "loading"; label: string; ratio: number | null }
  | { phase: "ready"; name: string; note: string }
  | { phase: "error"; message: string };

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

const BUILD_STARTERS = [
  "Build a phone-friendly tip calculator as one HTML file.",
  "Write a Python script that prints a directory tree.",
  "Design a SQLite schema for a reading list, plus the queries to use it.",
  "Turn a JSON list of expenses into a sortable HTML table.",
];

const CHAT_STARTERS = [
  "Walk me through why a service worker is required before Windows will install a site.",
  "Compare SQLite and Postgres for a small personal app.",
  "I'll paste an error next. What should I include so you can help?",
  "Help me decide what belongs in Chat versus Build.",
];

function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (/quota|not enough space|storage/i.test(message)) return "Not enough free space on this device.";
  if (/out of memory|oom|aborted\(\)|memory access/i.test(message)) {
    return "This device ran out of memory. Try a smaller model and close other tabs.";
  }
  return message;
}

function clipTitle(text: string): string {
  const line = text.trim().split("\n")[0] || "New chat";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

function blankEndpoint(preset = PRESETS[0]): Endpoint {
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

export function KilnApp() {
  const kiln = useKiln();
  const thread = kiln.threads.find((item) => item.id === kiln.activeThreadId) ?? kiln.threads[0];
  const endpoint = kiln.endpoints.find((item) => item.id === kiln.activeId);
  const [panel, setPanel] = useState<Panel>(null);
  const [tab, setTab] = useState<Tab>("models");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ id: string; content: string } | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "idle" });
  const [models, setModels] = useState<SavedModel[]>([]);
  const [preview, setPreview] = useState<{ title: string; html: string } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [windows, setWindows] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const localName = models.find((model) => model.id === kiln.localModelId)?.name ?? null;
  const chip = endpointLabel(endpoint, localName, kiln.activeId);

  useEffect(() => {
    void Promise.resolve(useKiln.persist.rehydrate()).then(() => {
      const state = useKiln.getState();
      const active = state.threads.find((item) => item.id === state.activeThreadId) ?? state.threads[0];
      const next = active?.mode ?? "build";
      if (next !== state.mode) useKiln.setState({ mode: next });
    });
    void refreshModels();
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    setWindows(isWindowsDevice());
    const display = window.matchMedia("(display-mode: standalone)");
    const syncDisplay = () => setStandalone(display.matches);
    syncDisplay();
    display.addEventListener("change", syncDisplay);
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js");
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      display.removeEventListener("change", syncDisplay);
    };
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [thread?.messages, live?.content, thread?.id]);

  async function refreshModels() {
    try {
      setModels(await listModels());
    } catch {
      setModels([]);
    }
  }

  function openPreview(html: string, title: string) {
    setPreview({ html, title });
    setPreviewOpen(true);
  }

  async function activate(model: SavedModel) {
    kiln.setLocalModelId(model.id);
    setPanel(null);
    setLoad({ phase: "loading", label: "Starting", ratio: null });
    try {
      await ensureLocal(model, useKiln.getState().settings.localCtx, (label, ratio) => {
        setLoad({ phase: "loading", label, ratio });
      });
      setLoad({ phase: "ready", name: model.name, note: planRuntime(useKiln.getState().settings.localCtx, 512).note });
    } catch (error) {
      if (isLoadCancelled(error)) return;
      setLoad({ phase: "error", message: explain(error) });
    }
  }

  async function sendText(text: string, again = false) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const state = useKiln.getState();
    const threadId = state.activeThreadId;
    const active = state.endpoints.find((item) => item.id === state.activeId);

    if (state.activeId === "local") {
      if (!state.localModelId) {
        setTab("models");
        setPanel("library");
        return;
      }
    } else if (!active) {
      setTab("endpoints");
      setPanel("library");
      return;
    } else if (!active.model.trim() || (kindNeedsKey(active.kind) && !active.apiKey.trim() && !shouldDirect(active))) {
      setEditing(active);
      setTab("endpoints");
      setPanel("library");
      return;
    }

    if (!again) {
      state.appendMessage(threadId, { id: newId(), role: "user", content: trimmed });
      state.titleIfBlank(threadId, clipTitle(trimmed));
      setDraft("");
      if (boxRef.current) boxRef.current.style.height = "auto";
    }

    const assistantId = newId();
    const via =
      state.activeId === "local"
        ? `Local · ${models.find((model) => model.id === state.localModelId)?.name ?? "model"}`
        : endpointLabel(active, null, state.activeId);
    useKiln.getState().appendMessage(threadId, { id: assistantId, role: "assistant", content: "" }, via);
    setLive({ id: assistantId, content: "" });

    const history = useKiln
      .getState()
      .threads.find((item) => item.id === threadId)
      ?.messages.filter((message) => message.id !== assistantId && message.content.trim() && !message.error)
      .map((message) => ({ role: message.role, content: message.content })) ?? [];
    const settings = useKiln.getState().settings;
    const mode = threadMode(
      useKiln.getState().threads.find((item) => item.id === threadId),
      state.mode,
    );
    const system = mode === "chat" ? settings.chatPrompt?.trim() || CHAT_SYSTEM : settings.systemPrompt.trim() || DEFAULT_SYSTEM;
    const maxChars = state.activeId === "local" ? Math.max(1800, settings.localCtx * 3) : 100_000;
    const messages = fitMessages([{ role: "system" as const, content: system }, ...history], maxChars);

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    stickRef.current = true;
    let full = "";
    let lastWrite = 0;
    const paint = (next: string, force = false) => {
      full = next;
      setLive({ id: assistantId, content: next });
      const now = Date.now();
      if (force || now - lastWrite > 400) {
        lastWrite = now;
        useKiln.getState().updateMessage(threadId, assistantId, { content: next, error: false });
      }
    };

    try {
      if (state.activeId === "local") {
        const saved = (await listModels()).find((model) => model.id === useKiln.getState().localModelId);
        if (!saved) throw new Error("Choose a model on this device first.");
        const plan = planRuntime(settings.localCtx, settings.maxTokens);
        await ensureLocal(saved, plan.ctx, (label, ratio) => setLoad({ phase: "loading", label, ratio }));
        setLoad({ phase: "ready", name: saved.name, note: plan.note });
        await completeLocal(messages, settings.temperature, plan.maxTokens, controller.signal, paint);
      } else if (active) {
        await streamChat({
          endpoint: active,
          messages,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          signal: controller.signal,
          onDelta: paint,
        });
      }
      useKiln.getState().updateMessage(threadId, assistantId, {
        content: full || "The model returned an empty reply.",
        error: !full,
      });
    } catch (error) {
      if (isAbort(error) || isLoadCancelled(error)) {
        if (full) useKiln.getState().updateMessage(threadId, assistantId, { content: full });
        else useKiln.getState().removeMessage(threadId, assistantId);
      } else {
        const message = explain(error);
        useKiln.getState().updateMessage(threadId, assistantId, {
          content: full ? `${full}\n\nError: ${message}` : `Error: ${message}`,
          error: !full,
        });
      }
    } finally {
      setLive(null);
      setBusy(false);
      abortRef.current = null;
    }
  }

  function regenerate() {
    if (!thread || busy) return;
    const last = thread.messages[thread.messages.length - 1];
    const prev = thread.messages[thread.messages.length - 2];
    if (!last || last.role !== "assistant" || !prev || prev.role !== "user") return;
    kiln.removeMessage(thread.id, last.id);
    void sendText(prev.content, true);
  }

  const shownLoad =
    load.phase === "loading"
      ? `${load.label}${load.ratio != null ? ` ${Math.round(load.ratio * 100)}%` : ""}`
      : load.phase === "error"
        ? load.message
        : load.phase === "ready"
          ? `${load.name} is ready. ${load.note}`
          : "";

  const mode = threadMode(thread, kiln.mode);
  const visibleThreads = kiln.threads.filter((item) => threadMode(item, "build") === mode);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-line lg:flex">
        <ThreadPane
          threads={visibleThreads}
          activeId={kiln.activeThreadId}
          mode={mode}
          onNew={() => {
            kiln.newThread();
            setPanel(null);
          }}
          onSelect={(id) => {
            abortRef.current?.abort();
            kiln.selectThread(id);
          }}
          onDelete={kiln.removeThread}
          install={install}
          onInstall={() => void install?.prompt()}
          windows={windows}
          standalone={standalone}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="safe-top flex items-center gap-2 border-b border-line px-3 py-2">
          <button type="button" className="press h-11 rounded-md px-3 text-sm lg:hidden" onClick={() => setPanel("threads")}>
            Chats
          </button>
          <div className="flex h-11 items-center rounded-md bg-subtle p-1" role="group" aria-label="Mode">
            {(
              [
                ["chat", "Chat"],
                ["build", "Build"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                className={`press h-9 rounded-md px-3 text-sm font-medium ${mode === id ? "bg-accent text-accent-ink" : "text-muted"}`}
                onClick={() => {
                  if (mode === id) return;
                  abortRef.current?.abort();
                  kiln.setMode(id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="press ml-auto h-11 min-w-0 max-w-32 shrink truncate rounded-md bg-subtle px-3 text-sm sm:max-w-xs"
            onClick={() => {
              setTab(kiln.activeId === "local" ? "models" : "endpoints");
              setPanel("library");
            }}
          >
            {chip}
          </button>
        </header>

        {shownLoad ? (
          <p
            role="status"
            className={`border-b border-line px-4 py-2 text-sm ${load.phase === "error" ? "text-danger" : "text-muted"}`}
          >
            {shownLoad}
          </p>
        ) : null}

        <div
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {thread && thread.messages.length === 0 ? (
              <Empty
                mode={mode}
                onPick={(prompt) => {
                  setDraft(prompt);
                  void sendText(prompt);
                }}
              />
            ) : null}
            {thread?.messages.map((message) => {
              const content = live?.id === message.id ? live.content : message.content;
              const streaming = busy && live?.id === message.id;
              return (
                <article key={message.id} className={message.role === "user" ? "ml-auto max-w-prose" : "max-w-3xl"}>
                  <div className="mb-1 text-xs font-medium text-faint">{message.role === "user" ? "You" : "Kiln"}</div>
                  <div className={message.role === "user" ? "rounded-lg bg-subtle px-4 py-3" : ""}>
                    {message.role === "assistant" ? (
                      message.error ? (
                        <p className="text-danger">{content}</p>
                      ) : content ? (
                        <Markdown text={content} onPreview={openPreview} />
                      ) : streaming ? (
                        <Writing />
                      ) : null
                    ) : (
                      <p className="whitespace-pre-wrap">{content}</p>
                    )}
                    {streaming && content ? <span className="caret" /> : null}
                  </div>
                  {message.role === "assistant" && content && !streaming ? (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="press h-11 rounded-md px-3 text-sm text-muted"
                        onClick={() => void copyText(content)}
                      >
                        Copy
                      </button>
                      {thread.messages[thread.messages.length - 1]?.id === message.id ? (
                        <button type="button" className="press h-11 rounded-md px-3 text-sm text-muted" onClick={regenerate}>
                          Regenerate
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>

        <form
          className="safe-bottom border-t border-line px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendText(draft);
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Message</span>
              <textarea
                ref={boxRef}
                value={draft}
                rows={1}
                placeholder={mode === "build" ? "Describe what to build" : "Message Kiln"}
                className="max-h-40 w-full resize-none rounded-lg border border-line bg-elevated px-3 py-3 text-base outline-none"
                onChange={(event) => setDraft(event.target.value)}
                onInput={(event) => {
                  const el = event.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  if (window.matchMedia("(pointer: coarse)").matches) return;
                  event.preventDefault();
                  void sendText(draft);
                }}
              />
            </label>
            {busy ? (
              <button
                type="button"
                className="press h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink"
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim()}
                className="press h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
          <p className="mx-auto mt-2 w-full max-w-3xl text-xs text-faint">
            Keys stay in this browser. On a phone, Enter adds a line.
          </p>
        </form>
      </div>

      {preview ? (
        <section
          className={`${previewOpen ? "fixed inset-x-0 bottom-0 z-30 flex h-[78dvh]" : "hidden"} min-w-0 flex-col border-line bg-elevated lg:static lg:z-auto lg:flex lg:h-auto lg:flex-1 lg:border-l`}
        >
          <div className="safe-top flex items-center gap-2 border-b border-line px-3 py-2">
            <h2 className="truncate text-sm font-medium">Preview · {preview.title}</h2>
            <button
              type="button"
              className="press ml-auto h-11 rounded-md px-3 text-sm"
              onClick={() => {
                setPreview(null);
                setPreviewOpen(false);
              }}
            >
              Close
            </button>
          </div>
          <iframe title="Code preview" sandbox="allow-scripts" srcDoc={preview.html} className="min-h-0 w-full flex-1 bg-canvas" />
        </section>
      ) : null}

      {panel === "threads" ? (
        <Overlay title="Chats" onClose={() => setPanel(null)}>
          <ThreadPane
            threads={visibleThreads}
            activeId={kiln.activeThreadId}
            mode={mode}
            onNew={() => {
              kiln.newThread();
              setPanel(null);
            }}
            onSelect={(id) => {
              abortRef.current?.abort();
              kiln.selectThread(id);
              setPanel(null);
            }}
            onDelete={kiln.removeThread}
            install={install}
            onInstall={() => void install?.prompt()}
            windows={windows}
            standalone={standalone}
          />
        </Overlay>
      ) : null}

      {panel === "library" ? (
        <Overlay title="Library" onClose={() => setPanel(null)}>
          <div className="mb-4 flex gap-2">
            {(
              [
                ["models", "Models"],
                ["endpoints", "Endpoints"],
                ["studio", "Studio"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`press h-11 flex-1 rounded-md text-sm font-medium ${tab === id ? "bg-accent text-accent-ink" : "bg-subtle"}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "models" ? (
            <ModelsTab
              models={models}
              activeId={kiln.localModelId}
              load={load}
              onUse={(model) => void activate(model)}
              onChanged={() => void refreshModels()}
              onUnload={() => {
                void unloadLocal();
                setLoad({ phase: "idle" });
              }}
            />
          ) : null}
          {tab === "endpoints" ? (
            <EndpointsTab
              endpoints={kiln.endpoints}
              activeId={kiln.activeId}
              editing={editing}
              onEdit={setEditing}
              onUse={(id) => {
                kiln.setActiveId(id);
                setPanel(null);
              }}
              onSave={(next) => {
                kiln.upsertEndpoint(next);
                kiln.setActiveId(next.id);
                setEditing(next);
              }}
              onDelete={(id) => {
                kiln.removeEndpoint(id);
                setEditing(null);
              }}
            />
          ) : null}
          {tab === "studio" ? (
            <StudioTab
              install={install}
              onInstall={() => void install?.prompt()}
              windows={windows}
              standalone={standalone}
            />
          ) : null}
        </Overlay>
      ) : null}
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end lg:items-stretch lg:justify-end">
      <button type="button" className="absolute inset-0 bg-canvas/70" aria-label="Close" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet sheet-side safe-bottom relative z-10 flex max-h-[92dvh] w-full flex-col rounded-t-xl border border-line bg-elevated lg:h-full lg:max-h-none lg:max-w-md lg:rounded-none lg:border-y-0 lg:border-r-0"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-lg font-medium">{title}</h2>
          <button type="button" className="press ml-auto h-11 rounded-md px-3 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

function Writing() {
  return (
    <p className="writing" role="status">
      <span />
      <span />
      <span />
      Thinking
    </p>
  );
}

function Empty({ mode, onPick }: { mode: WorkMode; onPick: (prompt: string) => void }) {
  const build = mode === "build";
  const starters = build ? BUILD_STARTERS : CHAT_STARTERS;
  return (
    <div className="py-8">
      <h1 className="text-xl font-medium tracking-tight">{build ? "What should we build?" : "What do you want to talk through?"}</h1>
      <p className="mt-3 max-w-prose text-muted">
        {build
          ? "Build writes files, scripts, and small apps. An HTML reply can be previewed on this page. Switch to Chat when you want a conversation instead of a deliverable."
          : "Chat explains, compares, and debugs without turning every answer into a project. Switch to Build when you want a file you can run."}
      </p>
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {starters.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="press rounded-lg border border-line bg-elevated px-4 py-3 text-left text-sm"
            onClick={() => onPick(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadPane({
  threads,
  activeId,
  mode,
  onNew,
  onSelect,
  onDelete,
  install,
  onInstall,
  windows,
  standalone,
}: {
  threads: Thread[];
  activeId: string;
  mode: WorkMode;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  install: InstallPrompt | null;
  onInstall: () => void;
  windows?: boolean;
  standalone?: boolean;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="text-lg font-medium tracking-tight lg:inline">Kiln</span>
        <button type="button" className="press ml-auto h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink" onClick={onNew}>
          {mode === "build" ? "New build" : "New chat"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {threads.map((thread) => (
          <div key={thread.id} className={`mb-1 flex items-stretch rounded-md ${thread.id === activeId ? "bg-subtle" : ""}`}>
            <button type="button" className="min-w-0 flex-1 px-3 py-3 text-left" onClick={() => onSelect(thread.id)}>
              <div className="truncate text-sm font-medium">{thread.title}</div>
              <div className="truncate text-xs text-faint">
                <When at={thread.updatedAt} />
                {thread.via ? ` · ${thread.via}` : ""}
              </div>
            </button>
            <button
              type="button"
              className="press px-3 text-xs text-faint"
              onClick={() => {
                if (armed === thread.id) onDelete(thread.id);
                else setArmed(thread.id);
              }}
            >
              {armed === thread.id ? "Confirm" : "Delete"}
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-line px-3 py-3">
        <InstallActions install={install} onInstall={onInstall} windows={windows} standalone={standalone} compact />
      </div>
    </div>
  );
}

function When({ at }: { at: number }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(formatDistanceToNow(at, { addSuffix: true }));
  }, [at]);
  return <span className="tabular-nums">{label}</span>;
}

function ModelsTab({
  models,
  activeId,
  load,
  onUse,
  onChanged,
  onUnload,
}: {
  models: SavedModel[];
  activeId: string | null;
  load: LoadState;
  onUse: (model: SavedModel) => void;
  onChanged: () => void;
  onUnload: () => void;
}) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
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
      await writeOpfs(model.opfsName, file, () => undefined);
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

  async function addCatalog(item: (typeof CATALOG)[number]) {
    const existing = models.find((model) => model.kind === "hf" && model.repo === item.repo && model.file === item.file);
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
        Kiln runs GGUF files in this browser with llama.cpp. Nothing is uploaded. Phones do best around 400 MB.
        The first reply is slow, then it settles.
      </p>
      {load.phase === "ready" ? (
        <button type="button" className="press h-11 rounded-md bg-subtle text-sm" onClick={onUnload}>
          Unload model and free memory
        </button>
      ) : null}
      <div>
        <h3 className="text-sm font-medium">Suggested downloads</h3>
        <div className="mt-2 flex flex-col gap-2">
          {CATALOG.map((item) => (
            <button
              key={item.id}
              type="button"
              className="press rounded-lg border border-line px-3 py-3 text-left"
              onClick={() => void addCatalog(item)}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{item.name}</span>
                <span className="shrink-0 font-mono text-xs text-faint">{item.size}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{item.blurb}</p>
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium">On this device</h3>
        <div className="mt-2 flex flex-col gap-2">
          <button type="button" className="press h-11 rounded-md bg-subtle text-sm font-medium" onClick={() => fileRef.current?.click()}>
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
            <button type="button" className="press h-11 rounded-md bg-subtle px-3 text-sm font-medium" onClick={() => void addUrl()}>
              Use link
            </button>
          </div>
          {note ? <p className="text-sm text-danger">{note}</p> : null}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {models.length === 0 ? <p className="text-sm text-faint">No models saved yet.</p> : null}
          {models.map((model) => (
            <div key={model.id} className={`rounded-md border border-line px-3 py-3 ${model.id === activeId ? "bg-subtle" : ""}`}>
              <div className="font-medium">{model.name}</div>
              <div className="text-xs text-faint">
                {model.kind === "file" ? "Imported file" : model.kind === "hf" ? "Downloaded when you use it" : "Link"}
                {model.opfsName ? "" : model.kind === "file" ? " · this visit only" : ""}
                {model.bytes ? ` · ${Math.round(model.bytes / 1_000_000)} MB` : ""}
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" className="press h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink" onClick={() => onUse(model)}>
                  Use
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
                      await deleteOpfs(model.opfsName);
                      await deleteModelRecord(model.id);
                      if (activeId === model.id) onUnload();
                      onChanged();
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

function EndpointsTab({
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

  async function check(endpoint: Endpoint) {
    setStatus("Checking…");
    setChoices([]);
    try {
      const ids = await listRemoteModels(endpoint);
      setChoices(ids);
      setStatus(ids.length ? `${ids.length} models` : "Connected. No model list came back — type the name yourself.");
    } catch (error) {
      setStatus(explain(error));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Cloud calls are relayed so the provider accepts them. The key is sent with the request and not stored on the
        server. LM Studio and Ollama are called from this device.
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
            <input className={fieldClass} value={editing.name} onChange={(event) => onEdit({ ...editing, name: event.target.value })} />
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
          <Field label="Base URL">
            <input className={fieldClass} value={editing.baseUrl} onChange={(event) => onEdit({ ...editing, baseUrl: event.target.value })} />
          </Field>
          <Field label={editing.kind === "azure-openai" ? "Deployment name" : "Model"}>
            <input className={fieldClass} value={editing.model} onChange={(event) => onEdit({ ...editing, model: event.target.value })} />
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
          <Field label="API key">
            <div className="flex gap-2">
              <input
                className={fieldClass}
                type={showKey ? "text" : "password"}
                autoComplete="off"
                value={editing.apiKey}
                onChange={(event) => onEdit({ ...editing, apiKey: event.target.value })}
              />
              <button type="button" className="press h-11 rounded-md bg-subtle px-3 text-sm" onClick={() => setShowKey((value) => !value)}>
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
          {choices.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {choices.slice(0, 12).map((id) => (
                <button key={id} type="button" className="press h-11 rounded-md bg-subtle px-3 text-sm" onClick={() => onEdit({ ...editing, model: id })}>
                  {id}
                </button>
              ))}
            </div>
          ) : null}
          {status ? <p className="text-sm text-muted">{status}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="press h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink">
              Save and use
            </button>
            <button type="button" className="press h-11 rounded-md bg-subtle px-3 text-sm" onClick={() => void check(editing)}>
              List models
            </button>
            {endpoints.some((item) => item.id === editing.id) ? (
              <button type="button" className="press h-11 rounded-md px-3 text-sm text-danger" onClick={() => onDelete(editing.id)}>
                Delete
              </button>
            ) : null}
            {endpoints.some((item) => item.id === editing.id) ? (
              <button type="button" className="press h-11 rounded-md px-3 text-sm" onClick={() => onUse(editing.id)}>
                Use
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

const fieldClass = "h-11 w-full rounded-md border border-line bg-canvas px-3 text-base";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-faint">{label}</span>
      {children}
    </label>
  );
}

function StudioTab({
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
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Chat is a conversation. Build writes software, and an HTML or JavaScript block can be previewed in a sandbox
        on this page.
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
      <InstallActions install={install} onInstall={onInstall} windows={windows} standalone={standalone} />
    </div>
  );
}

function InstallActions({
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
        <button type="button" className="press h-11 rounded-md bg-accent text-sm font-medium text-accent-ink" onClick={onInstall}>
          Install Kiln
        </button>
      ) : null}
      <button type="button" className="press h-11 rounded-md bg-subtle text-sm font-medium" onClick={downloadWindowsInstaller}>
        {windows ? "Install on Windows" : "Download Windows installer"}
      </button>
      {compact ? null : (
        <p className="text-sm text-muted">
          On Windows, the download is Install-Kiln.bat. Double-click it. Edge or Chrome opens Kiln in its own window,
          and a Kiln shortcut is added to the Start menu and the desktop. If the browser offers Install Kiln, that
          is the same app without the extra file.
        </p>
      )}
    </div>
  );
}
