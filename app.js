import { openDatabase } from "./src/db/database.js";
import { listWords, saveWord, deleteWord, filterWords, getAudioRecord } from "./src/db/wordRepository.js";
import { listCategories, saveCategory, deleteCategory } from "./src/db/categoryRepository.js";
import { listPracticeAttempts, recordPracticeAttempt, summarizeAttempts } from "./src/db/practiceRepository.js";
import { AUDIO_ACCEPT, validateAudioFile, playAudioBlob } from "./src/services/audioService.js";
import { DEMO_CATEGORIES, DEMO_WORDS } from "./src/services/demoData.js";
import {
  clearAllData,
  createWordsCsvPackageZipBlob,
  createWordsCsvTemplate,
  importWordsFromCsvFile,
  inspectCsvImportFile,
} from "./src/services/importExportService.js";
import { createDownload, createId, escapeHtml, normalizeText, shuffle, uniqueStrings } from "./src/services/helpers.js";
import { renderWordsView } from "./src/views/wordsView.js";
import { renderCategoriesView } from "./src/views/categoriesView.js";
import { renderPracticeView } from "./src/views/practiceView.js";
import { renderSettingsView } from "./src/views/settingsView.js";

const appRoot = document.querySelector("#app");

if (!appRoot) {
  throw new Error("App root not found.");
}

const VIEWS = {
  words: "words",
  categories: "categories",
  practice: "practice",
  settings: "settings",
};

const MOBILE_WORDS_PER_PAGE = 10;
const DESKTOP_WORDS_PER_PAGE = 20;
const DESKTOP_WORDS_MEDIA_QUERY = "(min-width: 980px)";

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIosSafari() {
  const userAgent = window.navigator.userAgent || "";
  const vendor = window.navigator.vendor || "";
  const isiPadDesktopMode = window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  const isIosDevice = /iPad|iPhone|iPod/i.test(userAgent) || isiPadDesktopMode;
  const isAppleWebKit = /Apple/i.test(vendor);
  const isOtherIosBrowser = /(CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo)/i.test(userAgent);

  return isIosDevice && isAppleWebKit && !isOtherIosBrowser;
}

const state = {
  view: VIEWS.words,
  loading: true,
  busy: false,
  words: [],
  categories: [],
  practiceAttempts: [],
  filters: {
    query: "",
    categoryIds: [],
  },
  wordDraft: createEmptyWordDraft(),
  categoryDraft: createEmptyCategoryDraft(),
  practiceConfig: {
    categoryIds: [],
    limit: 10,
    pageSpec: "",
  },
  wordListPagination: createWordListPagination(),
  practiceSession: createEmptyPracticeSession(),
  importPreviews: createEmptyImportPreviews(),
  notice: null,
  storageEstimate: null,
  installPromptEvent: null,
  standalone: isStandaloneMode(),
  serviceWorkerState: "idle",
};

let noticeTimerId;

function createEmptyWordDraft() {
  return {
    id: "",
    term: "",
    phonetic: "",
    meaning: "",
    example: "",
    notes: "",
    categoryIds: [],
    hasAudio: false,
    hasExampleAudio: false,
  };
}

function createEmptyCategoryDraft() {
  return {
    id: "",
    name: "",
    group: "",
    description: "",
  };
}

function createEmptyPracticeSession() {
  return {
    sessionId: "",
    queueIds: [],
    currentIndex: 0,
    currentResult: null,
    selectedCategoryIds: [],
    selectedPages: [],
    summary: {
      total: 0,
      correct: 0,
      accuracy: 0,
    },
  };
}

function getResponsiveWordsPerPage() {
  return window.matchMedia(DESKTOP_WORDS_MEDIA_QUERY).matches ? DESKTOP_WORDS_PER_PAGE : MOBILE_WORDS_PER_PAGE;
}

function createWordListPagination() {
  return {
    page: 1,
    pageSize: getResponsiveWordsPerPage(),
  };
}

function resetWordListPage() {
  state.wordListPagination.page = 1;
}

function clampWordListPage(totalItems = getFilteredWords().length) {
  const totalPages = Math.max(1, Math.ceil(totalItems / state.wordListPagination.pageSize));
  state.wordListPagination.page = Math.min(Math.max(1, state.wordListPagination.page), totalPages);
}

function syncWordListPageSize() {
  const nextPageSize = getResponsiveWordsPerPage();

  if (state.wordListPagination.pageSize === nextPageSize) {
    return false;
  }

  state.wordListPagination.pageSize = nextPageSize;
  clampWordListPage();
  return true;
}

function createEmptyImportPreviews() {
  return {
    csv: null,
  };
}

function createImportPreview(file, summary, overrides = {}) {
  return {
    status: "ready",
    file,
    filename: file?.name || "",
    size: file?.size || 0,
    lastModified: file?.lastModified || 0,
    ...summary,
    ...overrides,
  };
}

function getPwaStatus() {
  const serviceWorkerSupported = "serviceWorker" in navigator;
  const serviceWorkerControlled = serviceWorkerSupported &&
    (state.serviceWorkerState === "controlled" || Boolean(navigator.serviceWorker.controller));

  return {
    origin: window.location.origin,
    iosSafari: isIosSafari(),
    promptInstallAvailable: Boolean(state.installPromptEvent),
    secureContext: window.isSecureContext,
    serviceWorkerSupported,
    serviceWorkerControlled,
    serviceWorkerState: serviceWorkerControlled ? "controlled" : state.serviceWorkerState,
    standalone: isStandaloneMode(),
  };
}

function matchesPreviewFile(preview, file) {
  return Boolean(
    preview &&
      file &&
      preview.filename === file.name &&
      preview.size === file.size &&
      preview.lastModified === file.lastModified,
  );
}

function setNotice(text, type = "info") {
  state.notice = { text, type };
  window.clearTimeout(noticeTimerId);
  noticeTimerId = window.setTimeout(() => {
    state.notice = null;
    render();
  }, 3200);
  render();
}

async function runAction(task, successMessage) {
  state.busy = true;
  render();

  try {
    const result = await task();

    if (successMessage) {
      setNotice(successMessage, "success");
    }

    return result;
  } catch (error) {
    console.error(error);
    setNotice(error instanceof Error ? error.message : "操作失败。", "error");
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

async function updateStorageEstimate() {
  if (!navigator.storage?.estimate) {
    state.storageEstimate = null;
    return;
  }

  state.storageEstimate = await navigator.storage.estimate();
}

function withCategoryCounts(categories, words) {
  const usageMap = new Map();

  for (const word of words) {
    for (const categoryId of word.categoryIds || []) {
      usageMap.set(categoryId, (usageMap.get(categoryId) || 0) + 1);
    }
  }

  return categories.map((category) => ({
    ...category,
    wordCount: usageMap.get(category.id) || 0,
  }));
}

async function refreshData() {
  const [words, categories, practiceAttempts] = await Promise.all([
    listWords(),
    listCategories(),
    listPracticeAttempts(),
  ]);

  state.words = words;
  state.categories = withCategoryCounts(categories, words);
  state.practiceAttempts = practiceAttempts;
  state.wordDraft.categoryIds = state.wordDraft.categoryIds.filter((categoryId) =>
    state.categories.some((category) => category.id === categoryId),
  );
  state.filters.categoryIds = state.filters.categoryIds.filter((categoryId) =>
    state.categories.some((category) => category.id === categoryId),
  );
  state.practiceConfig.categoryIds = state.practiceConfig.categoryIds.filter((categoryId) =>
    state.categories.some((category) => category.id === categoryId),
  );
  state.wordListPagination.pageSize = getResponsiveWordsPerPage();
  clampWordListPage(filterWords(words, state.filters).length);
  await updateStorageEstimate();
}

function getCategoriesById() {
  return new Map(state.categories.map((category) => [category.id, category]));
}

function getWordsById() {
  return new Map(state.words.map((word) => [word.id, word]));
}

function getFilteredWords() {
  return filterWords(state.words, state.filters);
}

function getPaginatedWords(filteredWords = getFilteredWords()) {
  const totalItems = filteredWords.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / state.wordListPagination.pageSize));
  const currentPage = Math.min(Math.max(1, state.wordListPagination.page), totalPages);
  const startOffset = (currentPage - 1) * state.wordListPagination.pageSize;
  const items = filteredWords.slice(startOffset, startOffset + state.wordListPagination.pageSize);

  return {
    items,
    currentPage,
    totalPages,
    totalItems,
    pageSize: state.wordListPagination.pageSize,
    startIndex: totalItems ? startOffset + 1 : 0,
    endIndex: Math.min(startOffset + state.wordListPagination.pageSize, totalItems),
    hasPrevious: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}

function parsePageSpec(pageSpec) {
  const text = String(pageSpec ?? "").trim();

  if (!text) {
    return [];
  }

  const tokens = text.split(/[，,、\s]+/).filter(Boolean);
  const pages = new Set();

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);

    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        throw new Error("页码必须是大于等于 1 的整数。");
      }

      const [from, to] = start <= end ? [start, end] : [end, start];

      for (let page = from; page <= to; page += 1) {
        pages.add(page);
      }

      continue;
    }

    const singlePage = Number(token);

    if (!Number.isInteger(singlePage) || singlePage < 1) {
      throw new Error("页码格式无效，请输入如 2 或 1,3-5 这样的页码。");
    }

    pages.add(singlePage);
  }

  return [...pages].sort((left, right) => left - right);
}

function getPracticeSourceInfo(selectedCategoryIds = [], pageSpec = "") {
  const words = filterWords(state.words, {
    query: "",
    categoryIds: selectedCategoryIds,
  });
  const pageSize = getResponsiveWordsPerPage();
  const totalPages = words.length ? Math.ceil(words.length / pageSize) : 0;
  const selectedPages = parsePageSpec(pageSpec);

  if (selectedPages.length && !totalPages) {
    throw new Error("当前筛选条件下没有可练习的单词。");
  }

  const invalidPages = selectedPages.filter((page) => page > totalPages);

  if (invalidPages.length) {
    throw new Error(`页码超出范围。当前条件下共有 ${totalPages} 页。`);
  }

  const sourceWords = selectedPages.length
    ? selectedPages.flatMap((page) => {
        const startOffset = (page - 1) * pageSize;
        return words.slice(startOffset, startOffset + pageSize);
      })
    : words;

  return {
    words: sourceWords,
    totalWords: words.length,
    totalPages,
    pageSize,
    selectedPages,
  };
}

function scrollToWordListStart() {
  window.requestAnimationFrame(() => {
    const anchor = document.querySelector("[data-word-list-scroll-anchor]");

    if (!(anchor instanceof HTMLElement)) {
      return;
    }

    anchor.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}

function buildAppSummary() {
  return {
    words: state.words.length,
    categories: state.categories.length,
    practiceAttempts: state.practiceAttempts.length,
  };
}

function getCurrentPracticeWord() {
  if (!state.practiceSession.queueIds.length) {
    return null;
  }

  if (state.practiceSession.currentIndex >= state.practiceSession.queueIds.length) {
    return null;
  }

  const wordId = state.practiceSession.queueIds[state.practiceSession.currentIndex];
  return getWordsById().get(wordId) ?? null;
}

function renderNavigation() {
  return `
    <nav class="tab-row" aria-label="Primary">
      ${Object.entries({
        [VIEWS.words]: "单词",
        [VIEWS.categories]: "分类",
        [VIEWS.practice]: "练习",
        [VIEWS.settings]: "词库",
      })
        .map(
          ([view, label]) => `
            <button
              type="button"
              class="tab-button ${state.view === view ? "tab-button--active" : ""}"
              data-action="switch-view"
              data-view="${view}"
            >
              ${label}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

function renderNotice() {
  if (!state.notice) {
    return "";
  }

  return `<div class="notice notice--${state.notice.type}">${escapeHtml(state.notice.text)}</div>`;
}

function renderView() {
  const categoriesById = getCategoriesById();
  const wordsById = getWordsById();

  switch (state.view) {
    case VIEWS.categories:
      return renderCategoriesView({
        categories: state.categories,
        draft: state.categoryDraft,
        busy: state.busy,
      });
    case VIEWS.practice:
      const practiceSourceInfo = getPracticeSourceInfo(
        state.practiceConfig.categoryIds,
        state.practiceConfig.pageSpec,
      );

      return renderPracticeView({
        categories: state.categories,
        categoriesById,
        practiceConfig: state.practiceConfig,
        practiceSession: state.practiceSession,
        practiceSourceInfo,
        currentWord: getCurrentPracticeWord(),
        stats: summarizeAttempts(state.practiceAttempts),
        recentAttempts: state.practiceAttempts,
        wordsById,
        busy: state.busy,
      });
    case VIEWS.settings:
      return renderSettingsView({
        summary: buildAppSummary(),
        storageEstimate: state.storageEstimate,
        busy: state.busy,
        pwaStatus: getPwaStatus(),
        importPreviews: state.importPreviews,
      });
    case VIEWS.words:
    default:
      syncWordListPageSize();
      const filteredWords = getFilteredWords();
      clampWordListPage(filteredWords.length);
      const wordPagination = getPaginatedWords(filteredWords);

      return renderWordsView({
        words: wordPagination.items,
        pagination: wordPagination,
        categories: state.categories,
        categoriesById,
        filters: state.filters,
        draft: state.wordDraft,
        busy: state.busy,
        audioAccept: AUDIO_ACCEPT,
      });
  }
}

function renderLoading() {
  appRoot.innerHTML = `
    <section class="placeholder">
      <div>
        <h2>应用初始化中</h2>
        <p>正在载入本地数据库和离线模块。</p>
      </div>
    </section>
  `;
}

function render() {
  if (state.loading) {
    renderLoading();
    return;
  }

  appRoot.innerHTML = `
    <section class="status-bar">
      <div class="status-pill">单词 ${state.words.length}</div>
      <div class="status-pill">分类 ${state.categories.length}</div>
      <div class="status-pill">练习 ${state.practiceAttempts.length}</div>
      <div class="status-pill ${navigator.onLine ? "status-pill--online" : "status-pill--offline"}">${navigator.onLine ? "在线" : "离线"}</div>
    </section>
    ${renderNotice()}
    ${renderNavigation()}
    ${renderView()}
  `;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    state.serviceWorkerState = "unsupported";
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
    state.serviceWorkerState = navigator.serviceWorker.controller ? "controlled" : "registered";
  } catch (error) {
    state.serviceWorkerState = "error";
    console.error(error);
  }
}

async function startPracticeSession(selectedCategoryIds, limit, pageSpec = "") {
  const sourceInfo = getPracticeSourceInfo(selectedCategoryIds, pageSpec);
  const candidateWords = sourceInfo.words;

  if (!candidateWords.length) {
    throw new Error("当前筛选条件下没有可练习的单词。");
  }

  const queueIds = shuffle(candidateWords)
    .slice(0, limit)
    .map((word) => word.id);

  state.practiceSession = {
    sessionId: createId(),
    queueIds,
    currentIndex: 0,
    currentResult: null,
    selectedCategoryIds,
    selectedPages: sourceInfo.selectedPages,
    summary: {
      total: queueIds.length,
      correct: 0,
      accuracy: 0,
    },
  };
}

function resetPracticeSession() {
  state.practiceSession = createEmptyPracticeSession();
}

function finalizePracticeSession() {
  const sessionAttempts = state.practiceAttempts.filter(
    (attempt) => attempt.sessionId === state.practiceSession.sessionId,
  );
  const summary = summarizeAttempts(sessionAttempts);

  state.practiceSession = {
    ...state.practiceSession,
    currentIndex: state.practiceSession.queueIds.length,
    currentResult: null,
    summary,
  };
}

function formatCsvImportSummary(summary, options = {}) {
  const audioSummary =
    summary.importedAudio || summary.updatedAudio || summary.skippedAudio
      ? `，新增 ${summary.importedAudio} 个音频，更新 ${summary.updatedAudio} 个音频，跳过 ${summary.skippedAudio} 个音频`
      : "";
  const overwriteHint = summary.skippedWords
    ? " 若你是在用新版词库补充音标、例句等字段，请改用“覆盖同名单词”或“覆盖导入”。"
    : "";

  if (options.importMode === "replace") {
    return `已清空本地数据并导入词库：新增 ${summary.createdWords} 个单词，新增 ${summary.createdCategories} 个分类${audioSummary}。`;
  }

  if (summary.duplicateMode === "overwrite") {
    return `词库导入完成：新增 ${summary.createdWords} 个单词，覆盖 ${summary.updatedWords} 个同名单词，新增 ${summary.createdCategories} 个分类${audioSummary}。`;
  }

  return `词库导入完成：新增 ${summary.createdWords} 个单词，跳过 ${summary.skippedWords} 个重复单词，新增 ${summary.createdCategories} 个分类${audioSummary}。${overwriteHint}`;
}

async function previewImportFile(file) {
  if (!file) {
    state.importPreviews.csv = null;
    render();
    return;
  }

  state.busy = true;
  render();

  try {
    const summary = await inspectCsvImportFile(file);

    if (summary.requiresZipForAudio) {
      state.importPreviews.csv = createImportPreview(file, summary, {
        status: "error",
        message: "纯 CSV 中检测到 audio 或 exampleAudio 列引用。若要一起导入音频，请改用 ZIP 包，并包含 words.csv、audio 目录和可选 example-audio 目录。",
      });
      return;
    }

    state.importPreviews.csv = createImportPreview(file, summary);
  } catch (error) {
    state.importPreviews.csv = createImportPreview(file, {}, {
      status: "error",
      message: error instanceof Error ? error.message : "预览失败。",
    });
  } finally {
    state.busy = false;
    render();
  }
}

async function handleWordSubmit(form) {
  const formData = new FormData(form);
  const audioFile = formData.get("audioFile");
  let audioChange = { mode: "keep" };

  if (audioFile instanceof File && audioFile.size > 0) {
    validateAudioFile(audioFile);
    audioChange = { mode: "replace", file: audioFile };
  } else if (formData.get("removeAudio") === "on") {
    audioChange = { mode: "remove" };
  }

  await saveWord(
    {
      id: String(formData.get("id") || ""),
      term: formData.get("term"),
      phonetic: formData.get("phonetic"),
      meaning: formData.get("meaning"),
      example: formData.get("example"),
      notes: formData.get("notes"),
      categoryIds: formData.getAll("categoryId"),
    },
    audioChange,
  );

  state.wordDraft = createEmptyWordDraft();
  await refreshData();
}

async function handleCategorySubmit(form) {
  const formData = new FormData(form);

  await saveCategory({
    id: String(formData.get("id") || ""),
    name: formData.get("name"),
    group: formData.get("group"),
    description: formData.get("description"),
  });

  state.categoryDraft = createEmptyCategoryDraft();
  await refreshData();
}

async function handleWordFiltersSubmit(form) {
  const formData = new FormData(form);
  state.filters = {
    query: String(formData.get("query") || ""),
    categoryIds: uniqueStrings(formData.getAll("filterCategoryId")),
  };
  resetWordListPage();
}

async function handleWordPaginationJump(form) {
  const formData = new FormData(form);
  const requestedPage = Number(formData.get("page") || "");

  if (!Number.isFinite(requestedPage)) {
    throw new Error("请输入有效页码。");
  }

  state.wordListPagination.page = Math.max(1, Math.floor(requestedPage));
  clampWordListPage();
  scrollToWordListStart();
}

async function handlePracticeStart(form) {
  const formData = new FormData(form);
  const limit = Number(formData.get("limit") || 10);
  const selectedCategoryIds = uniqueStrings(formData.getAll("practiceCategoryId"));
  const pageSpec = String(formData.get("pageSpec") || "").trim();
  const nextPracticeConfig = {
    categoryIds: selectedCategoryIds,
    limit: Math.max(1, Math.min(50, Number.isFinite(limit) ? limit : 10)),
    pageSpec,
  };

  await startPracticeSession(nextPracticeConfig.categoryIds, nextPracticeConfig.limit, nextPracticeConfig.pageSpec);
  state.practiceConfig = nextPracticeConfig;
}

async function handlePracticeAnswer(form) {
  const currentWord = getCurrentPracticeWord();

  if (!currentWord) {
    return;
  }

  const formData = new FormData(form);
  const answer = String(formData.get("answer") || "").trim();
  const correct = normalizeText(answer) === normalizeText(currentWord.term);
  const attempt = await recordPracticeAttempt({
    sessionId: state.practiceSession.sessionId,
    wordId: currentWord.id,
    answer,
    expected: currentWord.term,
    correct,
    selectedCategoryIds: state.practiceSession.selectedCategoryIds,
    selectedPages: state.practiceSession.selectedPages,
  });

  state.practiceAttempts = [attempt, ...state.practiceAttempts].slice(0, 80);
  state.practiceSession.currentResult = {
    correct,
    answer,
  };
}

async function handleImportCsv(form) {
  const formData = new FormData(form);
  const rawFile = formData.get("csvFile");
  const importMode = String(formData.get("importMode") || "merge");
  const duplicateMode = String(formData.get("duplicateMode") || "skip");
  const preview = state.importPreviews.csv;
  const file = rawFile instanceof File && rawFile.size > 0 ? rawFile : preview?.file;

  if (!(file instanceof File) || file.size === 0) {
    throw new Error("请选择一个 CSV 文件或 ZIP 词库包。");
  }

  if (preview?.status === "error" && matchesPreviewFile(preview, file)) {
    throw new Error(preview.message || "词库文件预检失败。");
  }

  const inspection = preview?.status === "ready" && matchesPreviewFile(preview, file)
    ? preview
    : await inspectCsvImportFile(file);
  const confirmed = window.confirm(
    importMode === "replace"
      ? `将先清空当前本地单词、分类、音频和练习记录，再从${inspection.format === "zip" ? " ZIP 词库包" : " CSV 文件"}导入 ${inspection.rows} 行词条，涉及 ${inspection.categories} 个分类${inspection.audioRefs ? `，并引用 ${inspection.audioRefs} 个音频文件` : ""}。\n该操作不可恢复，是否继续？`
      : `将从${inspection.format === "zip" ? " ZIP 词库包" : " CSV 文件"}导入 ${inspection.rows} 行词条，涉及 ${inspection.categories} 个分类${inspection.audioRefs ? `，并引用 ${inspection.audioRefs} 个音频文件` : ""}。\n重复单词策略：${duplicateMode === "overwrite" ? "覆盖同名单词" : "跳过同名单词"}。${duplicateMode === "skip" ? "\n如果你是在用新版词库更新音标、例句或备注，请改选“覆盖同名单词”。" : ""}\n是否继续？`,
  );

  if (!confirmed) {
    return null;
  }

  if (importMode === "replace") {
    await clearAllData();
    resetPracticeSession();
  }

  const summary = await importWordsFromCsvFile(file, {
    duplicateMode: importMode === "replace" ? "overwrite" : duplicateMode,
  });
  state.wordDraft = createEmptyWordDraft();
  state.categoryDraft = createEmptyCategoryDraft();
  state.view = VIEWS.words;
  state.importPreviews.csv = null;
  await refreshData();
  return formatCsvImportSummary(summary, { importMode });
}

async function onChange(event) {
  const target = event.target;

  if (!(target instanceof HTMLInputElement) || target.type !== "file") {
    return;
  }

  if (target.name === "csvFile") {
    await previewImportFile(target.files?.[0] ?? null);
  }
}

async function handlePlayWordAudio(wordId) {
  const record = await getAudioRecord(wordId);

  if (!record?.blob) {
    throw new Error("当前单词还没有音频。");
  }

  await playAudioBlob(record.blob);
}

async function seedDemoData() {
  const categoryByName = new Map(state.categories.map((category) => [normalizeText(category.name), category]));
  const categoryIdByKey = new Map();
  let createdCategories = 0;

  for (const demoCategory of DEMO_CATEGORIES) {
    const normalizedName = normalizeText(demoCategory.name);
    let record = categoryByName.get(normalizedName);

    if (!record) {
      record = await saveCategory({
        name: demoCategory.name,
        group: demoCategory.group,
        description: demoCategory.description,
      });
      categoryByName.set(normalizedName, record);
      createdCategories += 1;
    }

    categoryIdByKey.set(demoCategory.key, record.id);
  }

  const existingTerms = new Set(state.words.map((word) => normalizeText(word.term)));
  let createdWords = 0;

  for (const demoWord of DEMO_WORDS) {
    const normalizedTerm = normalizeText(demoWord.term);

    if (existingTerms.has(normalizedTerm)) {
      continue;
    }

    await saveWord(
      {
        term: demoWord.term,
        meaning: demoWord.meaning,
        example: demoWord.example,
        notes: demoWord.notes,
        categoryIds: demoWord.categoryKeys.map((key) => categoryIdByKey.get(key)).filter(Boolean),
      },
      { mode: "keep" },
    );

    existingTerms.add(normalizedTerm);
    createdWords += 1;
  }

  await refreshData();
  state.view = VIEWS.words;

  return {
    createdCategories,
    createdWords,
  };
}

function populateWordDraft(wordId) {
  const word = state.words.find((item) => item.id === wordId);

  if (!word) {
    return;
  }

  state.wordDraft = {
    id: word.id,
    term: word.term,
    phonetic: word.phonetic,
    meaning: word.meaning,
    example: word.example,
    notes: word.notes,
    categoryIds: [...(word.categoryIds || [])],
    hasAudio: word.hasAudio,
    hasExampleAudio: Boolean(word.hasExampleAudio),
  };
  state.view = VIEWS.words;
}

function populateCategoryDraft(categoryId) {
  const category = state.categories.find((item) => item.id === categoryId);

  if (!category) {
    return;
  }

  state.categoryDraft = {
    id: category.id,
    name: category.name,
    group: category.group,
    description: category.description,
  };
  state.view = VIEWS.categories;
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.target.closest("form");

  if (!form) {
    return;
  }

  await runAction(async () => {
    switch (form.dataset.form) {
      case "word-editor":
        await handleWordSubmit(form);
        return "单词已保存。";
      case "category-editor":
        await handleCategorySubmit(form);
        return "分类已保存。";
      case "word-filters":
        await handleWordFiltersSubmit(form);
        return null;
      case "word-pagination-jump":
        await handleWordPaginationJump(form);
        return null;
      case "practice-start":
        await handlePracticeStart(form);
        return null;
      case "practice-answer":
        await handlePracticeAnswer(form);
        return null;
      case "import-csv":
        return handleImportCsv(form);
      default:
        return null;
    }
  }).then((message) => {
    if (message) {
      setNotice(message, "success");
    }
  });
}

async function onClick(event) {
  const trigger = event.target.closest("[data-action]");

  if (!trigger) {
    return;
  }

  const { action } = trigger.dataset;

  switch (action) {
    case "switch-view":
      state.view = trigger.dataset.view || VIEWS.words;
      render();
      return;
    case "reset-word-draft":
      state.wordDraft = createEmptyWordDraft();
      render();
      return;
    case "reset-category-draft":
      state.categoryDraft = createEmptyCategoryDraft();
      render();
      return;
    case "reset-word-filters":
      state.filters = { query: "", categoryIds: [] };
      resetWordListPage();
      render();
      return;
    case "set-word-page": {
      const previousPage = state.wordListPagination.page;
      const nextPage = Number(trigger.dataset.page || state.wordListPagination.page);

      if (!Number.isFinite(nextPage)) {
        return;
      }

      state.wordListPagination.page = Math.max(1, Math.floor(nextPage));
      clampWordListPage();

      if (state.wordListPagination.page !== previousPage) {
        scrollToWordListStart();
      }

      render();
      return;
    }
    case "edit-word":
      populateWordDraft(trigger.dataset.wordId);
      render();
      return;
    case "delete-word":
      if (!window.confirm("确认删除这个单词吗？相关音频也会一起删除。")) {
        return;
      }

      await runAction(async () => {
        await deleteWord(trigger.dataset.wordId);
        state.wordDraft = createEmptyWordDraft();
        await refreshData();
      }, "单词已删除。");
      return;
    case "play-word-audio":
    case "play-practice-audio":
      await runAction(async () => {
        await handlePlayWordAudio(trigger.dataset.wordId);
      });
      return;
    case "edit-category":
      populateCategoryDraft(trigger.dataset.categoryId);
      render();
      return;
    case "delete-category": {
      const category = state.categories.find((item) => item.id === trigger.dataset.categoryId);
      const count = category?.wordCount || 0;
      const confirmed = window.confirm(
        count > 0
          ? `删除后会从 ${count} 个单词中移除该分类，确认继续吗？`
          : "确认删除这个分类吗？",
      );

      if (!confirmed) {
        return;
      }

      await runAction(async () => {
        await deleteCategory(trigger.dataset.categoryId);
        state.categoryDraft = createEmptyCategoryDraft();
        await refreshData();
      }, "分类已删除。");
      return;
    }
    case "advance-practice":
      state.practiceSession.currentIndex += 1;
      state.practiceSession.currentResult = null;

      if (state.practiceSession.currentIndex >= state.practiceSession.queueIds.length) {
        finalizePracticeSession();
      }

      render();
      return;
    case "reset-practice-session":
      resetPracticeSession();
      render();
      return;
    case "download-csv-template":
      await runAction(async () => {
        const csvTemplate = createWordsCsvTemplate();
        createDownload("english-learning-template.csv", csvTemplate, "text/csv;charset=utf-8");
      }, "CSV 模板已生成。");
      return;
    case "export-csv-package":
      await runAction(async () => {
        const csvPackageZip = await createWordsCsvPackageZipBlob();
        const filename = `english-learning-words-${new Date().toISOString().slice(0, 10)}.zip`;
        createDownload(filename, csvPackageZip, "application/zip");
      }, "CSV + 音频 ZIP 已生成。");
      return;
    case "load-demo-data": {
      const hasData = state.words.length > 0 || state.categories.length > 0;

      if (hasData) {
        const confirmed = window.confirm("将把示例分类和示例单词补充到当前数据中，已存在的同名单词会跳过，是否继续？");

        if (!confirmed) {
          return;
        }
      }

      const result = await runAction(async () => seedDemoData());

      if (!result) {
        return;
      }

      if (result.createdCategories === 0 && result.createdWords === 0) {
        setNotice("示例数据已经存在，无需重复加载。", "info");
        return;
      }

      setNotice(`已加载 ${result.createdCategories} 个分类和 ${result.createdWords} 个示例单词。`, "success");
      return;
    }
    case "clear-local-data":
      if (!window.confirm("这会清空所有本地数据，且不可恢复，是否继续？")) {
        return;
      }

      await runAction(async () => {
        await clearAllData();
        state.wordDraft = createEmptyWordDraft();
        state.categoryDraft = createEmptyCategoryDraft();
        resetPracticeSession();
        state.importPreviews = createEmptyImportPreviews();
        await refreshData();
      }, "本地数据已清空。");
      return;
    case "install-app":
      if (!state.installPromptEvent) {
        return;
      }

      await runAction(async () => {
        state.installPromptEvent.prompt();
        await state.installPromptEvent.userChoice;
        state.installPromptEvent = null;
      });
      return;
    default:
      return;
  }
}

async function initialize() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPromptEvent = event;
    render();
  });

  window.addEventListener("appinstalled", () => {
    state.installPromptEvent = null;
    state.standalone = isStandaloneMode();
    render();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      state.serviceWorkerState = "controlled";
      render();
    });
  }

  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  window.addEventListener("resize", () => {
    if (!syncWordListPageSize()) {
      return;
    }

    render();
  });

  appRoot.addEventListener("submit", onSubmit);
  appRoot.addEventListener("click", onClick);
  appRoot.addEventListener("change", onChange);

  await openDatabase();
  await refreshData();
  await registerServiceWorker();

  state.standalone = isStandaloneMode();
  state.loading = false;
  render();
}

initialize().catch((error) => {
  console.error(error);
  appRoot.innerHTML = `
    <section class="placeholder">
      <div>
        <h2>初始化失败</h2>
        <p>${escapeHtml(error instanceof Error ? error.message : "请刷新页面后重试。")}</p>
      </div>
    </section>
  `;
});