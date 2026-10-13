import test from "node:test";
import assert from "node:assert/strict";
import { searchCatalogPage, parseCatalogFiles, catalogFiles } from "../src/lib/catalog.ts";

test("live catalog request carries search, sort, task and bounded page size", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, "https://huggingface.co");
      assert.equal(target.searchParams.get("search"), "Qwen");
      assert.equal(target.searchParams.get("sort"), "lastModified");
      assert.equal(target.searchParams.get("pipeline_tag"), "text-generation");
      assert.equal(target.searchParams.get("limit"), "50");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json([{ id: "review/qwen", downloads: 100, gated: true }], {
        headers: {
          link: '<https://huggingface.co/api/models?cursor=second>; rel="next", <https://huggingface.co/api/models?cursor=last>; rel="last"',
        },
      });
    };
    const result = await searchCatalogPage(
      { query: " Qwen ", sort: "lastModified", task: "text-generation", limit: 99 },
      new AbortController().signal,
    );
    assert.equal(result.items[0].repo, "review/qwen");
    assert.match(result.items[0].blurb, /gated/);
    assert.equal(result.nextCursor, "https://huggingface.co/api/models?cursor=second");
  } finally {
    globalThis.fetch = previous;
  }
});

test("catalog pagination rejects arbitrary hosts and endpoints before fetch", async () => {
  const previous = globalThis.fetch;
  let fetched = false;
  try {
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("unexpected request");
    };
    for (const cursor of [
      "https://evil.example/api/models",
      "http://huggingface.co/api/models",
      "https://huggingface.co/api/secrets",
      "https://huggingface.co.evil.example/api/models",
    ]) {
      await assert.rejects(searchCatalogPage({ cursor }), /Invalid catalog page cursor/);
    }
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test("catalog reports rate limit and malformed body instead of empty success", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    await assert.rejects(searchCatalogPage(), /429/);
    globalThis.fetch = async () => Response.json({ error: "incorrect schema" });
    await assert.rejects(searchCatalogPage(), /Unexpected model catalog response/);
    globalThis.fetch = async () => Response.json([]);
    assert.deepEqual(await searchCatalogPage(), { items: [], nextCursor: null });
  } finally {
    globalThis.fetch = previous;
  }
});

test("GGUF file metadata includes MXFP4, excludes non-models, and marks split/projector candidates", () => {
  const files = parseCatalogFiles("review/gpt-oss", [
    { rfilename: "README.md", size: 5 },
    { rfilename: "gpt-oss-20b-MXFP4.gguf", lfs: { size: 12e9 } },
    { rfilename: "model-Q4_K_M.gguf", size: 1e9 },
    { rfilename: "model-00001-of-00002.gguf", size: 2e9 },
    { rfilename: "mmproj-F16.gguf", size: 1e8 },
  ]);
  assert.equal(files.length, 4);
  assert.equal(files.find((file) => file.quantization === "MXFP4").bytes, 12e9);
  assert.equal(files.filter((file) => file.compatible).length, 2);
  assert.ok(files.every((file) => file.memory && file.format === "GGUF"));
});

test("repository inspection rejects unsafe identifiers before requesting files", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("Unsafe repository reached fetch");
    };
    for (const repo of [
      "../secret",
      "https://example.com/model",
      "org/model/extra",
      "org/model?token=secret",
    ]) {
      await assert.rejects(catalogFiles(repo), /Invalid model repository/);
    }
  } finally {
    globalThis.fetch = previous;
  }
});
