const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  langs: "ru en", format: "txt", timestamps: false, saveAs: false,
  dubVoice: "tera:ru_m5", dubDuck: 20, dubMerge: true, dubWait: true, dubSubs: false, tab: "pane-subs",
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

// Во фрейме на странице YouTube navigator.clipboard может быть недоступен —
// тогда по-старому, через выделение текста.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("не получилось скопировать в буфер обмена");
  }
}

async function run(action) {
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    const { text, filename, count, note } = await buildText();
    if (action === "copy") {
      await copyText(text);
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
    dubSubs: $("dubSubs").checked,
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

const NO_VOICE = "none"; // только субтитры с текстом, без голоса
const noVoiceOption = () => new Option("— без голоса, только субтитры —", NO_VOICE);
let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  try {
    const { voices, installed } = await browser.runtime.sendMessage({ cmd: "tts-voices" });
    $("dubVoice").replaceChildren(...voices.map((v) => new Option(v.name.replace(/^TeraTTS — /, ""), v.id)), noVoiceOption());
    $("dubVoice").value = settings.dubVoice;
    if (!$("dubVoice").value && voices[0]) $("dubVoice").value = voices[0].id;
    voicesLoaded = true;
    if (!installed) setStatus("Голоса TeraTTS не скачаны: PDF-читалка → Настройки → Голоса и модели.", "err");
  } catch (e) {
    // Без читалки голоса нет, но субтитры с текстом показать можно.
    $("dubVoice").replaceChildren(noVoiceOption());
    $("dubVoice").value = NO_VOICE;
    setStatus(e.message, "err");
  }
  updateVoiceMode();
}

function updateVoiceMode() {
  const none = $("dubVoice").value === NO_VOICE;
  $("dubWait").disabled = none;
  $("dubDuck").disabled = none;
  $("dubSubs").disabled = none;
  if (none) $("dubSubs").checked = true;
}

// «≈ 7 с», «≈ 2 мин»
function about(sec) {
  if (sec < 1.5) return "≈ 1 с";
  if (sec < 90) return `≈ ${Math.round(sec)} с`;
  return `≈ ${Math.round(sec / 60)} мин`;
}

const clock = (sec) => {
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

// Сколько ждать озвучку: фраза готовится заранее, поэтому важно, успеет ли
// она к своему таймкоду.
function describeNext(st) {
  const n = st.next;
  if (!n) return "";
  if (n.readyIn === 0) return st.readyUntil != null ? `Озвучено впрок до ${clock(st.readyUntil)}` : "";
  if (n.readyIn == null) return "Готовлю первую фразу… первая дольше: загружается голос";
  if (st.waiting) return `Жду фразу ${n.index}: ${about(n.readyIn)}`;
  const late = n.readyIn > n.inSeconds + 0.5;
  return `Фраза ${n.index} будет готова через ${about(n.readyIn)}` +
    (late ? (st.wait ? " — видео подождёт" : " — может не успеть") : "");
}

function describeDub(st) {
  if (!st?.active) return null;
  if (!st.voiced) {
    return { text: `Фраза ${Math.max(st.position, 0)} из ${st.total} · только субтитры`, kind: "ok" };
  }
  const parts = [`Фраза ${Math.max(st.position, 0)} из ${st.total}`, `озвучено ${st.prepared}`];
  if (st.errors) parts.push(`ошибок ${st.errors}`);
  let line = parts.join(" · ");
  if (st.audioBlocked) return { text: `${line}\nFirefox не даёт играть звук — нажми на видео.`, kind: "err" };
  const next = describeNext({ ...st, wait: $("dubWait").checked });
  if (next) line += `\n${next}`;
  if (st.speaking && !st.waiting) line += `\n«${st.speaking.length > 90 ? `${st.speaking.slice(0, 90)}…` : st.speaking}»`;
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
        voiceId: $("dubVoice").value === NO_VOICE ? "" : $("dubVoice").value || settings.dubVoice,
        duck: Number($("dubDuck").value) / 100,
        wait: $("dubWait").checked,
        subs: $("dubSubs").checked,
      },
    });
    if (!res?.ok) throw new Error(res?.error || "страница не ответила");
    const skipped = parsed.skipped ? ` (строк без таймкода в начале пропущено: ${parsed.skipped})` : "";
    const what = $("dubVoice").value === NO_VOICE ? "Показываю субтитрами" : "Озвучиваю";
    setStatus(`${what} ${parsed.cues.length} фраз${skipped}. Панель можно закрыть.`, "ok");
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
  $("dubSubs").checked = settings.dubSubs;
  for (const id of ["langs", "format", "timestamps", "saveAs", "dubVoice", "dubDuck", "dubMerge", "dubWait", "dubSubs"]) {
    $(id).addEventListener("change", saveSettings);
  }
  $("dubVoice").addEventListener("change", updateVoiceMode);
  // Субтитры включаются и выключаются прямо во время озвучки.
  $("dubSubs").addEventListener("change", () => {
    if (tab) browser.tabs.sendMessage(tab.id, { cmd: "dub-config", args: { subs: $("dubSubs").checked } }).catch(() => {});
  });
  setupFileDrop();
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

  // Панель встроена в страницу YouTube (panel.js) и знает свою вкладку из
  // адреса фрейма. Другие вкладки её не касаются: у каждой своя панель.
  const fromUrl = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(fromUrl) && fromUrl >= 0) ownTabId = fromUrl;
  else [{ id: ownTabId } = {}] = await browser.tabs.query({ active: true, currentWindow: true });
  // YouTube переходит между видео без перезагрузки страницы — panel.js
  // сообщает об этом, а адрес мы всё равно перепроверяем у вкладки сами.
  window.addEventListener("message", async (e) => {
    if (e.source !== window.parent || e.data?.ytt !== "page-changed") return;
    const url = await pageUrl();
    // Тот же ролик (например, сменился только &t=) — не сбрасываем выбранное.
    if (videoKey(url) !== attachedKey) attach();
  });

  await attach();
}

// ── Файл субтитров перетаскиванием ──────────────────────────────────────
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Русские SRT нередко в windows-1251 — если это не UTF-8, читаем так.
async function readTextFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

async function loadSubtitleFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    setStatus(`Файл ${file.name} слишком большой для субтитров.`, "err");
    return;
  }
  const text = await readTextFile(file);
  if (attachedKey) showTab("pane-dub");
  $("dubText").value = text;
  if (!attachedKey) {
    setStatus(`Файл ${file.name} вставлен, но панель не видит видео на этой вкладке — обнови страницу (F5).`, "err");
    return;
  }
  await browser.storage.local.set({ [draftKey()]: text });
  try {
    const { cues } = YTTCues.parse(text, { merge: $("dubMerge").checked });
    setStatus(`Загружен ${file.name}: ${cues.length} фраз. Жми «Озвучить».`, "ok");
  } catch (e) {
    setStatus(`${file.name}: ${e.message}`, "err");
  }
}

function setupFileDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    document.body.classList.add("dropping");
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove("dropping");
  });
  // Без preventDefault Firefox открыл бы файл вместо панели.
  document.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return; // перетащенный текст textarea вставит сама
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dropping");
    const file = e.dataTransfer.files[0];
    if (file) loadSubtitleFile(file).catch((err) => setStatus(`Ошибка: ${err.message}`, "err"));
  });
  $("dubFile").addEventListener("change", () => {
    const file = $("dubFile").files[0];
    $("dubFile").value = "";
    if (file) loadSubtitleFile(file).catch((err) => setStatus(`Ошибка: ${err.message}`, "err"));
  });
}

let ownTabId = null;

// Адрес страницы — у скрипта на ней (panel.js); tabs.get — запасной путь.
async function pageUrl() {
  if (ownTabId == null) return null;
  const res = await browser.tabs.sendMessage(ownTabId, { cmd: "page-url" }).catch(() => null);
  if (res?.url) return res.url;
  return (await browser.tabs.get(ownTabId).catch(() => null))?.url ?? null;
}
let attachedKey = null; // ролик, к которому сейчас подключена панель
let generation = 0;     // защищает от ответов про видео, с которого уже ушли

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
  const url = await pageUrl();
  if (stale()) return;
  tab = ownTabId == null ? null : { id: ownTabId, url };
  attachedKey = videoKey(tab?.url);
  if (!attachedKey) {
    $("title").textContent = "Открой видео на YouTube";
    setStatus("Панель подхватит его сама, когда откроешь видео в этой вкладке.");
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
