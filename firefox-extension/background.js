// Фоновая страница: сохраняет файлы и передаёт фразы озвучки в PDF-читалку.
const PDF_READER = "pdf-reader@chadgpttop666.github.io";
const READER_COMMANDS = new Set(["tts-render", "tts-voices", "tts-preload"]);

// Окно расширения — панель прямо на странице YouTube (panel.js). Значок на
// панели инструментов открывает и закрывает её в текущей вкладке.
browser.action.onClicked.addListener(async (tab) => {
  try {
    await browser.tabs.sendMessage(tab.id, { cmd: "panel-toggle" });
  } catch {
    // Не YouTube или вкладка открыта до установки расширения — подскажем значком.
    const youtube = /^https:\/\/www\.youtube\.com\//.test(tab.url || "");
    await browser.action.setBadgeText({ tabId: tab.id, text: youtube ? "F5" : "YT" });
    await browser.action.setTitle({
      tabId: tab.id,
      title: youtube ? "Обнови страницу (F5) — тогда панель откроется" : "Открой видео на YouTube — панель открывается там",
    });
    setTimeout(() => browser.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {}), 4000);
  }
});

// Скачивание делается здесь, а не в окне расширения: так оно не зависит от
// того, открыта ли панель, пока идёт диалог «Сохранить как».
async function download({ text, filename, saveAs }) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  try {
    return await browser.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// Голос TeraTTS живёт в PDF-читалке: там скачанные голоса, ускоритель и
// словарь ударений. Content scripts писать другим расширениям не могут — через нас.
async function toReader({ cmd, text, voiceId }) {
  try {
    return await browser.runtime.sendMessage(PDF_READER, { type: cmd, text, voiceId });
  } catch (e) {
    if (/establish connection|Receiving end|does not exist/i.test(e?.message || "")) {
      throw new Error("Нужна PDF-читалка 0.29 или новее с голосами TeraTTS — она и озвучивает перевод.");
    }
    throw e;
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  // Панели на странице нужен номер своей вкладки, а сама она его не знает.
  if (msg?.cmd === "whoami") return Promise.resolve(sender.tab?.id ?? null);
  if (msg?.cmd === "download") return download(msg);
  if (READER_COMMANDS.has(msg?.cmd)) return toReader(msg);
  return undefined;
});
