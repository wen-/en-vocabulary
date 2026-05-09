import { STORES, requestToPromise, runTransaction } from "./database.js";
import { createId, uniqueStrings } from "../services/helpers.js";

function uniquePositiveIntegers(values) {
  return [...new Set((values ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

export async function listPracticeAttempts(limit = 80) {
  return runTransaction([STORES.practiceAttempts], "readonly", async ({ practiceAttempts }) => {
    const records = await requestToPromise(practiceAttempts.getAll());

    return [...records]
      .sort((left, right) => right.attemptedAt - left.attemptedAt)
      .slice(0, limit);
  });
}

export async function recordPracticeAttempt(input) {
  const record = {
    id: createId(),
    sessionId: String(input.sessionId ?? ""),
    wordId: String(input.wordId ?? ""),
    answer: String(input.answer ?? "").trim(),
    expected: String(input.expected ?? "").trim(),
    correct: Boolean(input.correct),
    selectedCategoryIds: uniqueStrings(input.selectedCategoryIds),
    selectedPages: uniquePositiveIntegers(input.selectedPages),
    attemptedAt: Date.now(),
  };

  return runTransaction([STORES.practiceAttempts], "readwrite", async ({ practiceAttempts }) => {
    await requestToPromise(practiceAttempts.add(record));
    return record;
  });
}

export function summarizeAttempts(attempts) {
  const total = attempts.length;
  const correct = attempts.filter((attempt) => attempt.correct).length;
  const accuracy = total === 0 ? 0 : Math.round((correct / total) * 100);

  return {
    total,
    correct,
    accuracy,
  };
}