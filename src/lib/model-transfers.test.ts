import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTransfers, useModelTransfers } from "./model-transfers";
import type { SavedModel } from "./types";
test("transfer recovery makes unfinished downloads resumable and discards active controllers", () => {
  const restored = recoverTransfers(
    JSON.stringify([
      {
        id: "a",
        name: "model",
        phase: "working",
        ratio: 0.5,
        url: "https://example.com/model.gguf?token=secret",
        abort: {},
        model: { id: "model", repo: "org/model", file: "model.gguf" },
      },
    ]),
  );
  assert.equal(restored[0].phase, "paused");
  assert.match(restored[0].detail, /resume/);
  assert.equal(restored[0].url, undefined);
  assert.equal(restored[0].abort, undefined);
});
test("transfer recovery rejects malformed metadata and explains interrupted file imports", () => {
  assert.deepEqual(recoverTransfers("bad json"), []);
  assert.deepEqual(recoverTransfers("{}"), []);
  assert.deepEqual(recoverTransfers('[null,{"id":"x","name":"x","phase":"bogus"}]'), []);
  assert.match(
    recoverTransfers('[{"id":"x","name":"x","phase":"working","ratio":0}]')[0].detail,
    /source file again/,
  );
});
test("background transfers retain live cancellation in memory but never persist request URLs", () => {
  let stored = "";
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    },
    configurable: true,
  });
  const model: SavedModel = {
    id: "x",
    name: "x",
    kind: "url",
    repo: "",
    file: "model.gguf",
    url: "https://example.com/model.gguf?token=secret",
    bytes: 123,
    opfsName: "",
    createdAt: 1,
  };
  const abort = new AbortController();
  useModelTransfers
    .getState()
    .setRows([
      {
        id: "t",
        name: "x",
        phase: "working",
        detail: "Downloading",
        ratio: 0,
        model,
        url: model.url,
        abort,
      },
    ]);
  assert.equal(useModelTransfers.getState().rows[0].abort, abort);
  assert.ok(!stored.includes("secret"));
  assert.ok(!stored.includes("abort"));
  useModelTransfers.getState().setRows((rows) => rows.map((row) => ({ ...row, phase: "done" })));
  assert.equal(useModelTransfers.getState().rows[0].phase, "done");
  useModelTransfers.getState().setRows([]);
});
