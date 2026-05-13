import {
  AUDIO_OWNER_TYPES,
  STORES,
  createAudioRecordId,
  normalizeAudioOwnerType,
  requestToPromise,
  runTransaction,
} from "./database.js";
import { createExampleKey, createId, normalizeStringList, normalizeText, uniqueStrings } from "../services/helpers.js";

function normalizeAudioRecord(record) {
  if (!record?.wordId || !record?.ownerId) {
    return null;
  }

  const ownerType = normalizeAudioOwnerType(record.ownerType);

  return {
    ...record,
    id: record.id || createAudioRecordId(ownerType, record.ownerId),
    ownerType,
  };
}

function normalizeExamples(examples) {
  const normalizedExamples = [];
  const seen = new Set();

  for (const value of Array.isArray(examples) ? examples : []) {
    const example = {
      id: value?.id ? String(value.id).trim() : createId(),
      en: String(value?.en ?? "").trim(),
      zh: String(value?.zh ?? "").trim(),
    };

    if (!example.en && !example.zh) {
      continue;
    }

    const key = createExampleKey(example);

    if (example.en && example.zh && seen.has(key)) {
      continue;
    }

    if (example.en && example.zh) {
      seen.add(key);
    }

    normalizedExamples.push(example);
  }

  return normalizedExamples;
}

function normalizeWordRecord(record) {
  const exampleAudioIds = uniqueStrings(record?.exampleAudioIds);

  return {
    ...record,
    term: String(record?.term ?? "").trim(),
    phonetics: normalizeStringList(record?.phonetics),
    meaning: String(record?.meaning ?? "").trim(),
    examples: normalizeExamples(record?.examples),
    categoryIds: uniqueStrings(record?.categoryIds),
    isFavorite: Boolean(record?.isFavorite),
    hasWordAudio: Boolean(record?.hasWordAudio),
    exampleAudioIds,
    exampleAudioCount: exampleAudioIds.length,
  };
}

function sanitizeWordInput(input) {
  return {
    id: input?.id ? String(input.id) : "",
    term: String(input?.term ?? "").trim(),
    phonetics: normalizeStringList(input?.phonetics),
    meaning: String(input?.meaning ?? "").trim(),
    examples: normalizeExamples(input?.examples),
    categoryIds: uniqueStrings(input?.categoryIds),
    isFavorite: typeof input?.isFavorite === "boolean" ? input.isFavorite : undefined,
  };
}

function validateWordInput(word) {
  if (!word.term || !word.meaning) {
    throw new Error("单词和释义为必填项。");
  }

  for (let index = 0; index < word.examples.length; index += 1) {
    const example = word.examples[index];

    if (!example.en || !example.zh) {
      throw new Error(`第 ${index + 1} 条例句需要同时填写英文和中文翻译。`);
    }
  }
}

function normalizeSingleAudioChange(change) {
  if (change?.mode === "replace" && change.file) {
    return {
      mode: "replace",
      file: change.file,
    };
  }

  if (change?.mode === "remove") {
    return {
      mode: "remove",
    };
  }

  return {
    mode: "keep",
  };
}

function normalizeExampleAudioChanges(changes) {
  if (!changes || typeof changes !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(changes).map(([exampleId, change]) => [String(exampleId), normalizeSingleAudioChange(change)]),
  );
}

function createStoredAudioRecord(wordId, ownerType, ownerId, file, now) {
  const normalizedOwnerType = normalizeAudioOwnerType(ownerType);

  return {
    id: createAudioRecordId(normalizedOwnerType, ownerId),
    ownerType: normalizedOwnerType,
    ownerId: String(ownerId),
    wordId: String(wordId),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    updatedAt: now,
  };
}

async function deleteAudioRecordsByWord(audioStore, wordId) {
  if (!wordId) {
    return;
  }

  const keys = await requestToPromise(audioStore.index("wordId").getAllKeys(IDBKeyRange.only(wordId)));

  for (const key of keys) {
    await requestToPromise(audioStore.delete(key));
  }
}

async function ensureUniqueTerm(wordsStore, normalizedTerm, currentId) {
  const existing = await requestToPromise(wordsStore.index("normalizedTerm").get(normalizedTerm));

  if (existing && existing.id !== currentId) {
    throw new Error("该单词已存在，请直接编辑原有词条。");
  }
}

function sortWords(words) {
  return [...words].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }

    return left.term.localeCompare(right.term, "en");
  });
}

export async function listWords() {
  return runTransaction([STORES.words], "readonly", async ({ words }) => {
    const records = await requestToPromise(words.getAll());
    return sortWords(records.map((record) => normalizeWordRecord(record)));
  });
}

export function filterWords(words, filters = {}) {
  const normalizedQuery = normalizeText(filters.query);
  const selectedCategoryIds = uniqueStrings(filters.categoryIds);
  const favoritesOnly = Boolean(filters.favoritesOnly);

  return words.filter((word) => {
    const haystack = [
      word.term,
      ...(word.phonetics || []),
      word.meaning,
      ...(word.examples || []).flatMap((example) => [example.en, example.zh]),
    ]
      .map((value) => normalizeText(value))
      .join(" ");
    const matchesQuery = !normalizedQuery || haystack.includes(normalizedQuery);
    const matchesCategory =
      selectedCategoryIds.length === 0 ||
      selectedCategoryIds.some((categoryId) => word.categoryIds?.includes(categoryId));
    const matchesFavorite = !favoritesOnly || Boolean(word.isFavorite);

    return matchesQuery && matchesCategory && matchesFavorite;
  });
}

export async function saveWord(input, audioChanges = {}) {
  const word = sanitizeWordInput(input);
  validateWordInput(word);

  const wordAudioChange = normalizeSingleAudioChange(audioChanges.wordAudio);
  const exampleAudioChanges = normalizeExampleAudioChanges(audioChanges.exampleAudios);
  const now = Date.now();
  const normalizedTerm = normalizeText(word.term);

  return runTransaction([STORES.words, STORES.audio], "readwrite", async ({ words, audio }) => {
    let existing = null;

    if (word.id) {
      existing = await requestToPromise(words.get(word.id));

      if (!existing) {
        throw new Error("未找到要编辑的单词。");
      }
    }

    await ensureUniqueTerm(words, normalizedTerm, existing?.id ?? "");

    const normalizedExisting = existing ? normalizeWordRecord(existing) : null;
    const recordId = normalizedExisting?.id ?? createId();
    const existingAudioRecords = normalizedExisting
      ? (await requestToPromise(audio.index("wordId").getAll(IDBKeyRange.only(recordId))))
          .map((record) => normalizeAudioRecord(record))
          .filter(Boolean)
      : [];
    const exampleAudioIds = new Set(
      existingAudioRecords
        .filter((record) => record.ownerType === AUDIO_OWNER_TYPES.example)
        .map((record) => record.ownerId),
    );
    const nextExamples = word.examples.map((example) => ({
      id: example.id || createId(),
      en: example.en,
      zh: example.zh,
    }));
    const nextExampleIds = new Set(nextExamples.map((example) => example.id));
    const removedExampleIds = (normalizedExisting?.examples || [])
      .filter((example) => !nextExampleIds.has(example.id))
      .map((example) => example.id);
    let hasWordAudio = existingAudioRecords.some((record) => record.ownerType === AUDIO_OWNER_TYPES.word);

    for (const exampleId of removedExampleIds) {
      if (exampleAudioIds.has(exampleId)) {
        exampleAudioIds.delete(exampleId);
      }

      await requestToPromise(audio.delete(createAudioRecordId(AUDIO_OWNER_TYPES.example, exampleId)));
    }

    if (wordAudioChange.mode === "replace") {
      hasWordAudio = true;
      await requestToPromise(
        audio.put(createStoredAudioRecord(recordId, AUDIO_OWNER_TYPES.word, recordId, wordAudioChange.file, now)),
      );
    }

    if (wordAudioChange.mode === "remove") {
      hasWordAudio = false;
      await requestToPromise(audio.delete(createAudioRecordId(AUDIO_OWNER_TYPES.word, recordId)));
    }

    for (const example of nextExamples) {
      const exampleAudioChange = exampleAudioChanges[example.id] || { mode: "keep" };

      if (exampleAudioChange.mode === "replace") {
        exampleAudioIds.add(example.id);
        await requestToPromise(
          audio.put(createStoredAudioRecord(recordId, AUDIO_OWNER_TYPES.example, example.id, exampleAudioChange.file, now)),
        );
      }

      if (exampleAudioChange.mode === "remove") {
        exampleAudioIds.delete(example.id);
        await requestToPromise(audio.delete(createAudioRecordId(AUDIO_OWNER_TYPES.example, example.id)));
      }
    }

    const record = {
      id: recordId,
      term: word.term,
      normalizedTerm,
      phonetics: word.phonetics,
      meaning: word.meaning,
      examples: nextExamples,
      categoryIds: word.categoryIds,
      isFavorite: typeof word.isFavorite === "boolean" ? word.isFavorite : Boolean(normalizedExisting?.isFavorite),
      createdAt: normalizedExisting?.createdAt ?? now,
      updatedAt: now,
      hasWordAudio,
      exampleAudioIds: [...exampleAudioIds],
      exampleAudioCount: exampleAudioIds.size,
    };

    await requestToPromise(words.put(record));
    return normalizeWordRecord(record);
  });
}

export async function deleteWord(wordId) {
  if (!wordId) {
    return;
  }

  await runTransaction([STORES.words, STORES.audio], "readwrite", async ({ words, audio }) => {
    await requestToPromise(words.delete(wordId));
    await deleteAudioRecordsByWord(audio, wordId);
  });
}

export async function setWordFavorite(wordId, isFavorite) {
  if (!wordId) {
    throw new Error("未找到要收藏的单词。");
  }

  return runTransaction([STORES.words], "readwrite", async ({ words }) => {
    const existing = await requestToPromise(words.get(wordId));

    if (!existing) {
      throw new Error("未找到要收藏的单词。");
    }

    const nextRecord = {
      ...existing,
      isFavorite: Boolean(isFavorite),
      updatedAt: Date.now(),
    };

    await requestToPromise(words.put(nextRecord));
    return normalizeWordRecord(nextRecord);
  });
}

export async function getAudioRecord(ownerType, ownerId) {
  return runTransaction([STORES.audio], "readonly", async ({ audio }) => {
    const record = await requestToPromise(audio.get(createAudioRecordId(ownerType, ownerId)));
    return normalizeAudioRecord(record);
  });
}

export async function getWordAudioRecord(wordId) {
  return getAudioRecord(AUDIO_OWNER_TYPES.word, wordId);
}

export async function getExampleAudioRecord(exampleId) {
  return getAudioRecord(AUDIO_OWNER_TYPES.example, exampleId);
}

export async function listAudioRecords() {
  return runTransaction([STORES.audio], "readonly", async ({ audio }) => {
    const records = await requestToPromise(audio.getAll());
    return records.map((record) => normalizeAudioRecord(record)).filter(Boolean);
  });
}

export async function listWordAudioRecords(wordId) {
  if (!wordId) {
    return [];
  }

  return runTransaction([STORES.audio], "readonly", async ({ audio }) => {
    const records = await requestToPromise(audio.index("wordId").getAll(IDBKeyRange.only(wordId)));

    return records
      .map((record) => normalizeAudioRecord(record))
      .filter(Boolean)
      .sort((left, right) => {
        if (left.ownerType !== right.ownerType) {
          return left.ownerType === AUDIO_OWNER_TYPES.word ? -1 : 1;
        }

        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });
  });
}