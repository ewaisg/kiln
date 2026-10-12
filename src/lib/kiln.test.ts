import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { sseData } from "./sse";
import { tokensFromUpstream, buildChatRequest, shouldDirect, fitMessages } from "./wire";
import { highlightCode } from "./highlight";
import { parseCatalogFiles } from "./catalog";
import { workspaceStorage } from "./workspace-storage";
import { useKiln } from "./store";
import { exportWorkspace, importWorkspace } from "./workspace-transfer";
import { PRESETS } from "./types";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
  configurable: true,
});
function byteStream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
}
test("streaming handles UTF8 splits, CRLF, final event and DONE", async () => {
  const values = [];
  for await (const value of sseData(byteStream('data: {"t":"café"}\r\n\r\ndata: {"t":"last"}')))
    values.push(JSON.parse(value).t);
  assert.deepEqual(values, ["café", "last"]);
  const tokens = [];
  for await (const value of tokensFromUpstream(
    byteStream('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'),
    "openai",
  ))
    tokens.push(value);
  assert.deepEqual(tokens, ["hello"]);
});
test("provider streaming errors propagate rather than looking successful", async () => {
  await assert.rejects(async () => {
    for await (const _token of tokensFromUpstream(
      byteStream('data: {"error":{"message":"Rate limit"}}'),
      "openai",
    )) {
      /* consume */
    }
  }, /Rate limit/);
  await assert.rejects(async () => {
    for await (const _token of tokensFromUpstream(byteStream("data: broken"), "openai")) {
      /* consume */
    }
  }, /malformed/);
});
test("code highlighting escapes executable HTML and tokenizes safely", () => {
  const output = highlightCode('<img src=x onerror="alert(1)"> const x = "<script>";');
  assert.ok(!output.includes("<img"));
  assert.ok(!output.includes("<script>"));
  assert.ok(output.includes("&lt;img"));
  assert.ok(output.includes('class="tok-k">const'));
});
test("provider payloads include actual image content and Azure deployment", () => {
  const endpoint = { ...PRESETS[1], id: "api", apiKey: "test-key" };
  const built = buildChatRequest(
    endpoint,
    [{ role: "user", content: "Describe", images: [{ mime: "image/png", data: "abcd" }] }],
    0.4,
    256,
  );
  assert.ok(JSON.stringify(built.body).includes("data:image/png;base64,abcd"));
  const azure = buildChatRequest(
    {
      ...endpoint,
      kind: "azure-openai",
      baseUrl: "https://resource.openai.azure.com",
      model: "deployment",
    },
    [{ role: "user", content: "test" }],
    0.4,
    100,
  );
  assert.ok(azure.url.includes("/deployments/deployment/chat/completions"));
  assert.equal(azure.headers["api-key"], "test-key");
  assert.equal(shouldDirect({ direct: false, baseUrl: "http://127.0.0.1:1234/v1" }), true);
});
test("reasoning profile uses completion budget without incompatible sampling", () => {
  const endpoint = { ...PRESETS[1], id: "reasoning", apiKey: "mock", model: "gpt-5" };
  const automatic = buildChatRequest(endpoint, [{ role: "user", content: "test" }], 0.4, 4096)
    .body as Record<string, unknown>;
  assert.equal(automatic.max_completion_tokens, 4096);
  assert.equal(automatic.max_tokens, undefined);
  assert.equal(automatic.temperature, undefined);
  const azure = buildChatRequest(
    { ...endpoint, kind: "azure-openai", model: "deployment-name", chatProfile: "reasoning" },
    [{ role: "user", content: "test" }],
    0.4,
    4096,
  ).body as Record<string, unknown>;
  assert.equal(azure.max_completion_tokens, 4096);
  const standard = buildChatRequest(
    { ...endpoint, chatProfile: "standard" },
    [{ role: "user", content: "test" }],
    0.4,
    256,
  ).body as Record<string, unknown>;
  assert.equal(standard.max_tokens, 256);
  assert.equal(standard.temperature, 0.4);
});
test("catalog file metadata is real parsed metadata, split/projectors blocked", () => {
  const rows = parseCatalogFiles("org/model", [
    { rfilename: "model-Q4_K_M.gguf", lfs: { size: 1e9 } },
    { rfilename: "mmproj-F16.gguf", size: 1e8 },
    { rfilename: "model-00001-of-00002.gguf", size: 2e9 },
  ]);
  assert.equal(rows.find((row) => row.bytes === 1e9)?.quantization, "Q4_K_M");
  assert.equal(rows.filter((row) => row.compatible).length, 1);
});
test("history has no silent forty-thread cap and branches preserve original", () => {
  for (let index = 0; index < 55; index++) useKiln.getState().newThread();
  assert.ok(useKiln.getState().threads.length > 40);
  const id = useKiln.getState().activeThreadId;
  useKiln.getState().appendMessage(id, { id: "u", role: "user", content: "original" });
  useKiln.getState().appendMessage(id, { id: "a", role: "assistant", content: "response" });
  const branch = useKiln.getState().forkThread(id, "a", false);
  assert.notEqual(branch, id);
  assert.equal(useKiln.getState().threads.find((thread) => thread.id === id)?.messages.length, 2);
  assert.equal(
    useKiln.getState().threads.find((thread) => thread.id === branch)?.messages.length,
    1,
  );
});
test("workspace export strips every credential and import refuses malformed data atomically", () => {
  useKiln
    .getState()
    .upsertEndpoint({ ...PRESETS[1], id: "secret-provider", apiKey: "DO_NOT_EXPORT" });
  useKiln
    .getState()
    .upsertMcp({
      id: "secret-mcp",
      name: "server",
      url: "https://mcp.example.com",
      token: "DO_NOT_EXPORT_TOKEN",
    });
  useKiln.getState().setToolGrant("secret-mcp", "delete", true);
  const exported = exportWorkspace();
  assert.ok(!exported.includes("DO_NOT_EXPORT"));
  assert.ok(!exported.includes("toolGrants"));
  const count = useKiln.getState().threads.length;
  assert.throws(
    () =>
      importWorkspace(
        JSON.stringify({
          app: "kiln",
          version: 2,
          threads: [{ title: "bad", messages: [{ role: "tool", content: "bad" }] }],
        }),
      ),
    /malformed/,
  );
  assert.equal(useKiln.getState().threads.length, count);
  const imported = importWorkspace(exported);
  assert.ok(imported.threads > 40);
  assert.equal(useKiln.getState().endpoints.at(-1)?.apiKey, "");
});
test("legacy localStorage is consumed and removed only after IndexedDB commit", async () => {
  memory.set("legacy-test", "old-workspace");
  assert.equal(await workspaceStorage.getItem("legacy-test"), "old-workspace");
  await workspaceStorage.setItem("legacy-test", "new-workspace");
  assert.equal(memory.has("legacy-test"), false);
  assert.equal(await workspaceStorage.getItem("legacy-test"), "new-workspace");
});
test("context fitting preserves system instructions and latest turn", () => {
  const fitted = fitMessages(
    [
      { role: "system", content: "instructions" },
      { role: "user", content: "x".repeat(100) },
      { role: "assistant", content: "old" },
      { role: "user", content: "latest" },
    ],
    22,
  );
  assert.equal(fitted[0].role, "system");
  assert.equal(fitted.at(-1)?.content, "latest");
  assert.ok(!fitted.some((message) => message.content.length === 100));
});
