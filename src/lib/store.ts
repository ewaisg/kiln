import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_SETTINGS,
  newId,
  type ChatMessage,
  type Endpoint,
  type Settings,
  type Thread,
} from "@/lib/types";

const WELCOME_ID = "thread-welcome";

function blankThread(): Thread {
  return {
    id: WELCOME_ID,
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
  };
}

type State = {
  endpoints: Endpoint[];
  activeId: string;
  localModelId: string | null;
  threads: Thread[];
  activeThreadId: string;
  settings: Settings;
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
};

export const useKiln = create<State>()(
  persist(
    (set) => ({
      endpoints: [],
      activeId: "local",
      localModelId: null,
      threads: [blankThread()],
      activeThreadId: WELCOME_ID,
      settings: DEFAULT_SETTINGS,
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
        const thread: Thread = {
          id: newId(),
          title: "New chat",
          messages: [],
          updatedAt: Date.now(),
        };
        set((state) => ({ threads: [thread, ...state.threads].slice(0, 40), activeThreadId: thread.id }));
        return thread.id;
      },
      selectThread: (id) => set({ activeThreadId: id }),
      removeThread: (id) =>
        set((state) => {
          const threads = state.threads.filter((thread) => thread.id !== id);
          if (threads.length === 0) {
            const fresh = { ...blankThread(), id: newId(), updatedAt: Date.now() };
            return { threads: [fresh], activeThreadId: fresh.id };
          }
          const activeThreadId = state.activeThreadId === id ? threads[0].id : state.activeThreadId;
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
              ? { ...thread, messages: thread.messages.filter((message) => message.id !== messageId) }
              : thread,
          ),
        })),
      titleIfBlank: (threadId, title) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId && thread.title === "New chat" ? { ...thread, title } : thread,
          ),
        })),
    }),
    {
      name: "kiln-v1",
      skipHydration: true,
      partialize: (state) => ({
        endpoints: state.endpoints,
        activeId: state.activeId,
        localModelId: state.localModelId,
        threads: state.threads,
        activeThreadId: state.activeThreadId,
        settings: state.settings,
      }),
    },
  ),
);
