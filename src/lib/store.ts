import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { workspaceStorage } from "@/lib/workspace-storage";
import {
  DEFAULT_SETTINGS,
  newId,
  type ChatMessage,
  type Endpoint,
  type Settings,
  type Thread,
  type WorkMode,
  type Folder,
  type McpServer,
} from "@/lib/types";

const WELCOME_ID = "thread-welcome";

function blankThread(mode: WorkMode = "chat"): Thread {
  return {
    id: WELCOME_ID,
    title: mode === "build" ? "New build" : "New chat",
    messages: [],
    updatedAt: Date.now(),
    mode,
  };
}

function freshThread(mode: WorkMode): Thread {
  return {
    id: newId(),
    title: mode === "build" ? "New build" : "New chat",
    messages: [],
    updatedAt: Date.now(),
    mode,
  };
}

export function threadMode(
  thread: Pick<Thread, "mode"> | undefined,
  fallback: WorkMode = "build",
): WorkMode {
  return thread?.mode ?? fallback;
}

type State = {
  endpoints: Endpoint[];
  activeId: string;
  localModelId: string | null;
  threads: Thread[];
  activeThreadId: string;
  settings: Settings;
  mode: WorkMode;
  folders: Folder[];
  mcpServers: McpServer[];
  toolGrants: Record<string, boolean>;
  setMode: (mode: WorkMode) => void;
  setActiveId: (id: string) => void;
  setLocalModelId: (id: string | null) => void;
  upsertEndpoint: (endpoint: Endpoint) => void;
  removeEndpoint: (id: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  newThread: () => string;
  selectThread: (id: string) => void;
  removeThread: (id: string) => void;
  appendMessage: (threadId: string, message: ChatMessage, via?: string) => void;
  updateMessage: (threadId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  removeMessage: (threadId: string, messageId: string) => void;
  titleIfBlank: (threadId: string, title: string) => void;
  renameThread: (threadId: string, title: string) => void;
  setThreadFolder: (threadId: string, folderId: string | null) => void;
  addFolder: (name: string) => void;
  renameFolder: (id: string, name: string) => void;
  removeFolder: (id: string) => void;
  truncateFrom: (threadId: string, messageId: string) => void;
  upsertMcp: (server: McpServer) => void;
  removeMcp: (id: string) => void;
  setToolGrant: (serverId: string, tool: string, allowed: boolean) => void;
  clearSecrets: () => void;
  archiveThread: (id: string, archived: boolean) => void;
  forkThread: (id: string, messageId: string, include?: boolean) => string;
};

export const useKiln = create<State>()(
  persist(
    (set, get) => ({
      endpoints: [],
      activeId: "local",
      localModelId: null,
      threads: [blankThread("chat")],
      activeThreadId: WELCOME_ID,
      settings: DEFAULT_SETTINGS,
      mode: "chat",
      folders: [],
      mcpServers: [],
      toolGrants: {},
      setMode: (mode) =>
        set((state) => {
          if (
            state.mode === mode &&
            state.threads.some(
              (thread) =>
                thread.id === state.activeThreadId && threadMode(thread, "build") === mode,
            )
          ) {
            return { mode };
          }
          const match = state.threads.find((thread) => threadMode(thread, "build") === mode);
          if (match) return { mode, activeThreadId: match.id };
          const thread = freshThread(mode);
          return { mode, threads: [thread, ...state.threads], activeThreadId: thread.id };
        }),
      setActiveId: (id) => set({ activeId: id }),
      setLocalModelId: (id) => set({ localModelId: id, activeId: "local" }),
      upsertEndpoint: (endpoint) =>
        set((state) => {
          const exists = state.endpoints.some((item) => item.id === endpoint.id);
          return {
            endpoints: exists
              ? state.endpoints.map((item) => (item.id === endpoint.id ? endpoint : item))
              : [...state.endpoints, endpoint],
          };
        }),
      removeEndpoint: (id) =>
        set((state) => ({
          endpoints: state.endpoints.filter((item) => item.id !== id),
          activeId: state.activeId === id ? "local" : state.activeId,
        })),
      updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
      newThread: () => {
        let id = "";
        set((state) => {
          const thread = freshThread(state.mode);
          id = thread.id;
          return { threads: [thread, ...state.threads], activeThreadId: thread.id };
        });
        return id;
      },
      selectThread: (id) => {
        const thread = get().threads.find((item) => item.id === id);
        if (thread) set({ activeThreadId: id, mode: thread.mode ?? "build" });
      },
      removeThread: (id) =>
        set((state) => {
          const gone = state.threads.find((thread) => thread.id === id);
          const mode = threadMode(gone, state.mode);
          const threads = state.threads.filter((thread) => thread.id !== id);
          const same = threads.filter((thread) => threadMode(thread, "build") === mode);
          if (same.length === 0) {
            const fresh = freshThread(mode);
            return {
              threads: [fresh, ...threads],
              activeThreadId: state.activeThreadId === id ? fresh.id : state.activeThreadId,
              mode: state.activeThreadId === id ? mode : state.mode,
            };
          }
          const activeThreadId = state.activeThreadId === id ? same[0].id : state.activeThreadId;
          return { threads, activeThreadId };
        }),
      appendMessage: (threadId, message, via) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: [...thread.messages, message],
                  updatedAt: Date.now(),
                  via: via ?? thread.via,
                }
              : thread,
          ),
        })),
      updateMessage: (threadId, messageId, patch) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: thread.messages.map((message) =>
                    message.id === messageId ? { ...message, ...patch } : message,
                  ),
                  updatedAt: Date.now(),
                }
              : thread,
          ),
        })),
      removeMessage: (threadId, messageId) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: thread.messages.filter((message) => message.id !== messageId),
                }
              : thread,
          ),
        })),
      titleIfBlank: (threadId, title) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId && (thread.title === "New chat" || thread.title === "New build")
              ? { ...thread, title }
              : thread,
          ),
        })),
      renameThread: (threadId, title) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, title: title.trim().slice(0, 80) || thread.title }
              : thread,
          ),
        })),
      setThreadFolder: (threadId, folderId) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId ? { ...thread, folderId: folderId ?? undefined } : thread,
          ),
        })),
      addFolder: (name) =>
        set((state) => ({
          folders: [
            ...state.folders,
            { id: newId(), name: name.trim().slice(0, 40) || "Folder" },
          ].slice(0, 20),
        })),
      renameFolder: (id, name) =>
        set((state) => ({
          folders: state.folders.map((folder) =>
            folder.id === id
              ? { ...folder, name: name.trim().slice(0, 40) || folder.name }
              : folder,
          ),
        })),
      removeFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((folder) => folder.id !== id),
          threads: state.threads.map((thread) =>
            thread.folderId === id ? { ...thread, folderId: undefined } : thread,
          ),
        })),
      truncateFrom: (threadId, messageId) =>
        set((state) => ({
          threads: state.threads.map((thread) => {
            if (thread.id !== threadId) return thread;
            const index = thread.messages.findIndex((message) => message.id === messageId);
            if (index < 0) return thread;
            return { ...thread, messages: thread.messages.slice(0, index), updatedAt: Date.now() };
          }),
        })),
      upsertMcp: (server) =>
        set((state) => ({
          mcpServers: state.mcpServers.some((item) => item.id === server.id)
            ? state.mcpServers.map((item) => (item.id === server.id ? server : item))
            : [...state.mcpServers, server].slice(0, 12),
        })),
      removeMcp: (id) =>
        set((state) => ({
          mcpServers: state.mcpServers.filter((item) => item.id !== id),
          toolGrants: Object.fromEntries(
            Object.entries(state.toolGrants).filter(([key]) => !key.startsWith(`${id}:`)),
          ),
        })),
      setToolGrant: (serverId, tool, allowed) =>
        set((state) => ({ toolGrants: { ...state.toolGrants, [`${serverId}:${tool}`]: allowed } })),
      clearSecrets: () =>
        set((state) => ({
          endpoints: state.endpoints.map((endpoint) => ({ ...endpoint, apiKey: "" })),
          mcpServers: state.mcpServers.map((server) => ({ ...server, token: "" })),
        })),
      archiveThread: (id, archived) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === id ? { ...thread, archived } : thread,
          ),
        })),
      forkThread: (id, messageId, include = true) => {
        const source = get().threads.find((thread) => thread.id === id);
        const index = source?.messages.findIndex((message) => message.id === messageId) ?? -1;
        if (!source || index < 0) return id;
        const branch: Thread = {
          ...source,
          id: newId(),
          title: `${source.title} · branch`,
          messages: source.messages
            .slice(0, index + (include ? 1 : 0))
            .map((message) => ({ ...message })),
          parentThreadId: source.id,
          archived: false,
          updatedAt: Date.now(),
        };
        set((state) => ({
          threads: [branch, ...state.threads],
          activeThreadId: branch.id,
          mode: branch.mode ?? "build",
        }));
        return branch.id;
      },
    }),
    {
      name: "kiln-v1",
      storage: createJSONStorage(() => workspaceStorage),
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<State>;
        return {
          endpoints: state.endpoints ?? [],
          activeId: state.activeId ?? "local",
          localModelId: state.localModelId ?? null,
          threads: state.threads ?? [blankThread()],
          activeThreadId: state.activeThreadId ?? WELCOME_ID,
          mode: state.mode ?? "chat",
          folders: state.folders ?? [],
          mcpServers: state.mcpServers ?? [],
          toolGrants: state.toolGrants ?? {},
          settings: {
            ...DEFAULT_SETTINGS,
            ...state.settings,
            rememberCredentials: state.settings?.rememberCredentials ?? true,
          },
        };
      },
      merge: (persisted, current) => {
        const state = persisted as Partial<State> | undefined;
        return { ...current, ...state, settings: { ...DEFAULT_SETTINGS, ...state?.settings } };
      },
      skipHydration: true,
      partialize: (state) => ({
        endpoints: state.endpoints.map((endpoint) => ({
          ...endpoint,
          apiKey: state.settings.rememberCredentials ? endpoint.apiKey : "",
        })),
        activeId: state.activeId,
        localModelId: state.localModelId,
        threads: state.threads,
        activeThreadId: state.activeThreadId,
        settings: state.settings,
        mode: state.mode,
        folders: state.folders,
        mcpServers: state.mcpServers.map((server) => ({
          ...server,
          token: state.settings.rememberCredentials ? server.token : "",
        })),
        toolGrants: state.toolGrants,
      }),
    },
  ),
);
