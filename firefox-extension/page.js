// Работает в контексте самой страницы YouTube (world: MAIN): видит плеер и ходит
// в YouTube с куками страницы. Общается с content.js через window.postMessage.
(() => {
  if (window.__yttInstalled) return;
  window.__yttInstalled = true;

  // YouTube требует для субтитров PO-токен (&pot=...). Плеер добавляет его сам, когда
  // включаешь субтитры, — поэтому подслушиваем его запросы и запоминаем токен по видео.
  const capturedByVideo = new Map();

  function remember(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.includes("/api/timedtext") || !u.searchParams.get("pot")) return;
      const v = u.searchParams.get("v");
      if (v) capturedByVideo.set(v, u.toString());
    } catch {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input) {
    try { remember(typeof input === "string" ? input : input?.url); } catch {}
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    remember(String(url));
    return origOpen.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (n) => n?.simpleText ?? (n?.runs || []).map((r) => r.text).join("") ?? "";

  function currentVideoId() {
    const u = new URL(location.href);
    return u.searchParams.get("v") || (u.pathname.match(/\/shorts\/([\w-]{11})/) || [])[1] || null;
  }

  function player() {
    return document.querySelector("#shorts-player") && location.pathname.startsWith("/shorts/")
      ? document.querySelector("#shorts-player")
      : document.getElementById("movie_player");
  }

  async function loadPlayerResponse(id) {
    // window.ytInitialPlayerResponse устаревает при переходах между видео без перезагрузки,
    // поэтому сначала спрашиваем сам плеер и проверяем, что это то же видео.
    const candidates = [];
    try { candidates.push(player()?.getPlayerResponse?.()); } catch {}
    candidates.push(window.ytInitialPlayerResponse);
    const hit = candidates.find((pr) => pr?.videoDetails?.videoId === id);
    if (hit) return hit;
    // у удалённого/закрытого видео videoDetails нет — тогда берём ответ страницы как есть
    const initial = window.ytInitialPlayerResponse;
    if (initial?.playabilityStatus?.status && initial.playabilityStatus.status !== "OK"
        && location.href.includes(id)) return initial;

    const html = await (await origFetch(`/watch?v=${id}`, { credentials: "include" })).text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s);
    if (!m) throw new Error("не удалось прочитать данные видео");
    return JSON.parse(m[1]);
  }

  async function getInfo() {
    const id = currentVideoId();
    if (!id) throw new Error("на этой странице нет видео");
    const pr = await loadPlayerResponse(id);
    const ps = pr.playabilityStatus;
    if (ps && ps.status !== "OK" && !pr.videoDetails) {
      throw new Error(ps.reason || textOf(ps.errorScreen?.playerErrorMessageRenderer?.reason) || "видео недоступно");
    }
    const vd = pr.videoDetails || {};
    const list = pr.captions?.playerCaptionsTracklistRenderer || {};
    return {
      videoId: id,
      title: vd.title || "",
      author: vd.author || "",
      tracks: (list.captionTracks || []).map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        name: textOf(t.name),
        kind: t.kind || "",
        translatable: !!t.isTranslatable,
      })),
      translations: (list.translationLanguages || []).map((l) => ({
        languageCode: l.languageCode,
        name: textOf(l.languageName),
      })),
    };
  }

  async function tryJson(url) {
    const r = await origFetch(url, { credentials: "include" });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function capturePoToken(id, track) {
    if (capturedByVideo.has(id)) return capturedByVideo.get(id);
    const p = player();
    if (!p) return null;

    // Включаем субтитры программно — плеер сам запросит их с токеном.
    let wasOn = false;
    try {
      const cur = p.getOption?.("captions", "track");
      wasOn = !!(cur && Object.keys(cur).length);
      p.loadModule?.("captions");
      p.setOption?.("captions", "track", { languageCode: track.languageCode, kind: track.kind || undefined });
    } catch {}
    for (let i = 0; i < 30 && !capturedByVideo.has(id); i++) await sleep(100);

    // Запасной путь — дважды нажать кнопку CC (включить и вернуть как было).
    const btn = document.querySelector(".ytp-subtitles-button");
    if (!capturedByVideo.has(id) && btn) {
      btn.click();
      for (let i = 0; i < 30 && !capturedByVideo.has(id); i++) await sleep(100);
      btn.click();
    } else if (!wasOn) {
      try { p.unloadModule?.("captions"); } catch {}
    }
    return capturedByVideo.get(id) || null;
  }

  async function fetchTrack(id, track, tlang) {
    const u = new URL(track.baseUrl, location.origin);
    u.searchParams.set("fmt", "json3");
    if (tlang) u.searchParams.set("tlang", tlang);

    let data = await tryJson(u);
    if (data) return data;

    const captured = await capturePoToken(id, track);
    if (!captured) return null;
    // Берём наш URL (нужный язык/перевод) и добавляем недостающие параметры плеера: pot, c, cver…
    const c = new URL(captured);
    for (const [k, v] of c.searchParams) {
      if (!u.searchParams.has(k) && !["tlang", "lang", "kind", "name", "fmt"].includes(k)) {
        u.searchParams.set(k, v);
      }
    }
    return tryJson(u);
  }

  function parseJson3(data) {
    const out = [];
    for (const e of data.events || []) {
      if (!e.segs) continue;
      const text = e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      out.push({ start: (e.tStartMs || 0) / 1000, duration: (e.dDurationMs || 0) / 1000, text });
    }
    return out;
  }

  function findKey(obj, key) {
    const stack = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (key in cur) return cur[key];
      for (const v of Object.values(cur)) stack.push(v);
    }
    return null;
  }

  // Запасной источник — панель «Расшифровка видео» (язык выбирает YouTube).
  async function panelTranscript(id) {
    const cfg = window.ytcfg?.get;
    const context = cfg?.("INNERTUBE_CONTEXT");
    if (!context) return null;
    const headers = {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": String(cfg("INNERTUBE_CONTEXT_CLIENT_NAME") || 1),
      "X-Youtube-Client-Version": String(cfg("INNERTUBE_CONTEXT_CLIENT_VERSION") || ""),
    };
    const post = async (path, body) =>
      (await origFetch(`/youtubei/v1/${path}?prettyPrint=false`, {
        method: "POST", headers, credentials: "include", body: JSON.stringify({ context, ...body }),
      })).json();

    const next = await post("next", { videoId: id });
    const params = findKey(next, "getTranscriptEndpoint")?.params;
    if (!params) return null;
    const res = await post("get_transcript", { params });

    const out = [];
    const stack = [res];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      const seg = cur.transcriptSegmentRenderer;
      if (seg) {
        const text = textOf(seg.snippet).replace(/\s+/g, " ").trim();
        const start = Number(seg.startMs) / 1000;
        if (text) out.push({ start, duration: Number(seg.endMs) / 1000 - start, text });
        continue;
      }
      for (const v of Object.values(cur)) stack.push(v);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  async function getTranscript({ track, tlang }) {
    const id = currentVideoId();
    const data = await fetchTrack(id, track, tlang);
    const snippets = data ? parseJson3(data) : [];
    if (snippets.length) return { snippets, source: "captions" };

    if (!tlang) {
      const panel = await panelTranscript(id).catch(() => null);
      if (panel?.length) return { snippets: panel, source: "panel" };
    }
    throw new Error("YouTube не отдал субтитры. Включи субтитры (CC) в плеере и попробуй ещё раз.");
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.__ytt !== "req") return;
    const { id, cmd, args } = e.data;
    try {
      let result;
      if (cmd === "info") result = await getInfo();
      else if (cmd === "transcript") result = await getTranscript(args);
      else throw new Error(`неизвестная команда ${cmd}`);
      window.postMessage({ __ytt: "res", id, ok: true, result }, location.origin);
    } catch (err) {
      window.postMessage({ __ytt: "res", id, ok: false, error: String(err?.message || err) }, location.origin);
    }
  });
})();
