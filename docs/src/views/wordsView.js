import { AUDIO_ACCEPT } from "../services/audioService.js";
import { escapeHtml } from "../services/helpers.js";

function renderCategorySelector(categories, selectedIds, fieldName, options = {}) {
  const variant = options.variant || "default";

  if (!categories.length) {
    return '<p class="empty-inline">还没有分类，先去“分类”页创建几个类别。</p>';
  }

  return `
    <div class="selector-grid ${variant === "compact" ? "selector-grid--compact" : ""}">
      ${categories
        .map(
          (category) => `
            <label class="check-chip check-chip--inline ${variant === "compact" ? "check-chip--compact" : ""}">
              <input
                type="checkbox"
                name="${fieldName}"
                value="${escapeHtml(category.id)}"
                ${selectedIds.includes(category.id) ? "checked" : ""}
              />
              <div class="check-chip__content check-chip__content--single-line">
                <span>${escapeHtml(category.name)}</span>
              </div>
            </label>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderCategoryBadges(word, categoriesById) {
  const names = (word.categoryIds || [])
    .map((categoryId) => categoriesById.get(categoryId))
    .filter(Boolean)
    .map((category) => category.name);

  if (!names.length) {
    return '<span class="tag tag-muted">未分类</span>';
  }

  return names.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("");
}

function renderPhoneticText(phonetics) {
  if (!phonetics?.length) {
    return "无音标";
  }

  return phonetics.map((phonetic) => escapeHtml(phonetic)).join("，");
}

function renderExamplePreview(example, canPlay) {
  return `
    <div class="example-preview-item">
      <div class="example-preview-item__english-row">
        <p class="supporting-text">${escapeHtml(example.en)}</p>
        ${
          canPlay
            ? `
                <button
                  type="button"
                  class="icon-button icon-button--audio example-preview-item__play-button"
                  data-action="play-example-audio"
                  data-example-id="${escapeHtml(example.id)}"
                  aria-label="播放例句音频"
                >
                  <span class="audio-icon" aria-hidden="true"></span>
                </button>
              `
            : ""
        }
      </div>
      <p class="supporting-text example-preview-item__translation">${escapeHtml(example.zh)}</p>
    </div>
  `;
}

function renderWordCards(words, categoriesById, categories, busy) {
  if (!words.length) {
    return `
      <div class="empty-state">
        <h3>还没有匹配的单词</h3>
        <p>可以手动添加第一个单词，也可以先加载示例数据快速体验。</p>
        <div class="form-actions">
          <button type="button" class="primary-button" data-action="load-demo-data" ${busy ? "disabled" : ""}>加载示例数据</button>
          ${
            categories.length
              ? ""
              : '<button type="button" class="ghost-button" data-action="switch-view" data-view="categories">先创建分类</button>'
          }
        </div>
      </div>
    `;
  }

  return `
    <div class="card-list">
      <div class="word-list-scroll-anchor" data-word-list-scroll-anchor></div>
      ${words
        .map((word) => {
          const visibleExamples = (word.examples || []).slice(0, 2);
          const remainingExamples = Math.max((word.examples || []).length - visibleExamples.length, 0);

          return `
            <div class="word-card-swipe">
              <div class="word-card-swipe__track">
                <article class="item-card item-card--word">
                  <div class="item-card__header item-card__header--word">
                    <div class="item-card__title">
                      <div class="item-card__term-row ${word.hasWordAudio ? "" : "item-card__term-row--single"}">
                        <div class="item-card__term-line">
                          <h3>${escapeHtml(word.term)}</h3>
                          <p class="item-card__phonetic">${renderPhoneticText(word.phonetics || [])}</p>
                        </div>
                        ${
                          word.hasWordAudio
                            ? `
                                <button
                                  type="button"
                                  class="icon-button icon-button--audio item-card__play-button"
                                  data-action="play-word-audio"
                                  data-word-id="${escapeHtml(word.id)}"
                                  aria-label="播放单词音频"
                                >
                                  <span class="audio-icon" aria-hidden="true"></span>
                                </button>
                              `
                            : ""
                        }
                      </div>
                      <p class="item-card__meaning">${escapeHtml(word.meaning)}</p>
                    </div>
                  </div>
                  <div class="tag-row">${renderCategoryBadges(word, categoriesById)}</div>
                  ${(word.examples || []).length ? `<div class="example-preview-list">${visibleExamples.map((example) => renderExamplePreview(example, word.exampleAudioIds?.includes(example.id))).join("")}</div>` : ""}
                  ${remainingExamples ? `<p class="tiny-meta">还有 ${remainingExamples} 条例句未展开显示</p>` : ""}
                </article>
                <div class="word-card-swipe__actions" aria-label="单词操作">
                  <button type="button" class="ghost-button" data-action="edit-word" data-word-id="${escapeHtml(word.id)}">编辑</button>
                  <button type="button" class="ghost-button" data-action="delete-word" data-word-id="${escapeHtml(word.id)}">删除</button>
                </div>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderWordPagination(pagination, busy) {
  if (!pagination || pagination.totalItems === 0) {
    return "";
  }

  const summary = `显示 ${pagination.startIndex}-${pagination.endIndex} / ${pagination.totalItems} 条，每页 ${pagination.pageSize} 条`;

  if (pagination.totalPages <= 1) {
    return `<div class="pagination-block"><p class="tiny-meta">${escapeHtml(summary)}</p></div>`;
  }

  return `
    <div class="pagination-block">
      <div class="pagination-block__meta">
        <p class="tiny-meta">${escapeHtml(summary)}</p>
        <span class="counter-pill">第 ${pagination.currentPage} / ${pagination.totalPages} 页</span>
      </div>
      <div class="pagination-actions">
        <button type="button" class="ghost-button" data-action="set-word-page" data-page="1" ${busy || !pagination.hasPrevious ? "disabled" : ""}>首页</button>
        <button type="button" class="ghost-button" data-action="set-word-page" data-page="${pagination.currentPage - 1}" ${busy || !pagination.hasPrevious ? "disabled" : ""}>上一页</button>
        <button type="button" class="ghost-button" data-action="set-word-page" data-page="${pagination.currentPage + 1}" ${busy || !pagination.hasNext ? "disabled" : ""}>下一页</button>
        <button type="button" class="ghost-button" data-action="set-word-page" data-page="${pagination.totalPages}" ${busy || !pagination.hasNext ? "disabled" : ""}>末页</button>
      </div>
      <form data-form="word-pagination-jump" class="pagination-jump">
        <label class="field field--inline-control pagination-jump__field">
          <span>跳至页码</span>
          <input name="page" type="number" min="1" max="${pagination.totalPages}" value="${pagination.currentPage}" inputmode="numeric" ${busy ? "disabled" : ""} />
        </label>
        <button type="submit" class="ghost-button" ${busy ? "disabled" : ""}>前往</button>
      </form>
    </div>
  `;
}

function renderPhoneticEditorRows(phonetics, busy) {
  return `
    <div class="dynamic-list">
      ${phonetics
        .map(
          (phonetic, index) => `
            <div class="inline-input-row">
              <input name="phoneticValue" value="${escapeHtml(phonetic)}" maxlength="120" placeholder="如 /əˈnæləsɪs/" />
              <button type="button" class="ghost-button" data-action="remove-phonetic" data-index="${index}" ${busy ? "disabled" : ""}>删除</button>
            </div>
          `,
        )
        .join("")}
      <button type="button" class="ghost-button" data-action="add-phonetic" ${busy ? "disabled" : ""}>新增音标</button>
    </div>
  `;
}

function renderExampleEditorRows(draft, busy) {
  return `
    <div class="editor-section-list">
      ${draft.examples
        .map(
          (example, index) => `
            <section class="nested-editor-card">
              <input type="hidden" name="exampleId" value="${escapeHtml(example.id)}" />
              <div class="section-heading section-heading--inline-mobile">
                <div>
                  <p class="eyebrow">Example ${index + 1}</p>
                  <h3>例句 ${index + 1}</h3>
                </div>
                <div class="inline-actions">
                  <button type="button" class="ghost-button" data-action="remove-example" data-example-id="${escapeHtml(example.id)}" ${busy ? "disabled" : ""}>删除例句</button>
                  <button type="button" class="ghost-button" data-action="play-example-audio" data-example-id="${escapeHtml(example.id)}" ${example.hasAudio ? "" : "disabled"}>播放例句音频</button>
                </div>
              </div>
              <label class="field">
                <span>英文例句</span>
                <textarea name="exampleEn" rows="3" maxlength="400">${escapeHtml(example.en)}</textarea>
              </label>
              <label class="field">
                <span>中文翻译</span>
                <textarea name="exampleZh" rows="3" maxlength="240">${escapeHtml(example.zh)}</textarea>
              </label>
              <div class="form-grid form-grid--audio">
                <label class="field">
                  <span>例句音频文件</span>
                  <input type="file" name="exampleAudioFile" data-example-id="${escapeHtml(example.id)}" accept="${AUDIO_ACCEPT}" />
                </label>
                <label class="inline-check ${example.hasAudio ? "" : "inline-check--muted"}">
                  <input type="checkbox" name="removeExampleAudio" value="${escapeHtml(example.id)}" ${example.hasAudio ? "" : "disabled"} ${example.removeAudio ? "checked" : ""} />
                  <span>${example.hasAudio ? "移除当前例句音频" : "当前没有例句音频"}</span>
                </label>
              </div>
              ${example.audioFile ? `<p class="help-text">待上传：${escapeHtml(example.audioFile.name)}</p>` : example.hasAudio ? '<p class="help-text">当前已保存例句音频。</p>' : ""}
            </section>
          `,
        )
        .join("")}
      <button type="button" class="ghost-button" data-action="add-example" ${busy ? "disabled" : ""}>新增例句</button>
    </div>
  `;
}

export function renderWordsView({ words, pagination, categories, categoriesById, filters, draft, isEditorOpen, busy }) {
  const title = draft.id ? "编辑单词" : "添加陌生单词";
  const submitLabel = draft.id ? "保存修改" : "添加单词";
  const shouldOpenEditor = Boolean(isEditorOpen);
  const selectedFilterCount = (filters.categoryIds || []).length;
  const phonetics = draft.phonetics?.length ? draft.phonetics : [""];

  return `
    <section class="view-stack">
      <div class="section-grid section-grid--wide">
        <section class="panel">
          <details class="disclosure-panel" data-ui="word-editor-disclosure" ${shouldOpenEditor ? "open" : ""}>
            <summary class="disclosure-toggle">
              <div>
                <p class="eyebrow">Words</p>
                <h2>${title}</h2>
                <p class="tiny-meta">${draft.id ? "正在编辑已有词条" : "点击后展开录入单词、音标、例句和音频。"}</p>
              </div>
              <span class="counter-pill">${draft.id ? "编辑中" : "展开"}</span>
            </summary>
            <div class="disclosure-panel__body">
              <div class="form-actions form-actions--toolbar">
                <button type="button" class="ghost-button" data-action="reset-word-draft">清空表单</button>
              </div>
              <form data-form="word-editor" class="form-stack">
                <input type="hidden" name="id" value="${escapeHtml(draft.id || "")}" />
                <label class="field">
                  <span>单词</span>
                  <input name="term" value="${escapeHtml(draft.term || "")}" required maxlength="120" />
                </label>
                <div class="field">
                  <div class="field-title">
                    <span>音标</span>
                    <small>支持录入多个音标</small>
                  </div>
                  ${renderPhoneticEditorRows(phonetics, busy)}
                </div>
                <label class="field">
                  <span>释义</span>
                  <textarea name="meaning" rows="3" maxlength="300" required>${escapeHtml(draft.meaning || "")}</textarea>
                </label>
                <div class="form-grid form-grid--audio">
                  <label class="field">
                    <span>单词音频文件</span>
                    <input type="file" name="wordAudioFile" accept="${AUDIO_ACCEPT}" />
                  </label>
                  <label class="inline-check ${draft.hasWordAudio ? "" : "inline-check--muted"}">
                    <input type="checkbox" name="removeWordAudio" ${draft.hasWordAudio ? "" : "disabled"} ${draft.removeWordAudio ? "checked" : ""} />
                    <span>${draft.hasWordAudio ? "移除当前单词音频" : "当前没有单词音频"}</span>
                  </label>
                </div>
                ${draft.wordAudioFile ? `<p class="help-text">待上传：${escapeHtml(draft.wordAudioFile.name)}</p>` : draft.hasWordAudio ? '<p class="help-text">当前已保存单词音频。</p>' : ""}
                <div class="field">
                  <div class="field-title">
                    <span>例句</span>
                    <small>每条例句都需要英文和中文翻译，可单独上传例句音频</small>
                  </div>
                  ${renderExampleEditorRows(draft, busy)}
                </div>
                <div class="field">
                  <div class="field-title">
                    <span>分类</span>
                    <small>同一个单词可同时属于多个分类</small>
                  </div>
                  ${renderCategorySelector(categories, draft.categoryIds || [], "categoryId")}
                </div>
                <div class="form-actions">
                  <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>${submitLabel}</button>
                  <button type="button" class="ghost-button" data-action="play-word-audio" data-word-id="${escapeHtml(draft.id || "")}" ${draft.id && draft.hasWordAudio ? "" : "disabled"}>播放当前单词音频</button>
                </div>
              </form>
            </div>
          </details>
        </section>

        <section class="panel">
          <div class="section-heading section-heading--inline-mobile">
            <div>
              <p class="eyebrow">Browse</p>
              <h2>单词列表</h2>
            </div>
            <span class="counter-pill">${pagination?.totalItems || 0} 条结果</span>
          </div>
          <form data-form="word-filters" class="form-stack compact-form">
            <label class="field field--inline-control">
              <span>搜索</span>
              <input name="query" value="${escapeHtml(filters.query || "")}" placeholder="搜索单词、音标、释义、例句英文或中文翻译" />
            </label>
            <details class="disclosure-panel disclosure-panel--compact" ${selectedFilterCount ? "open" : ""}>
              <summary class="disclosure-toggle disclosure-toggle--compact">
                <div>
                  <span>分类筛选</span>
                  <small>${selectedFilterCount ? `已选 ${selectedFilterCount} 个分类` : "点击展开分类筛选"}</small>
                </div>
                <span class="counter-pill counter-pill--soft">并集</span>
              </summary>
              <div class="disclosure-panel__body disclosure-panel__body--compact">
                ${renderCategorySelector(categories, filters.categoryIds || [], "filterCategoryId", { variant: "compact" })}
              </div>
            </details>
            <div class="form-actions form-actions--inline-mobile">
              <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>应用筛选</button>
              <button type="button" class="ghost-button" data-action="reset-word-filters">重置筛选</button>
            </div>
          </form>
          ${renderWordPagination(pagination, busy)}
          ${renderWordCards(words, categoriesById, categories, busy)}
          ${renderWordPagination(pagination, busy)}
        </section>
      </div>
    </section>
  `;
}
