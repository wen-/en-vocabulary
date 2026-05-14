import { escapeHtml, renderAudioIcon } from "../services/helpers.js";

function renderPracticeExamples(word) {
  const examples = Array.isArray(word?.examples) ? word.examples : [];

  if (!examples.length) {
    return "";
  }

  return `
    <details class="disclosure-panel disclosure-panel--compact">
      <summary class="disclosure-toggle disclosure-toggle--compact">
        <div>
          <span>查看例句与翻译</span>
          <small>共 ${examples.length} 条</small>
        </div>
      </summary>
      <div class="disclosure-panel__body disclosure-panel__body--compact example-preview-list">
        ${examples
          .map(
            (example, index) => `
              <div class="example-pair">
                <div class="example-pair__header">
                  <strong>例句 ${index + 1}</strong>
                </div>
                <p class="supporting-text example-pair__english">
                  ${escapeHtml(example.en)}
                  ${
                    word.exampleAudioIds?.includes(example.id)
                      ? `
                          <button
                            type="button"
                            class="icon-button icon-button--audio inline-audio-button example-pair__play-button"
                            data-action="play-example-audio"
                            data-example-id="${escapeHtml(example.id)}"
                            aria-label="播放例句音频"
                          >
                            ${renderAudioIcon()}
                          </button>
                        `
                      : ""
                  }
                </p>
                <p class="supporting-text example-pair__translation">${escapeHtml(example.zh)}</p>
              </div>
            `,
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderCategorySelector(categories, selectedIds, fieldName) {
  if (!categories.length) {
    return '<p class="empty-inline">先创建分类，再按类别练习。</p>';
  }

  return `
    <div class="selector-grid selector-grid--practice">
      ${categories
        .map(
          (category) => `
            <label class="check-chip check-chip--inline">
              <input type="checkbox" name="${fieldName}" value="${escapeHtml(category.id)}" ${selectedIds.includes(category.id) ? "checked" : ""} />
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

function formatAttemptMeta(attempt, word, categoriesById) {
  const categoryNames = (attempt.selectedCategoryIds || [])
    .map((categoryId) => categoriesById.get(categoryId)?.name)
    .filter(Boolean);
  const metaParts = [];

  if (categoryNames.length) {
    metaParts.push(`分类：${categoryNames.join(" / ")}`);
  } else if (word?.categoryIds?.length) {
    const wordCategoryNames = word.categoryIds
      .map((categoryId) => categoriesById.get(categoryId)?.name)
      .filter(Boolean);

    if (wordCategoryNames.length) {
      metaParts.push(`所属分类：${wordCategoryNames.join(" / ")}`);
    }
  }

  if (attempt.selectedPages?.length) {
    metaParts.push(`页数：第 ${attempt.selectedPages.join("、")} 页`);
  }

  if (!metaParts.length) {
    return "";
  }

  return `<small class="tiny-meta">${escapeHtml(metaParts.join(" · "))}</small>`;
}

function renderRecentAttempts(attempts, wordsById, categoriesById, options = {}) {
  const showFavoriteActions = Boolean(options.showFavoriteActions);
  const busy = Boolean(options.busy);
  const orderedAttempts = [...attempts]
    .sort((left, right) => (right.attemptedAt || 0) - (left.attemptedAt || 0))
    .slice(0, 20)
    .sort((left, right) => {
      if (left.correct !== right.correct) {
        return Number(left.correct) - Number(right.correct);
      }

      return (right.attemptedAt || 0) - (left.attemptedAt || 0);
    });

  if (!attempts.length) {
    return '<p class="empty-inline">还没有练习记录。</p>';
  }

  return `
    <div class="history-list">
      ${orderedAttempts
        .map((attempt) => {
          const word = wordsById.get(attempt.wordId);
          const statusText = attempt.correct ? "正确" : `你的答案：${escapeHtml(attempt.answer || "空")}`;

          return `
            <div class="history-item ${attempt.correct ? "history-item--success" : "history-item--error"}">
              <div class="history-item__content">
                <strong>${escapeHtml(word?.term || attempt.expected || "未知单词")}</strong>
                ${formatAttemptMeta(attempt, word, categoriesById)}
                <span class="history-item__status">${statusText}</span>
              </div>
              ${
                showFavoriteActions && word?.id
                  ? `
                      <div class="history-item__aside">
                        <button
                          type="button"
                          class="icon-button icon-button--favorite ${word.isFavorite ? "icon-button--active" : ""}"
                          data-action="toggle-word-favorite"
                          data-word-id="${escapeHtml(word.id)}"
                          data-next-favorite="${word.isFavorite ? "false" : "true"}"
                          aria-label="${word.isFavorite ? "取消收藏" : "收藏单词"}"
                          aria-pressed="${word.isFavorite ? "true" : "false"}"
                          ${busy ? "disabled" : ""}
                        >
                          <span class="favorite-icon" aria-hidden="true">${word.isFavorite ? "&#9733;" : "&#9734;"}</span>
                        </button>
                      </div>
                    `
                  : ""
              }
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function formatSelectedPages(selectedPages) {
  if (!selectedPages?.length) {
    return "全部页";
  }

  return `第 ${selectedPages.join("、")} 页`;
}

function formatPracticeScope(practiceSession) {
  return practiceSession?.favoritesOnly ? "仅收藏单词" : "全部单词";
}

export function renderPracticeView({ categories, categoriesById, practiceConfig, practiceSession, practiceSourceInfo, currentWord, stats, recentAttempts, wordsById, busy }) {
  const hasSession = Boolean(practiceSession?.queueIds?.length);
  const answeredCurrent = Boolean(practiceSession?.currentResult);
  const isFinished = hasSession && practiceSession.currentIndex >= practiceSession.queueIds.length;
  const pageHint = practiceSourceInfo?.totalPages
    ? `当前条件下共 ${practiceSourceInfo.totalPages} 页，每页 ${practiceSourceInfo.pageSize} 条；留空表示从全部页抽题。`
    : "留空表示从全部页抽题；页码按当前设备的单词列表分页规则计算。";

  return `
    <section class="view-stack">
      <div class="section-grid section-grid--wide">
        <section class="panel">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Practice</p>
              <h2>拼写练习</h2>
            </div>
            <span class="counter-pill">累计正确率 ${stats.accuracy}%</span>
          </div>
          ${
            !hasSession || isFinished
              ? `
                <form data-form="practice-start" class="form-stack">
                  <div class="field">
                    <div class="field-title">
                      <span>选择练习分类</span>
                      <small>不选则默认从全部单词中抽取</small>
                    </div>
                    ${renderCategorySelector(categories, practiceConfig.categoryIds || [], "practiceCategoryId")}
                  </div>
                  <label class="inline-check ${practiceConfig.favoritesOnly ? "" : "inline-check--muted"}">
                    <input type="checkbox" name="favoritesOnly" ${practiceConfig.favoritesOnly ? "checked" : ""} />
                    <span>仅从已收藏单词中抽题</span>
                  </label>
                  <label class="field field--inline-control">
                    <span>题目数量</span>
                    <input name="limit" type="number" min="1" max="50" value="${escapeHtml(String(practiceConfig.limit || 10))}" />
                  </label>
                  <label class="field field--inline-control">
                    <span>练习页码</span>
                    <input name="pageSpec" value="${escapeHtml(practiceConfig.pageSpec || "")}" placeholder="如 1 或 1,3-5" />
                    <small>${escapeHtml(pageHint)}</small>
                  </label>
                  <div class="form-actions">
                    <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>开始练习</button>
                    ${
                      isFinished
                        ? `<button type="button" class="ghost-button" data-action="reset-practice-session">回到准备态</button>`
                        : ""
                    }
                  </div>
                </form>
                ${
                  isFinished
                    ? `
                      <div class="result-banner ${practiceSession.summary.accuracy >= 60 ? "result-banner--success" : "result-banner--warning"}">
                        <h3>本轮练习完成</h3>
                        <p>共 ${practiceSession.summary.total} 题，答对 ${practiceSession.summary.correct} 题，正确率 ${practiceSession.summary.accuracy}%</p>
                      </div>
                    `
                    : ""
                }
              `
              : `
                <div class="question-panel">
                  <div class="question-panel__meta">
                    <span>第 ${practiceSession.currentIndex + 1} / ${practiceSession.queueIds.length} 题，${escapeHtml(formatPracticeScope(practiceSession))}，${currentWord?.hasWordAudio ? "可播放" : "无音频"}，${escapeHtml(formatSelectedPages(practiceSession.selectedPages))}</span>
                  </div>
                  <div class="question-panel__prompt">
                    <h3>${escapeHtml(currentWord?.meaning || "请根据提示拼写单词")}</h3>
                    <button
                      type="button"
                      class="icon-button icon-button--audio"
                      data-action="play-practice-audio"
                      aria-label="播放"
                      ${currentWord?.hasWordAudio ? `data-word-id="${escapeHtml(currentWord.id)}"` : "disabled"}
                    >
                      ${renderAudioIcon()}
                    </button>
                  </div>
                  ${renderPracticeExamples(currentWord)}
                  ${
                    answeredCurrent
                      ? `
                        <div class="result-banner ${practiceSession.currentResult.correct ? "result-banner--success" : "result-banner--warning"}">
                          <h3>${practiceSession.currentResult.correct ? "回答正确" : "继续加油"}</h3>
                          <p>正确拼写：${escapeHtml(currentWord?.term || "")}</p>
                          <p>你的答案：${escapeHtml(practiceSession.currentResult.answer || "空")}</p>
                        </div>
                        <div class="form-actions">
                          <button type="button" class="primary-button" data-action="advance-practice">${practiceSession.currentIndex + 1 >= practiceSession.queueIds.length ? "查看结果" : "下一题"}</button>
                        </div>
                      `
                      : `
                        <form data-form="practice-answer" class="form-stack compact-form">
                          <label class="field">
                            <span>请输入拼写</span>
                            <input name="answer" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" lang="en" autofocus required />
                          </label>
                          <div class="form-actions form-actions--inline-mobile">
                            <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>提交答案</button>
                            <button type="button" class="ghost-button" data-action="reset-practice-session">结束本轮</button>
                          </div>
                        </form>
                      `
                  }
                </div>
              `
          }
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <p class="eyebrow">History</p>
              <h2>最近练习</h2>
            </div>
          </div>
          <div class="stats-grid">
            <div class="stat-card">
              <strong>${stats.total}</strong>
              <span>总练习次数</span>
            </div>
            <div class="stat-card">
              <strong>${stats.correct}</strong>
              <span>答对次数</span>
            </div>
            <div class="stat-card">
              <strong>${stats.accuracy}%</strong>
              <span>正确率</span>
            </div>
          </div>
          ${renderRecentAttempts(recentAttempts, wordsById, categoriesById, { showFavoriteActions: isFinished, busy })}
        </section>
      </div>
    </section>
  `;
}
