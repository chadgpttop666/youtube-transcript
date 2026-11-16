// Мост между окном расширения (popup) и page.js, который живёт внутри страницы YouTube.
const pending = new Map();
let seq = 0;

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.__ytt !== "res") return;
  const done = pending.get(e.data.id);
  if (!done) return;
  pending.delete(e.data.id);
  done({ ok: e.data.ok, result: e.data.result, error: e.data.error });
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd !== "info" && msg?.cmd !== "transcript") return undefined; // dub-* — для dub.js
  return new Promise((resolve) => {
    const id = `${++seq}-${Math.random()}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "страница YouTube не ответила — обнови её (F5)" });
    }, 30000);
    pending.set(id, (res) => {
      clearTimeout(timer);
      // JSON-круг снимает обёртки Firefox (Xray) с объектов, пришедших со страницы
      resolve(JSON.parse(JSON.stringify(res)));
    });
    window.postMessage({ __ytt: "req", id, cmd: msg.cmd, args: msg.args }, location.origin);
  });
});
