export const AUDIO_ACCEPT = ".mp3,.wav,.ogg,.m4a,audio/mpeg,audio/wav,audio/ogg,audio/mp4";
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export function validateAudioFile(file) {
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("请选择一个有效的音频文件。");
  }

  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error("单个音频文件请控制在 4 MB 以内。");
  }

  if (!file.type.startsWith("audio/") && !/\.(mp3|wav|ogg|m4a)$/i.test(file.name)) {
    throw new Error("仅支持 mp3、wav、ogg、m4a 等常见音频格式。");
  }
}

export async function playAudioBlob(blob) {
  if (!blob) {
    throw new Error("当前单词没有可播放的音频。");
  }

  const objectUrl = URL.createObjectURL(blob);
  const audio = new Audio(objectUrl);

  try {
    await audio.play();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("音频播放失败，请在用户点击后重试。");
  }

  return new Promise((resolve) => {
    const release = () => {
      URL.revokeObjectURL(objectUrl);
      resolve();
    };

    audio.onended = release;
    audio.onerror = release;
  });
}