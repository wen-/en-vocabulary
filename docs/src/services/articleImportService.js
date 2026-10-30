import { importArticles, listArticles, listArticleAudio } from "../db/articleRepository.js";

export const ARTICLE_LIMITS = Object.freeze({
  zipBytes: 100 * 1024 * 1024,
  expandedBytes: 100 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
  audioBytes: 4 * 1024 * 1024,
  entries: 2000,
  articles: 200,
  sentences: 5000,
});

function fail(message) {
  throw new Error(`文章包无效：${message}`);
}

function safePath(path) {
  return typeof path === "string" && path.length <= 240 &&
    !path.includes("\\") && !path.includes("\0") &&
    !path.startsWith("/") && !path.includes(":") &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

function requiredText(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(`${label}必须为非空文本，且不超过 ${max} 个字符。`);
  }
  return value.trim();
}

export function parseArticleManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.articles) ||
      !value.articles.length || value.articles.length > ARTICLE_LIMITS.articles) {
    fail("需要 schemaVersion: 1 和 1 至 200 篇 articles。");
  }
  let sentenceCount = 0;
  return value.articles.map((article) => {
    const title = requiredText(article?.title, "标题", 300);
    if (!Array.isArray(article.sentences) || !article.sentences.length) fail(`“${title}”缺少句子。`);
    sentenceCount += article.sentences.length;
    if (sentenceCount > ARTICLE_LIMITS.sentences) fail("句子总数不得超过 5000。");
    return {
      title,
      sentences: article.sentences.map((sentence) => {
        const en = requiredText(sentence?.en, "英文句子", 10000);
        const zh = requiredText(sentence?.zh, "中文句子", 10000);
        const audio = sentence.audio;
        if (audio !== undefined && (!safePath(audio) || !/^audio\/.+\.(wav|mp3|ogg|m4a)$/i.test(audio))) {
          fail("audio 必须是 audio/ 下的 wav、mp3、ogg 或 m4a 相对路径；无音频请省略 audio。");
        }
        return { en, zh, ...(audio === undefined ? {} : { audio }) };
      }),
    };
  });
}

export function detectAudioType(bytes) {
  const text = (offset, count) => String.fromCharCode(...bytes.slice(offset, offset + count));
  if (bytes.length >= 44 && text(0, 4) === "RIFF" && text(8, 4) === "WAVE") return "audio/wav";
  if (bytes.length > 10 && (text(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224))) return "audio/mpeg";
  if (bytes.length > 27 && text(0, 4) === "OggS") return "audio/ogg";
  if (bytes.length > 16 && text(4, 4) === "ftyp") return "audio/mp4";
  fail("音频为空或不是支持的音频格式。");
}

function zipLibrary() {
  if (!globalThis.JSZip) throw new Error("ZIP 组件未加载，请刷新页面。");
  return globalThis.JSZip;
}

async function decodeAudio(bytes) {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) throw new Error("此浏览器不支持音频校验，请使用支持 Web Audio 的浏览器导入。");
  const context = new Context();
  let decoded;
  try {
    decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch {
    fail("音频无法解码，请检查文件是否损坏或使用 PCM WAV。");
  } finally {
    await context.close();
  }
  if (!(decoded.duration > 0) || decoded.duration > 300) fail("音频必须有内容且不超过 5 分钟。");
}

export async function readArticlePackage(file, { validateAudio = decodeAudio } = {}) {
  if (!file?.size || file.size > ARTICLE_LIMITS.zipBytes || !/\.zip$/i.test(file.name || "")) {
    fail("请选择不超过 100 MB 的 ZIP 文件。");
  }
  let zip;
  try {
    zip = await zipLibrary().loadAsync(await file.arrayBuffer());
  } catch {
    fail("无法读取 ZIP 文件。");
  }
  const entries = Object.values(zip.files);
  if (entries.length > ARTICLE_LIMITS.entries) fail("ZIP 内文件数不得超过 2000。");
  let expanded = 0;
  for (const entry of entries) {
    const path = entry.dir ? entry.name.replace(/\/$/, "") : entry.name;
    if (!safePath(path) || (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)) fail("ZIP 包含不安全路径。");
    const size = entry._data?.uncompressedSize ?? 0;
    expanded += size;
    if (!entry.dir && size > (entry.name === "articles.json" ? ARTICLE_LIMITS.jsonBytes : ARTICLE_LIMITS.audioBytes)) {
      fail(`文件过大：${entry.name}`);
    }
  }
  if (expanded > ARTICLE_LIMITS.expandedBytes) fail("解压后总大小不得超过 100 MB。");
  const manifest = zip.file("articles.json");
  if (!manifest) fail("ZIP 根目录缺少 articles.json。");
  const manifestBytes = await manifest.async("uint8array");
  if (manifestBytes.length > ARTICLE_LIMITS.jsonBytes) fail("articles.json 超过 1 MB。");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    fail("articles.json 不是有效的 UTF-8 JSON。");
  }
  const articles = parseArticleManifest(value);
  const blobs = new Map();
  for (const article of articles) {
    for (const sentence of article.sentences) {
      if (!sentence.audio) continue;
      if (!blobs.has(sentence.audio)) {
        const entry = zip.file(sentence.audio);
        if (!entry) fail(`缺少音频文件：${sentence.audio}`);
        const bytes = await entry.async("uint8array");
        if (!bytes.length || bytes.length > ARTICLE_LIMITS.audioBytes) fail("单个音频必须为 1 字节至 4 MB。");
        const type = detectAudioType(bytes);
        await validateAudio(bytes);
        blobs.set(sentence.audio, new Blob([bytes], { type }));
      }
      sentence.blob = blobs.get(sentence.audio);
    }
  }
  return articles;
}

export async function importArticlePackage(file) {
  const articles = await readArticlePackage(file);
  return importArticles(articles);
}

export async function createArticlePackage(articles, audioById) {
  const Zip = zipLibrary();
  const zip = new Zip();
  const manifest = {
    schemaVersion: 1,
    articles: articles.map((article) => ({
      title: article.title,
      sentences: article.sentences.map((sentence) => {
        const blob = audioById.get(sentence.id);
        if (sentence.hasAudio && !blob?.size) throw new Error("文章音频缺失，无法生成无损导出。");
        if (!blob) return { en: sentence.en, zh: sentence.zh };
        const extension = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a" }[blob.type];
        if (!extension) throw new Error("文章音频格式无效。");
        const path = `audio/${sentence.id}.${extension}`;
        zip.file(path, blob.arrayBuffer());
        return { en: sentence.en, zh: sentence.zh, audio: path };
      }),
    })),
  };
  try {
    parseArticleManifest(manifest);
    const json = JSON.stringify(manifest, null, 2);
    const jsonBytes = new TextEncoder().encode(json).length;
    const audioBytes = [...audioById.values()].reduce((total, blob) => total + (blob?.size || 0), 0);
    if (jsonBytes > ARTICLE_LIMITS.jsonBytes || audioBytes + jsonBytes > ARTICLE_LIMITS.expandedBytes ||
        audioById.size + 2 > ARTICLE_LIMITS.entries) throw new Error("limit");
    zip.file("articles.json", json);
    const result = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    if (result.size > ARTICLE_LIMITS.zipBytes) throw new Error("limit");
    return result;
  } catch {
    throw new Error("文章数量或体积超过单包限制，请在文章详情页逐篇导出。");
  }
}

export async function exportArticlePackage() {
  const [articles, audio] = await Promise.all([listArticles(), listArticleAudio()]);
  if (!articles.length) throw new Error("还没有可导出的文章。");
  return createArticlePackage(articles, new Map(audio.map((record) => [record.id, record.blob])));
}

export async function createArticleTemplate() {
  const response = await fetch("./assets/article-template.wav");
  if (!response.ok) throw new Error("模板音频未加载，请联网刷新一次后重试。");
  const blob = new Blob([await response.arrayBuffer()], { type: "audio/wav" });
  return createArticlePackage([{
    title: "A Quiet Morning",
    sentences: [{ id: "morning", en: "A new day begins.", zh: "新的一天开始了。", hasAudio: true }],
  }], new Map([["morning", blob]]));
}
