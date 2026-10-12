import { useKiln } from "@/lib/store";
import {
  DEFAULT_SETTINGS,
  PROVIDER_KINDS,
  newId,
  type Endpoint,
  type Thread,
  type Folder,
  type Settings,
  type McpServer,
} from "@/lib/types";

export function exportWorkspace(): string {
  const { threads, folders, settings, endpoints, mcpServers } = useKiln.getState();
  return JSON.stringify(
    {
      app: "kiln",
      version: 2,
      exportedAt: new Date().toISOString(),
      threads,
      folders,
      settings: { ...settings, rememberCredentials: false },
      endpoints: endpoints.map(({ apiKey: _key, ...endpoint }) => endpoint),
      mcpServers: mcpServers.map(({ token: _token, ...server }) => server),
    },
    null,
    2,
  );
}
export function importWorkspace(raw: string): { threads: number; endpoints: number } {
  if (raw.length > 30e6)
    throw new Error("Import exceeds 30 MB. Split the export into smaller files.");
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data.app !== "kiln" || (data.version !== 1 && data.version !== 2))
    throw new Error("Choose a Kiln workspace export (version 1 or 2).");
  const state = useKiln.getState();
  const idMap = new Map<string, string>();
  const importedFolders: Folder[] = [];
  if (Array.isArray(data.folders))
    for (const row of data.folders.slice(0, 1000)) {
      if (!row || typeof row.id !== "string" || typeof row.name !== "string") continue;
      const id = newId();
      idMap.set(row.id, id);
      importedFolders.push({ id, name: row.name.slice(0, 80) });
    }
  const importedThreads: Thread[] = [];
  if (Array.isArray(data.threads))
    for (const row of data.threads.slice(0, 10000)) {
      if (!row || typeof row.title !== "string" || !Array.isArray(row.messages))
        throw new Error("A conversation in the import is malformed.");
      const messages = row.messages.map((message: Record<string, unknown>) => {
        if (
          !message ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string"
        )
          throw new Error("A message in the import is malformed.");
        // Embedded vision inputs are portable; generated blob IDs remain device-owned.
        const images = Array.isArray(message.images)
          ? message.images.slice(0, 24).map((image: Record<string, unknown>) => {
              if (
                !image ||
                !["image/png", "image/jpeg", "image/webp"].includes(String(image.mime)) ||
                typeof image.data !== "string" ||
                image.data.length > 350000 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
              )
                throw new Error("An imported image is malformed or exceeds the supported size.");
              return { mime: String(image.mime), data: image.data };
            })
          : undefined;
        return {
          id: newId(),
          role: message.role as "user" | "assistant",
          content: message.content,
          error: message.error === true,
          images,
          visionObservation:
            typeof message.visionObservation === "string"
              ? message.visionObservation.slice(0, 100000)
              : undefined,
        };
      });
      importedThreads.push({
        id: newId(),
        title: row.title.slice(0, 160),
        messages,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
        mode: row.mode === "build" ? "build" : "chat",
        archived: row.archived === true,
        folderId: idMap.get(row.folderId),
      });
    }
  const importedEndpoints: Endpoint[] = [];
  if (Array.isArray(data.endpoints))
    for (const row of data.endpoints.slice(0, 1000)) {
      if (
        !row ||
        !PROVIDER_KINDS.includes(row.kind) ||
        typeof row.baseUrl !== "string" ||
        typeof row.model !== "string"
      )
        throw new Error("A provider in the import is malformed.");
      const url = new URL(row.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid provider URL.");
      const id = newId();
      idMap.set(row.id, id);
      importedEndpoints.push({
        id,
        kind: row.kind,
        name: String(row.name || row.kind).slice(0, 80),
        baseUrl: url.toString().replace(/\/$/, ""),
        model: row.model.slice(0, 200),
        apiKey: "",
        apiVersion: typeof row.apiVersion === "string" ? row.apiVersion.slice(0, 40) : "",
        direct: row.direct === true,
        chatProfile:
          row.chatProfile === "reasoning" || row.chatProfile === "standard"
            ? row.chatProfile
            : "auto",
        capabilities: Array.isArray(row.capabilities)
          ? row.capabilities.filter((cap: string) =>
              ["chat", "vision", "image", "transcription", "speech", "video"].includes(cap),
            )
          : undefined,
      });
    }
  const importedMcp: McpServer[] = [];
  if (Array.isArray(data.mcpServers))
    for (const row of data.mcpServers.slice(0, 100)) {
      if (!row || typeof row.url !== "string") continue;
      const url = new URL(row.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid MCP URL.");
      importedMcp.push({
        id: newId(),
        name: String(row.name || "Imported server").slice(0, 80),
        url: url.toString(),
        token: "",
        transport: row.transport === "companion" ? "companion" : "http",
      });
    }
  const inputSettings = data.settings as Partial<Settings> | undefined;
  const settings: Settings = { ...state.settings };
  if (inputSettings && typeof inputSettings === "object") {
    for (const key of ["systemPrompt", "chatPrompt"] as const)
      if (typeof inputSettings[key] === "string")
        settings[key] = inputSettings[key]!.slice(0, 100000);
    for (const [key, min, max] of [
      ["temperature", 0, 2],
      ["maxTokens", 16, 32768],
      ["localCtx", 512, 32768],
    ] as const)
      if (typeof inputSettings[key] === "number" && Number.isFinite(inputSettings[key]))
        settings[key] = Math.max(min, Math.min(max, inputSettings[key]!));
    if (inputSettings.theme === "light" || inputSettings.theme === "dark")
      settings.theme = inputSettings.theme;
    if (Array.isArray(inputSettings.promptTemplates))
      settings.promptTemplates = inputSettings.promptTemplates
        .slice(0, 500)
        .filter(
          (template) =>
            template && typeof template.name === "string" && typeof template.text === "string",
        )
        .map((template) => ({
          id: newId(),
          name: template.name.slice(0, 80),
          text: template.text.slice(0, 100000),
        }));
    if (["auto", "balanced", "quality", "saver"].includes(inputSettings.performanceProfile ?? ""))
      settings.performanceProfile = inputSettings.performanceProfile;
    settings.mediaDefaults = Object.fromEntries(
      Object.entries(inputSettings.mediaDefaults ?? {})
        .filter(
          ([cap, value]) =>
            ["vision", "image", "speech", "transcription", "video"].includes(cap) &&
            typeof value?.model === "string" &&
            idMap.has(value.endpointId),
        )
        .map(([cap, value]) => [
          cap,
          { endpointId: idMap.get(value!.endpointId), model: value!.model.slice(0, 200) },
        ]),
    ) as Settings["mediaDefaults"];
  }
  useKiln.setState({
    threads: [...importedThreads, ...state.threads],
    folders: [...state.folders, ...importedFolders],
    endpoints: [...state.endpoints, ...importedEndpoints],
    mcpServers: [...state.mcpServers, ...importedMcp],
    settings: { ...DEFAULT_SETTINGS, ...settings },
    activeThreadId: importedThreads[0]?.id ?? state.activeThreadId,
  });
  return { threads: importedThreads.length, endpoints: importedEndpoints.length };
}
