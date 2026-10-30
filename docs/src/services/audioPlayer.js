export function createAudioPlayer({
  createAudio = () => new Audio(),
  createUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
  onState = () => {},
} = {}) {
  let audio;
  let generation = 0;
  let releaseCurrent = null;
  let playbackState = { status: "idle", ownerId: null, sentenceId: null };
  const publish = (next) => {
    playbackState = next;
    onState(next);
  };
  const stop = () => {
    generation += 1;
    if (releaseCurrent) releaseCurrent();
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    publish({ status: "idle", ownerId: null, sentenceId: null });
  };
  return {
    stop,
    get state() { return playbackState; },
    async play(items, loadBlob, { ownerId = null } = {}) {
      stop();
      const current = generation;
      audio ||= createAudio();
      try {
        for (const item of items) {
          if (current !== generation) return;
          publish({ status: "playing", ownerId, sentenceId: item.id });
          const blob = await loadBlob(item);
          if (current !== generation) return;
          if (!blob?.size) throw new Error("当前句子没有可播放的音频。");
          const url = createUrl(blob);
          await new Promise((resolve, reject) => {
            let finished = false;
            const finish = (error) => {
              if (finished) return;
              finished = true;
              audio.removeEventListener("ended", ended);
              audio.removeEventListener("error", failed);
              revokeUrl(url);
              releaseCurrent = null;
              if (error) reject(error);
              else resolve();
            };
            const ended = () => finish();
            const failed = () => finish(new Error("音频播放失败，请检查音频文件或再次点击播放。"));
            releaseCurrent = () => finish();
            audio.addEventListener("ended", ended);
            audio.addEventListener("error", failed);
            audio.src = url;
            try {
              Promise.resolve(audio.play()).catch(failed);
            } catch {
              failed();
            }
          });
        }
      } catch (error) {
        if (current === generation) {
          stop();
          throw error;
        }
      } finally {
        if (current === generation) stop();
      }
    },
  };
}

let observer = () => {};
export function observePlayback(callback) {
  observer = callback;
}
export const audioPlayer = createAudioPlayer({ onState: (state) => observer(state) });
