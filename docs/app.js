import { openDatabase } from "./src/db/database.js";
import {
  listWords,
  saveWord,
  deleteWord,
  filterWords,
  getWordAudioRecord,
  getExampleAudioRecord,
  setWordFavorite,
} from "./src/db/wordRepository.js";
import { listCategories, saveCategory, deleteCategory } from "./src/db/categoryRepository.js";
import { listPracticeAttempts, recordPracticeAttempt, summarizeAttempts } from "./src/db/practiceRepository.js";
import { AUDIO_ACCEPT, validateAudioFile, playAudioBlob } from "./src/services/audioService.js";
import { DEMO_CATEGORIES, DEMO_WORDS } from "./src/services/demoData.js";
import {
  clearAllData,
  createLibraryPackageZipBlob,
  createLibraryTemplate,
  importLibraryFromFile,
  inspectLibraryImportFile,
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
const DEFAULT_WORD_SORT_MODE = "term-asc";
const DEFAULT_NOTICE_DURATION_MS = 3000;
const EXAMPLE_WORD_HINT_CARD_WIDTH_PX = 340;
const EXAMPLE_WORD_HINT_VIEWPORT_MARGIN_PX = 12;
const EXAMPLE_WORD_HINT_VERTICAL_OFFSET_PX = 12;
const EXAMPLE_WORD_HINT_MIN_ANCHOR_TOP_PX = 156;
const EXAMPLE_WORD_HINT_ARROW_EDGE_PADDING_PX = 22;
const ENGLISH_TERM_COLLATOR = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

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
  wordEditorExpanded: false,
  wordFilterDisclosureOpen: false,
  words: [],
  categories: [],
  practiceAttempts: [],
  filters: {
    query: "",
    categoryIds: [],
    favoritesOnly: false,
    sortMode: DEFAULT_WORD_SORT_MODE,
  },
  wordDraft: createEmptyWordDraft(),
  categoryDraft: createEmptyCategoryDraft(),
  practiceConfig: {
    categoryIds: [],
    limit: 10,
    pageSpec: "",
    favoritesOnly: false,
  },
  wordListPagination: createWordListPagination(),
  practiceSession: createEmptyPracticeSession(),
  importPreviews: createEmptyImportPreviews(),
  notice: null,
  exampleWordHint: null,
  storageEstimate: null,
  installPromptEvent: null,
  standalone: isStandaloneMode(),
  serviceWorkerState: "idle",
};

let noticeTimerId = 0;

function createEmptyWordDraft() {
  return {
    id: "",
    term: "",
    phonetics: [""],
    meaning: "",
    examples: [createEmptyExampleDraft()],
    categoryIds: [],
    isFavorite: false,
    hasWordAudio: false,
    removeWordAudio: false,
    wordAudioFile: null,
  };
}

function createEmptyExampleDraft() {
  return {
    id: createId(),
    en: "",
    zh: "",
    hasAudio: false,
    removeAudio: false,
    audioFile: null,
  };
}

function createEmptyCategoryDraft() {
  return {
    id: "",
    name: "",
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
    favoritesOnly: false,
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
    library: null,
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

function normalizeDraftPhonetics(values) {
  const phonetics = Array.isArray(values) ? values.map((value) => String(value ?? "")) : [];
  return phonetics.length ? phonetics : [""];
}

function normalizeDraftExamples(values) {
  const examples = (Array.isArray(values) ? values : [])
    .map((value) => ({
      id: value?.id ? String(value.id) : createId(),
      en: String(value?.en ?? ""),
      zh: String(value?.zh ?? ""),
      hasAudio: Boolean(value?.hasAudio),
      removeAudio: Boolean(value?.removeAudio) && Boolean(value?.hasAudio),
      audioFile: value?.audioFile || null,
    }))
    .filter(Boolean);

  return examples.length ? examples : [createEmptyExampleDraft()];
}

function readWordDraftFromForm(form) {
  const formData = new FormData(form);
  const currentExamplesById = new Map(state.wordDraft.examples.map((example) => [example.id, example]));
  const exampleIds = formData.getAll("exampleId").map((value) => String(value || createId()));
  const exampleEnValues = formData.getAll("exampleEn").map((value) => String(value ?? ""));
  const exampleZhValues = formData.getAll("exampleZh").map((value) => String(value ?? ""));
  const removeExampleAudioIds = new Set(formData.getAll("removeExampleAudio").map((value) => String(value)));
  const examples = exampleIds.map((id, index) => {
    const current = currentExamplesById.get(id) || createEmptyExampleDraft();

    return {
      ...current,
      id,
      en: exampleEnValues[index] || "",
      zh: exampleZhValues[index] || "",
      removeAudio: current.hasAudio && removeExampleAudioIds.has(id),
    };
  });

  return {
    ...state.wordDraft,
    id: String(formData.get("id") || ""),
    term: String(formData.get("term") || ""),
    phonetics: normalizeDraftPhonetics(formData.getAll("phoneticValue")),
    meaning: String(formData.get("meaning") || ""),
    examples: normalizeDraftExamples(examples),
    categoryIds: uniqueStrings(formData.getAll("categoryId")),
    removeWordAudio: state.wordDraft.hasWordAudio && formData.get("removeWordAudio") === "on",
  };
}

function syncWordDraftFromForm(form) {
  state.wordDraft = readWordDraftFromForm(form);
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

function setNotice(text, type = "info", autoCloseMs = DEFAULT_NOTICE_DURATION_MS) {
  state.notice = { text, type };
  window.clearTimeout(noticeTimerId);

  if (autoCloseMs > 0) {
    noticeTimerId = window.setTimeout(() => {
      state.notice = null;
      noticeTimerId = 0;
      render();
    }, autoCloseMs);
  }

  render();
}

function clearNotice() {
  window.clearTimeout(noticeTimerId);
  noticeTimerId = 0;

  if (!state.notice) {
    return;
  }

  state.notice = null;
  render();
}

function formatWordHintPhonetics(word) {
  if (!word?.phonetics?.length) {
    return "无音标";
  }

  return word.phonetics.join("，");
}

function addExampleWordHintStemCandidates(candidates, stem) {
  const normalizedStem = normalizeText(stem);

  if (!normalizedStem) {
    return;
  }

  candidates.push(normalizedStem);
  candidates.push(`${normalizedStem}e`);

  if (/([b-df-hj-np-tv-z])\1$/i.test(normalizedStem)) {
    candidates.push(normalizedStem.slice(0, -1));
  }
}

function getExampleWordHintCandidates(token) {
  const normalizedToken = normalizeText(token)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "")
    .replace(/[’]/g, "'");

  const candidates = [normalizedToken];

  if (normalizedToken.endsWith("'s")) {
    candidates.push(normalizedToken.slice(0, -2));
  }

  if (normalizedToken.endsWith("ies") && normalizedToken.length > 3) {
    candidates.push(`${normalizedToken.slice(0, -3)}y`);
  }

  if (normalizedToken.endsWith("es") && normalizedToken.length > 2) {
    candidates.push(normalizedToken.slice(0, -2));
  }

  if (normalizedToken.endsWith("s") && normalizedToken.length > 1) {
    candidates.push(normalizedToken.slice(0, -1));
  }

  if (normalizedToken.endsWith("ied") && normalizedToken.length > 3) {
    candidates.push(`${normalizedToken.slice(0, -3)}y`);
  }

  if (normalizedToken.endsWith("ed") && normalizedToken.length > 2) {
    addExampleWordHintStemCandidates(candidates, normalizedToken.slice(0, -2));
  }

  if (normalizedToken.endsWith("ying") && normalizedToken.length > 4) {
    candidates.push(`${normalizedToken.slice(0, -4)}ie`);
  }

  if (normalizedToken.endsWith("ing") && normalizedToken.length > 3) {
    addExampleWordHintStemCandidates(candidates, normalizedToken.slice(0, -3));
  }

  if (normalizedToken.endsWith("iest") && normalizedToken.length > 4) {
    candidates.push(`${normalizedToken.slice(0, -4)}y`);
  }

  if (normalizedToken.endsWith("est") && normalizedToken.length > 3) {
    addExampleWordHintStemCandidates(candidates, normalizedToken.slice(0, -3));
  }

  if (normalizedToken.endsWith("ier") && normalizedToken.length > 3) {
    candidates.push(`${normalizedToken.slice(0, -3)}y`);
  }

  if (normalizedToken.endsWith("er") && normalizedToken.length > 2) {
    addExampleWordHintStemCandidates(candidates, normalizedToken.slice(0, -2));
  }

  return uniqueStrings(candidates.filter(Boolean));
}

function findWordByExampleToken(token) {
  const candidates = getExampleWordHintCandidates(token);

  for (const candidate of candidates) {
    const matchedWord = state.words.find((word) => normalizeText(word.term) === candidate);

    if (matchedWord) {
      return matchedWord;
    }
  }

  return null;
}

function openExampleWordHint(token, anchorElement) {
  const matchedWord = findWordByExampleToken(token);

  if (!matchedWord || !(anchorElement instanceof HTMLElement)) {
    return;
  }

  const rect = anchorElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || EXAMPLE_WORD_HINT_CARD_WIDTH_PX;
  const cardWidth = Math.min(EXAMPLE_WORD_HINT_CARD_WIDTH_PX, viewportWidth - EXAMPLE_WORD_HINT_VIEWPORT_MARGIN_PX * 2);
  const anchorCenterX = rect.left + rect.width / 2;
  const cardLeft = Math.min(
    Math.max(EXAMPLE_WORD_HINT_VIEWPORT_MARGIN_PX, anchorCenterX - cardWidth / 2),
    viewportWidth - EXAMPLE_WORD_HINT_VIEWPORT_MARGIN_PX - cardWidth,
  );
  const cardAnchorTop = Math.max(
    EXAMPLE_WORD_HINT_MIN_ANCHOR_TOP_PX,
    rect.top - EXAMPLE_WORD_HINT_VERTICAL_OFFSET_PX,
  );
  const arrowLeft = Math.min(
    Math.max(EXAMPLE_WORD_HINT_ARROW_EDGE_PADDING_PX, anchorCenterX - cardLeft),
    cardWidth - EXAMPLE_WORD_HINT_ARROW_EDGE_PADDING_PX,
  );

  state.exampleWordHint = {
    id: matchedWord.id,
    term: matchedWord.term,
    phonetics: [...(matchedWord.phonetics || [])],
    meaning: matchedWord.meaning,
    hasWordAudio: Boolean(matchedWord.hasWordAudio),
    cardLeft,
    cardAnchorTop,
    cardWidth,
    arrowLeft,
  };
  render();
}

function closeExampleWordHint() {
  if (!state.exampleWordHint) {
    return;
  }

  state.exampleWordHint = null;
  render();
}

function shouldDismissExampleWordHint(target) {
  return Boolean(
    state.exampleWordHint &&
      target instanceof Element &&
      target.closest('[data-action="dismiss-example-word-hint"]') &&
      !target.closest("[data-word-hint-card]"),
  );
}

function renderExampleWordHint() {
  if (!state.exampleWordHint || state.view !== VIEWS.words) {
    return "";
  }

  return `
    <div class="word-hint-overlay" data-action="dismiss-example-word-hint">
      <div
        class="word-hint-card"
        data-word-hint-card
        role="dialog"
        aria-modal="true"
        aria-label="单词提示"
        style="left:${state.exampleWordHint.cardLeft}px;top:${state.exampleWordHint.cardAnchorTop}px;width:${state.exampleWordHint.cardWidth}px;--word-hint-arrow-left:${state.exampleWordHint.arrowLeft}px;"
      >
        <div class="word-hint-card__header">
          <div class="word-hint-card__title-block">
            <strong class="word-hint-card__term">${escapeHtml(state.exampleWordHint.term)}</strong>
            <p class="word-hint-card__phonetic">${escapeHtml(formatWordHintPhonetics(state.exampleWordHint))}</p>
          </div>
          <button
            type="button"
            class="icon-button icon-button--audio"
            data-action="play-word-audio"
            data-word-id="${escapeHtml(state.exampleWordHint.id)}"
            aria-label="播放单词音频"
            ${state.exampleWordHint.hasWordAudio ? "" : "disabled"}
          >
            <span class="audio-icon" aria-hidden="true"></span>
          </button>
        </div>
        <p class="word-hint-card__meaning">${escapeHtml(state.exampleWordHint.meaning || "暂无释义")}</p>
      </div>
    </div>
  `;
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

async function runPassiveAction(task) {
  try {
    return await task();
  } catch (error) {
    console.error(error);
    setNotice(error instanceof Error ? error.message : "操作失败。", "error");
    return null;
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

function compareWordsByTerm(left, right) {
  const byTerm = ENGLISH_TERM_COLLATOR.compare(left?.term || "", right?.term || "");

  if (byTerm !== 0) {
    return byTerm;
  }

  return (right?.updatedAt || 0) - (left?.updatedAt || 0);
}

function sortWordsForDisplay(words, sortMode = DEFAULT_WORD_SORT_MODE) {
  const items = [...words];

  switch (sortMode) {
    case "term-desc":
      return items.sort((left, right) => compareWordsByTerm(right, left));
    case "updated-desc":
      return items.sort((left, right) => {
        const updatedDelta = (right?.updatedAt || 0) - (left?.updatedAt || 0);

        if (updatedDelta !== 0) {
          return updatedDelta;
        }

        return compareWordsByTerm(left, right);
      });
    case DEFAULT_WORD_SORT_MODE:
    default:
      return items.sort(compareWordsByTerm);
  }
}

function getCategoriesById() {
  return new Map(state.categories.map((category) => [category.id, category]));
}

function getWordsById() {
  return new Map(state.words.map((word) => [word.id, word]));
}

function getFilteredWords() {
  return sortWordsForDisplay(filterWords(state.words, state.filters), state.filters.sortMode || DEFAULT_WORD_SORT_MODE);
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

function getPracticeSourceInfo(selectedCategoryIds = [], pageSpec = "", options = {}) {
  const words = sortWordsForDisplay(
    filterWords(state.words, {
      query: "",
      categoryIds: selectedCategoryIds,
      favoritesOnly: Boolean(options.favoritesOnly),
    }),
    state.filters.sortMode || DEFAULT_WORD_SORT_MODE,
  );
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

function scrollToWordEditorStart() {
  window.requestAnimationFrame(() => {
    const anchor = document.querySelector("[data-word-editor-scroll-anchor]");

    if (!(anchor instanceof HTMLElement)) {
      return;
    }

    anchor.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}

function scrollToCategoryEditorStart() {
  window.requestAnimationFrame(() => {
    const anchor = document.querySelector("[data-category-editor-scroll-anchor]");

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

  const role = state.notice.type === "error" ? "alert" : "status";
  const live = state.notice.type === "error" ? "assertive" : "polite";

  return `
    <div class="notice-layer" aria-live="${live}">
      <div class="notice notice--${state.notice.type}" role="${role}">
        <div class="notice__body">
          <p class="notice__text">${escapeHtml(state.notice.text)}</p>
        </div>
        <button type="button" class="ghost-button ghost-button--tiny notice__close" data-action="dismiss-notice">关闭</button>
      </div>
    </div>
  `;
}

function renderBackToTopButton() {
  return `
    <button
      type="button"
      class="icon-button scroll-top-button"
      data-action="scroll-to-top"
      aria-label="回到顶部"
      title="回到顶部"
    >
      <span class="scroll-top-button__icon" aria-hidden="true">⌅</span>
    </button>
  `;
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
        { favoritesOnly: state.practiceConfig.favoritesOnly },
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
        isFilterOpen: state.wordFilterDisclosureOpen,
        draft: state.wordDraft,
        isEditorOpen: state.wordEditorExpanded || Boolean(state.wordDraft.id),
        busy: state.busy,
        audioAccept: AUDIO_ACCEPT,
      });
  }
}

function onToggle(event) {
  const target = event.target;

  if (!(target instanceof HTMLDetailsElement)) {
    return;
  }

  if (target.dataset.ui === "word-editor-disclosure") {
    state.wordEditorExpanded = target.open;
    return;
  }

  if (target.dataset.ui === "word-filter-disclosure") {
    state.wordFilterDisclosureOpen = target.open;
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
    ${renderBackToTopButton()}
    ${renderExampleWordHint()}
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

function onPointerDown(event) {
  if (!shouldDismissExampleWordHint(event.target)) {
    return;
  }

  event.preventDefault();
  closeExampleWordHint();
}

function onScroll() {
  if (!state.exampleWordHint) {
    return;
  }

  closeExampleWordHint();
}

async function startPracticeSession(selectedCategoryIds, limit, pageSpec = "", favoritesOnly = false) {
  const sourceInfo = getPracticeSourceInfo(selectedCategoryIds, pageSpec, { favoritesOnly });
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
    favoritesOnly,
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

function formatLibraryImportSummary(summary, options = {}) {
  const audioSummary =
    summary.importedAudio || summary.updatedAudio || summary.skippedAudio
      ? `，新增 ${summary.importedAudio} 个音频，更新 ${summary.updatedAudio} 个音频，跳过 ${summary.skippedAudio} 个音频`
      : "";

  if (options.importMode === "replace") {
    return `已清空本地数据并导入词库：新增 ${summary.createdWords} 个单词，新增 ${summary.createdCategories} 个分类${audioSummary}。`;
  }

  if (summary.duplicateMode === "merge") {
    return `词库导入完成：新增 ${summary.createdWords} 个单词，合并 ${summary.updatedWords} 个同名单词，跳过 ${summary.skippedWords} 个完全一致的重复单词，新增 ${summary.createdCategories} 个分类${audioSummary}。`;
  }

  return `词库导入完成：新增 ${summary.createdWords} 个单词，跳过 ${summary.skippedWords} 个重复单词，新增 ${summary.createdCategories} 个分类${audioSummary}。`;
}

async function previewImportFile(file) {
  if (!file) {
    state.importPreviews.library = null;
    render();
    return;
  }

  state.busy = true;
  render();

  try {
    const summary = await inspectLibraryImportFile(file);

    if (summary.requiresZipForAudio) {
      state.importPreviews.library = createImportPreview(file, summary, {
        status: "error",
        message: "纯 JSON 词库中检测到音频引用。若要一起导入单词或例句音频，请改用 ZIP 词库包，并包含 library.json 与 audio 目录。",
      });
      return;
    }

    state.importPreviews.library = createImportPreview(file, summary);
  } catch (error) {
    state.importPreviews.library = createImportPreview(file, {}, {
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
  const draft = readWordDraftFromForm(form);
  const selectedWordAudio = formData.get("wordAudioFile");
  const wordAudioFile = selectedWordAudio instanceof File && selectedWordAudio.size > 0
    ? selectedWordAudio
    : draft.wordAudioFile;
  const exampleAudioFiles = formData.getAll("exampleAudioFile");
  let wordAudioChange = { mode: "keep" };

  if (wordAudioFile instanceof File && wordAudioFile.size > 0) {
    validateAudioFile(wordAudioFile);
    wordAudioChange = { mode: "replace", file: wordAudioFile };
  } else if (draft.removeWordAudio) {
    wordAudioChange = { mode: "remove" };
  }

  const exampleAudios = {};

  for (const [index, example] of draft.examples.entries()) {
    const selectedExampleAudio = exampleAudioFiles[index];
    const exampleAudioFile = selectedExampleAudio instanceof File && selectedExampleAudio.size > 0
      ? selectedExampleAudio
      : example.audioFile;

    if (exampleAudioFile instanceof File && exampleAudioFile.size > 0) {
      validateAudioFile(exampleAudioFile);
      exampleAudios[example.id] = { mode: "replace", file: exampleAudioFile };
      continue;
    }

    if (example.removeAudio) {
      exampleAudios[example.id] = { mode: "remove" };
    }
  }

  await saveWord(
    {
      id: draft.id,
      term: draft.term,
      phonetics: draft.phonetics,
      meaning: draft.meaning,
      isFavorite: draft.isFavorite,
      examples: draft.examples.map((example) => ({
        id: example.id,
        en: example.en,
        zh: example.zh,
      })),
      categoryIds: draft.categoryIds,
    },
    {
      wordAudio: wordAudioChange,
      exampleAudios,
    },
  );

  state.wordDraft = createEmptyWordDraft();
  await refreshData();
}

async function handleCategorySubmit(form) {
  const formData = new FormData(form);

  await saveCategory({
    id: String(formData.get("id") || ""),
    name: formData.get("name"),
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
    favoritesOnly: formData.get("favoritesOnly") === "on",
    sortMode: String(formData.get("sortMode") || DEFAULT_WORD_SORT_MODE),
  };
  state.wordFilterDisclosureOpen = false;
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
  const favoritesOnly = formData.get("favoritesOnly") === "on";
  const nextPracticeConfig = {
    categoryIds: selectedCategoryIds,
    limit: Math.max(1, Math.min(50, Number.isFinite(limit) ? limit : 10)),
    pageSpec,
    favoritesOnly,
  };

  await startPracticeSession(
    nextPracticeConfig.categoryIds,
    nextPracticeConfig.limit,
    nextPracticeConfig.pageSpec,
    nextPracticeConfig.favoritesOnly,
  );
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

async function handleImportLibrary(form) {
  const formData = new FormData(form);
  const rawFile = formData.get("libraryFile");
  const importMode = String(formData.get("importMode") || "merge");
  const duplicateMode = String(formData.get("duplicateMode") || "skip");
  const preview = state.importPreviews.library;
  const file = rawFile instanceof File && rawFile.size > 0 ? rawFile : preview?.file;

  if (!(file instanceof File) || file.size === 0) {
    throw new Error("请选择一个 JSON 文件或 ZIP 词库包。");
  }

  if (preview?.status === "error" && matchesPreviewFile(preview, file)) {
    throw new Error(preview.message || "词库文件预检失败。");
  }

  const inspection = preview?.status === "ready" && matchesPreviewFile(preview, file)
    ? preview
    : await inspectLibraryImportFile(file);
  const confirmed = window.confirm(
    importMode === "replace"
      ? `将先清空当前本地单词、分类、音频和练习记录，再从${inspection.format === "zip" ? " ZIP 词库包" : " JSON 词库"}导入 ${inspection.words} 个单词、${inspection.examples} 条例句和 ${inspection.categories} 个分类${inspection.audioRefs ? `，并引用 ${inspection.audioRefs} 个音频文件` : ""}。\n该操作不可恢复，是否继续？`
      : `将从${inspection.format === "zip" ? " ZIP 词库包" : " JSON 词库"}导入 ${inspection.words} 个单词、${inspection.examples} 条例句和 ${inspection.categories} 个分类${inspection.audioRefs ? `，并引用 ${inspection.audioRefs} 个音频文件` : ""}。\n重复单词策略：${duplicateMode === "merge" ? "合并同名单词" : "跳过同名单词"}。\n是否继续？`,
  );

  if (!confirmed) {
    return null;
  }

  if (importMode === "replace") {
    await clearAllData();
    resetPracticeSession();
  }

  const summary = await importLibraryFromFile(file, {
    duplicateMode: importMode === "replace" ? "merge" : duplicateMode,
  });
  state.wordDraft = createEmptyWordDraft();
  state.categoryDraft = createEmptyCategoryDraft();
  state.view = VIEWS.words;
  state.importPreviews.library = null;
  await refreshData();
  return formatLibraryImportSummary(summary, { importMode });
}

async function onChange(event) {
  const target = event.target;

  if (!(target instanceof HTMLInputElement) || target.type !== "file") {
    return;
  }

  if (target.name === "libraryFile") {
    await previewImportFile(target.files?.[0] ?? null);
    return;
  }

  if (target.name === "wordAudioFile") {
    state.wordDraft.wordAudioFile = target.files?.[0] ?? null;
    state.wordDraft.removeWordAudio = false;
    return;
  }

  if (target.name === "exampleAudioFile") {
    const exampleId = String(target.dataset.exampleId || "");

    state.wordDraft.examples = state.wordDraft.examples.map((example) => {
      if (example.id !== exampleId) {
        return example;
      }

      return {
        ...example,
        audioFile: target.files?.[0] ?? null,
        removeAudio: false,
      };
    });
  }
}

async function handlePlayWordAudio(wordId) {
  const record = await getWordAudioRecord(wordId);

  if (!record?.blob) {
    throw new Error("当前单词还没有音频。");
  }

  await playAudioBlob(record.blob);
}

async function handlePlayExampleAudio(exampleId) {
  const record = await getExampleAudioRecord(exampleId);

  if (!record?.blob) {
    throw new Error("当前例句还没有音频。");
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
        phonetics: demoWord.phonetics,
        meaning: demoWord.meaning,
        examples: demoWord.examples,
        categoryIds: demoWord.categoryKeys.map((key) => categoryIdByKey.get(key)).filter(Boolean),
      },
      { wordAudio: { mode: "keep" }, exampleAudios: {} },
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
    phonetics: word.phonetics?.length ? [...word.phonetics] : [""],
    meaning: word.meaning,
    examples: word.examples?.length
      ? word.examples.map((example) => ({
          id: example.id,
          en: example.en,
          zh: example.zh,
          hasAudio: word.exampleAudioIds?.includes(example.id),
          removeAudio: false,
          audioFile: null,
        }))
      : [createEmptyExampleDraft()],
    categoryIds: [...(word.categoryIds || [])],
    isFavorite: Boolean(word.isFavorite),
    hasWordAudio: Boolean(word.hasWordAudio),
    removeWordAudio: false,
    wordAudioFile: null,
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
      case "import-library":
        return handleImportLibrary(form);
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
  const exampleWordToken = event.target.closest("[data-example-word-token]");

  if (exampleWordToken instanceof HTMLElement) {
    const token = String(exampleWordToken.dataset.exampleWordToken || "").trim();

    if (token) {
      openExampleWordHint(token, exampleWordToken);
      return;
    }
  }

  const trigger = event.target.closest("[data-action]");

  if (!trigger) {
    return;
  }

  const { action } = trigger.dataset;

  switch (action) {
    case "switch-view":
      closeExampleWordHint();
      state.view = trigger.dataset.view || VIEWS.words;
      render();
      return;
    case "scroll-to-top":
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    case "dismiss-notice":
      clearNotice();
      return;
    case "dismiss-example-word-hint":
      if (!shouldDismissExampleWordHint(event.target)) {
        return;
      }

      closeExampleWordHint();
      return;
    case "add-phonetic": {
      const form = trigger.closest("form");

      if (!form) {
        return;
      }

      syncWordDraftFromForm(form);
      state.wordDraft.phonetics = [...state.wordDraft.phonetics, ""];
      render();
      return;
    }
    case "remove-phonetic": {
      const form = trigger.closest("form");
      const index = Number(trigger.dataset.index || "-1");

      if (!form || index < 0) {
        return;
      }

      syncWordDraftFromForm(form);
      state.wordDraft.phonetics = state.wordDraft.phonetics.filter((_, currentIndex) => currentIndex !== index);
      state.wordDraft.phonetics = normalizeDraftPhonetics(state.wordDraft.phonetics);
      render();
      return;
    }
    case "add-example": {
      const form = trigger.closest("form");

      if (!form) {
        return;
      }

      syncWordDraftFromForm(form);
      state.wordDraft.examples = [...state.wordDraft.examples, createEmptyExampleDraft()];
      render();
      return;
    }
    case "remove-example": {
      const form = trigger.closest("form");
      const exampleId = String(trigger.dataset.exampleId || "");

      if (!form || !exampleId) {
        return;
      }

      syncWordDraftFromForm(form);
      state.wordDraft.examples = normalizeDraftExamples(
        state.wordDraft.examples.filter((example) => example.id !== exampleId),
      );
      render();
      return;
    }
    case "reset-word-draft":
      state.wordDraft = createEmptyWordDraft();
      render();
      return;
    case "collapse-word-editor": {
      const form = trigger.closest("form");

      if (form) {
        syncWordDraftFromForm(form);
      }

      state.wordEditorExpanded = false;
      render();
      return;
    }
    case "cancel-word-edit":
      state.wordDraft = createEmptyWordDraft();
      state.wordEditorExpanded = false;
      render();
      return;
    case "reset-category-draft":
      state.categoryDraft = createEmptyCategoryDraft();
      render();
      return;
    case "reset-word-filters":
      state.filters = { query: "", categoryIds: [], favoritesOnly: false, sortMode: DEFAULT_WORD_SORT_MODE };
      state.wordFilterDisclosureOpen = false;
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
      state.wordEditorExpanded = true;
      render();
      scrollToWordEditorStart();
      return;
    case "toggle-word-favorite":
      await runAction(async () => {
        const nextFavorite = trigger.dataset.nextFavorite === "true";

        await setWordFavorite(trigger.dataset.wordId, nextFavorite);

        if (state.wordDraft.id === trigger.dataset.wordId) {
          state.wordDraft = {
            ...state.wordDraft,
            isFavorite: nextFavorite,
          };
        }

        await refreshData();
      });
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
      await runPassiveAction(async () => {
        await handlePlayWordAudio(trigger.dataset.wordId);
      });
      return;
    case "play-example-audio":
      await runPassiveAction(async () => {
        await handlePlayExampleAudio(trigger.dataset.exampleId);
      });
      return;
    case "edit-category":
      populateCategoryDraft(trigger.dataset.categoryId);
      render();
      scrollToCategoryEditorStart();
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
    case "download-library-template":
      await runAction(async () => {
        const libraryTemplate = createLibraryTemplate();
        createDownload("english-learning-library-template.json", libraryTemplate, "application/json;charset=utf-8");
      }, "JSON 词库模板已生成。");
      return;
    case "export-library-package":
      await runAction(async () => {
        const libraryPackageZip = await createLibraryPackageZipBlob();
        const filename = `english-learning-library-${new Date().toISOString().slice(0, 10)}.zip`;
        createDownload(filename, libraryPackageZip, "application/zip");
      }, "JSON 词库 ZIP 已生成。");
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
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => {
    if (!syncWordListPageSize()) {
      return;
    }

    render();
  });

  appRoot.addEventListener("submit", onSubmit);
  appRoot.addEventListener("pointerdown", onPointerDown);
  appRoot.addEventListener("click", onClick);
  appRoot.addEventListener("change", onChange);
  appRoot.addEventListener("toggle", onToggle, true);

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