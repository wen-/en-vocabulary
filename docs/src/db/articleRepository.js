import { STORES, requestToPromise, runTransaction } from "./database.js";
import { createId } from "../services/helpers.js";

export function listArticles() {
  return runTransaction([STORES.articles], "readonly", (stores) =>
    requestToPromise(stores[STORES.articles].getAll()));
}

export function getArticleAudio(id) {
  return runTransaction([STORES.articleAudio], "readonly", (stores) =>
    requestToPromise(stores[STORES.articleAudio].get(id)));
}

export function listArticleAudio() {
  return runTransaction([STORES.articleAudio], "readonly", (stores) =>
    requestToPromise(stores[STORES.articleAudio].getAll()));
}

export function importArticles(articles) {
  const now = Date.now();
  const records = articles.map((article) => ({
    id: createId(),
    title: article.title,
    createdAt: now,
    updatedAt: now,
    sentences: article.sentences.map((sentence) => ({
      id: createId(), en: sentence.en, zh: sentence.zh,
      hasAudio: Boolean(sentence.blob),
      blob: sentence.blob,
    })),
  }));
  return runTransaction([STORES.articles, STORES.articleAudio], "readwrite", (stores) => {
    for (const article of records) {
      const sentences = article.sentences.map(({ blob, ...sentence }) => {
        if (blob) {
          stores[STORES.articleAudio].put({ id: sentence.id, articleId: article.id, blob });
        }
        return sentence;
      });
      stores[STORES.articles].put({ ...article, sentences });
    }
    return records.length;
  });
}

export function deleteArticle(article) {
  return runTransaction([STORES.articles, STORES.articleAudio], "readwrite", (stores) => {
    stores[STORES.articles].delete(article.id);
    for (const sentence of article.sentences) stores[STORES.articleAudio].delete(sentence.id);
  });
}
