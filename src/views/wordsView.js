import { AUDIO_ACCEPT } from "../services/audioService.js";
import { escapeHtml, formatDateTime } from "../services/helpers.js";

function renderCategorySelector(categories, selectedIds, fieldName, options = {}) {
  const variant = options.variant || "default";
  const showGroup = options.showGroup !== false;

  if (!categories.length) {
    return '<p class="empty-inline">还没有分类，先去“分类”页创建几个类别。</p>';
  }

  return `
    <div class="selector-grid ${variant === "compact" ? "selector-grid--compact" : ""}">
      ${categories
        .map(
          (category) => `
            <label class="check-chip ${variant === "compact" ? "check-chip--compact" : ""}">
              <input
                type="checkbox"
                name="${fieldName}"
                value="${escapeHtml(category.id)}"
                ${selectedIds.includes(category.id) ? "checked" : ""}
              />
              <span>${escapeHtml(category.name)}</span>
              ${showGroup ? `<small>${escapeHtml(category.group || "未分组")}</small>` : ""}
            </label>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderCategoryBadges(word, categoriesById) {
  const names = (word.categoryIds || [])
    .map((categoryId) => categoriesById.get(categoryId)?.name)
    .filter(Boolean);

  if (!names.length) {
    return '<span class="tag tag-muted">未分类</span>';
  }

  return names.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("");
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
        .map(
          (word) => {
            const audioMeta = [
              word.hasAudio ? "含发音音频" : "",
              word.hasExampleAudio ? "含例句音频" : "",
            ]
              .filter(Boolean)
              .join(" · ");

            return `
            <article class="item-card">
              <div class="item-card__header">
                <div class="item-card__title">
                  <div class="item-card__term-line">
                    <h3>${escapeHtml(word.term)}</h3>
                    ${word.phonetic ? `<span class="item-card__phonetic">${escapeHtml(word.phonetic)}</span>` : ""}
                  </div>
                  <p class="item-card__meaning">${escapeHtml(word.meaning)}</p>
                </div>
                <div class="inline-actions inline-actions--word-card">
                  <button type="button" class="ghost-button" data-action="edit-word" data-word-id="${escapeHtml(word.id)}">编辑</button>
                  <button type="button" class="ghost-button" data-action="delete-word" data-word-id="${escapeHtml(word.id)}">删除</button>
                  <button type="button" class="ghost-button" data-action="play-word-audio" data-word-id="${escapeHtml(word.id)}" ${word.hasAudio ? "" : "disabled"}>播放</button>
                </div>
              </div>
              <div class="tag-row">${renderCategoryBadges(word, categoriesById)}</div>
              ${word.example ? `<p class="supporting-text">例句：${escapeHtml(word.example)}</p>` : ""}
              ${word.notes ? `<p class="supporting-text">备注：${escapeHtml(word.notes)}</p>` : ""}
              <p class="tiny-meta">更新于 ${formatDateTime(word.updatedAt)}${audioMeta ? ` · ${audioMeta}` : ""}</p>
            </article>
          `;
          },
        )
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

export function renderWordsView({ words, pagination, categories, categoriesById, filters, draft, busy }) {
  const title = draft.id ? "编辑单词" : "添加陌生单词";
  const submitLabel = draft.id ? "保存修改" : "添加单词";
  const shouldOpenEditor = Boolean(draft.id);
  const selectedFilterCount = (filters.categoryIds || []).length;

  return `
    <section class="view-stack">
      <div class="section-grid section-grid--wide">
        <section class="panel">
          <details class="disclosure-panel" ${shouldOpenEditor ? "open" : ""}>
            <summary class="disclosure-toggle">
              <div>
                <p class="eyebrow">Words</p>
                <h2>${title}</h2>
                <p class="tiny-meta">${draft.id ? "正在编辑已有词条" : "点击后展开录入单词、分类和音频。"}</p>
              </div>
              <span class="counter-pill">${draft.id ? "编辑中" : "展开"}</span>
            </summary>
            <div class="disclosure-panel__body">
              <div class="form-actions form-actions--toolbar">
                <button type="button" class="ghost-button" data-action="reset-word-draft">清空表单</button>
              </div>
              <form data-form="word-editor" class="form-stack">
                <input type="hidden" name="id" value="${escapeHtml(draft.id || "")}" />
                <div class="form-grid">
                  <label class="field">
                    <span>单词</span>
                    <input name="term" value="${escapeHtml(draft.term || "")}" required maxlength="120" />
                  </label>
                  <label class="field">
                    <span>音标</span>
                    <input name="phonetic" value="${escapeHtml(draft.phonetic || "")}" maxlength="120" placeholder="如 /əˈnæləsɪs/" />
                  </label>
                </div>
                <label class="field">
                  <span>释义</span>
                  <input name="meaning" value="${escapeHtml(draft.meaning || "")}" required maxlength="200" />
                </label>
                <label class="field">
                  <span>例句</span>
                  <textarea name="example" rows="3" maxlength="300">${escapeHtml(draft.example || "")}</textarea>
                </label>
                <label class="field">
                  <span>备注</span>
                  <textarea name="notes" rows="3" maxlength="300">${escapeHtml(draft.notes || "")}</textarea>
                </label>
                <div class="field">
                  <div class="field-title">
                    <span>分类</span>
                    <small>同一个单词可同时属于多个类别</small>
                  </div>
                  ${renderCategorySelector(categories, draft.categoryIds || [], "categoryId")}
                </div>
                <div class="form-grid form-grid--audio">
                  <label class="field">
                    <span>发音音频文件</span>
                    <input type="file" name="audioFile" accept="${AUDIO_ACCEPT}" />
                  </label>
                  <label class="inline-check ${draft.hasAudio ? "" : "inline-check--muted"}">
                    <input type="checkbox" name="removeAudio" ${draft.hasAudio ? "" : "disabled"} />
                    <span>${draft.hasAudio ? "移除当前发音音频" : "当前没有发音音频"}</span>
                  </label>
                </div>
                <div class="form-actions">
                  <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>${submitLabel}</button>
                  <p class="help-text">支持手动上传单词发音，留空表示不替换已有音频。例句音频的数据位与导入导出格式已预留${draft.hasExampleAudio ? "，当前词条已含例句音频。" : "。"}</p>
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
              <input name="query" value="${escapeHtml(filters.query || "")}" placeholder="搜索单词、音标、释义、备注" />
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
                ${renderCategorySelector(categories, filters.categoryIds || [], "filterCategoryId", { variant: "compact", showGroup: false })}
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