import { escapeHtml } from "../services/helpers.js";

const COPY = {
  library: {
    title: "词库导入进度",
    hint: "各阶段分别计数，写入数量包含按所选策略合并或跳过的单词。完成提示出现前请勿刷新或关闭页面。",
    phases: {
      reading: "正在读取并解析词库文件",
      audio: "正在读取单词及例句音频",
      clearing: "正在清理待覆盖的词库数据",
      writing: "正在写入词库",
      committing: "正在提交数据，请勿关闭页面",
      refreshing: "数据已保存，正在刷新列表",
    },
  },
  article: {
    title: "文章导入进度",
    hint: "音频较多时校验需要一些时间。完成提示出现前请勿刷新或关闭页面。",
    phases: {
      reading: "正在读取并解析文章包",
      audio: "正在校验文章音频",
      committing: "正在写入文章，请勿关闭页面",
      refreshing: "文章已保存，正在刷新列表",
    },
  },
};

export function renderImportProgress(progress, kind = "library") {
  if (!progress) return "";
  const copy = COPY[kind];
  const label = copy.phases[progress.phase];
  const determinate = progress.total > 0;
  const count = determinate ? ` ${progress.completed} / ${progress.total}` : "";
  const percent = determinate ? Math.floor(progress.completed / progress.total * 100) : null;
  return `<section class="import-progress" aria-label="${copy.title}" aria-busy="true">
    <p role="status" aria-live="polite">${escapeHtml(label)}${count}${determinate ? `（${percent}%）` : "…"}</p>
    <progress aria-label="${escapeHtml(label)}" ${determinate ? `max="${progress.total}" value="${progress.completed}"` : ""}></progress>
    <p class="help-text">${copy.hint}</p>
  </section>`;
}
