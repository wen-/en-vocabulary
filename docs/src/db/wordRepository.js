import { AUDIO_SLOTS, STORES, createAudioRecordId, normalizeAudioSlot, requestToPromise, runTransaction } from "./database.js";
import { createId, normalizePhoneticAndNotes, normalizeText, uniqueStrings } from "../services/helpers.js";

function normalizeAudioRecord(record) {
  if (!record?.wordId) {
    return null;
  }

  const slot = normalizeAudioSlot(record.slot);

  return {
    ...record,
    id: record.id || createAudioRecordId(record.wordId, slot),
    slot,
  };
}

function normalizeWordRecord(record) {
  const normalizedText = normalizePhoneticAndNotes(record?.phonetic, record?.notes);

  return {
    ...record,
    term: String(record?.term ?? "").trim(),
    phonetic: normalizedText.phonetic,
    meaning: String(record?.meaning ?? "").trim(),
    example: String(record?.example ?? "").trim(),
    notes: normalizedText.notes,
    categoryIds: uniqueStrings(record?.categoryIds),
    hasAudio: Boolean(record?.hasAudio),
    hasExampleAudio: Boolean(record?.hasExampleAudio),
  };
}

function sanitizeWordInput(input) {
  const normalizedText = normalizePhoneticAndNotes(input.phonetic, input.notes);

  return {
    id: input.id ? String(input.id) : "",
    term: String(input.term ?? "").trim(),
    phonetic: normalizedText.phonetic,
    meaning: String(input.meaning ?? "").trim(),
    example: String(input.example ?? "").trim(),
    notes: normalizedText.notes,
    categoryIds: uniqueStrings(input.categoryIds),
  };
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

function normalizeAudioChanges(audioChanges) {
  if (!audioChanges || typeof audioChanges !== "object" || Array.isArray(audioChanges)) {
    return {
      [AUDIO_SLOTS.term]: normalizeSingleAudioChange(null),
      [AUDIO_SLOTS.example]: normalizeSingleAudioChange(null),
    };
  }

  if (Object.prototype.hasOwnProperty.call(audioChanges, "mode")) {
    return {
      [AUDIO_SLOTS.term]: normalizeSingleAudioChange(audioChanges),
      [AUDIO_SLOTS.example]: normalizeSingleAudioChange(null),
    };
  }

  return {
    [AUDIO_SLOTS.term]: normalizeSingleAudioChange(audioChanges[AUDIO_SLOTS.term]),
    [AUDIO_SLOTS.example]: normalizeSingleAudioChange(audioChanges[AUDIO_SLOTS.example]),
  };
}

function createStoredAudioRecord(wordId, slot, file, now) {
  return {
    id: createAudioRecordId(wordId, slot),
    wordId,
    slot: normalizeAudioSlot(slot),
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

  if (!audioStore.indexNames.contains("wordId")) {
    await requestToPromise(audioStore.delete(wordId));
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

  return words.filter((word) => {
    const haystack = [word.term, word.phonetic, word.meaning, word.example, word.notes]
      .map((value) => normalizeText(value))
      .join(" ");
    const matchesQuery = !normalizedQuery || haystack.includes(normalizedQuery);
    const matchesCategory =
      selectedCategoryIds.length === 0 ||
      selectedCategoryIds.some((categoryId) => word.categoryIds?.includes(categoryId));

    return matchesQuery && matchesCategory;
  });
}

export async function saveWord(input, audioChange = { mode: "keep" }) {
  const word = sanitizeWordInput(input);
  const audioChanges = normalizeAudioChanges(audioChange);

  if (!word.term || !word.meaning) {
    throw new Error("单词和释义为必填项。");
  }

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

    const record = {
      id: normalizedExisting?.id ?? createId(),
      term: word.term,
      normalizedTerm,
      phonetic: word.phonetic,
      meaning: word.meaning,
      example: word.example,
      notes: word.notes,
      categoryIds: word.categoryIds,
      createdAt: normalizedExisting?.createdAt ?? now,
      updatedAt: now,
      hasAudio: normalizedExisting?.hasAudio ?? false,
      hasExampleAudio: normalizedExisting?.hasExampleAudio ?? false,
    };

    if (audioChanges[AUDIO_SLOTS.term].mode === "replace") {
      record.hasAudio = true;
      await requestToPromise(
        audio.put(createStoredAudioRecord(record.id, AUDIO_SLOTS.term, audioChanges[AUDIO_SLOTS.term].file, now)),
      );
    }

    if (audioChanges[AUDIO_SLOTS.term].mode === "remove") {
      record.hasAudio = false;
      await requestToPromise(audio.delete(createAudioRecordId(record.id, AUDIO_SLOTS.term)));
    }

    if (audioChanges[AUDIO_SLOTS.example].mode === "replace") {
      record.hasExampleAudio = true;
      await requestToPromise(
        audio.put(createStoredAudioRecord(record.id, AUDIO_SLOTS.example, audioChanges[AUDIO_SLOTS.example].file, now)),
      );
    }

    if (audioChanges[AUDIO_SLOTS.example].mode === "remove") {
      record.hasExampleAudio = false;
      await requestToPromise(audio.delete(createAudioRecordId(record.id, AUDIO_SLOTS.example)));
    }

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

export async function getAudioRecord(wordId, slot = AUDIO_SLOTS.term) {
  return runTransaction([STORES.audio], "readonly", async ({ audio }) => {
    const record = await requestToPromise(audio.get(createAudioRecordId(wordId, slot)));
    return normalizeAudioRecord(record);
  });
}

export async function listAudioRecords() {
  return runTransaction([STORES.audio], "readonly", async ({ audio }) => {
    const records = await requestToPromise(audio.getAll());
    return records.map((record) => normalizeAudioRecord(record)).filter(Boolean);
  });
}