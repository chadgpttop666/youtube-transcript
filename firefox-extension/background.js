// Фоновая страница: сохраняет файлы и передаёт фразы озвучки в PDF-читалку.
const PDF_READER = "pdf-reader@chadgpttop666.github.io";
const READER_COMMANDS = new Set(["tts-render", "tts-voices", "tts-preload"]);

// Окно расширения — боковая панель: в отличие от всплывающего окошка она не
// закрывается, когда щёлкаешь по странице. Значок на панели инструментов
// открывает и закрывает её.
browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());

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

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === "download") return download(msg);
  if (READER_COMMANDS.has(msg?.cmd)) return toReader(msg);
  return undefined;
});
