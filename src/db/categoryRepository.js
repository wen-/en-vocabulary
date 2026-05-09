import { STORES, requestToPromise, runTransaction } from "./database.js";
import { createId, normalizeText, uniqueStrings } from "../services/helpers.js";

function sanitizeCategoryInput(input) {
  return {
    id: input.id ? String(input.id) : "",
    name: String(input.name ?? "").trim(),
    group: String(input.group ?? "").trim(),
    description: String(input.description ?? "").trim(),
  };
}

function sortCategories(categories) {
  return [...categories].sort((left, right) => {
    const leftGroup = left.group || "未分组";
    const rightGroup = right.group || "未分组";

    if (leftGroup !== rightGroup) {
      return leftGroup.localeCompare(rightGroup, "zh-CN");
    }

    return left.name.localeCompare(right.name, "zh-CN");
  });
}

async function ensureUniqueCategory(categoriesStore, normalizedName, currentId) {
  const existing = await requestToPromise(categoriesStore.index("normalizedName").get(normalizedName));

  if (existing && existing.id !== currentId) {
    throw new Error("该分类名称已存在。");
  }
}

export async function listCategories() {
  return runTransaction([STORES.categories], "readonly", async ({ categories }) => {
    const records = await requestToPromise(categories.getAll());
    return sortCategories(records);
  });
}

export async function saveCategory(input) {
  const category = sanitizeCategoryInput(input);

  if (!category.name) {
    throw new Error("分类名称不能为空。");
  }

  const normalizedName = normalizeText(category.name);
  const now = Date.now();

  return runTransaction([STORES.categories], "readwrite", async ({ categories }) => {
    let existing = null;

    if (category.id) {
      existing = await requestToPromise(categories.get(category.id));

      if (!existing) {
        throw new Error("未找到要编辑的分类。");
      }
    }

    await ensureUniqueCategory(categories, normalizedName, category.id);

    const record = {
      id: existing?.id ?? createId(),
      name: category.name,
      normalizedName,
      group: category.group,
      description: category.description,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await requestToPromise(categories.put(record));
    return record;
  });
}

export async function deleteCategory(categoryId) {
  if (!categoryId) {
    return;
  }

  await runTransaction([STORES.categories, STORES.words], "readwrite", async ({ categories, words }) => {
    const affectedWords = await requestToPromise(words.index("categoryIds").getAll(categoryId));

    for (const word of affectedWords) {
      const nextCategoryIds = uniqueStrings(word.categoryIds).filter((currentId) => currentId !== categoryId);
      await requestToPromise(
        words.put({
          ...word,
          categoryIds: nextCategoryIds,
          updatedAt: Date.now(),
        }),
      );
    }

    await requestToPromise(categories.delete(categoryId));
  });
}