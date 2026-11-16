const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  langs: "ru en", format: "txt", timestamps: false, saveAs: false,
  dubVoice: "tera:ru_m5", dubDuck: 20, dubMerge: true, dubWait: true, tab: "pane-subs",
};
let settings = { ...DEFAULTS };
let tab = null;
let info = null;

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`;
}

async function ask(cmd, args = {}) {
  const res = await browser.tabs.sendMessage(tab.id, { cmd, args });
  if (!res?.ok) throw new Error(res?.error || "нет ответа от страницы");
  return res.result;
}

function pickTrack(tracks) {
  const langs = settings.langs.split(/[\s,]+/).filter(Boolean);
  for (const lang of langs) {
    // как в Python-версии: сначала ручные субтитры на этом языке, потом автоматические
    const manual = tracks.findIndex((t) => t.languageCode.startsWith(lang) && t.kind !== "asr");
    if (manual >= 0) return manual;
    const auto = tracks.findIndex((t) => t.languageCode.startsWith(lang));
    if (auto >= 0) return auto;
  }
  return 0;
}

function trackLabel(t) {
  return t.kind === "asr" && !/авто|auto/i.test(t.name) ? `${t.name} (авто)` : t.name;
}

function updateTranslate() {
  const track = info.tracks[$("track").value];
  $("tlang").disabled = !track?.translatable;
  if ($("tlang").disabled) $("tlang").value = "";
}

function showInfo() {
  $("title").textContent = info.title || info.videoId;
  $("channel").textContent = info.author;
  const onSubs = settings.tab !== "pane-dub";
  if (!info.tracks.length) {
    if (onSubs) setStatus("У этого видео нет субтитров. Распознать речь можно в приложении yt_gui (через Groq).", "err");
    return;
  }
  $("track").replaceChildren(...info.tracks.map((t, i) => new Option(trackLabel(t), i)));
  $("track").value = pickTrack(info.tracks);
  $("tlang").replaceChildren(
    new Option("— без перевода —", ""),
    ...info.translations.map((l) => new Option(l.name, l.languageCode)),
  );
  updateTranslate();
  $("form").hidden = false;
  if (onSubs) setStatus("");
}

async function buildText() {
  const track = info.tracks[$("track").value];
  const tlang = $("tlang").value;
  setStatus("Загружаю субтитры…");
  const { snippets, source } = await ask("transcript", { track, tlang });
  const format = $("format").value;
  const text = YTT.render(snippets, format, $("timestamps").checked);
  const lang = tlang || track.languageCode;
  const stem = YTT.fileStem(info.title, info.author) || info.videoId;
  const note = source === "panel" ? " (из панели «Расшифровка», язык выбрал YouTube)" : "";
  return { text, filename: `${stem} [${lang}].${format}`, count: snippets.length, note };
}

async function run(action) {
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    const { text, filename, count, note } = await buildText();
    if (action === "copy") {
      await navigator.clipboard.writeText(text);
      setStatus(`Скопировано: ${count} фраз${note}`, "ok");
    } else {
      await browser.runtime.sendMessage({ cmd: "download", text, filename, saveAs: settings.saveAs });
      setStatus(`Сохранено: ${filename}${note}`, "ok");
    }
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`, "err");
  } finally {
    for (const b of document.querySelectorAll("button")) b.disabled = false;
  }
}

async function saveSettings() {
  settings = {
    langs: $("langs").value.trim() || DEFAULTS.langs,
    format: $("format").value,
    timestamps: $("timestamps").checked,
    saveAs: $("saveAs").checked,
    dubVoice: $("dubVoice").value || settings.dubVoice,
    dubDuck: Number($("dubDuck").value),
    dubMerge: $("dubMerge").checked,
    dubWait: $("dubWait").checked,
    tab: settings.tab,
  };
  await browser.storage.local.set(settings);
}

// ── Озвучка ─────────────────────────────────────────────────────────────
const RELOAD_HINT = "Обнови вкладку с видео (F5) — расширение подключается к страницам, открытым после его установки.";
const isReloadError = (e) => /Receiving end|establish connection/i.test(e?.message || "");
let pollTimer = 0;
const draftKey = () => `dubText:${new URL(tab.url).searchParams.get("v") || tab.url}`;

function showTab(paneId) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.pane === paneId);
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.id !== paneId;
  settings.tab = paneId;
  browser.storage.local.set({ tab: paneId });
  setStatus("");
  clearInterval(pollTimer);
  if (paneId === "pane-dub") {
    loadVoices();
    pollStatus();
    pollTimer = setInterval(pollStatus, 1000);
  } else if (info && !info.tracks.length) {
    showInfo(); // вернуть сообщение «нет субтитров»
  }
}

let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  try {
    const { voices, installed } = await browser.runtime.sendMessage({ cmd: "tts-voices" });
    $("dubVoice").replaceChildren(...voices.map((v) => new Option(v.name.replace(/^TeraTTS — /, ""), v.id)));
    $("dubVoice").value = settings.dubVoice;
    if (!$("dubVoice").value && voices[0]) $("dubVoice").value = voices[0].id;
    voicesLoaded = true;
    if (!installed) setStatus("Голоса TeraTTS не скачаны: PDF-читалка → Настройки → Голоса и модели.", "err");
  } catch (e) {
    $("dubVoice").replaceChildren(new Option("нет голосов", ""));
    setStatus(e.message, "err");
  }
}

function describeDub(st) {
  if (!st?.active) return null;
  const parts = [`Фраза ${Math.max(st.position, 0)} из ${st.total}`, `озвучено ${st.prepared}`];
  if (st.errors) parts.push(`ошибок ${st.errors}`);
  let line = parts.join(" · ");
  if (st.audioBlocked) return { text: `${line}\nFirefox не даёт играть звук — нажми на видео.`, kind: "err" };
  if (st.waiting) line += "\nЖду, пока озвучится фраза…";
  else if (st.speaking) line += `\n«${st.speaking.length > 90 ? `${st.speaking.slice(0, 90)}…` : st.speaking}»`;
  if (st.lastError) return { text: `${line}\nОшибка: ${st.lastError}`, kind: "err" };
  return { text: line, kind: "ok" };
}

async function pollStatus() {
  const my = generation;
  try {
    const res = await browser.tabs.sendMessage(tab.id, { cmd: "dub-status" });
    if (my !== generation) return; // пока ждали ответ, панель переключилась на другую вкладку
    const d = describeDub(res?.result);
    if (d) setStatus(d.text, d.kind);
    $("dubStop").disabled = !res?.result?.active;
  } catch (e) {
    if (my !== generation) return;
    clearInterval(pollTimer);
    setStatus(isReloadError(e) ? RELOAD_HINT : e.message, "err");
  }
}

async function startDub() {
  const text = $("dubText").value;
  let parsed;
  try {
    parsed = YTTCues.parse(text, { merge: $("dubMerge").checked });
  } catch (e) {
    setStatus(e.message, "err");
    return;
  }
  await browser.storage.local.set({ [draftKey()]: text });
  try {
    const res = await browser.tabs.sendMessage(tab.id, {
      cmd: "dub-start",
      args: {
        cues: parsed.cues,
        voiceId: $("dubVoice").value || settings.dubVoice,
        duck: Number($("dubDuck").value) / 100,
        wait: $("dubWait").checked,
      },
    });
    if (!res?.ok) throw new Error(res?.error || "страница не ответила");
    const skipped = parsed.skipped ? ` (строк без таймкода в начале пропущено: ${parsed.skipped})` : "";
    setStatus(`Озвучиваю ${parsed.cues.length} фраз${skipped}. Панель можно закрыть.`, "ok");
    clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  } catch (e) {
    setStatus(isReloadError(e) ? RELOAD_HINT : `Ошибка: ${e.message}`, "err");
  }
}

async function stopDub() {
  try {
    await browser.tabs.sendMessage(tab.id, { cmd: "dub-stop" });
    setStatus("Озвучка остановлена.");
    $("dubStop").disabled = true;
  } catch (e) {
    setStatus(e.message, "err");
  }
}

async function init() {
  settings = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  $("langs").value = settings.langs;
  $("format").value = settings.format;
  $("timestamps").checked = settings.timestamps;
  $("saveAs").checked = settings.saveAs;
  $("dubDuck").value = settings.dubDuck;
  $("dubDuckValue").textContent = `${settings.dubDuck}%`;
  $("dubMerge").checked = settings.dubMerge;
  $("dubWait").checked = settings.dubWait;
  for (const id of ["langs", "format", "timestamps", "saveAs", "dubVoice", "dubDuck", "dubMerge", "dubWait"]) {
    $(id).addEventListener("change", saveSettings);
  }
  $("dubDuck").addEventListener("input", () => ($("dubDuckValue").textContent = `${$("dubDuck").value}%`));
  $("track").addEventListener("change", updateTranslate);
  $("download").addEventListener("click", () => run("download"));
  $("copy").addEventListener("click", () => run("copy"));
  $("dubStart").addEventListener("click", startDub);
  $("dubStop").addEventListener("click", stopDub);
  for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => showTab(t.dataset.pane));
  $("dubText").addEventListener("input", () => {
    if (attachedKey) browser.storage.local.set({ [draftKey()]: $("dubText").value });
  });

  // Панель живёт, пока открыта, поэтому следит за активной вкладкой своего
  // окна: переключение вкладок, переход к другому видео, перезагрузка.
  windowId = (await browser.windows.getCurrent()).id;
  browser.tabs.onActivated.addListener((a) => {
    if (a.windowId === windowId) attach();
  });
  browser.tabs.onUpdated.addListener((id, change, t) => {
    if (t.windowId !== windowId || !t.active) return;
    // Тот же ролик (например, сменился только &t=) — не сбрасываем выбранное.
    if (change.url && videoKey(change.url) !== attachedKey) attach();
    else if (change.status === "complete") attach();
  }, { properties: ["url", "status"] });

  await attach();
}

let windowId = null;
let attachedKey = null; // ролик, к которому сейчас подключена панель
let generation = 0;     // защищает от ответов страницы, которая уже не активна

function videoKey(url) {
  if (!url || !/^https:\/\/www\.youtube\.com\/(watch|shorts\/)/.test(url)) return null;
  const u = new URL(url);
  return u.searchParams.get("v") || u.pathname;
}

function resetView() {
  clearInterval(pollTimer);
  info = null;
  $("title").textContent = "…";
  $("channel").textContent = "";
  $("tabs").hidden = true;
  $("form").hidden = true;
  for (const p of document.querySelectorAll(".pane")) p.hidden = true;
  $("dubText").value = "";
  setStatus("");
}

async function attach() {
  const my = ++generation;
  const stale = () => my !== generation;
  resetView();
  [tab] = await browser.tabs.query({ active: true, windowId });
  if (stale()) return;
  attachedKey = videoKey(tab?.url);
  if (!attachedKey) {
    $("title").textContent = "Открой видео на YouTube";
    setStatus("Панель подхватит его сама.");
    return;
  }
  $("tabs").hidden = false;
  const draft = (await browser.storage.local.get(draftKey()))[draftKey()];
  if (stale()) return;
  if (draft) $("dubText").value = draft;

  // Идёт озвучка — сразу на её вкладку.
  const dubbing = await browser.tabs.sendMessage(tab.id, { cmd: "dub-status" }).catch(() => null);
  if (stale()) return;
  showTab(dubbing?.result?.active ? "pane-dub" : settings.tab);

  if (settings.tab !== "pane-dub") setStatus("Читаю список субтитров…");
  try {
    const result = await ask("info");
    if (stale()) return;
    info = result;
    showInfo();
  } catch (e) {
    if (stale()) return;
    $("title").textContent = "Не получилось подключиться к странице";
    if (settings.tab !== "pane-dub" || isReloadError(e)) setStatus(isReloadError(e) ? RELOAD_HINT : `Ошибка: ${e.message}`, "err");
  }
}

init();
