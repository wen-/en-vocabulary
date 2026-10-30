import { escapeHtml, renderAudioIcon } from "../services/helpers.js";
import { renderExampleEnglishText } from "./wordsView.js";

const ARTICLE_TITLE_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function getCoursePassage(title) {
  const match = title.match(/^(.+?)\s*[|｜]\s*Passage\s+(\d+)(?:\s*[|｜]|$)/i);
  return match ? { course: match[1].trim(), passage: Number(match[2]) } : null;
}

function compareArticles(left, right) {
  const leftPassage = getCoursePassage(left.title);
  const rightPassage = getCoursePassage(right.title);

  if (leftPassage && rightPassage) {
    const courseOrder = ARTICLE_TITLE_COLLATOR.compare(leftPassage.course, rightPassage.course);
    if (courseOrder) return courseOrder;

    const passageOrder = leftPassage.passage - rightPassage.passage;
    if (passageOrder) return passageOrder;
  }

  return ARTICLE_TITLE_COLLATOR.compare(left.title, right.title);
}

export function renderArticlesView({ articles, selectedId, section = "list", busy, importFile, playback }) {
  const article = articles.find((item) => item.id === selectedId);
  const sortedArticles = [...articles].sort(compareArticles);
  return `<section class="view-stack">
    <nav class="article-section-nav" aria-label="文章板块">
      <button type="button" class="tab-button ${section === "list" ? "tab-button--active" : ""}" data-action="article-section" data-section="list" aria-pressed="${section === "list"}" ${busy ? "disabled" : ""}>文章列表</button>
      <button type="button" class="tab-button ${section === "import" ? "tab-button--active" : ""}" data-action="article-section" data-section="import" aria-pressed="${section === "import"}" ${busy ? "disabled" : ""}>导入文章</button>
    </nav>
    <section class="panel">
      ${section === "import" ? `
        <div class="section-heading"><h2>导入文章</h2></div>
        <div class="form-stack">
          <p class="help-text">导入 ZIP 文章包，将中英对照文章和音频保存在本机，离线也能阅读与播放。</p>
          <div class="form-actions">
            <button class="ghost-button" data-action="article-template" ${busy ? "disabled" : ""}>下载文章 ZIP 模板（含音频）</button>
          </div>
          <label class="field"><span>选择文章 ZIP 包</span>
            <input type="file" name="articlePackage" accept=".zip,application/zip" aria-describedby="article-import-file-status" ${busy ? "disabled" : ""}>
          </label>
          <p class="help-text" id="article-import-file-status" role="status">${importFile ? `已选择 ${escapeHtml(importFile.name)}` : "尚未选择文件。"}</p>
          <p class="help-text">ZIP 根目录须包含 articles.json；音频可选。同名文章会另存为新文章，不覆盖已有内容。</p>
          <div class="form-actions">
            <button class="primary-button" data-action="article-import" ${busy || !importFile ? "disabled" : ""}>${busy ? "处理中…" : "导入文章"}</button>
          </div>
          <p class="help-text">备份文章请到“文章列表”导出，词库备份不包含文章。</p>
        </div>
      ` : article ? `
        <div class="section-heading"><h2>文章</h2></div>
        <div class="form-actions form-actions--triple-mobile">
          <button class="ghost-button" data-action="article-back">返回</button>
          <button class="ghost-button" data-action="article-export-one" data-article-id="${escapeHtml(article.id)}" ${busy ? "disabled" : ""}>导出</button>
          <button class="danger-button" data-action="article-delete" data-article-id="${escapeHtml(article.id)}" ${busy ? "disabled" : ""}>删除</button>
        </div>
        <h3>${escapeHtml(article.title)}</h3>
        <div class="form-actions form-actions--inline-mobile">
          <button class="primary-button" data-action="article-play-all" ${article.sentences.some((s) => s.hasAudio) ? "" : "disabled"}>连续播放</button>
          <button class="ghost-button" data-action="article-stop">停止</button>
        </div>
        <p class="help-text" data-article-playback-status role="status">${playback.ownerId === article.id && playback.status === "playing" ? "正在播放英文" : "未播放。有音频的句子按顺序播放，无音频的句子跳过。"}</p>
        <div class="article-sentences">
          ${article.sentences.map((sentence, index) => `
            <section class="article-sentence ${playback.sentenceId === sentence.id ? "is-playing" : ""}" data-article-sentence="${escapeHtml(sentence.id)}">
              <p class="article-english" lang="en"><span class="article-number">${index + 1}.</span> ${renderExampleEnglishText(sentence.en)}
                <button class="icon-button icon-button--audio" data-action="article-play-sentence" data-sentence-id="${escapeHtml(sentence.id)}" aria-label="播放第 ${index + 1} 句英文" title="${sentence.hasAudio ? "播放英文" : "未导入音频"}" ${sentence.hasAudio ? "" : "disabled"}>${renderAudioIcon()}</button>
              </p>
              <p class="article-chinese" lang="zh-CN">${escapeHtml(sentence.zh)}</p>
            </section>`).join("")}
        </div>` : `
        <div class="section-heading article-list-heading">
          <h2>文章列表 <span class="help-text article-count">${articles.length} 篇</span></h2>
          <button class="ghost-button" data-action="article-export" ${busy || !articles.length ? "disabled" : ""}>导出全部文章 ZIP</button>
        </div>
        <p class="help-text">文章和音频保存在本机，可离线阅读与播放。</p>
        <ul class="article-list">
          ${sortedArticles.map((item) => `<li><button class="ghost-button article-title" data-action="article-open" data-article-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button><span class="help-text">${item.sentences.length} 句</span></li>`).join("")}
        </ul>
        ${articles.length ? "" : `<div class="form-stack">
          <p class="empty-inline">还没有文章，导入文章 ZIP 开始阅读。</p>
          <div class="form-actions"><button class="primary-button" data-action="article-section" data-section="import" ${busy ? "disabled" : ""}>去导入文章</button></div>
        </div>`}
      `}
    </section>
  </section>`;
}
