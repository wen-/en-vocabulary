export function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatDateTime(value) {
  if (!value) {
    return "未记录";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function bytesToSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function shuffle(items) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

export function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

export function normalizeStringList(values) {
  if (Array.isArray(values)) {
    return uniqueStrings(values);
  }

  if (values === undefined || values === null) {
    return [];
  }

  return uniqueStrings([values]);
}

export function createCategoryKey(name) {
  return normalizeText(name);
}

export function createExampleKey(example) {
  return `${normalizeText(example?.en)}@@${normalizeText(example?.zh)}`;
}

export function normalizePhoneticAndNotes(phoneticValue, notesValue) {
  const phonetic = String(phoneticValue ?? "").trim();
  const notes = String(notesValue ?? "").trim();

  if (phonetic || !notes) {
    return {
      phonetic,
      notes,
    };
  }

  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return {
      phonetic: "",
      notes: "",
    };
  }

  const match = lines[0].match(/^(?:音标|phonetic|ipa)\s*[:：]\s*(.+)$/i);

  if (!match) {
    return {
      phonetic: "",
      notes,
    };
  }

  return {
    phonetic: match[1].trim(),
    notes: lines.slice(1).join("\n"),
  };
}

export function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(item);
    return groups;
  }, new Map());
}

export function createDownload(filename, content, type = "application/json") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}