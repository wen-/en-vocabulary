import { AUDIO_SLOTS, STORES, createAudioRecordId, normalizeAudioSlot, requestToPromise, runTransaction } from "../db/database.js";
import { listAudioRecords, listWords } from "../db/wordRepository.js";
import { listCategories } from "../db/categoryRepository.js";
import { listPracticeAttempts } from "../db/practiceRepository.js";
import { createId, normalizePhoneticAndNotes, normalizeText, uniqueStrings } from "./helpers.js";

export const BACKUP_SCHEMA_VERSION = 1;
export const CSV_TEMPLATE_HEADERS = ["term", "phonetic", "meaning", "example", "notes", "categories", "audio", "exampleAudio"];
const ZIP_METADATA_PATH = "metadata.json";
const ZIP_AUDIO_DIRECTORY = "audio";
const ZIP_EXAMPLE_AUDIO_DIRECTORY = "example-audio";

const CSV_HEADER_ALIASES = {
  term: "term",
  word: "term",
  单词: "term",
  英文: "term",
  phonetic: "phonetic",
  ipa: "phonetic",
  pronunciation: "phonetic",
  音标: "phonetic",
  meaning: "meaning",
  definition: "meaning",
  释义: "meaning",
  中文: "meaning",
  example: "example",
  sentence: "example",
  例句: "example",
  notes: "notes",
  note: "notes",
  备注: "notes",
  categories: "categories",
  category: "categories",
  分类: "categories",
  audio: "audio",
  audiofile: "audio",
  audiofilename: "audio",
  audiopath: "audio",
  音频: "audio",
  音频文件: "audio",
  exampleaudio: "exampleAudio",
  example_audio: "exampleAudio",
  exampleaudiopath: "exampleAudio",
  sentenceaudio: "exampleAudio",
  例句音频: "exampleAudio",
  例句音频文件: "exampleAudio",
};

const CSV_TEMPLATE_ROWS = [
  {
    term: "analysis",
    phonetic: "/əˈnæləsɪs/",
    meaning: "分析；解析",
    example: "Careful analysis of the data revealed a clear pattern.",
    notes: "适合学术写作与实验报告。",
    categories: "本科@学历层级|理工英语@专业领域",
    audio: "analysis.mp3",
    exampleAudio: "",
  },
  {
    term: "narrative",
    phonetic: "/ˈnærətɪv/",
    meaning: "叙述；叙事文",
    example: "The author uses a personal narrative to introduce the topic.",
    notes: "适合人文写作与阅读课。",
    categories: "本科@学历层级|人文英语@专业领域",
    audio: "narrative.mp3",
    exampleAudio: "",
  },
];

function getZipAudioDirectory(slot = AUDIO_SLOTS.term) {
  return normalizeAudioSlot(slot) === AUDIO_SLOTS.example ? ZIP_EXAMPLE_AUDIO_DIRECTORY : ZIP_AUDIO_DIRECTORY;
}

function countAudioReferences(record) {
  return Number(Boolean(record?.audio)) + Number(Boolean(record?.exampleAudio));
}

function countHydratedAudioBlobs(record) {
  return Number(Boolean(record?.audioBlob)) + Number(Boolean(record?.exampleAudioBlob));
}

function normalizeImportedAudioEntry(audioEntry) {
  if (!audioEntry?.wordId) {
    return null;
  }

  const slot = normalizeAudioSlot(audioEntry.slot);

  return {
    ...audioEntry,
    id: audioEntry.id || createAudioRecordId(audioEntry.wordId, slot),
    slot,
  };
}

function groupAudioRecordsByWordId(audioRecords) {
  const grouped = new Map();

  for (const record of audioRecords) {
    if (!record?.wordId) {
      continue;
    }

    const slot = normalizeAudioSlot(record.slot);
    const slotMap = grouped.get(record.wordId) || new Map();
    slotMap.set(slot, record);
    grouped.set(record.wordId, slotMap);
  }

  return grouped;
}

function setGroupedAudioRecord(groupedRecords, audioRecord) {
  if (!audioRecord?.wordId) {
    return;
  }

  const slot = normalizeAudioSlot(audioRecord.slot);
  const slotMap = groupedRecords.get(audioRecord.wordId) || new Map();
  slotMap.set(slot, audioRecord);
  groupedRecords.set(audioRecord.wordId, slotMap);
}

function getGroupedAudioRecord(groupedRecords, wordId, slot = AUDIO_SLOTS.term) {
  return groupedRecords.get(wordId)?.get(normalizeAudioSlot(slot)) || null;
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function createCsvLine(values) {
  return values.map((value) => csvEscape(value)).join(",");
}

function normalizeCsvHeader(value) {
  const normalized = normalizeText(value);
  return CSV_HEADER_ALIASES[normalized] || normalized;
}

function parseCsvTable(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }

      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    cell += char;
  }

  row.push(cell);

  if (row.some((value) => value !== "") || rows.length === 0) {
    rows.push(row);
  }

  return rows;
}

function parseCategorySpecs(value) {
  return uniqueStrings(String(value ?? "").split(/[|；;]/))
    .map((item) => {
      const [namePart, groupPart = ""] = item.split("@");
      const name = String(namePart ?? "").trim();
      const group = String(groupPart ?? "").trim();

      return name ? { name, group } : null;
    })
    .filter(Boolean);
}

function parseCsvRecords(text) {
  const table = parseCsvTable(text);

  if (table.length < 2) {
    throw new Error("CSV 至少需要表头和一行数据。");
  }

  const headers = table[0].map((header) => normalizeCsvHeader(header));
  const headerIndex = Object.fromEntries(headers.map((header, index) => [header, index]));

  for (const requiredHeader of ["term", "meaning"]) {
    if (headerIndex[requiredHeader] === undefined) {
      throw new Error(`CSV 缺少必填列：${requiredHeader}。`);
    }
  }

  const records = [];
  const errors = [];

  for (let rowIndex = 1; rowIndex < table.length; rowIndex += 1) {
    const row = table[rowIndex];

    if (row.every((cell) => !String(cell ?? "").trim())) {
      continue;
    }

    const normalizedText = normalizePhoneticAndNotes(row[headerIndex.phonetic] ?? "", row[headerIndex.notes] ?? "");

    const record = {
      term: String(row[headerIndex.term] ?? "").trim(),
      phonetic: normalizedText.phonetic,
      meaning: String(row[headerIndex.meaning] ?? "").trim(),
      example: String(row[headerIndex.example] ?? "").trim(),
      notes: normalizedText.notes,
      categories: parseCategorySpecs(row[headerIndex.categories] ?? ""),
      audio: String(row[headerIndex.audio] ?? "").trim(),
      exampleAudio: String(row[headerIndex.exampleAudio] ?? "").trim(),
      lineNumber: rowIndex + 1,
    };

    if (!record.term || !record.meaning) {
      errors.push(`第 ${record.lineNumber} 行缺少单词或释义。`);
      continue;
    }

    records.push(record);
  }

  if (!records.length && !errors.length) {
    throw new Error("CSV 中没有可导入的数据行。");
  }

  if (errors.length) {
    throw new Error(errors.slice(0, 5).join(" "));
  }

  return records;
}

function dataUrlToBlob(dataUrl, mimeType) {
  const [prefix, base64Data] = String(dataUrl).split(",");

  if (!prefix || !base64Data) {
    throw new Error("备份中的音频数据格式无效。");
  }

  const inferredType = prefix.match(/data:(.*?);base64/)?.[1] || mimeType || "application/octet-stream";
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: inferredType });
}

function audioEntryToBlob(audioEntry) {
  if (audioEntry?.blob instanceof Blob) {
    return audioEntry.blob;
  }

  if (audioEntry?.dataUrl) {
    return dataUrlToBlob(audioEntry.dataUrl, audioEntry.type);
  }

  throw new Error(`备份中的音频 ${audioEntry?.wordId || "unknown"} 缺少可恢复内容。`);
}

function getZipLibrary() {
  const zipLibrary = globalThis.JSZip;

  if (!zipLibrary) {
    throw new Error("ZIP 组件未加载，请刷新页面后重试。");
  }

  return zipLibrary;
}

function isZipFile(file) {
  const name = String(file?.name ?? "").toLowerCase();
  const type = String(file?.type ?? "").toLowerCase();
  return name.endsWith(".zip") || type.includes("zip");
}

function inferAudioExtension(name, mimeType) {
  const nameMatch = String(name ?? "").match(/\.[a-z0-9]+$/i);

  if (nameMatch) {
    return nameMatch[0].toLowerCase();
  }

  switch (String(mimeType ?? "").toLowerCase()) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    default:
      return ".bin";
  }
}

function inferAudioMimeType(name) {
  const extension = String(name ?? "").trim().toLowerCase().match(/\.[a-z0-9]+$/)?.[0];

  switch (extension) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

function normalizeArchivePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function findCsvEntryInZip(zip) {
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && /\.csv$/i.test(entry.name) && !entry.name.startsWith("__MACOSX/"),
  );

  if (!entries.length) {
    throw new Error("ZIP 词库中未找到 CSV 文件，请至少包含一个 words.csv。");
  }

  const preferred = entries.find((entry) => /(^|\/)words\.csv$/i.test(entry.name));

  if (preferred) {
    return preferred;
  }

  if (entries.length > 1) {
    throw new Error("ZIP 词库中包含多个 CSV 文件，请将主文件命名为 words.csv。");
  }

  return entries[0];
}

function resolveZipAudioEntry(zip, audioReference, slot = AUDIO_SLOTS.term) {
  const normalizedPath = normalizeArchivePath(audioReference);

  if (!normalizedPath) {
    return null;
  }

  const basename = normalizedPath.split("/").pop();
  const directory = getZipAudioDirectory(slot);
  const candidates = uniqueStrings([
    normalizedPath,
    normalizedPath.startsWith(`${directory}/`) ? normalizedPath : `${directory}/${normalizedPath}`,
    basename,
    basename ? `${directory}/${basename}` : "",
  ]);

  for (const candidate of candidates) {
    const zipEntry = zip.file(candidate);

    if (zipEntry) {
      return {
        zipEntry,
        path: candidate,
      };
    }
  }

  throw new Error(`ZIP 词库中缺少音频文件：${audioReference}。`);
}

function createZipAudioPath(record) {
  const directory = getZipAudioDirectory(record?.slot);
  return `${directory}/${record.wordId}${inferAudioExtension(record.name, record.type)}`;
}

function normalizeBackupPayload(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt,
    words: Array.isArray(payload.words) ? payload.words : [],
    categories: Array.isArray(payload.categories) ? payload.categories : [],
    practiceAttempts: Array.isArray(payload.practiceAttempts) ? payload.practiceAttempts : [],
    audio: (Array.isArray(payload.audio) ? payload.audio : []).map((entry) => normalizeImportedAudioEntry(entry)).filter(Boolean),
  };
}

function validateBackupPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("备份文件内容无效。");
  }

  if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error("备份版本不匹配，暂不支持导入该文件。");
  }

  for (const key of ["words", "categories", "practiceAttempts", "audio"]) {
    if (!Array.isArray(payload[key])) {
      throw new Error(`备份文件缺少 ${key} 数据。`);
    }
  }

  payload.categories.forEach((category, index) => {
    if (!String(category?.name ?? "").trim()) {
      throw new Error(`备份中的第 ${index + 1} 个分类缺少名称。`);
    }
  });

  payload.words.forEach((word, index) => {
    if (!String(word?.term ?? "").trim() || !String(word?.meaning ?? "").trim()) {
      throw new Error(`备份中的第 ${index + 1} 个单词缺少单词或释义。`);
    }
  });
}

function parseBackupText(text) {
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是合法的 JSON。");
  }

  validateBackupPayload(payload);
  return normalizeBackupPayload(payload);
}

function summarizeBackupPayload(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt,
    words: payload.words.length,
    categories: payload.categories.length,
    practiceAttempts: payload.practiceAttempts.length,
    audio: payload.audio.length,
  };
}

async function parseBackupZip(file, options = {}) {
  const JSZip = getZipLibrary();
  const zip = await JSZip.loadAsync(file);
  const metadataEntry = zip.file(ZIP_METADATA_PATH);

  if (!metadataEntry) {
    throw new Error("ZIP 备份缺少 metadata.json。");
  }

  const metadataText = await metadataEntry.async("string");
  const payload = parseBackupText(metadataText);

  if (!options.includeAudio) {
    return payload;
  }

  const audio = [];

  for (const audioEntry of payload.audio) {
    if (audioEntry?.dataUrl) {
      audio.push(audioEntry);
      continue;
    }

    const zipPath = String(audioEntry?.path ?? "").trim();

    if (!zipPath) {
      throw new Error(`ZIP 备份中的音频 ${audioEntry?.wordId || "unknown"} 缺少文件路径。`);
    }

    const archiveFile = zip.file(zipPath);

    if (!archiveFile) {
      throw new Error(`ZIP 备份缺少音频文件：${zipPath}。`);
    }

    audio.push({
      ...audioEntry,
      blob: await archiveFile.async("blob"),
    });
  }

  return {
    ...payload,
    audio,
  };
}

function createCategoryRecord(category, now, categoryId = category.id || createId()) {
  return {
    id: categoryId,
    name: String(category.name ?? "").trim(),
    normalizedName: normalizeText(category.name),
    group: String(category.group ?? "").trim(),
    description: String(category.description ?? "").trim(),
    createdAt: category.createdAt || now,
    updatedAt: category.updatedAt || now,
  };
}

function createWordRecord(word, now, options = {}) {
  const normalizedText = normalizePhoneticAndNotes(word.phonetic, word.notes);

  return {
    id: options.id || word.id || createId(),
    term: String(word.term ?? "").trim(),
    normalizedTerm: normalizeText(word.term),
    phonetic: normalizedText.phonetic,
    meaning: String(word.meaning ?? "").trim(),
    example: String(word.example ?? "").trim(),
    notes: normalizedText.notes,
    categoryIds: uniqueStrings(options.categoryIds ?? word.categoryIds),
    createdAt: options.createdAt || word.createdAt || now,
    updatedAt: options.updatedAt || word.updatedAt || now,
    hasAudio: Boolean(options.hasAudio ?? word.hasAudio),
    hasExampleAudio: Boolean(options.hasExampleAudio ?? word.hasExampleAudio),
  };
}

export async function createBackupZipBlob() {
  const JSZip = getZipLibrary();
  const [words, categories, practiceAttempts, audioRecords] = await Promise.all([
    listWords(),
    listCategories(),
    listPracticeAttempts(5000),
    listAudioRecords(),
  ]);
  const zip = new JSZip();
  const audio = [];

  for (const record of audioRecords) {
    const path = createZipAudioPath(record);
    audio.push({
      id: record.id,
      wordId: record.wordId,
      slot: normalizeAudioSlot(record.slot),
      name: record.name,
      type: record.type,
      size: record.size,
      updatedAt: record.updatedAt,
      path,
    });
    zip.file(path, record.blob);
  }

  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    words,
    categories,
    practiceAttempts,
    audio,
  };

  zip.file(ZIP_METADATA_PATH, JSON.stringify(payload, null, 2));

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });
}

function formatCategoryExportValue(category) {
  if (!category) {
    return "";
  }

  const name = String(category.name ?? "").trim();
  const group = String(category.group ?? "").trim();

  if (!name) {
    return "";
  }

  return group ? `${name}@${group}` : name;
}

function createWordsCsvExportText(words, categoriesById, audioByWordId) {
  const lines = [createCsvLine(CSV_TEMPLATE_HEADERS)];

  for (const word of words) {
    const audioRecord = getGroupedAudioRecord(audioByWordId, word.id, AUDIO_SLOTS.term);
    const exampleAudioRecord = getGroupedAudioRecord(audioByWordId, word.id, AUDIO_SLOTS.example);
    const categories = uniqueStrings(word.categoryIds || [])
      .map((categoryId) => formatCategoryExportValue(categoriesById.get(categoryId)))
      .filter(Boolean)
      .join("|");
    const audioPath = audioRecord ? createZipAudioPath(audioRecord) : "";
    const exampleAudioPath = exampleAudioRecord ? createZipAudioPath(exampleAudioRecord) : "";

    lines.push(
      createCsvLine([
        word.term,
        word.phonetic,
        word.meaning,
        word.example,
        word.notes,
        categories,
        audioPath,
        exampleAudioPath,
      ]),
    );
  }

  return `\uFEFF${lines.join("\n")}\n`;
}

export async function createWordsCsvPackageZipBlob() {
  const JSZip = getZipLibrary();
  const [words, categories, audioRecords] = await Promise.all([
    listWords(),
    listCategories(),
    listAudioRecords(),
  ]);
  const zip = new JSZip();
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const audioByWordId = groupAudioRecordsByWordId(audioRecords);
  const csvText = createWordsCsvExportText(words, categoriesById, audioByWordId);

  zip.file("words.csv", csvText);

  for (const record of audioRecords) {
    zip.file(createZipAudioPath(record), record.blob);
  }

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });
}

export function inspectBackupText(text) {
  return summarizeBackupPayload(parseBackupText(text));
}

export async function inspectBackupFile(file) {
  if (isZipFile(file)) {
    return {
      format: "zip",
      ...summarizeBackupPayload(await parseBackupZip(file, { includeAudio: false })),
    };
  }

  return {
    format: "json",
    ...inspectBackupText(await file.text()),
  };
}

export function createWordsCsvTemplate() {
  const lines = [
    createCsvLine(CSV_TEMPLATE_HEADERS),
    ...CSV_TEMPLATE_ROWS.map((row) =>
      createCsvLine(CSV_TEMPLATE_HEADERS.map((header) => row[header] ?? "")),
    ),
  ];

  return `\uFEFF${lines.join("\n")}\n`;
}

export function inspectCsvImportText(text) {
  const records = parseCsvRecords(text);
  const categories = new Set();

  for (const record of records) {
    for (const category of record.categories) {
      categories.add(`${normalizeText(category.name)}@@${normalizeText(category.group)}`);
    }
  }

  return {
    rows: records.length,
    categories: categories.size,
    audioRefs: records.reduce((total, record) => total + countAudioReferences(record), 0),
  };
}

async function parseCsvImportFile(file, options = {}) {
  const includeAudio = Boolean(options.includeAudio);

  if (!isZipFile(file)) {
    const text = await file.text();
    const records = parseCsvRecords(text);

    if (includeAudio && records.some((record) => countAudioReferences(record) > 0)) {
      throw new Error("纯 CSV 文件无法携带音频；如需一起导入发音或例句音频，请上传包含 words.csv、audio 目录和可选 example-audio 目录的 ZIP 包。");
    }

    return {
      format: "csv",
      records,
    };
  }

  const JSZip = getZipLibrary();
  const zip = await JSZip.loadAsync(file);
  const csvEntry = findCsvEntryInZip(zip);
  const csvText = await csvEntry.async("string");
  const records = parseCsvRecords(csvText);

  if (!includeAudio) {
    return {
      format: "zip",
      records,
    };
  }

  const hydratedRecords = [];

  for (const record of records) {
    const hydratedRecord = { ...record };

    if (record.audio) {
      const resolved = resolveZipAudioEntry(zip, record.audio, AUDIO_SLOTS.term);
      const blob = await resolved.zipEntry.async("blob");

      hydratedRecord.audioPath = resolved.path;
      hydratedRecord.audioName = record.audio.split("/").pop() || resolved.path.split("/").pop() || `${record.term}.bin`;
      hydratedRecord.audioBlob = blob;
      hydratedRecord.audioType = blob.type || inferAudioMimeType(record.audio);
      hydratedRecord.audioSize = blob.size;
    }

    if (record.exampleAudio) {
      const resolved = resolveZipAudioEntry(zip, record.exampleAudio, AUDIO_SLOTS.example);
      const blob = await resolved.zipEntry.async("blob");

      hydratedRecord.exampleAudioPath = resolved.path;
      hydratedRecord.exampleAudioName = record.exampleAudio.split("/").pop() || resolved.path.split("/").pop() || `${record.term}-example.bin`;
      hydratedRecord.exampleAudioBlob = blob;
      hydratedRecord.exampleAudioType = blob.type || inferAudioMimeType(record.exampleAudio);
      hydratedRecord.exampleAudioSize = blob.size;
    }

    hydratedRecords.push(hydratedRecord);
  }

  return {
    format: "zip",
    records: hydratedRecords,
  };
}

export async function inspectCsvImportFile(file) {
  const { format, records } = await parseCsvImportFile(file, { includeAudio: false });
  const categories = new Set();

  for (const record of records) {
    for (const category of record.categories) {
      categories.add(`${normalizeText(category.name)}@@${normalizeText(category.group)}`);
    }
  }

  return {
    format,
    rows: records.length,
    categories: categories.size,
    audioRefs: records.reduce((total, record) => total + countAudioReferences(record), 0),
    requiresZipForAudio: format === "csv" && records.some((record) => countAudioReferences(record) > 0),
  };
}

function createImportedCsvAudioRecord(wordId, slot, record, now) {
  if (normalizeAudioSlot(slot) === AUDIO_SLOTS.example) {
    if (!record.exampleAudioBlob) {
      return null;
    }

    return {
      id: createAudioRecordId(wordId, AUDIO_SLOTS.example),
      wordId,
      slot: AUDIO_SLOTS.example,
      name: record.exampleAudioName || record.exampleAudio || `${record.term}-example.bin`,
      type: record.exampleAudioType || inferAudioMimeType(record.exampleAudioName || record.exampleAudio),
      size: record.exampleAudioSize || record.exampleAudioBlob.size,
      blob: record.exampleAudioBlob,
      updatedAt: now,
    };
  }

  if (!record.audioBlob) {
    return null;
  }

  return {
    id: createAudioRecordId(wordId, AUDIO_SLOTS.term),
    wordId,
    slot: AUDIO_SLOTS.term,
    name: record.audioName || record.audio || `${record.term}.bin`,
    type: record.audioType || inferAudioMimeType(record.audioName || record.audio),
    size: record.audioSize || record.audioBlob.size,
    blob: record.audioBlob,
    updatedAt: now,
  };
}

async function importWordsFromParsedCsvRecords(records, options = {}) {
  const duplicateMode = options.duplicateMode === "overwrite" ? "overwrite" : "skip";

  return runTransaction([STORES.categories, STORES.words, STORES.audio], "readwrite", async ({ categories, words, audio }) => {
    const now = Date.now();
    const [existingCategories, existingWords, existingAudio] = await Promise.all([
      requestToPromise(categories.getAll()),
      requestToPromise(words.getAll()),
      requestToPromise(audio.getAll()),
    ]);
    const categoriesByName = new Map(
      existingCategories.map((category) => [normalizeText(category.name), category]),
    );
    const wordsByTerm = new Map(existingWords.map((word) => [normalizeText(word.term), word]));
    const audioByWordId = groupAudioRecordsByWordId(existingAudio.map((entry) => normalizeImportedAudioEntry(entry)).filter(Boolean));
    const summary = {
      duplicateMode,
      rows: records.length,
      createdCategories: 0,
      createdWords: 0,
      updatedWords: 0,
      skippedWords: 0,
      importedAudio: 0,
      updatedAudio: 0,
      skippedAudio: 0,
    };

    for (const record of records) {
      const categoryIds = [];

      for (const categorySpec of record.categories) {
        const normalizedName = normalizeText(categorySpec.name);
        let category = categoriesByName.get(normalizedName);

        if (!category) {
          category = createCategoryRecord(categorySpec, now);
          await requestToPromise(categories.put(category));
          categoriesByName.set(normalizedName, category);
          summary.createdCategories += 1;
        } else if (!category.group && categorySpec.group) {
          category = {
            ...category,
            group: categorySpec.group,
            updatedAt: now,
          };
          await requestToPromise(categories.put(category));
          categoriesByName.set(normalizedName, category);
        }

        categoryIds.push(category.id);
      }

      const normalizedTerm = normalizeText(record.term);
      const existingWord = wordsByTerm.get(normalizedTerm);

      if (existingWord && duplicateMode === "skip") {
        summary.skippedWords += 1;
        summary.skippedAudio += countHydratedAudioBlobs(record);

        continue;
      }

      if (existingWord) {
        const updatedWord = createWordRecord(record, now, {
          id: existingWord.id,
          createdAt: existingWord.createdAt,
          updatedAt: now,
          categoryIds,
          hasAudio: existingWord.hasAudio || Boolean(record.audioBlob),
          hasExampleAudio: Boolean(existingWord.hasExampleAudio) || Boolean(record.exampleAudioBlob),
        });
        await requestToPromise(words.put(updatedWord));
        wordsByTerm.set(normalizedTerm, updatedWord);
        summary.updatedWords += 1;

        for (const slot of [AUDIO_SLOTS.term, AUDIO_SLOTS.example]) {
          const importedAudioRecord = createImportedCsvAudioRecord(existingWord.id, slot, record, now);

          if (!importedAudioRecord) {
            continue;
          }

          const existingAudioRecord = getGroupedAudioRecord(audioByWordId, existingWord.id, slot);
          await requestToPromise(audio.put(importedAudioRecord));
          setGroupedAudioRecord(audioByWordId, importedAudioRecord);

          if (existingAudioRecord) {
            summary.updatedAudio += 1;
          } else {
            summary.importedAudio += 1;
          }
        }

        continue;
      }

      const newWord = createWordRecord(record, now, {
        categoryIds,
        hasAudio: Boolean(record.audioBlob),
        hasExampleAudio: Boolean(record.exampleAudioBlob),
      });
      await requestToPromise(words.put(newWord));
      wordsByTerm.set(normalizedTerm, newWord);
      summary.createdWords += 1;

      for (const slot of [AUDIO_SLOTS.term, AUDIO_SLOTS.example]) {
        const importedAudioRecord = createImportedCsvAudioRecord(newWord.id, slot, record, now);

        if (!importedAudioRecord) {
          continue;
        }

        await requestToPromise(audio.put(importedAudioRecord));
        setGroupedAudioRecord(audioByWordId, importedAudioRecord);
        summary.importedAudio += 1;
      }
    }

    return summary;
  });
}

export async function importWordsFromCsvText(text, options = {}) {
  const records = parseCsvRecords(text);
  return importWordsFromParsedCsvRecords(records, options);
}

export async function importWordsFromCsvFile(file, options = {}) {
  const { records } = await parseCsvImportFile(file, { includeAudio: true });
  return importWordsFromParsedCsvRecords(records, options);
}

async function replaceBackupPayload(payload) {
  const importedAudioByWordId = groupAudioRecordsByWordId(payload.audio);

  return runTransaction(
    [STORES.words, STORES.categories, STORES.audio, STORES.practiceAttempts, STORES.settings],
    "readwrite",
    async (stores) => {
      const now = Date.now();
      const categoryIdMap = new Map();
      const validWordIds = new Set();

      for (const storeName of Object.values(STORES)) {
        await requestToPromise(stores[storeName].clear());
      }

      for (const category of payload.categories) {
        const record = createCategoryRecord(category, now);
        categoryIdMap.set(category.id, record.id);
        await requestToPromise(stores.categories.put(record));
      }

      for (const word of payload.words) {
        const categoryIds = uniqueStrings(
          (word.categoryIds || []).map((categoryId) => categoryIdMap.get(categoryId)).filter(Boolean),
        );
        const termAudioEntry = getGroupedAudioRecord(importedAudioByWordId, word.id, AUDIO_SLOTS.term);
        const exampleAudioEntry = getGroupedAudioRecord(importedAudioByWordId, word.id, AUDIO_SLOTS.example);
        const record = createWordRecord(word, now, {
          categoryIds,
          hasAudio: Boolean(termAudioEntry),
          hasExampleAudio: Boolean(exampleAudioEntry),
        });
        validWordIds.add(record.id);
        await requestToPromise(stores.words.put(record));
      }

      let restoredAudio = 0;

      for (const audioEntry of payload.audio) {
        const normalizedAudioEntry = normalizeImportedAudioEntry(audioEntry);

        if (!normalizedAudioEntry || !validWordIds.has(normalizedAudioEntry.wordId)) {
          continue;
        }

        await requestToPromise(
          stores.audio.put({
            id: normalizedAudioEntry.id,
            wordId: normalizedAudioEntry.wordId,
            slot: normalizedAudioEntry.slot,
            name: normalizedAudioEntry.name,
            type: normalizedAudioEntry.type,
            size: normalizedAudioEntry.size,
            updatedAt: normalizedAudioEntry.updatedAt,
            blob: audioEntryToBlob(normalizedAudioEntry),
          }),
        );
        restoredAudio += 1;
      }

      let restoredPracticeAttempts = 0;

      for (const attempt of payload.practiceAttempts) {
        if (!validWordIds.has(attempt.wordId)) {
          continue;
        }

        await requestToPromise(stores.practiceAttempts.put(attempt));
        restoredPracticeAttempts += 1;
      }

      await requestToPromise(
        stores.settings.put({
          key: "lastImportAt",
          value: Date.now(),
        }),
      );
      await requestToPromise(
        stores.settings.put({
          key: "lastImportMode",
          value: "replace",
        }),
      );

      return {
        mode: "replace",
        totalCategories: payload.categories.length,
        totalWords: payload.words.length,
        totalAudio: restoredAudio,
        totalPracticeAttempts: restoredPracticeAttempts,
        createdCategories: payload.categories.length,
        updatedCategories: 0,
        createdWords: payload.words.length,
        updatedWords: 0,
        skippedWords: 0,
        importedAudio: restoredAudio,
        updatedAudio: 0,
        skippedAudio: payload.audio.length - restoredAudio,
        importedPracticeAttempts: restoredPracticeAttempts,
        skippedPracticeAttempts: payload.practiceAttempts.length - restoredPracticeAttempts,
      };
    },
  );
}

async function mergeBackupPayload(payload) {
  const importedAudioByWordId = groupAudioRecordsByWordId(payload.audio);

  return runTransaction(
    [STORES.words, STORES.categories, STORES.audio, STORES.practiceAttempts, STORES.settings],
    "readwrite",
    async (stores) => {
      const now = Date.now();
      const [existingCategories, existingWords, existingAudio, existingPracticeAttempts] = await Promise.all([
        requestToPromise(stores.categories.getAll()),
        requestToPromise(stores.words.getAll()),
        requestToPromise(stores.audio.getAll()),
        requestToPromise(stores.practiceAttempts.getAll()),
      ]);
      const categoriesByName = new Map(
        existingCategories.map((category) => [normalizeText(category.name), category]),
      );
      const wordsByTerm = new Map(existingWords.map((word) => [normalizeText(word.term), word]));
      const audioByWordId = groupAudioRecordsByWordId(
        existingAudio.map((audio) => normalizeImportedAudioEntry(audio)).filter(Boolean),
      );
      const practiceAttemptIds = new Set(existingPracticeAttempts.map((attempt) => attempt.id));
      const categoryIdMap = new Map();
      const wordIdMap = new Map();
      const summary = {
        mode: "merge",
        totalCategories: payload.categories.length,
        totalWords: payload.words.length,
        totalAudio: payload.audio.length,
        totalPracticeAttempts: payload.practiceAttempts.length,
        createdCategories: 0,
        updatedCategories: 0,
        createdWords: 0,
        updatedWords: 0,
        skippedWords: 0,
        importedAudio: 0,
        updatedAudio: 0,
        skippedAudio: 0,
        importedPracticeAttempts: 0,
        skippedPracticeAttempts: 0,
      };

      for (const category of payload.categories) {
        const normalizedName = normalizeText(category.name);
        const existingCategory = categoriesByName.get(normalizedName);

        if (existingCategory) {
          const nextCategory = {
            ...existingCategory,
            group: existingCategory.group || String(category.group ?? "").trim(),
            description: existingCategory.description || String(category.description ?? "").trim(),
            updatedAt: Math.max(existingCategory.updatedAt || 0, category.updatedAt || 0, now),
          };
          await requestToPromise(stores.categories.put(nextCategory));
          categoriesByName.set(normalizedName, nextCategory);
          categoryIdMap.set(category.id, nextCategory.id);
          summary.updatedCategories += 1;
          continue;
        }

        const newCategory = createCategoryRecord(category, now);
        await requestToPromise(stores.categories.put(newCategory));
        categoriesByName.set(normalizedName, newCategory);
        categoryIdMap.set(category.id, newCategory.id);
        summary.createdCategories += 1;
      }

      for (const word of payload.words) {
        const normalizedTerm = normalizeText(word.term);
        const existingWord = wordsByTerm.get(normalizedTerm);
        const remappedCategoryIds = uniqueStrings(
          (word.categoryIds || []).map((categoryId) => categoryIdMap.get(categoryId)).filter(Boolean),
        );
        const normalizedText = normalizePhoneticAndNotes(word.phonetic, word.notes);
        const importedTermAudio = getGroupedAudioRecord(importedAudioByWordId, word.id, AUDIO_SLOTS.term);
        const importedExampleAudio = getGroupedAudioRecord(importedAudioByWordId, word.id, AUDIO_SLOTS.example);

        if (existingWord) {
          const mergedWord = {
            ...existingWord,
            term: String(word.term ?? existingWord.term).trim() || existingWord.term,
            normalizedTerm,
            phonetic: normalizedText.phonetic || existingWord.phonetic,
            meaning: String(word.meaning ?? "").trim() || existingWord.meaning,
            example: String(word.example ?? "").trim() || existingWord.example,
            notes: normalizedText.notes || existingWord.notes,
            categoryIds: uniqueStrings([...(existingWord.categoryIds || []), ...remappedCategoryIds]),
            updatedAt: Math.max(existingWord.updatedAt || 0, word.updatedAt || 0, now),
            hasAudio: existingWord.hasAudio || Boolean(importedTermAudio),
            hasExampleAudio: Boolean(existingWord.hasExampleAudio) || Boolean(importedExampleAudio),
          };
          await requestToPromise(stores.words.put(mergedWord));
          wordsByTerm.set(normalizedTerm, mergedWord);
          wordIdMap.set(word.id, mergedWord.id);
          summary.updatedWords += 1;

          for (const slot of [AUDIO_SLOTS.term, AUDIO_SLOTS.example]) {
            const importedAudio = getGroupedAudioRecord(importedAudioByWordId, word.id, slot);

            if (!importedAudio) {
              continue;
            }

            const existingAudioRecord = getGroupedAudioRecord(audioByWordId, existingWord.id, slot);
            const shouldReplace = !existingAudioRecord || (importedAudio.updatedAt || 0) >= (existingAudioRecord.updatedAt || 0);

            if (shouldReplace) {
              const nextAudioRecord = {
                ...importedAudio,
                id: createAudioRecordId(existingWord.id, slot),
                wordId: existingWord.id,
                slot: normalizeAudioSlot(slot),
              };

              await requestToPromise(
                stores.audio.put({
                  id: nextAudioRecord.id,
                  wordId: nextAudioRecord.wordId,
                  slot: nextAudioRecord.slot,
                  name: nextAudioRecord.name,
                  type: nextAudioRecord.type,
                  size: nextAudioRecord.size,
                  updatedAt: nextAudioRecord.updatedAt,
                  blob: audioEntryToBlob(nextAudioRecord),
                }),
              );
              setGroupedAudioRecord(audioByWordId, nextAudioRecord);
              summary.updatedAudio += existingAudioRecord ? 1 : 0;
              summary.importedAudio += existingAudioRecord ? 0 : 1;
            } else {
              summary.skippedAudio += 1;
            }
          }

          continue;
        }

        const newWord = createWordRecord(word, now, {
          categoryIds: remappedCategoryIds,
          hasAudio: Boolean(importedTermAudio),
          hasExampleAudio: Boolean(importedExampleAudio),
        });
        await requestToPromise(stores.words.put(newWord));
        wordsByTerm.set(normalizedTerm, newWord);
        wordIdMap.set(word.id, newWord.id);
        summary.createdWords += 1;

        for (const slot of [AUDIO_SLOTS.term, AUDIO_SLOTS.example]) {
          const importedAudio = getGroupedAudioRecord(importedAudioByWordId, word.id, slot);

          if (!importedAudio) {
            continue;
          }

          const nextAudioRecord = {
            ...importedAudio,
            id: createAudioRecordId(newWord.id, slot),
            wordId: newWord.id,
            slot: normalizeAudioSlot(slot),
          };

          await requestToPromise(
            stores.audio.put({
              id: nextAudioRecord.id,
              wordId: nextAudioRecord.wordId,
              slot: nextAudioRecord.slot,
              name: nextAudioRecord.name,
              type: nextAudioRecord.type,
              size: nextAudioRecord.size,
              updatedAt: nextAudioRecord.updatedAt,
              blob: audioEntryToBlob(nextAudioRecord),
            }),
          );
          setGroupedAudioRecord(audioByWordId, nextAudioRecord);
          summary.importedAudio += 1;
        }
      }

      for (const audioEntry of payload.audio) {
        if (wordIdMap.has(audioEntry.wordId)) {
          continue;
        }

        summary.skippedAudio += 1;
      }

      for (const attempt of payload.practiceAttempts) {
        if (practiceAttemptIds.has(attempt.id)) {
          summary.skippedPracticeAttempts += 1;
          continue;
        }

        const mappedWordId = wordIdMap.get(attempt.wordId);

        if (!mappedWordId) {
          summary.skippedPracticeAttempts += 1;
          continue;
        }

        await requestToPromise(
          stores.practiceAttempts.put({
            ...attempt,
            wordId: mappedWordId,
          }),
        );
        practiceAttemptIds.add(attempt.id);
        summary.importedPracticeAttempts += 1;
      }

      await requestToPromise(
        stores.settings.put({
          key: "lastImportAt",
          value: Date.now(),
        }),
      );
      await requestToPromise(
        stores.settings.put({
          key: "lastImportMode",
          value: "merge",
        }),
      );

      return summary;
    },
  );
}

export async function restoreBackupFromText(text, options = {}) {
  const payload = parseBackupText(text);
  const mode = options.mode === "merge" ? "merge" : "replace";

  if (mode === "merge") {
    return mergeBackupPayload(payload);
  }

  return replaceBackupPayload(payload);
}

export async function restoreBackupFromFile(file, options = {}) {
  if (isZipFile(file)) {
    const payload = await parseBackupZip(file, { includeAudio: true });
    const mode = options.mode === "merge" ? "merge" : "replace";

    if (mode === "merge") {
      return mergeBackupPayload(payload);
    }

    return replaceBackupPayload(payload);
  }

  return restoreBackupFromText(await file.text(), options);
}

export async function clearAllData() {
  await runTransaction(
    [STORES.words, STORES.categories, STORES.audio, STORES.practiceAttempts, STORES.settings],
    "readwrite",
    async (stores) => {
      for (const storeName of Object.values(STORES)) {
        await requestToPromise(stores[storeName].clear());
      }
    },
  );
}