import { STORES, requestToPromise, runTransaction } from "./database.js";

export const APP_SETTING_KEYS = {
  showLibraryExportAction: "showLibraryExportAction",
};

export async function getSetting(key, fallbackValue = null) {
  return runTransaction([STORES.settings], "readonly", async ({ settings }) => {
    const record = await requestToPromise(settings.get(String(key ?? "")));
    return record ? record.value : fallbackValue;
  });
}

export async function setSetting(key, value) {
  return runTransaction([STORES.settings], "readwrite", async ({ settings }) => {
    settings.put({
      key: String(key ?? ""),
      value,
      updatedAt: Date.now(),
    });

    return value;
  });
}

export async function getBooleanSetting(key, fallbackValue = false) {
  const value = await getSetting(key, fallbackValue);

  if (typeof value === "boolean") {
    return value;
  }

  return Boolean(value);
}

export async function setBooleanSetting(key, value) {
  return setSetting(key, Boolean(value));
}