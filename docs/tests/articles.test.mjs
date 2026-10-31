import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import { parseArticleManifest, readArticlePackage, importArticlePackage, createArticlePackage, detectAudioType, ARTICLE_LIMITS } from "../src/services/articleImportService.js";
import { createAudioPlayer } from "../src/services/audioPlayer.js";
import { renderArticlesView } from "../src/views/articlesView.js";

const zipModule = { exports: {} };
vm.runInNewContext(await readFile(new URL("../assets/vendor/jszip.min.js", import.meta.url), "utf8"), {
  module: zipModule, exports: zipModule.exports, require: createRequire(import.meta.url),
  Uint8Array, ArrayBuffer, Buffer, Blob, Promise, setTimeout, clearTimeout, setImmediate,
});
globalThis.JSZip = zipModule.exports;
const wav = new Uint8Array(await readFile(new URL("../assets/article-template.wav", import.meta.url)));
const manifest = () => ({
  schemaVersion: 1,
  articles: [{ title: "Morning", sentences: [
    { en: "A new day begins.", zh: "新的一天开始了。", audio: "audio/morning.wav" },
    { en: "I open the window.", zh: "我打开窗户。" },
  ] }],
});

test("service-worker upgrade replaces stale HTTP-cached modules", async () => {
  const handlers = new Map();
  const cached = new Map();
  const fetchModule = async (request, options) => new Response(
    request.cache === "reload" || options?.cache === "no-cache"
      ? "export const currentVersion = true;"
      : "export const oldVersion = true;",
  );
  const cache = {
    async addAll(requests) {
      for (const request of requests) cached.set(request.url, await fetchModule(request));
    },
    async put(request, response) {
      cached.set(typeof request === "string" ? request : request.url, response);
    },
  };
  class LocalRequest extends Request {
    constructor(url, options) {
      super(new URL(url, "https://app.test/"), options);
    }
  }
  vm.runInNewContext(await readFile(new URL("../sw.js", import.meta.url), "utf8"), {
    self: {
      location: { origin: "https://app.test" },
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => {},
    },
    Request: LocalRequest,
    URL,
    fetch: fetchModule,
    caches: { open: async () => cache },
  });
  let installation;
  handlers.get("install")({ waitUntil: (promise) => { installation = promise; } });
  await installation;
  assert.equal(await cached.get("https://app.test/app.js").text(), "export const currentVersion = true;");
  let response;
  handlers.get("fetch")({
    request: new Request("https://app.test/src/services/importExportService.js"),
    respondWith: (promise) => { response = promise; },
  });
  assert.equal(await (await response).text(), "export const currentVersion = true;");
});

async function packageFile(value = manifest(), files = { "audio/morning.wav": wav }) {
  const zip = new globalThis.JSZip();
  zip.file("articles.json", typeof value === "string" ? value : JSON.stringify(value));
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], "articles.zip");
}

test("manifest preserves bilingual sentence order and optional audio", () => {
  const articles = parseArticleManifest(manifest());
  assert.equal(articles[0].title, "Morning");
  assert.deepEqual(articles[0].sentences.map((s) => [s.en, s.zh]), [
    ["A new day begins.", "新的一天开始了。"], ["I open the window.", "我打开窗户。"],
  ]);
  assert.equal(articles[0].sentences[1].audio, undefined);
});

test("manifest rejects invalid versions, empty collections and missing bilingual content", () => {
  for (const value of [
    null, {}, { schemaVersion: 2, articles: manifest().articles },
    { schemaVersion: 1, articles: [] },
    { schemaVersion: 1, articles: [{ title: "", sentences: [] }] },
    { schemaVersion: 1, articles: [{ title: "Title", sentences: [] }] },
    ...["en", "zh"].map((key) => {
      const value = manifest();
      value.articles[0].sentences[0][key] = " ";
      return value;
    }),
  ]) assert.throws(() => parseArticleManifest(value), /文章包无效/);
});

test("manifest rejects traversal, external URLs and invalid audio references", () => {
  for (const audio of ["../a.wav", "/audio/a.wav", "https://x/a.wav", "audio/../a.wav", "audio\\a.wav", "audio/a.exe", "", null]) {
    const value = manifest();
    value.articles[0].sentences[0].audio = audio;
    assert.throws(() => parseArticleManifest(value), /audio/);
  }
});

test("manifest enforces article, sentence and text limits", () => {
  assert.throws(() => parseArticleManifest({ schemaVersion: 1, articles: Array(201).fill(manifest().articles[0]) }));
  const value = manifest();
  value.articles[0].sentences = Array(5001).fill(value.articles[0].sentences[0]);
  assert.throws(() => parseArticleManifest(value), /5000/);
  value.articles[0].title = "x".repeat(301);
  assert.throws(() => parseArticleManifest(value), /300/);
});

test("ZIP validates every referenced audio before returning importable articles", async () => {
  let decoded = 0;
  const articles = await readArticlePackage(await packageFile(), { validateAudio: async (bytes) => {
    assert.equal(detectAudioType(bytes), "audio/wav");
    assert.ok(bytes.length > 44);
    decoded += 1;
  } });
  assert.equal(decoded, 1);
  assert.equal(articles[0].sentences[0].blob.size, wav.length);
  assert.equal(articles[0].sentences[1].blob, undefined);
});

test("article package reading reports parsing then each unique audio check", async () => {
  const files = { "audio/a.wav": wav, "audio/b.wav": wav };
  const value = { schemaVersion: 1, articles: [{ title: "Two", sentences: [
    { en: "A.", zh: "甲。", audio: "audio/a.wav" },
    { en: "B.", zh: "乙。", audio: "audio/b.wav" },
    { en: "A again.", zh: "再甲。", audio: "audio/a.wav" },
  ] }] };
  const progress = [];
  await readArticlePackage(await packageFile(value, files), {
    validateAudio: async () => {},
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(progress, [
    { phase: "reading", completed: 0, total: 0 },
    { phase: "audio", completed: 0, total: 2 },
    { phase: "audio", completed: 1, total: 2 },
    { phase: "audio", completed: 2, total: 2 },
  ]);
});

test("ZIP rejects missing audio, empty audio, invalid audio, and decoder failures", async () => {
  for (const files of [{}, { "audio/morning.wav": new Uint8Array() }, { "audio/morning.wav": new Uint8Array([1, 2, 3]) }]) {
    await assert.rejects(readArticlePackage(await packageFile(manifest(), files)), /文章包无效/);
  }
  await assert.rejects(readArticlePackage(await packageFile(), { validateAudio: async () => { throw new Error("decoder failure"); } }), /decoder failure/);
});

test("ZIP rejects corrupt JSON, unsupported schema, absent manifest and corrupt archive", async () => {
  for (const value of ["{", { schemaVersion: 0, articles: [] }]) {
    await assert.rejects(readArticlePackage(await packageFile(value)), /文章包无效/);
  }
  const zip = new globalThis.JSZip();
  zip.file("readme.txt", "no manifest");
  const file = new File([await zip.generateAsync({ type: "uint8array" })], "missing.zip");
  await assert.rejects(readArticlePackage(file), /articles.json/);
  await assert.rejects(readArticlePackage(new File(["broken"], "bad.zip")), /ZIP/);
});

test("invalid article imports never open a database or partially write earlier articles", async () => {
  const value = manifest();
  value.articles.push({ title: "Later article", sentences: [{ en: "Hello.", zh: "你好。", audio: "audio/missing.wav" }] });
  let opened = 0;
  const originalDatabase = globalThis.indexedDB;
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.indexedDB = { open() { opened += 1; throw new Error("must not write"); } };
  globalThis.OfflineAudioContext = class {
    async decodeAudioData() { return { duration: 1 }; }
  };
  try {
    await assert.rejects(importArticlePackage(await packageFile(value)), /missing.wav/);
    assert.equal(opened, 0);
  } finally {
    globalThis.indexedDB = originalDatabase;
    globalThis.OfflineAudioContext = originalContext;
  }
});

test("repeated imports decode audio without opening a hardware audio context per file", async () => {
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`audio/${index}.wav`, wav]));
  const value = { schemaVersion: 1, articles: [{ title: "Many", sentences: Object.keys(files)
    .map((audio) => ({ en: "Hello.", zh: "你好。", audio })) }] };
  let realtime = 0;
  let offline = 0;
  const originalContext = globalThis.AudioContext;
  const originalOffline = globalThis.OfflineAudioContext;
  globalThis.AudioContext = class { constructor() { realtime += 1; } };
  globalThis.OfflineAudioContext = class {
    constructor() { offline += 1; }
    async decodeAudioData() { return { duration: 1 }; }
  };
  try {
    for (let run = 0; run < 2; run += 1) {
      const articles = await readArticlePackage(await packageFile(value, files));
      assert.equal(articles[0].sentences.length, 5);
    }
    assert.equal(realtime, 0);
    assert.ok(offline <= 2, `offline contexts: ${offline}`);
  } finally {
    globalThis.AudioContext = originalContext;
    globalThis.OfflineAudioContext = originalOffline;
  }
});

test("ZIP rejects unsafe archive paths and compressed files over the expanded limit", async () => {
  const unsafe = await packageFile(manifest(), { "../outside.wav": wav });
  await assert.rejects(readArticlePackage(unsafe), /路径/);
  const large = await packageFile(manifest(), { "audio/morning.wav": new Uint8Array(ARTICLE_LIMITS.audioBytes + 1) });
  await assert.rejects(readArticlePackage(large), /过大/);
  await assert.rejects(readArticlePackage({ name: "big.zip", size: ARTICLE_LIMITS.zipBytes + 1 }), /100 MB/);
});

test("article ZIP export round-trips text and audio without requiring vocabulary data", async () => {
  const articles = [{
    title: "Morning", sentences: [
      { id: "one", en: "A new day begins.", zh: "新的一天开始了。", hasAudio: true },
      { id: "two", en: "I open the window.", zh: "我打开窗户。", hasAudio: false },
    ],
  }];
  const blob = await createArticlePackage(articles, new Map([["one", new Blob([wav], { type: "audio/wav" })]]));
  const result = await readArticlePackage(new File([blob], "backup.zip"), { validateAudio: async () => {} });
  assert.equal(result[0].title, articles[0].title);
  assert.deepEqual(result[0].sentences.map(({ en, zh }) => ({ en, zh })), articles[0].sentences.map(({ en, zh }) => ({ en, zh })));
  assert.deepEqual(new Uint8Array(await result[0].sentences[0].blob.arrayBuffer()), wav);
  await assert.rejects(createArticlePackage(articles, new Map()), /缺失/);
});

class FakeAudio extends EventTarget {
  plays = [];
  src = "";
  pause() {}
  load() {}
  removeAttribute() { this.src = ""; }
  play() {
    this.plays.push(this.src);
    return Promise.resolve();
  }
}

function playerFixture() {
  const audio = new FakeAudio();
  const revoked = [];
  const states = [];
  let created = 0;
  let urls = 0;
  const player = createAudioPlayer({
    createAudio: () => { created += 1; return audio; },
    createUrl: () => `blob:${++urls}`,
    revokeUrl: (url) => revoked.push(url),
    onState: (state) => states.push(state),
  });
  return { audio, player, revoked, states, created: () => created };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const blob = new Blob(["audio"]);

test("sequence plays in order using one audio element and releases all URLs", async () => {
  const f = playerFixture();
  const loaded = [];
  const playing = f.player.play([{ id: "one" }, { id: "two" }], async (item) => {
    loaded.push(item.id); return blob;
  }, { ownerId: "article" });
  await tick();
  assert.deepEqual(loaded, ["one"]);
  assert.equal(f.player.state.sentenceId, "one");
  f.audio.dispatchEvent(new Event("ended"));
  await tick();
  assert.deepEqual(loaded, ["one", "two"]);
  assert.equal(f.player.state.sentenceId, "two");
  f.audio.dispatchEvent(new Event("ended"));
  await playing;
  assert.equal(f.created(), 1);
  assert.deepEqual(f.revoked, ["blob:1", "blob:2"]);
  assert.equal(f.player.state.status, "idle");
});

test("stop during an asynchronous audio lookup prevents stale playback", async () => {
  const f = playerFixture();
  let resolveBlob;
  const playing = f.player.play([{ id: "one" }, { id: "two" }], () => new Promise((resolve) => { resolveBlob = resolve; }));
  f.player.stop();
  resolveBlob(blob);
  await playing;
  assert.equal(f.audio.plays.length, 0);
  assert.equal(f.player.state.status, "idle");
});

test("next play cancels a sequence, ignores stale loads and reuses the element", async () => {
  const f = playerFixture();
  let resolveOld;
  const old = f.player.play([{ id: "old" }], () => new Promise((resolve) => { resolveOld = resolve; }));
  const next = f.player.play([{ id: "new" }], async () => blob);
  await tick();
  resolveOld(blob);
  await old;
  assert.equal(f.player.state.sentenceId, "new");
  assert.deepEqual(f.audio.plays, ["blob:1"]);
  f.audio.dispatchEvent(new Event("ended"));
  await next;
  assert.equal(f.created(), 1);
});

test("stop during playback settles the sequence and prevents the next sentence", async () => {
  const f = playerFixture();
  let loads = 0;
  const playing = f.player.play([{ id: "one" }, { id: "two" }], async () => { loads += 1; return blob; });
  await tick();
  f.player.stop();
  f.audio.dispatchEvent(new Event("ended"));
  await playing;
  assert.equal(loads, 1);
  assert.deepEqual(f.revoked, ["blob:1"]);
});

test("audio errors terminate the sequence and reach the caller", async () => {
  const f = playerFixture();
  let loads = 0;
  const playing = f.player.play([{ id: "one" }, { id: "two" }], async () => { loads += 1; return blob; });
  const rejected = assert.rejects(playing, /播放失败/);
  await tick();
  f.audio.dispatchEvent(new Event("error"));
  await rejected;
  assert.equal(loads, 1);
  assert.equal(f.player.state.status, "idle");
  assert.deepEqual(f.revoked, ["blob:1"]);
});

test("rejected play promises and missing audio terminate playback", async () => {
  const f = playerFixture();
  f.audio.play = () => Promise.reject(new Error("not allowed"));
  await assert.rejects(f.player.play([{ id: "one" }], async () => blob), /播放失败/);
  assert.deepEqual(f.revoked, ["blob:1"]);
  await assert.rejects(f.player.play([{ id: "one" }], async () => null), /没有可播放/);
  assert.equal(f.player.state.status, "idle");
});

test("a stale play rejection cannot stop a later playback", async () => {
  const f = playerFixture();
  let rejectOld;
  f.audio.play = () => new Promise((resolve, reject) => { rejectOld = reject; });
  const old = f.player.play([{ id: "old" }], async () => blob);
  await tick();
  f.audio.play = () => Promise.resolve();
  const next = f.player.play([{ id: "new" }], async () => blob);
  await tick();
  rejectOld(new Error("old play rejected"));
  await old;
  await tick();
  assert.equal(f.player.state.sentenceId, "new");
  assert.equal(f.player.state.status, "playing");
  f.audio.dispatchEvent(new Event("ended"));
  await next;
  assert.deepEqual(f.revoked, ["blob:1", "blob:2"]);
});

test("rendered articles share word tokens, escape text and disable missing audio", () => {
  const html = renderArticlesView({
    articles: [{ id: "article", title: "<script>", sentences: [
      { id: "one", en: "Hello <img>", zh: "你好", hasAudio: false },
    ] }],
    selectedId: "article", busy: false, importFile: null, playback: { status: "idle" },
  });
  assert.ok(html.includes('data-example-word-token="Hello"'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<img>"));
  assert.match(html, /data-action="article-play-sentence"[^>]+disabled/);
  assert.ok(html.includes("你好"));
  assert.ok(!html.includes("播放中文"));
});

test("article title list sorts by course and numeric passage number", () => {
  const articles = [
    { id: "p10", title: "人文英语3 | Passage 10 | Ten", sentences: [] },
    { id: "p2", title: "人文英语3｜Passage 2｜Two", sentences: [] },
    { id: "p1", title: "人文英语3 | Passage 1 | One", sentences: [] },
    { id: "other-course", title: "人文英语4 | Passage 1 | Next course", sentences: [] },
  ];
  const html = renderArticlesView({
    articles,
    selectedId: null,
    busy: false,
    importFile: null,
    playback: { status: "idle" },
  });
  const positions = ["p1", "p2", "p10", "other-course"].map((id) =>
    html.indexOf(`data-article-id="${id}"`),
  );

  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.deepEqual(articles.map((article) => article.id), ["p10", "p2", "p1", "other-course"]);
});

test("article list keeps import controls in a separate section", () => {
  const html = renderArticlesView({
    articles: [{ id: "one", title: "Morning", sentences: [] }],
    selectedId: null, busy: false, importFile: null, playback: { status: "idle" },
  });
  assert.match(html, /data-section="list" aria-pressed="true"/);
  assert.match(html, /data-section="import" aria-pressed="false"/);
  assert.match(html, /data-action="article-open"/);
  assert.match(html, /data-action="article-export"/);
  assert.match(html, /1 篇/);
  assert.doesNotMatch(html, /name="articlePackage"|data-action="article-template"|data-action="article-import"/);
});

test("article import section shows the template and selected file without the list", () => {
  const html = renderArticlesView({
    articles: [{ id: "one", title: "Morning", sentences: [] }],
    section: "import", selectedId: "one", busy: false,
    importFile: { name: "<selected>.zip" }, playback: { status: "idle" },
  });
  assert.match(html, /data-section="import" aria-pressed="true"/);
  assert.match(html, /data-action="article-template"/);
  assert.match(html, /name="articlePackage"/);
  assert.match(html, /已选择 &lt;selected&gt;\.zip/);
  assert.match(html, /data-action="article-import" >导入文章/);
  assert.doesNotMatch(html, /data-action="article-open"|data-action="article-export"|article-sentences/);
});

test("article import section shows article progress only while importing", () => {
  const props = { articles: [], section: "import", playback: {} };
  const busy = renderArticlesView({ ...props, busy: true, importProgress: { phase: "audio", completed: 3, total: 10 } });
  const slot = busy.match(/<div data-import-progress="article">([\s\S]*?)<\/section><\/div>/)[1];
  assert.match(slot, /正在校验文章音频 3 \/ 10（30%）/);
  assert.match(slot, /文章导入进度/);
  assert.doesNotMatch(slot, /词库/);
  const idle = renderArticlesView({ ...props, busy: false, importProgress: null });
  assert.match(idle, /<div data-import-progress="article"><\/div>/);
});

test("article import requires a file and disables controls while busy", () => {
  const props = { articles: [], section: "import", selectedId: null, playback: { status: "idle" } };
  const empty = renderArticlesView({ ...props, busy: false, importFile: null });
  assert.match(empty, /尚未选择文件/);
  assert.match(empty, /data-action="article-import" disabled/);
  const busy = renderArticlesView({ ...props, busy: true, importFile: { name: "articles.zip" } });
  assert.match(busy, /name="articlePackage"[^>]+disabled/);
  assert.match(busy, /data-action="article-template" disabled/);
  assert.match(busy, /data-action="article-import" disabled/);
  assert.match(busy, /data-section="list"[^>]+disabled/);
  assert.match(busy, /data-section="import"[^>]+disabled/);
});

test("empty article list provides an import entry without showing the form", () => {
  const html = renderArticlesView({
    articles: [], selectedId: null, busy: false, importFile: null, playback: { status: "idle" },
  });
  assert.match(html, /data-action="article-section" data-section="import" >去导入文章/);
  assert.match(html, /data-action="article-export" disabled/);
  assert.doesNotMatch(html, /name="articlePackage"/);
});
