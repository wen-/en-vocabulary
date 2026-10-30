import { escapeHtml } from "../services/helpers.js";

const PHASE_LABELS = {
  reading: "正在读取并解析词库文件",
  audio: "正在读取单词及例句音频",
  clearing: "正在清理待覆盖的词库数据",
  writing: "正在写入词库",
  committing: "正在提交数据，请勿关闭页面",
  refreshing: "数据已保存，正在刷新列表",
};

export function renderImportProgress(progress) {
  if (!progress) return "";
  const label = PHASE_LABELS[progress.phase];
  const determinate = progress.total > 0;
  const count = determinate ? ` ${progress.completed} / ${progress.total}` : "";
  const percent = determinate ? Math.floor(progress.completed / progress.total * 100) : null;
  return `<section class="import-progress" aria-label="词库导入进度" aria-busy="true">
    <p role="status" aria-live="polite">${escapeHtml(label)}${count}${determinate ? `（${percent}%）` : "…"}</p>
    <progress aria-label="${escapeHtml(label)}" ${determinate ? `max="${progress.total}" value="${progress.completed}"` : ""}></progress>
    <p class="help-text">各阶段分别计数，写入数量包含按所选策略合并或跳过的单词。完成提示出现前请勿刷新或关闭页面。</p>
  </section>`;
}
