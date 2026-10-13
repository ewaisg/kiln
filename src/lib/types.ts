export const PROVIDER_KINDS = [
  "grok",
  "openai",
  "anthropic",
  "azure-openai",
  "azure-ai",
  "lmstudio",
  "ollama",
  "custom",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type Capability = "chat" | "vision" | "image" | "transcription" | "speech" | "video";
export type PerformanceProfile = "auto" | "balanced" | "quality" | "saver";

export type Endpoint = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiVersion: string;
  direct: boolean;
  capabilities?: Capability[];
  chatProfile?: "auto" | "standard" | "reasoning";
};

export type WireMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: { mime: string; data: string }[];
};

export type Attachment = {
  id: string;
  name: string;
  kind: "text" | "image" | "audio" | "video" | "file";
  detail: string;
  mediaId?: string;
  mime?: string;
  bytes?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  attachments?: Attachment[];
  media?: { id: string; alt: string }[];
  images?: { mime: string; data: string }[];
  status?: "complete" | "stopped" | "error";
  visionObservation?: string;
};

export type WorkMode = "chat" | "build";

export type Thread = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  via?: string;
  mode?: WorkMode;
  folderId?: string;
  archived?: boolean;
  parentThreadId?: string;
};

export type Folder = {
  id: string;
  name: string;
};

export type McpServer = {
  id: string;
  name: string;
  url: string;
  token: string;
  transport?: "http" | "companion";
  oauthClientId?: string;
};

export type Settings = {
  systemPrompt: string;
  chatPrompt?: string;
  temperature: number;
  maxTokens: number;
  localCtx: number;
  theme: "dark" | "light";
  performanceProfile?: PerformanceProfile;
  mediaDefaults?: Partial<Record<Capability, { endpointId: string; model: string }>>;
  rememberCredentials?: boolean;
  reducedMotion?: boolean;
  fontSize?: "normal" | "large";
  promptTemplates?: { id: string; name: string; text: string }[];
};

export type Preset = {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiVersion: string;
  direct: boolean;
  hint: string;
};

export const CHAT_SYSTEM = `You are Kiln, a coding companion in chat. Talk with the person: explain, compare, debug, and think through design. Answer in plain language first.

Use short fenced code blocks only when a snippet makes the point clearer. Do not wrap a whole app in one HTML document unless they ask for a file they can run. Do not generate images or video.`;

export const DEFAULT_SYSTEM = `You are Kiln, a coding assistant in build mode. You help people build software: programs, scripts, refactors, schemas, and small apps.

When asked to build a small web app, widget, or visual tool, reply with a few sentences and exactly one complete HTML document in a single html code fence. The document must be self-contained, with inline CSS and JavaScript only, no build step, and it must work on a narrow phone screen.

For other tasks, use fenced code blocks with a language tag and prefer complete, runnable files. Explain briefly. Do not generate images or video. Stay on code, debugging, and the design of software.`;

export const DEFAULT_SETTINGS: Settings = {
  systemPrompt: DEFAULT_SYSTEM,
  chatPrompt: CHAT_SYSTEM,
  temperature: 0.4,
  maxTokens: 1600,
  localCtx: 2048,
  theme: "dark",
  performanceProfile: "auto",
  rememberCredentials: false,
};

export const PRESETS: Preset[] = [
  {
    kind: "grok",
    name: "Grok",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    apiVersion: "",
    direct: false,
    hint: "Key from xAI. OpenAI-compatible chat at api.x.ai.",
  },
  {
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    apiVersion: "",
    direct: false,
    hint: "Key from OpenAI. Change the model to one your account can use.",
  },
  {
    kind: "anthropic",
    name: "Claude",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    apiVersion: "",
    direct: false,
    hint: "Key from Anthropic.",
  },
  {
    kind: "azure-openai",
    name: "Azure OpenAI",
    baseUrl: "https://example.openai.azure.com",
    model: "my-deployment",
    apiVersion: "2024-10-21",
    direct: false,
    hint: "Resource host and the deployment name. The key is the Azure key, not an OpenAI key.",
  },
  {
    kind: "azure-ai",
    name: "Azure AI",
    baseUrl: "https://example.services.ai.azure.com/models",
    model: "gpt-4o",
    apiVersion: "2024-05-01-preview",
    direct: false,
    hint: "Azure AI Foundry endpoint. Model is the deployment or model name the resource serves.",
  },
  {
    kind: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    apiVersion: "",
    direct: true,
    hint: "On a phone, 127.0.0.1 is the phone. Use the computer’s LAN address, and enable CORS in LM Studio.",
  },
  {
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    apiVersion: "",
    direct: true,
    hint: "On a phone, use the computer’s LAN address. Set OLLAMA_ORIGINS so this site is allowed.",
  },
  {
    kind: "custom",
    name: "Custom",
    baseUrl: "https://api.example.com/v1",
    model: "model-name",
    apiVersion: "",
    direct: false,
    hint: "Any OpenAI-compatible /chat/completions endpoint.",
  },
];

export const CATALOG = [
  {
    id: "qwen25-coder-0.5b",
    name: "Qwen2.5 Coder 0.5B",
    blurb: "Small coding model. The practical choice on a phone.",
    size: "400 MB",
    repo: "bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    file: "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    bytes: 398_000_000,
  },
  {
    id: "smollm2-360m",
    name: "SmolLM2 360M",
    blurb: "Fast general chat. Light on memory.",
    size: "400 MB",
    repo: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF",
    file: "smollm2-360m-instruct-q8_0.gguf",
    bytes: 386_000_000,
  },
  {
    id: "llama32-1b",
    name: "Llama 3.2 1B",
    blurb: "Clearer answers. Better on a tablet or computer.",
    size: "800 MB",
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    bytes: 810_000_000,
  },
  {
    id: "qwen25-coder-1.5b",
    name: "Qwen2.5 Coder 1.5B",
    blurb: "Stronger code. Needs a machine with more RAM.",
    size: "1 GB",
    repo: "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    file: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    bytes: 1_040_000_000,
  },
] as const;

export type CatalogItem = {
  id: string;
  name: string;
  blurb: string;
  size: string;
  repo: string;
  file: string;
  bytes: number;
  quantization?: string;
  memory?: string;
  format?: string;
  compatible?: boolean;
};

export type SavedModel = {
  id: string;
  name: string;
  kind: "hf" | "url" | "file";
  repo: string;
  file: string;
  url: string;
  bytes: number;
  opfsName: string;
  externalName?: string;
  where?: string;
  folderKey?: string;
  createdAt: number;
  config?: ModelConfig;
  metadata?: { architecture?: string; quantization?: string; parameters?: number; contextLength?: number };
  linked?: boolean;
};

export type ModelConfig = {
  context: number;
  profile: PerformanceProfile;
  gpuLayers?: number;
  threads?: number;
  batch?: number;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  repeatPenalty?: number;
};

export function presetByKind(kind: ProviderKind): Preset {
  return PRESETS.find((item) => item.kind === kind) ?? PRESETS[PRESETS.length - 1];
}

export function newId(): string {
  return crypto.randomUUID();
}
