// Ускорение речи без изменения высоты голоса (WSOLA) — перенесено из PDF-читалки
// (github.com/chadgpttop666/pdf, extension/src/tts/time-stretch.js) без изменений
// в алгоритме; здесь — обычный скрипт, потому что content scripts не модули.
const YTTStretch = (() => {
  const WINDOW_SECONDS = 0.03;
  // Насколько можно сдвинуть окно ради совпадения фазы: больше полупериода
  // самого низкого голоса (≈ 70 Гц).
  const TOLERANCE_SECONDS = 0.008;
  // Сходство окон сначала считается грубо, потом уточняется рядом с лучшим сдвигом.
  const COARSE_RATE = 11025;

  const hannCache = new Map();
  function hann(length) {
    if (!hannCache.has(length)) {
      const w = new Float32Array(length);
      for (let i = 0; i < length; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
      hannCache.set(length, w);
    }
    return hannCache.get(length);
  }

  function similarity(x, a, b, length, step) {
    let sum = 0;
    for (let i = 0; i < length; i += step) sum += x[a + i] * x[b + i];
    return sum;
  }

  /** Вся запись на скорости rate (2 — вдвое быстрее), высота голоса та же. */
  function timeStretch(pcm, sampleRate, rate) {
    if (!(rate > 0) || Math.abs(rate - 1) < 0.01) return pcm;
    const length = Math.ceil(pcm.length / rate);
    const frame = 2 * Math.round((WINDOW_SECONDS * sampleRate) / 2);
    const hop = frame / 2;
    const tolerance = Math.round(TOLERANCE_SECONDS * sampleRate);
    const coarse = Math.max(1, Math.round(sampleRate / COARSE_RATE));
    const window = hann(frame);

    const pad = frame + tolerance + hop;
    const x = new Float32Array(pcm.length + 2 * pad);
    x.set(pcm, pad);
    const out = new Float32Array(length + frame);
    const weight = new Float32Array(length + frame);
    let previous = pad;

    for (let at = 0; at < length; at += hop) {
      const nominal = pad + Math.round(at * rate);
      let source = nominal;
      if (at > 0) {
        const natural = previous + hop;
        let best = -Infinity;
        for (let shift = -tolerance; shift <= tolerance; shift += coarse) {
          const score = similarity(x, nominal + shift, natural, hop, coarse);
          if (score > best) {
            best = score;
            source = nominal + shift;
          }
        }
        if (coarse > 1) {
          const from = Math.max(nominal - tolerance, source - coarse + 1);
          const to = Math.min(nominal + tolerance, source + coarse - 1);
          best = -Infinity;
          for (let candidate = from; candidate <= to; candidate += 1) {
            const score = similarity(x, candidate, natural, hop, 1);
            if (score > best) {
              best = score;
              source = candidate;
            }
          }
        }
      }
      for (let i = 0; i < frame; i += 1) {
        out[at + i] += window[i] * x[source + i];
        weight[at + i] += window[i];
      }
      previous = source;
    }

    const result = new Float32Array(length);
    for (let i = 0; i < length; i += 1) result[i] = weight[i] > 1e-6 ? out[i] / weight[i] : 0;
    return result;
  }

  return { timeStretch };
})();

if (typeof module !== "undefined") module.exports = YTTStretch;
