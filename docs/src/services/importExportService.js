import { AUDIO_OWNER_TYPES, STORES, createAudioRecordId, requestToPromise, runTransaction } from "../db/database.js";
import { listAudioRecords, listWords } from "../db/wordRepository.js";
import { listCategories } from "../db/categoryRepository.js";
import { createCategoryKey, createExampleKey, createId, normalizeStringList, normalizeText, uniqueStrings } from "./helpers.js";

export const LIBRARY_SCHEMA_VERSION = 1;

const LIBRARY_JSON_PATH = "library.json";
const WORD_AUDIO_DIRECTORY = "audio/words";
const EXAMPLE_AUDIO_DIRECTORY = "audio/examples";

const LIBRARY_TEMPLATE = {
  schemaVersion: LIBRARY_SCHEMA_VERSION,
  categories: [
    {
      name: "理工英语",
      description: "偏理工、实验、工程与技术语境。",
    },
    {
      name: "本科",
      description: "适合本科通识英语与学术阅读。",
    },
  ],
  words: [
    {
      term: "analysis",
      phonetics: ["/əˈnæləsɪs/", "/əˈnælɪsɪs/"],
      meaning: "分析；解析",
      categories: [
        { name: "理工英语" },
        { name: "本科" },
      ],
      examples: [
        {
          en: "Careful analysis of the data revealed a clear pattern.",
          zh: "对数据进行仔细分析后，发现了一个清晰的规律。",
        },
        {
          en: "The report provides a detailed analysis of the experiment.",
          zh: "这份报告对实验进行了详细分析。",
        },
      ],
    },
  ],
};

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

function normalizeArchivePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function normalizeCategorySpec(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const [namePart] = value.split("@");
    const name = String(namePart ?? "").trim();

    if (!name) {
      return null;
    }

    return {
      name,
      description: "",
    };
  }

  const name = String(value.name ?? value.categoryName ?? "").trim();
  const description = String(value.description ?? "").trim();

  if (!name) {
    return null;
  }

  return {
    name,
    description,
  };
}

function normalizeExample(example) {
  const normalized = {
    id: example?.id ? String(example.id).trim() : createId(),
    en: String(example?.en ?? "").trim(),
    zh: String(example?.zh ?? "").trim(),
    audio: normalizeArchivePath(example?.audio),
  };

  if (!normalized.en && !normalized.zh) {
    return null;
  }

  return normalized;
}

function normalizeWord(word) {
  const normalizedExamples = [];
  const seenExamples = new Set();

  for (const value of Array.isArray(word?.examples) ? word.examples : []) {
    const example = normalizeExample(value);

    if (!example) {
      continue;
    }

    const exampleKey = createExampleKey(example);

    if (example.en && example.zh && seenExamples.has(exampleKey)) {
      continue;
    }

    if (example.en && example.zh) {
      seenExamples.add(exampleKey);
    }

    normalizedExamples.push(example);
  }

  const seenCategories = new Set();
  const normalizedCategories = [];

  for (const value of Array.isArray(word?.categories) ? word.categories : []) {
    const category = normalizeCategorySpec(value);

    if (!category) {
      continue;
    }

    const categoryKey = createCategoryKey(category.name);

    if (seenCategories.has(categoryKey)) {
      continue;
    }

    seenCategories.add(categoryKey);
    normalizedCategories.push(category);
  }

  return {
    id: word?.id ? String(word.id).trim() : createId(),
    term: String(word?.term ?? "").trim(),
    phonetics: normalizeStringList(word?.phonetics),
    meaning: String(word?.meaning ?? "").trim(),
    isFavorite: Boolean(word?.isFavorite),
    categories: normalizedCategories,
    examples: normalizedExamples,
    audio: normalizeArchivePath(word?.audio),
  };
}

function validateWord(word, wordIndex) {
  const label = `第 ${wordIndex + 1} 个单词`;

  if (!word.term || !word.meaning) {
    throw new Error(`${label}缺少单词或释义。`);
  }

  for (let index = 0; index < word.examples.length; index += 1) {
    const example = word.examples[index];

    if (!example.en || !example.zh) {
      throw new Error(`${label}的第 ${index + 1} 条例句需要同时包含英文和中文翻译。`);
    }
  }
}

function sanitizeLibraryPayload(payload) {
  const words = [];
  const categoriesByKey = new Map();

  for (const categoryValue of Array.isArray(payload?.categories) ? payload.categories : []) {
    const category = normalizeCategorySpec(categoryValue);

    if (!category) {
      continue;
    }

    const categoryKey = createCategoryKey(category.name);
    const existing = categoriesByKey.get(categoryKey);
    categoriesByKey.set(categoryKey, {
      name: category.name,
      description: existing?.description || category.description,
    });
  }

  for (const [index, wordValue] of (Array.isArray(payload?.words) ? payload.words : []).entries()) {
    const word = normalizeWord(wordValue);
    validateWord(word, index);

    if (!word.term) {
      continue;
    }

    for (const category of word.categories) {
      const categoryKey = createCategoryKey(category.name);
      const existing = categoriesByKey.get(categoryKey);

      categoriesByKey.set(categoryKey, {
        name: category.name,
        description: existing?.description || category.description,
      });
    }

    words.push(word);
  }

  if (!words.length) {
    throw new Error("词库中没有可导入的单词。");
  }

  return {
    schemaVersion: Number(payload?.schemaVersion) || LIBRARY_SCHEMA_VERSION,
    categories: [...categoriesByKey.values()],
    words,
  };
}

function countAudioReferences(payload) {
  return payload.words.reduce((total, word) => {
    const exampleAudioCount = word.examples.reduce((count, example) => count + Number(Boolean(example.audio)), 0);
    return total + Number(Boolean(word.audio)) + exampleAudioCount;
  }, 0);
}

function countExamples(payload) {
  return payload.words.reduce((total, word) => total + word.examples.length, 0);
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

function sanitizeFileStem(value) {
  const sanitized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || "audio";
}

function createUniqueAudioPath(directory, fileName, fallbackStem, usedPaths) {
  const extension = inferAudioExtension(fileName);
  const stem = sanitizeFileStem(fileName ? fileName.replace(/\.[a-z0-9]+$/i, "") : fallbackStem);
  let candidate = `${directory}/${stem}${extension}`;
  let suffix = 2;

  while (usedPaths.has(candidate)) {
    candidate = `${directory}/${stem}-${suffix}${extension}`;
    suffix += 1;
  }

  usedPaths.add(candidate);
  return candidate;
}

function resolveZipAudioEntry(zip, audioReference, directory) {
  const normalizedPath = normalizeArchivePath(audioReference);

  if (!normalizedPath) {
    return null;
  }

  const basename = normalizedPath.split("/").pop();
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
        path: candidate,
        zipEntry,
      };
    }
  }

  throw new Error(`ZIP 词库缺少音频文件：${normalizedPath}`);
}

function findLibraryJsonEntry(zip) {
  const preferred = zip.file(LIBRARY_JSON_PATH);

  if (preferred) {
    return preferred;
  }

  const matches = Object.values(zip.files).filter(
    (entry) => !entry.dir && /(^|\/)library\.json$/i.test(entry.name) && !entry.name.startsWith("__MACOSX/"),
  );

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error("ZIP 词库中包含多个 library.json，请只保留一个主词库文件。");
  }

  throw new Error("ZIP 词库中未找到 library.json。");
}

async function parseLibraryFile(file, options = {}) {
  const includeAudio = Boolean(options.includeAudio);

  if (!isZipFile(file)) {
    const payload = sanitizeLibraryPayload(JSON.parse(await file.text()));

    if (includeAudio && countAudioReferences(payload) > 0) {
      throw new Error("纯 JSON 词库无法携带音频；如需一起导入单词或例句音频，请上传包含 library.json 和 audio 目录的 ZIP 词库包。");
    }

    return {
      format: "json",
      payload,
    };
  }

  const JSZip = getZipLibrary();
  const zip = await JSZip.loadAsync(file);
  const libraryEntry = findLibraryJsonEntry(zip);
  const payload = sanitizeLibraryPayload(JSON.parse(await libraryEntry.async("string")));

  if (!includeAudio) {
    return {
      format: "zip",
      payload,
    };
  }

  const hydratedWords = [];

  for (const word of payload.words) {
    const hydratedWord = {
      ...word,
      examples: [],
    };

    if (word.audio) {
      const resolved = resolveZipAudioEntry(zip, word.audio, WORD_AUDIO_DIRECTORY);
      const blob = await resolved.zipEntry.async("blob");
      hydratedWord.audio = resolved.path;
      hydratedWord.audioBlob = blob;
      hydratedWord.audioName = resolved.path.split("/").pop() || `${word.term}.bin`;
      hydratedWord.audioType = blob.type || inferAudioMimeType(hydratedWord.audioName);
      hydratedWord.audioSize = blob.size;
    }

    for (const example of word.examples) {
      const hydratedExample = { ...example };

      if (example.audio) {
        const resolved = resolveZipAudioEntry(zip, example.audio, EXAMPLE_AUDIO_DIRECTORY);
        const blob = await resolved.zipEntry.async("blob");
        hydratedExample.audio = resolved.path;
        hydratedExample.audioBlob = blob;
        hydratedExample.audioName = resolved.path.split("/").pop() || `${word.term}-example.bin`;
        hydratedExample.audioType = blob.type || inferAudioMimeType(hydratedExample.audioName);
        hydratedExample.audioSize = blob.size;
      }

      hydratedWord.examples.push(hydratedExample);
    }

    hydratedWords.push(hydratedWord);
  }

  return {
    format: "zip",
    payload: {
      ...payload,
      words: hydratedWords,
    },
  };
}

function groupAudioRecordsByWordId(audioRecords) {
  return audioRecords.reduce((grouped, record) => {
    const bucket = grouped.get(record.wordId) || [];
    bucket.push(record);
    grouped.set(record.wordId, bucket);
    return grouped;
  }, new Map());
}

function splitMeaningParts(value) {
  return uniqueStrings(String(value ?? "").split(/(?:\r?\n|；|;|\|)+/));
}

function mergeMeaning(existingMeaning, importedMeaning) {
  return uniqueStrings([...splitMeaningParts(existingMeaning), ...splitMeaningParts(importedMeaning)]).join("；");
}

function createCategoryRecord(category, now, categoryId = createId()) {
  return {
    id: categoryId,
    name: category.name,
    description: category.description,
    normalizedKey: createCategoryKey(category.name),
    createdAt: now,
    updatedAt: now,
  };
}

function createWordRecord(word, categoryIds, now, options = {}) {
  const exampleAudioIds = uniqueStrings(options.exampleAudioIds);

  return {
    id: options.id || createId(),
    term: word.term,
    normalizedTerm: normalizeText(word.term),
    phonetics: normalizeStringList(word.phonetics),
    meaning: String(word.meaning ?? "").trim(),
    examples: (word.examples || []).map((example) => ({
      id: example.id || createId(),
      en: example.en,
      zh: example.zh,
    })),
    categoryIds: uniqueStrings(categoryIds),
    isFavorite: Boolean(options.isFavorite ?? word.isFavorite),
    createdAt: options.createdAt || now,
    updatedAt: options.updatedAt || now,
    hasWordAudio: Boolean(options.hasWordAudio),
    exampleAudioIds,
    exampleAudioCount: exampleAudioIds.length,
  };
}

function createImportedAudioRecord(wordId, ownerType, ownerId, source, now) {
  const blob = source?.audioBlob;

  if (!blob) {
    return null;
  }

  const normalizedOwnerType = ownerType === AUDIO_OWNER_TYPES.example ? AUDIO_OWNER_TYPES.example : AUDIO_OWNER_TYPES.word;

  return {
    id: createAudioRecordId(normalizedOwnerType, ownerId),
    ownerType: normalizedOwnerType,
    ownerId: String(ownerId),
    wordId: String(wordId),
    name: source.audioName || source.audio || `${wordId}.bin`,
    type: source.audioType || inferAudioMimeType(source.audioName || source.audio),
    size: source.audioSize || blob.size,
    blob,
    updatedAt: now,
  };
}

function countImportedAudioBlobs(word) {
  return Number(Boolean(word.audioBlob)) + word.examples.reduce((count, example) => count + Number(Boolean(example.audioBlob)), 0);
}

async function importLibraryFromPayload(payload, options = {}) {
  const duplicateMode = options.duplicateMode === "skip" ? "skip" : "merge";

  return runTransaction([STORES.categories, STORES.words, STORES.audio], "readwrite", async ({ categories, words, audio }) => {
    const now = Date.now();
    const [existingCategories, existingWords, existingAudio] = await Promise.all([
      requestToPromise(categories.getAll()),
      requestToPromise(words.getAll()),
      requestToPromise(audio.getAll()),
    ]);
    const categoriesByKey = new Map(existingCategories.map((category) => [category.normalizedKey, category]));
    const wordsByTerm = new Map(existingWords.map((word) => [normalizeText(word.term), word]));
    const audioByWordId = groupAudioRecordsByWordId(existingAudio);
    const summary = {
      duplicateMode,
      words: payload.words.length,
      categories: payload.categories.length,
      createdCategories: 0,
      createdWords: 0,
      updatedWords: 0,
      skippedWords: 0,
      importedAudio: 0,
      updatedAudio: 0,
      skippedAudio: 0,
    };

    const ensureCategory = async (categorySpec) => {
      const normalizedKey = createCategoryKey(categorySpec.name);
      let category = categoriesByKey.get(normalizedKey);

      if (!category) {
        category = createCategoryRecord(categorySpec, now);
        await requestToPromise(categories.put(category));
        categoriesByKey.set(normalizedKey, category);
        summary.createdCategories += 1;
        return category;
      }

      if (!category.description && categorySpec.description) {
        category = {
          ...category,
          description: categorySpec.description,
          updatedAt: now,
        };
        await requestToPromise(categories.put(category));
        categoriesByKey.set(normalizedKey, category);
      }

      return category;
    };

    for (const categorySpec of payload.categories) {
      await ensureCategory(categorySpec);
    }

    for (const importedWord of payload.words) {
      const normalizedTerm = normalizeText(importedWord.term);
      const existingWord = wordsByTerm.get(normalizedTerm);

      if (existingWord && duplicateMode === "skip") {
        summary.skippedWords += 1;
        summary.skippedAudio += countImportedAudioBlobs(importedWord);
        continue;
      }

      const categoryIds = [];

      for (const categorySpec of importedWord.categories) {
        const category = await ensureCategory(categorySpec);
        categoryIds.push(category.id);
      }

      if (existingWord) {
        const existingAudioRecordsForWord = audioByWordId.get(existingWord.id) || [];
        const nextAudioRecordsById = new Map(existingAudioRecordsForWord.map((record) => [record.id, record]));
        const existingExampleAudioById = new Map(
          existingAudioRecordsForWord
            .filter((record) => record.ownerType === AUDIO_OWNER_TYPES.example)
            .map((record) => [record.ownerId, record]),
        );
        const existingExamples = Array.isArray(existingWord.examples) ? existingWord.examples : [];
        const existingExamplesByKey = new Map(existingExamples.map((example) => [createExampleKey(example), example]));
        const mergedExamples = [...existingExamples];
        const exampleAudioIds = new Set(existingExampleAudioById.keys());
        let audioChanged = false;
        let wordChanged = false;

        for (const importedExample of importedWord.examples) {
          const exampleKey = createExampleKey(importedExample);
          let targetExample = existingExamplesByKey.get(exampleKey);

          if (!targetExample) {
            targetExample = {
              id: createId(),
              en: importedExample.en,
              zh: importedExample.zh,
            };
            mergedExamples.push(targetExample);
            existingExamplesByKey.set(exampleKey, targetExample);
            wordChanged = true;
          }

          const importedExampleAudio = createImportedAudioRecord(
            existingWord.id,
            AUDIO_OWNER_TYPES.example,
            targetExample.id,
            importedExample,
            now,
          );

          if (importedExampleAudio) {
            const existingExampleAudio = existingExampleAudioById.get(targetExample.id);
            await requestToPromise(audio.put(importedExampleAudio));
            existingExampleAudioById.set(targetExample.id, importedExampleAudio);
            nextAudioRecordsById.set(importedExampleAudio.id, importedExampleAudio);
            audioChanged = true;
            exampleAudioIds.add(targetExample.id);
            summary.updatedAudio += existingExampleAudio ? 1 : 0;
            summary.importedAudio += existingExampleAudio ? 0 : 1;
          }
        }

        const mergedPhonetics = uniqueStrings([...(existingWord.phonetics || []), ...normalizeStringList(importedWord.phonetics)]);
        const mergedMeaning = mergeMeaning(existingWord.meaning, importedWord.meaning);
        const mergedCategoryIds = uniqueStrings([...(existingWord.categoryIds || []), ...categoryIds]);
        const importedWordAudio = createImportedAudioRecord(
          existingWord.id,
          AUDIO_OWNER_TYPES.word,
          existingWord.id,
          importedWord,
          now,
        );

        if (importedWordAudio) {
          const existingWordAudio = existingAudioRecordsForWord.find((record) => record.ownerType === AUDIO_OWNER_TYPES.word);
          await requestToPromise(audio.put(importedWordAudio));
          nextAudioRecordsById.set(importedWordAudio.id, importedWordAudio);
          audioChanged = true;
          summary.updatedAudio += existingWordAudio ? 1 : 0;
          summary.importedAudio += existingWordAudio ? 0 : 1;
        }

        const nextWord = {
          ...existingWord,
          phonetics: mergedPhonetics,
          meaning: mergedMeaning,
          examples: mergedExamples,
          categoryIds: mergedCategoryIds,
          isFavorite: Boolean(existingWord.isFavorite) || Boolean(importedWord.isFavorite),
          updatedAt: now,
          hasWordAudio: Boolean(importedWordAudio) || Boolean(existingWord.hasWordAudio),
          exampleAudioIds: [...exampleAudioIds],
          exampleAudioCount: exampleAudioIds.size,
        };

        wordChanged =
          wordChanged ||
          JSON.stringify(mergedPhonetics) !== JSON.stringify(existingWord.phonetics || []) ||
          mergedMeaning !== existingWord.meaning ||
          JSON.stringify(mergedCategoryIds) !== JSON.stringify(existingWord.categoryIds || []) ||
          mergedExamples.length !== existingExamples.length ||
          nextWord.isFavorite !== Boolean(existingWord.isFavorite) ||
          nextWord.hasWordAudio !== Boolean(existingWord.hasWordAudio) ||
          nextWord.exampleAudioCount !== Number(existingWord.exampleAudioCount || 0);

        if (!wordChanged && !audioChanged) {
          summary.skippedWords += 1;
          continue;
        }

        await requestToPromise(words.put(nextWord));
        wordsByTerm.set(normalizedTerm, nextWord);
        audioByWordId.set(existingWord.id, [...nextAudioRecordsById.values()]);
        summary.updatedWords += 1;
        continue;
      }

      const newWordId = createId();
      const nextExamples = importedWord.examples.map((example) => ({
        id: createId(),
        en: example.en,
        zh: example.zh,
        audioBlob: example.audioBlob,
        audioName: example.audioName,
        audioType: example.audioType,
        audioSize: example.audioSize,
      }));
      const wordRecord = createWordRecord(
        {
          ...importedWord,
          examples: nextExamples,
        },
        categoryIds,
        now,
        {
          id: newWordId,
          isFavorite: Boolean(importedWord.isFavorite),
          hasWordAudio: Boolean(importedWord.audioBlob),
          exampleAudioIds: nextExamples.filter((example) => example.audioBlob).map((example) => example.id),
        },
      );

      await requestToPromise(words.put(wordRecord));
      wordsByTerm.set(normalizedTerm, wordRecord);
      summary.createdWords += 1;

      const wordAudioRecord = createImportedAudioRecord(newWordId, AUDIO_OWNER_TYPES.word, newWordId, importedWord, now);
      const storedAudioRecords = [];

      if (wordAudioRecord) {
        await requestToPromise(audio.put(wordAudioRecord));
        storedAudioRecords.push(wordAudioRecord);
        summary.importedAudio += 1;
      }

      for (const example of nextExamples) {
        const exampleAudioRecord = createImportedAudioRecord(newWordId, AUDIO_OWNER_TYPES.example, example.id, example, now);

        if (!exampleAudioRecord) {
          continue;
        }

        await requestToPromise(audio.put(exampleAudioRecord));
        storedAudioRecords.push(exampleAudioRecord);
        summary.importedAudio += 1;
      }

      if (storedAudioRecords.length) {
        audioByWordId.set(newWordId, storedAudioRecords);
      }
    }

    return summary;
  });
}

export function createLibraryTemplate() {
  return `${JSON.stringify(LIBRARY_TEMPLATE, null, 2)}\n`;
}

export async function createLibraryPackageZipBlob() {
  const JSZip = getZipLibrary();
  const [words, categories, audioRecords] = await Promise.all([listWords(), listCategories(), listAudioRecords()]);
  const zip = new JSZip();
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const audioById = new Map(audioRecords.map((record) => [record.id, record]));
  const usedPaths = new Set();
  const pendingAudio = [];

  const payload = {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    categories: categories.map((category) => ({
      name: category.name,
      description: category.description,
    })),
    words: words.map((word) => {
      const wordAudioRecord = audioById.get(createAudioRecordId(AUDIO_OWNER_TYPES.word, word.id));
      const wordAudioPath = wordAudioRecord
        ? createUniqueAudioPath(WORD_AUDIO_DIRECTORY, wordAudioRecord.name, word.term, usedPaths)
        : "";

      if (wordAudioRecord && wordAudioPath) {
        pendingAudio.push({ path: wordAudioPath, record: wordAudioRecord });
      }

      const examples = (word.examples || []).map((example, index) => {
        const exampleAudioRecord = audioById.get(createAudioRecordId(AUDIO_OWNER_TYPES.example, example.id));
        const exampleAudioPath = exampleAudioRecord
          ? createUniqueAudioPath(
              EXAMPLE_AUDIO_DIRECTORY,
              exampleAudioRecord.name,
              `${word.term}-example-${index + 1}`,
              usedPaths,
            )
          : "";

        if (exampleAudioRecord && exampleAudioPath) {
          pendingAudio.push({ path: exampleAudioPath, record: exampleAudioRecord });
        }

        return {
          en: example.en,
          zh: example.zh,
          ...(exampleAudioPath ? { audio: exampleAudioPath } : {}),
        };
      });

      return {
        term: word.term,
        phonetics: normalizeStringList(word.phonetics),
        meaning: word.meaning,
        isFavorite: Boolean(word.isFavorite),
        categories: uniqueStrings(word.categoryIds)
          .map((categoryId) => categoriesById.get(categoryId))
          .filter(Boolean)
          .map((category) => ({
            name: category.name,
          })),
        examples,
        ...(wordAudioPath ? { audio: wordAudioPath } : {}),
      };
    }),
  };

  zip.file(LIBRARY_JSON_PATH, JSON.stringify(payload, null, 2));

  for (const audioEntry of pendingAudio) {
    zip.file(audioEntry.path, audioEntry.record.blob);
  }

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });
}

export async function inspectLibraryImportFile(file) {
  const { format, payload } = await parseLibraryFile(file, { includeAudio: false });
  const audioRefs = countAudioReferences(payload);

  return {
    format,
    words: payload.words.length,
    categories: payload.categories.length,
    examples: countExamples(payload),
    audioRefs,
    requiresZipForAudio: format === "json" && audioRefs > 0,
  };
}

export async function importLibraryFromFile(file, options = {}) {
  const { payload } = await parseLibraryFile(file, { includeAudio: true });
  return importLibraryFromPayload(payload, options);
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
