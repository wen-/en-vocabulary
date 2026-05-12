import { escapeHtml } from "../services/helpers.js";

function renderCategoryList(categories) {
  if (!categories.length) {
    return `
      <div class="empty-state">
        <h3>还没有分类</h3>
        <p>先创建几个类别，例如 本科、理工英语、人文英语。</p>
      </div>
    `;
  }

  return `
    <div class="card-list">
      ${categories
        .map(
          (category) => `
            <article class="item-card item-card--compact">
              <div class="item-card__header">
                <div>
                  <h4>${escapeHtml(category.name)}</h4>
                  <p class="item-card__meaning">${escapeHtml(category.description || "用于筛选与练习")}</p>
                </div>
                <div class="inline-actions inline-actions--compact-row">
                  <button type="button" class="ghost-button" data-action="edit-category" data-category-id="${escapeHtml(category.id)}">编辑</button>
                  <button type="button" class="ghost-button" data-action="delete-category" data-category-id="${escapeHtml(category.id)}">删除</button>
                </div>
              </div>
              <p class="tiny-meta">引用词数：${category.wordCount || 0}</p>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

export function renderCategoriesView({ categories, draft, busy }) {
  const submitLabel = draft.id ? "保存分类" : "添加分类";

  return `
    <section class="view-stack">
      <div class="section-grid">
        <section class="panel">
          <div class="section-heading" data-category-editor-scroll-anchor>
            <div>
              <p class="eyebrow">Categories</p>
              <h2>分类管理</h2>
            </div>
            <button type="button" class="ghost-button" data-action="reset-category-draft">清空表单</button>
          </div>
          <form data-form="category-editor" class="form-stack">
            <input type="hidden" name="id" value="${escapeHtml(draft.id || "")}" />
            <label class="field">
              <span>分类名称</span>
              <input name="name" value="${escapeHtml(draft.name || "")}" required maxlength="80" placeholder="例如：本科" />
            </label>
            <label class="field">
              <span>说明</span>
              <textarea name="description" rows="4" maxlength="240" placeholder="可选，用于解释这个分类适合什么词汇。">${escapeHtml(draft.description || "")}</textarea>
            </label>
            <div class="form-actions">
              <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>${submitLabel}</button>
              <p class="help-text">分类采用多选模式，一个单词可以属于多个类别。</p>
            </div>
          </form>
        </section>

        <section class="panel">
          <div class="section-heading section-heading--inline-mobile">
            <div>
              <p class="eyebrow">Overview</p>
              <h2>已有分类</h2>
            </div>
            <span class="counter-pill">${categories.length} 个分类</span>
          </div>
          ${renderCategoryList(categories)}
        </section>
      </div>
    </section>
  `;
}