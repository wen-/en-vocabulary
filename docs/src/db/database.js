export const DATABASE_NAME = "english-learning-offline";
export const DATABASE_VERSION = 2;

export const AUDIO_SLOTS = {
  term: "term",
  example: "example",
};

export const STORES = {
  words: "words",
  categories: "categories",
  audio: "audio",
  practiceAttempts: "practiceAttempts",
  settings: "settings",
};

export function normalizeAudioSlot(value) {
  return value === AUDIO_SLOTS.example ? AUDIO_SLOTS.example : AUDIO_SLOTS.term;
}

export function createAudioRecordId(wordId, slot = AUDIO_SLOTS.term) {
  return `${String(wordId)}::${normalizeAudioSlot(slot)}`;
}

let databasePromise;

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function createAudioStore(database) {
  const audioStore = database.createObjectStore(STORES.audio, { keyPath: "id" });
  audioStore.createIndex("wordId", "wordId", { unique: false });
  audioStore.createIndex("slot", "slot", { unique: false });
  audioStore.createIndex("updatedAt", "updatedAt", { unique: false });
  return audioStore;
}

function ensureAudioStore(database, transaction, oldVersion) {
  if (!database.objectStoreNames.contains(STORES.audio)) {
    createAudioStore(database);
    return;
  }

  if (oldVersion >= 2) {
    return;
  }

  const legacyStore = transaction.objectStore(STORES.audio);
  const readRequest = legacyStore.getAll();

  readRequest.onsuccess = () => {
    const legacyRecords = Array.isArray(readRequest.result) ? readRequest.result : [];

    database.deleteObjectStore(STORES.audio);
    const audioStore = createAudioStore(database);

    for (const record of legacyRecords) {
      if (!record?.wordId) {
        continue;
      }

      const slot = normalizeAudioSlot(record.slot);
      audioStore.put({
        ...record,
        id: createAudioRecordId(record.wordId, slot),
        slot,
      });
    }
  };
}

function createStores(database, transaction, oldVersion = 0) {
  if (!database.objectStoreNames.contains(STORES.words)) {
    const wordsStore = database.createObjectStore(STORES.words, { keyPath: "id" });
    wordsStore.createIndex("normalizedTerm", "normalizedTerm", { unique: true });
    wordsStore.createIndex("categoryIds", "categoryIds", { multiEntry: true });
    wordsStore.createIndex("updatedAt", "updatedAt", { unique: false });
  }

  if (!database.objectStoreNames.contains(STORES.categories)) {
    const categoriesStore = database.createObjectStore(STORES.categories, { keyPath: "id" });
    categoriesStore.createIndex("normalizedName", "normalizedName", { unique: true });
    categoriesStore.createIndex("group", "group", { unique: false });
  }

  ensureAudioStore(database, transaction, oldVersion);

  if (!database.objectStoreNames.contains(STORES.practiceAttempts)) {
    const practiceStore = database.createObjectStore(STORES.practiceAttempts, { keyPath: "id" });
    practiceStore.createIndex("wordId", "wordId", { unique: false });
    practiceStore.createIndex("attemptedAt", "attemptedAt", { unique: false });
    practiceStore.createIndex("selectedCategoryIds", "selectedCategoryIds", { multiEntry: true });
  }

  if (!database.objectStoreNames.contains(STORES.settings)) {
    database.createObjectStore(STORES.settings, { keyPath: "key" });
  }
}

export function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      createStores(request.result, request.transaction, event.oldVersion);
    };

    request.onsuccess = () => {
      const database = request.result;

      database.onversionchange = () => {
        database.close();
      };

      resolve(database);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open IndexedDB."));
    };

    request.onblocked = () => {
      reject(new Error("数据库升级被阻塞，请关闭其他标签页后重试。"));
    };
  });

  return databasePromise;
}

export async function runTransaction(storeNames, mode, handler) {
  const database = await openDatabase();
  const transaction = database.transaction(storeNames, mode);
  const stores = Object.fromEntries(
    storeNames.map((storeName) => [storeName, transaction.objectStore(storeName)]),
  );

  try {
    const result = await handler(stores, transaction);
    await transactionToPromise(transaction);
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // Transaction may already be complete.
    }

    throw error;
  }
}