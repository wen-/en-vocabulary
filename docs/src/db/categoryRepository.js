import { STORES, requestToPromise, runTransaction } from "./database.js";
import { createCategoryKey, createId, normalizeText, uniqueStrings } from "../services/helpers.js";

function sanitizeCategoryInput(input) {
  return {
    id: input.id ? String(input.id) : "",
    name: String(input.name ?? "").trim(),
    description: String(input.description ?? "").trim(),
  };
}

function sortCategories(categories) {
  return [...categories].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

async function ensureUniqueCategory(categoriesStore, normalizedName, currentId) {
  const existing = await requestToPromise(categoriesStore.index("normalizedKey").get(normalizedName));

  if (existing && existing.id !== currentId) {
    throw new Error("已存在同名分类。");
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

  const normalizedKey = createCategoryKey(category.name);
  const now = Date.now();

  return runTransaction([STORES.categories], "readwrite", async ({ categories }) => {
    let existing = null;

    if (category.id) {
      existing = await requestToPromise(categories.get(category.id));

      if (!existing) {
        throw new Error("未找到要编辑的分类。");
      }
    }

    await ensureUniqueCategory(categories, normalizedKey, category.id);

    const record = {
      id: existing?.id ?? createId(),
      name: category.name,
      normalizedKey,
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