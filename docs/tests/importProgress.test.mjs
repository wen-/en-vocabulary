import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderImportProgress } from "../src/views/importProgress.js";
import { renderSettingsView } from "../src/views/settingsView.js";

const sourceUrl = new URL("../src/services/importExportService.js", import.meta.url);
const original = await readFile(sourceUrl, "utf8");
let moduleId = 0;

async function service(runTransaction) {
  const database = await import("../src/db/database.js");
  globalThis.__progressTestDatabase = {
    ...database,
    requestToPromise: async (value) => value,
    runTransaction,
  };
  const source = original
    .replace(/^import \{ ([^}]+) \} from "\.\.\/db\/database.js";/, "const { $1 } = globalThis.__progressTestDatabase;")
    .replace(/from "(\.[^"]+)"/g, (_, path) => `from "${new URL(path, sourceUrl)}"`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${moduleId++}`);
}

function payload() {
  return {
    schemaVersion: 1, categories: [{ name: "测试" }],
    words: [
      { term: "hello", meaning: "你好", examples: [], categories: [{ name: "测试" }] },
      { term: "world", meaning: "世界", examples: [], categories: [] },
    ],
  };
}

function stores(existingWords = []) {
  const records = { categories: [], words: [...existingWords], audio: [] };
  const result = Object.fromEntries(Object.entries(records).map(([name, values]) => [name, {
    getAll: () => [...values],
    put(value) {
      const index = values.findIndex((v) => v.id === value.id);
      if (index >= 0) values[index] = value;
      else values.push(value);
    },
  }]));
  return { records, stores: result };
}

test("JSON preflight reports reading without opening a database", async () => {
  const api = await service(() => { throw new Error("Unexpected database write"); });
  const progress = [];
  const result = await api.inspectLibraryImportFile(new File([JSON.stringify(payload())], "library.json"), {
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.words, 2);
  assert.deepEqual(progress, [{ phase: "reading", completed: 0, total: 0 }]);
});

test("writing progress counts all words and refresh starts only after commit", async () => {
  const database = stores();
  const progress = [];
  const api = await service(async (_, mode, handler) => {
    assert.equal(mode, "readwrite");
    const result = await handler(database.stores);
    assert.equal(progress.at(-1).phase, "committing");
    assert.equal(progress.some((p) => p.phase === "refreshing"), false);
    return result;
  });
  const summary = await api.importLibraryFromFile(new File([JSON.stringify(payload())], "library.json"), {
    onProgress: (event) => progress.push(event),
  });
  assert.equal(summary.createdWords, 2);
  assert.equal(database.records.words.length, 2);
  assert.deepEqual(progress.filter((p) => p.phase === "writing").map((p) => p.completed), [0, 0, 1, 2]);
  assert.equal(progress.at(-1).phase, "refreshing");
});

test("skipped and merged words advance the counter", async () => {
  for (const duplicateMode of ["skip", "merge"]) {
    const database = stores([{ id: "old", term: "hello", meaning: "你好", examples: [], phonetics: [], categoryIds: [] }]);
    const api = await service(async (_, __, handler) => handler(database.stores));
    const progress = [];
    const result = await api.importLibraryFromFile(new File([JSON.stringify(payload())], "library.json"), {
      duplicateMode, onProgress: (event) => progress.push(event),
    });
    assert.equal(result.createdWords, 1);
    assert.equal(result.skippedWords + result.updatedWords, 1);
    assert.equal(progress.filter((p) => p.phase === "writing").at(-1).completed, 2);
  }
});

test("failed commit never reports saved data", async () => {
  const database = stores();
  const api = await service(async (_, __, handler) => {
    await handler(database.stores);
    throw new Error("Quota exceeded");
  });
  const progress = [];
  await assert.rejects(api.importLibraryFromFile(new File([JSON.stringify(payload())], "library.json"), {
    onProgress: (event) => progress.push(event),
  }), /Quota exceeded/);
  assert.equal(progress.at(-1).phase, "committing");
  assert.equal(progress.some((p) => p.phase === "refreshing"), false);
});

test("unchanged merged words still complete the writing counter", async () => {
  const content = payload();
  content.words[0].categories = [];
  const database = stores([{ id: "old", term: "hello", meaning: "你好", examples: [], phonetics: [], categoryIds: [] }]);
  const api = await service(async (_, __, handler) => handler(database.stores));
  const progress = [];
  const result = await api.importLibraryFromFile(new File([JSON.stringify(content)], "library.json"), {
    duplicateMode: "merge", onProgress: (event) => progress.push(event),
  });
  assert.equal(result.skippedWords, 1);
  assert.equal(result.updatedWords, 0);
  assert.equal(result.createdWords, 1);
  assert.equal(progress.filter((p) => p.phase === "writing").at(-1).completed, 2);
});

test("ZIP reports actual audio references and missing audio stops before writing", async () => {
  const content = payload();
  content.words[0].audio = "audio/words/hello.mp3";
  content.words[0].examples = [{ en: "Hello.", zh: "你好。", audio: "audio/examples/hello.mp3" }];
  const entries = {
    "library.json": { name: "library.json", dir: false, async: async () => JSON.stringify(content) },
    "audio/words/hello.mp3": { name: "audio/words/hello.mp3", dir: false, async: async () => new Blob(["word"]) },
    "audio/examples/hello.mp3": { name: "audio/examples/hello.mp3", dir: false, async: async () => new Blob(["example"]) },
  };
  globalThis.JSZip = { loadAsync: async () => ({ files: entries, file: (name) => entries[name] }) };
  const database = stores();
  const api = await service(async (_, __, handler) => handler(database.stores));
  const progress = [];
  const result = await api.importLibraryFromFile(new File(["zip"], "library.zip"), {
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.importedAudio, 2);
  assert.deepEqual(database.records.audio.map((record) => record.blob.type), ["audio/mpeg", "audio/mpeg"]);
  assert.deepEqual(await Promise.all(database.records.audio.map((record) => record.blob.text())), ["word", "example"]);
  assert.deepEqual(progress.filter((p) => p.phase === "audio").map((p) => [p.completed, p.total]), [[0, 2], [1, 2], [2, 2]]);
  delete entries["audio/examples/hello.mp3"];
  const failureProgress = [];
  await assert.rejects(api.importLibraryFromFile(new File(["zip"], "library.zip"), {
    onProgress: (event) => failureProgress.push(event),
  }));
  assert.equal(failureProgress.some((p) => p.phase === "writing"), false);
});

test("previously imported untyped audio receives its stored media type on read", async () => {
  const url = new URL("../src/db/wordRepository.js", import.meta.url);
  const database = await import("../src/db/database.js");
  const blob = new Blob(["existing mp3 bytes"]);
  globalThis.__audioReadTestDatabase = {
    ...database,
    requestToPromise: async (value) => value,
    runTransaction: async (_, __, handler) => handler({
      audio: { get: () => ({ id: "word::old", ownerType: "word", wordId: "old", ownerId: "old", type: "audio/mpeg", blob }) },
    }),
  };
  const source = (await readFile(url, "utf8"))
    .replace(/^import \{([\s\S]*?)\} from "\.\/database.js";/, "const {$1} = globalThis.__audioReadTestDatabase;")
    .replace(/from "(\.[^"]+)"/g, (_, path) => `from "${new URL(path, url)}"`);
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const record = await api.getWordAudioRecord("old");
  assert.equal(record.blob.type, "audio/mpeg");
  assert.equal(await record.blob.text(), "existing mp3 bytes");
});

test("invalid JSON reports no write or saved stage", async () => {
  const api = await service(() => { throw new Error("Unexpected transaction"); });
  const progress = [];
  await assert.rejects(api.importLibraryFromFile(new File(["{"], "library.json"), {
    onProgress: (event) => progress.push(event),
  }));
  assert.deepEqual(progress.map((p) => p.phase), ["reading"]);
});

test("progress uses indeterminate stages and accessible counted stages", () => {
  assert.equal(renderImportProgress(null), "");
  const reading = renderImportProgress({ phase: "reading", completed: 0, total: 0 });
  assert.match(reading, /<progress aria-label="[^"]+"\s*><\/progress>/);
  const writing = renderImportProgress({ phase: "writing", completed: 200, total: 1000 });
  assert.match(writing, /200 \/ 1000（20%）/);
  assert.match(writing, /max="1000" value="200"/);
  assert.match(writing, /role="status"/);
  assert.match(renderImportProgress({ phase: "committing", completed: 0, total: 0 }), /正在提交数据/);
});

test("busy import disables file and mode changes", () => {
  const html = renderSettingsView({
    summary: { words: 0, categories: 0, practiceAttempts: 0 },
    busy: true, importPreviews: {}, pwaStatus: {},
  });
  assert.match(html, /name="libraryFile"[^>]+disabled/);
  assert.match(html, /name="importMode" disabled/);
  assert.match(html, /name="duplicateMode" disabled/);
});

test("offline shell includes the new progress renderer", async () => {
  const worker = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(worker, /"\.\/src\/views\/importProgress\.js"/);
});

test("selected library is shown as checking before preflight completes", () => {
  const html = renderSettingsView({
    summary: { words: 0, categories: 0, practiceAttempts: 0 },
    busy: true,
    importPreviews: { library: { filename: "selected-library.json", status: "loading", size: 100 } },
    pwaStatus: {},
  });
  assert.match(html, /selected-library\.json/);
  assert.match(html, /正在预检/);
  assert.doesNotMatch(html, /预检完成/);
});

test("library progress is directly below the import button inside the form", () => {
  const props = {
    summary: { words: 0, categories: 0, practiceAttempts: 0 },
    busy: true, importPreviews: {}, pwaStatus: {},
    importProgress: { phase: "writing", completed: 25, total: 100 },
  };
  const html = renderSettingsView(props);
  assert.match(html, /导入词库<\/button>\s*<\/div>\s*<div data-import-progress><section/);
  const form = html.match(/<form data-form="import-library"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.match(form, /正在写入词库 25 \/ 100（25%）/);
  assert.equal((html.match(/data-import-progress/g) || []).length, 1);
  const idle = renderSettingsView({ ...props, importProgress: null, busy: false });
  assert.match(idle, /<div data-import-progress><\/div>/);
  assert.doesNotMatch(idle, /aria-label="词库导入进度"/);
});

test("service worker still installs and takes over when one precached file is missing", async () => {
  const vm = await import("node:vm");
  const handlers = new Map();
  const cached = new Map();
  let skipped = false;
  const fetchAsset = async (request) => request.url.endsWith("/assets/article-template.wav")
    ? new Response("missing", { status: 404 })
    : new Response(`fresh ${new URL(request.url).pathname}`);
  const cache = {
    async addAll(requests) {
      for (const request of requests) {
        const response = await fetchAsset(request);
        if (!response.ok) throw new TypeError("addAll rejected a 404");
        cached.set(request.url, response);
      }
    },
    async add(request) { await this.addAll([request]); },
    async put(request, response) { cached.set(typeof request === "string" ? request : request.url, response); },
  };
  class LocalRequest extends Request {
    constructor(url, options) { super(new URL(url, "https://app.test/"), options); }
  }
  vm.runInNewContext(await readFile(new URL("../sw.js", import.meta.url), "utf8"), {
    self: {
      location: { origin: "https://app.test" },
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => { skipped = true; },
    },
    Request: LocalRequest, URL, console: { warn() {} }, fetch: fetchAsset,
    caches: { open: async () => cache },
  });
  let installation;
  handlers.get("install")({ waitUntil: (promise) => { installation = promise; } });
  await installation;
  assert.equal(skipped, true);
  assert.equal(await cached.get("https://app.test/app.js").text(), "fresh /app.js");
  assert.equal(await cached.get("https://app.test/src/views/importProgress.js").text(), "fresh /src/views/importProgress.js");
  assert.equal(cached.has("https://app.test/assets/article-template.wav"), false);
});
