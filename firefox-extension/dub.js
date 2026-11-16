// Закадровый перевод: фразы перевода звучат голосом TeraTTS (через PDF-читалку)
// в момент своих таймкодов, оригинал на это время приглушается — как в
// voice-over-translation. Озвучка идёт за видео: пауза, перемотка, скорость.
(() => {
  if (window.__yttDub) return;
  window.__yttDub = true;

  const AHEAD_SECONDS = 90; // насколько вперёд синтезировать
  const AHEAD_CUES = 12;
  const START_WINDOW = 0.8; // фразу, к началу которой опоздали больше, — пропускаем (перемотка)
  const QUEUE_WINDOW = 2.5; // фраза ждала конца предыдущей — столько ещё можно опоздать
  const MAX_RATE = 2.2; // быстрее речь уже не разобрать
  const UNDUCK_DELAY_MS = 600; // короткие паузы между фразами оригинал не «выныривает»
  const READ_CHARS_PER_SECOND = 14; // сколько субтитр висит без явного конца: успеть прочитать

  let s = null; // текущая озвучка
  let ctx = null;
  let output = null;

  const findVideo = () =>
    document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video");
  const currentVideoId = () => new URL(location.href).searchParams.get("v");

  function indexAt(t) {
    const cues = s.cues;
    let lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  // ── Громкость оригинала ─────────────────────────────────────────────
  function setVolume(value) {
    s.selfVolume = true;
    s.video.volume = Math.max(0, Math.min(1, value));
    setTimeout(() => s && (s.selfVolume = false), 0);
  }

  function duck() {
    clearTimeout(s.unduckTimer);
    if (s.ducked) return;
    s.baseVolume = s.video.volume;
    s.ducked = true;
    setVolume(s.baseVolume * s.duck);
  }

  function unduckSoon() {
    clearTimeout(s.unduckTimer);
    const mine = s;
    s.unduckTimer = setTimeout(() => {
      if (s !== mine || !s.ducked || s.playing) return;
      s.ducked = false;
      setVolume(s.baseVolume);
    }, UNDUCK_DELAY_MS);
  }

  // ── Синтез впрок ────────────────────────────────────────────────────
  async function pump() {
    if (!s || s.busy || !s.voiceId) return;
    const mine = s;
    const t = s.video.currentTime;
    const from = Math.max(0, indexAt(t));
    let cue = null;
    for (let j = from; j < Math.min(s.cues.length, from + AHEAD_CUES); j += 1) {
      if (s.cues[j].start - t > AHEAD_SECONDS) break;
      if (s.cues[j].state === "new") {
        cue = s.cues[j];
        break;
      }
    }
    // Далеко позади — звук больше не нужен: час речи занял бы сотни мегабайт.
    for (let j = 0; j < from - 2; j += 1) {
      if (s.cues[j].state === "ready") {
        s.cues[j].pcm = null;
        s.cues[j].state = "new";
      }
    }
    if (!cue) return;

    cue.state = "loading";
    s.busy = true;
    s.loadingSince = performance.now();
    try {
      const reply = await browser.runtime.sendMessage({ cmd: "tts-render", text: cue.text, voiceId: s.voiceId });
      if (s !== mine) return;
      // Скорость синтеза — для оценки, когда будет готова следующая фраза.
      const perChar = (performance.now() - s.loadingSince) / 1000 / Math.max(20, cue.text.length);
      s.secPerChar = s.secPerChar ? s.secPerChar * 0.6 + perChar * 0.4 : perChar;
      cue.pcm = reply.pcm;
      cue.sampleRate = reply.sampleRate;
      cue.state = "ready";
      s.prepared += 1;
      s.lastError = "";
    } catch (e) {
      if (s !== mine) return;
      cue.state = "error";
      s.errors += 1;
      s.lastError = String(e?.message || e);
    } finally {
      if (s === mine) {
        s.busy = false;
        pump();
      }
    }
  }

  // ── Субтитры с текстом перевода ─────────────────────────────────────
  let subsBox = null;

  function subsElement() {
    const player = document.querySelector("#movie_player") || s.video.parentElement;
    if (subsBox?.isConnected && subsBox.parentElement === player) return subsBox;
    subsBox?.remove();
    subsBox = document.createElement("div");
    subsBox.className = "ytt-dub-subs";
    Object.assign(subsBox.style, {
      position: "absolute",
      left: "50%",
      bottom: "14%",
      transform: "translateX(-50%)",
      maxWidth: "80%",
      padding: "4px 10px",
      borderRadius: "4px",
      background: "rgba(8, 8, 8, 0.75)",
      color: "#fff",
      font: "500 clamp(15px, 2.2vw, 30px)/1.35 'YouTube Noto', Roboto, Arial, sans-serif",
      textAlign: "center",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
      zIndex: "60",
      display: "none",
    });
    player.appendChild(subsBox);
    return subsBox;
  }

  // Субтитр висит до конца фразы (SRT/VTT), но не дольше, чем до следующей,
  // а без явного конца — сколько нужно, чтобы прочитать.
  function cueEnd(i) {
    const cue = s.cues[i];
    const next = s.cues[i + 1];
    const readable = cue.start + Math.max(2.5, cue.text.length / READ_CHARS_PER_SECOND) + 1;
    return Math.min(cue.end ?? readable, next ? next.start : Infinity);
  }

  function renderSubs(t, i) {
    if (!s.subs) {
      if (subsBox) subsBox.style.display = "none";
      return;
    }
    // Пока звучит фраза — её текст, даже если видео уже дошло до следующей.
    let text = s.playing ? s.cues[s.playing.index].text : "";
    if (!text && i >= 0 && t < cueEnd(i)) text = s.cues[i].text;
    const box = subsElement();
    if (box.textContent !== text) box.textContent = text;
    box.style.display = text ? "block" : "none";
  }

  // ── Проигрывание ────────────────────────────────────────────────────
  function stopSource() {
    if (!s?.playing) return;
    const { source } = s.playing;
    s.playing = null;
    try { source.stop(); } catch {}
    unduckSoon();
  }

  function play(i) {
    const cue = s.cues[i];
    const vr = s.video.playbackRate || 1;
    const next = s.cues[i + 1];
    const duration = cue.pcm.length / cue.sampleRate;
    const slot = Math.max(0.8, next ? next.start - cue.start : duration);
    // Говорим со скоростью видео, а если фраза не влезает до следующей — быстрее.
    const rate = Math.min(Math.max(vr, (duration * vr) / (slot * 0.95)), Math.max(vr, MAX_RATE));
    const pcm = YTTStretch.timeStretch(cue.pcm, cue.sampleRate, rate);

    const buffer = ctx.createBuffer(1, pcm.length, cue.sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    const mine = s;
    source.onended = () => {
      if (s !== mine || s.playing?.source !== source) return;
      s.playing = null;
      unduckSoon();
      tick();
    };
    s.lastIndex = i;
    s.pendingIndex = -1;
    s.playing = { source, index: i };
    duck();
    source.start();
  }

  function tick() {
    if (!s) return;
    if (currentVideoId() !== s.videoId) return stop();
    const v = s.video;
    const t = v.currentTime;
    const i = indexAt(t);
    renderSubs(t, i);
    if (!s.voiceId) return; // только субтитры

    if (s.waiting) {
      const cue = s.cues[s.waitIndex];
      if (cue.state === "ready" || cue.state === "error") {
        s.waiting = false;
        s.selfResume = true;
        v.play().catch(() => {}).finally(() => setTimeout(() => s && (s.selfResume = false), 300));
      }
      pump();
      return;
    }
    if (v.paused || i < 0 || i === s.lastIndex) {
      pump();
      return;
    }

    const cue = s.cues[i];
    const late = t - cue.start;
    if (late > (i === s.pendingIndex ? QUEUE_WINDOW : START_WINDOW)) {
      s.lastIndex = i; // попали в середину фразы — ждём следующую
    } else if (s.playing) {
      s.pendingIndex = i; // скажем сразу, как договорит предыдущая
    } else if (cue.state === "ready") {
      play(i);
    } else if (cue.state === "error") {
      s.lastIndex = i;
    } else if (s.wait) {
      s.waiting = true;
      s.waitIndex = i;
      v.pause();
    } else {
      s.lastIndex = i;
    }
    pump();
  }

  // ── События видео ───────────────────────────────────────────────────
  const handlers = {
    seeking() {
      stopSource();
      s.lastIndex = -1;
      s.pendingIndex = -1;
      s.waiting = false;
    },
    pause() {
      if (!s.waiting) ctx.suspend().catch(() => {});
    },
    play() {
      ctx.resume().catch(() => {});
      // Видео запустили сами, пока ждали озвучку, — эту фразу пропускаем.
      if (s.waiting && !s.selfResume) {
        s.waiting = false;
        s.lastIndex = s.waitIndex;
      }
    },
    // Запасной такт: в фоновой вкладке Firefox замедляет таймеры до раза в
    // секунду, а события видео идут как обычно — озвучка не отстаёт.
    timeupdate() {
      tick();
    },
    volumechange() {
      // Громкость поменял человек — это новая громкость оригинала.
      if (s.selfVolume) return;
      s.baseVolume = s.video.volume;
      s.ducked = false;
    },
  };

  function start({ cues, voiceId, duck: duckLevel, wait, subs }) {
    stop();
    const video = findVideo();
    if (!video) throw new Error("на странице нет видео");
    ctx ??= new AudioContext();
    output ??= ctx.createGain();
    output.connect(ctx.destination);
    s = {
      video,
      videoId: currentVideoId(),
      cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text, state: "new", pcm: null })),
      voiceId: voiceId || "",
      subs: !!subs || !voiceId,
      duck: Math.max(0, Math.min(1, duckLevel ?? 0.2)),
      wait: wait !== false,
      lastIndex: -1,
      pendingIndex: -1,
      playing: null,
      waiting: false,
      busy: false,
      prepared: 0,
      secPerChar: 0,
      loadingSince: 0,
      errors: 0,
      lastError: "",
      ducked: false,
      baseVolume: video.volume,
    };
    s.listeners = Object.entries(handlers).map(([name, fn]) => {
      const wrapped = () => s && fn();
      video.addEventListener(name, wrapped);
      return [name, wrapped];
    });
    if (!video.paused) ctx.resume().catch(() => {});
    s.timer = setInterval(tick, 100);
    if (s.voiceId) browser.runtime.sendMessage({ cmd: "tts-preload" }).catch(() => {});
    // Фраза, на которой стоит видео, — тоже озвучится, если начнётся не позже чем через START_WINDOW.
    const i = indexAt(video.currentTime);
    if (i >= 0 && video.currentTime - s.cues[i].start > START_WINDOW) s.lastIndex = i;
    pump();
    tick();
  }

  function stop() {
    if (!s) return;
    const old = s;
    clearInterval(old.timer);
    clearTimeout(old.unduckTimer);
    if (old.playing) try { old.playing.source.stop(); } catch {}
    for (const [name, fn] of old.listeners || []) old.video.removeEventListener(name, fn);
    if (old.ducked) {
      old.selfVolume = true;
      old.video.volume = old.baseVolume;
    }
    subsBox?.remove();
    subsBox = null;
    s = null;
  }

  // Когда будет готова фраза, которую скажем следующей. Синтез идёт по
  // порядку, поэтому ждать придётся и все неготовые фразы перед ней.
  function nextPhrase(t, i) {
    let target = s.waiting ? s.waitIndex : -1;
    if (target < 0) {
      for (let j = Math.max(0, i); j < s.cues.length; j += 1) {
        if (j > s.lastIndex && s.cues[j].state !== "error") {
          target = j;
          break;
        }
      }
    }
    if (target < 0) return null;
    const cue = s.cues[target];
    const inSeconds = Math.max(0, (cue.start - t) / (s.video.playbackRate || 1));
    if (cue.state === "ready") return { index: target + 1, inSeconds, readyIn: 0 };
    if (!s.secPerChar) return { index: target + 1, inSeconds, readyIn: null }; // ещё не замерили
    let chars = 0;
    for (let j = Math.max(0, i); j <= target; j += 1) {
      if (s.cues[j].state === "new" || s.cues[j].state === "loading") chars += Math.max(20, s.cues[j].text.length);
    }
    const loadingFor = s.busy ? (performance.now() - s.loadingSince) / 1000 : 0;
    return { index: target + 1, inSeconds, readyIn: Math.max(0.5, chars * s.secPerChar - loadingFor) };
  }

  // До какого места видео фразы уже озвучены подряд, без пропусков.
  function readyUntil(i) {
    let until = null;
    for (let j = Math.max(0, i); j < s.cues.length; j += 1) {
      const st = s.cues[j].state;
      if (st === "ready" || st === "error" || j <= s.lastIndex) until = s.cues[j].start;
      else break;
    }
    return until;
  }

  function status() {
    if (!s) return { active: false };
    const ready = s.cues.filter((c) => c.state === "ready").length;
    const i = indexAt(s.video.currentTime);
    return {
      active: true,
      total: s.cues.length,
      prepared: s.prepared,
      readyAhead: ready,
      errors: s.errors,
      lastError: s.lastError,
      waiting: s.waiting,
      speaking: s.playing ? s.cues[s.playing.index].text : "",
      position: i + 1,
      voiced: !!s.voiceId,
      subs: s.subs,
      next: s.voiceId ? nextPhrase(s.video.currentTime, i) : null,
      readyUntil: s.voiceId ? readyUntil(i) : null,
      audioBlocked: !!s.voiceId && ctx?.state === "suspended" && !s.video.paused && !s.waiting,
    };
  }

  // YouTube переходит между видео без перезагрузки страницы.
  document.addEventListener("yt-navigate-start", () => stop());

  browser.runtime.onMessage.addListener((msg) => {
    if (typeof msg?.cmd !== "string" || !msg.cmd.startsWith("dub-")) return undefined;
    try {
      if (msg.cmd === "dub-start") start(msg.args);
      else if (msg.cmd === "dub-stop") stop();
      else if (msg.cmd === "dub-config" && s) {
        s.subs = !!msg.args?.subs || !s.voiceId;
        tick();
      }
      return Promise.resolve({ ok: true, result: status() });
    } catch (e) {
      return Promise.resolve({ ok: false, error: String(e?.message || e) });
    }
  });
})();
