import { bytesToSize, escapeHtml } from "../services/helpers.js";

function getInstallStatus(pwaStatus) {
  if (pwaStatus?.standalone) {
    return {
      title: "已安装并以应用模式运行",
      description: "当前已脱离浏览器标签页，可从主屏幕或桌面直接打开。",
    };
  }

  if (pwaStatus?.promptInstallAvailable) {
    return {
      title: "可直接唤起安装提示",
      description: "当前浏览器已暴露安装入口，可直接使用下方按钮。",
    };
  }

  if (pwaStatus?.iosSafari) {
    return {
      title: "请用 Safari 的“添加到主屏幕”",
      description: "iPhone Safari 通常不会触发安装弹窗，这不代表 PWA 配置有问题。",
    };
  }

  if (!pwaStatus?.secureContext) {
    return {
      title: "当前地址不是安全上下文",
      description: "请改用 HTTPS 或 localhost/127.0.0.1 访问，否则离线缓存与安装能力可能受限。",
    };
  }

  return {
    title: "浏览器未提供安装提示",
    description: "可尝试刷新资源缓存，或改用支持安装提示的浏览器继续验证。",
  };
}

function getServiceWorkerStatus(pwaStatus) {
  if (!pwaStatus?.serviceWorkerSupported) {
    return {
      title: "当前浏览器不支持 Service Worker",
      description: "离线缓存与应用安装能力将不可用。",
    };
  }

  if (pwaStatus.serviceWorkerControlled) {
    return {
      title: "离线内核已接管当前页面",
      description: "静态资源更新后仍建议刷新一次，确保拿到最新缓存。",
    };
  }

  if (pwaStatus.serviceWorkerState === "registered") {
    return {
      title: "Service Worker 已注册",
      description: "当前页可能还未被接管；刷新一次后离线能力会更稳定。",
    };
  }

  if (pwaStatus.serviceWorkerState === "error") {
    return {
      title: "Service Worker 注册失败",
      description: "请先确认访问地址、缓存资源和浏览器控制台报错。",
    };
  }

  return {
    title: "正在等待离线内核接管",
    description: "初次访问时属于正常现象，刷新后通常会进入已接管状态。",
  };
}

function renderPreviewCard(preview) {
  if (!preview) {
    return '<p class="help-text">选中文件后会先预览单词数、例句数、分类数和音频引用数，再确认是否导入。</p>';
  }

  const stats = [
    `${preview.words || 0} 个单词`,
    `${preview.examples || 0} 条例句`,
    `${preview.categories || 0} 个分类`,
    `${preview.audioRefs || 0} 个音频引用`,
  ];

  return `
    <div class="import-preview import-preview--${preview.status === "error" ? "error" : "ready"}">
      <div class="import-preview__header">
        <div>
          <strong>${escapeHtml(preview.filename || "未命名文件")}</strong>
          <p class="tiny-meta">${preview.format ? escapeHtml(preview.format.toUpperCase()) : "文件"} · ${bytesToSize(preview.size || 0)}</p>
        </div>
        <span class="counter-pill">${preview.status === "error" ? "预检失败" : "预检完成"}</span>
      </div>
      <div class="import-preview__stats">
        ${stats.map((item) => `<span class="preview-stat">${escapeHtml(item)}</span>`).join("")}
      </div>
      ${preview.message ? `<p class="help-text">${escapeHtml(preview.message)}</p>` : ""}
    </div>
  `;
}

export function renderSettingsView({ summary, storageEstimate, pwaStatus, busy, importPreviews }) {
  const usage = storageEstimate?.usage ? bytesToSize(storageEstimate.usage) : "未知";
  const quota = storageEstimate?.quota ? bytesToSize(storageEstimate.quota) : "未知";
  const hasData = summary.words > 0 || summary.categories > 0;
  const hasLibraryPreview = Boolean(importPreviews?.library);
  const installStatus = getInstallStatus(pwaStatus);
  const serviceWorkerStatus = getServiceWorkerStatus(pwaStatus);

  return `
    <section class="view-stack">
      <div class="section-grid">
        <section class="panel">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Library</p>
              <h2>词库导入与导出</h2>
            </div>
          </div>
          <div class="stats-grid">
            <div class="stat-card">
              <strong>${summary.words}</strong>
              <span>单词</span>
            </div>
            <div class="stat-card">
              <strong>${summary.categories}</strong>
              <span>分类</span>
            </div>
            <div class="stat-card">
              <strong>${summary.practiceAttempts}</strong>
              <span>练习记录（仅本地）</span>
            </div>
          </div>
          <div class="settings-stack">
            <div class="stat-card stat-card--wide">
              <strong>${hasData ? "你已经可以开始使用" : "还没有学习数据"}</strong>
              <span>${hasData ? "可以继续录入、练习，或用统一词库包在设备间同步。" : "可一键加载示例分类和示例单词，先体验完整流程。"}</span>
            </div>
            <button type="button" class="ghost-button" data-action="load-demo-data" ${busy ? "disabled" : ""}>加载示例数据</button>
            <button type="button" class="ghost-button" data-action="download-library-template" ${busy ? "disabled" : ""}>下载 JSON 词库模板</button>
            <button type="button" class="primary-button" data-action="export-library-package" ${busy ? "disabled" : ""}>导出 JSON + 音频 ZIP</button>
            <form data-form="import-library" class="form-stack compact-form">
              <label class="field">
                <span>导入词库 ZIP / JSON</span>
                <input type="file" name="libraryFile" accept="application/json,.json,application/zip,.zip" ${hasLibraryPreview ? "" : "required"} />
              </label>
              <label class="field">
                <span>导入模式</span>
                <select name="importMode">
                  <option value="merge">合并导入，保留现有数据</option>
                  <option value="replace">覆盖导入，先清空本地数据</option>
                </select>
              </label>
              <label class="field">
                <span>重复单词策略</span>
                <select name="duplicateMode">
                  <option value="skip">跳过同名单词，保留现有内容</option>
                  <option value="merge">合并同名单词的音标、释义、例句、分类和音频</option>
                </select>
              </label>
              <div class="form-actions">
                <button type="submit" class="primary-button" ${busy ? "disabled" : ""}>导入词库</button>
              </div>
              <p class="help-text">词库统一使用 JSON 结构。文本模板使用 library.json，完整词库包使用 ZIP，其中包含 library.json 以及可选的 audio/words 和 audio/examples 目录。JSON 词库适合维护文本数据，ZIP 词库适合同时携带单词音频和例句音频。</p>
              ${renderPreviewCard(importPreviews?.library)}
            </form>
            <button type="button" class="danger-button" data-action="clear-local-data" ${busy ? "disabled" : ""}>清空全部本地数据</button>
            <p class="help-text">统一词库包只包含分类、单词、音标、释义、例句及单词/例句音频，不包含练习记录；练习记录仅保留在当前浏览器本地。</p>
          </div>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Device</p>
              <h2>离线与安装状态</h2>
            </div>
          </div>
          <div class="settings-stack">
            <div class="stat-card stat-card--wide">
              <strong>${usage} / ${quota}</strong>
              <span>浏览器已用存储 / 配额</span>
            </div>
            <div class="stat-card stat-card--wide">
              <strong>${pwaStatus?.standalone ? "已以应用模式运行" : "当前在浏览器标签页中"}</strong>
              <span>PWA 启动状态</span>
            </div>
            <div class="stat-card stat-card--wide">
              <strong>${escapeHtml(installStatus.title)}</strong>
              <span>${escapeHtml(installStatus.description)}</span>
            </div>
            <div class="stat-card stat-card--wide">
              <strong>${pwaStatus?.secureContext ? "安全上下文已满足" : "当前不是安全上下文"}</strong>
              <span>
                ${escapeHtml(
                  pwaStatus?.secureContext
                    ? "当前地址满足 Service Worker 与 PWA 运行要求。"
                    : "从 iPhone 访问电脑局域网地址时，纯 HTTP 通常无法稳定启用离线缓存。",
                )}
              </span>
            </div>
            <div class="stat-card stat-card--wide">
              <strong>${escapeHtml(serviceWorkerStatus.title)}</strong>
              <span>${escapeHtml(serviceWorkerStatus.description)}</span>
            </div>
            <button type="button" class="ghost-button" data-action="install-app" ${pwaStatus?.promptInstallAvailable && !busy ? "" : "disabled"}>安装到设备</button>
            <p class="help-text">当前访问地址：${escapeHtml(pwaStatus?.origin || "未知")}</p>
            <p class="help-text">iPhone 上如果没有安装按钮，请用 Safari 的分享菜单执行“添加到主屏幕”；如果当前是局域网地址，请优先改成 HTTPS 后再测离线能力。</p>
          </div>
        </section>
      </div>
    </section>
  `;
}
