import { PassThrough, addAbortSignal } from "node:stream";

// Download independently of playback, with a bounded startup reserve. A source
// already slower than playback must finish the clause before playback starts.
// Keep at most one clause (4 MiB); callers await completion before prefetching.
export function bufferSpeech(source, {
  sampleRate, signal, bufferMs = 800, maxBytes = 4 * 1024 * 1024,
  now = () => performance.now(), continuous = false,
}) {
  const audio = new PassThrough({ highWaterMark: maxBytes });
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  ready.catch(() => {});
  audio.on("error", reject);
  if (signal) addAbortSignal(signal, audio);
  let bytes = 0;
  let firstByteAt, startupChecked = false;
  const completion = (async () => {
    try {
      signal?.throwIfAborted();
      for await (const chunk of source) {
        signal?.throwIfAborted();
        if (audio.destroyed) throw new Error("语音播放已取消");
        if (chunk.length && firstByteAt == null) firstByteAt = now();
        bytes += chunk.length;
        if (bytes > (continuous ? 64 * 1024 * 1024 : maxBytes)) throw new Error("单段合成音频过长");
        if (continuous && audio.readableLength + audio.writableLength + chunk.length > maxBytes)
          throw new Error("合成音频积压过多");
        audio.write(chunk);
        const audioMs = bytes / (sampleRate * 2) * 1000;
        if (!startupChecked && audioMs >= bufferMs) {
          startupChecked = true;
          // Require 25% delivery headroom. Once a slow startup is observed,
          // retain the whole clause even if a later burst briefly catches up.
          // Continuous input includes pauses while the LLM supplies text. Those
          // are not a download-speed estimate; start once the reserve is ready.
          if (continuous || audioMs >= (now() - firstByteAt) * 1.25) resolve();
        }
      }
      if (!bytes || bytes % 2) throw new Error("合成音频未返回完整 PCM 数据");
      audio.end();
      resolve();
    } catch (error) {
      audio.destroy(error);
      reject(error);
      throw error;
    }
  })();
  completion.catch(() => {});
  return { ready, completion, audio };
}
