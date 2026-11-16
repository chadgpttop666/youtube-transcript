// Окно расширения прямо на странице YouTube и кнопка для него в плеере.
//
// Всплывающее окошко Firefox закрывается от любого щелчка по странице, а
// боковая панель видна во всех вкладках окна. Панель на странице живёт только
// в своей вкладке, не закрывается, пока её не закроешь сам, и её можно
// перетаскивать и растягивать. Внутри — та же страница расширения
// (popup.html) во фрейме: страница YouTube до её содержимого не дотянется.
(() => {
  if (window.__yttPanel) return;
  window.__yttPanel = true;

  const SVG = "http://www.w3.org/2000/svg";
  const DEFAULT_RECT = { top: 72, right: 24, width: 360, height: 560 };
  let host = null;
  let frame = null;
  let button = null;

  const svgEl = (name, attrs) => {
    const el = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // ── Панель ──────────────────────────────────────────────────────────
  async function savedRect() {
    try {
      const { panelRect } = await browser.storage.local.get("panelRect");
      return { ...DEFAULT_RECT, ...panelRect };
    } catch {
      return { ...DEFAULT_RECT };
    }
  }

  function placeWithinViewport(rect) {
    const width = Math.min(Math.max(280, rect.width), window.innerWidth - 16);
    const height = Math.min(Math.max(240, rect.height), window.innerHeight - 16);
    const left = Math.min(Math.max(8, window.innerWidth - rect.right - width), window.innerWidth - width - 8);
    const top = Math.min(Math.max(8, rect.top), window.innerHeight - height - 8);
    Object.assign(host.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  function rememberRect() {
    const r = host.getBoundingClientRect();
    const panelRect = { top: Math.round(r.top), right: Math.round(window.innerWidth - r.right), width: Math.round(r.width), height: Math.round(r.height) };
    browser.storage.local.set({ panelRect }).catch(() => {});
  }

  async function createPanel() {
    host = document.createElement("div");
    host.id = "ytt-panel";
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      zIndex: "2147483000",
      display: "flex",
      flexDirection: "column",
      background: "#1f1f23",
      border: "1px solid rgba(127, 127, 127, 0.45)",
      borderRadius: "10px",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.35)",
      overflow: "hidden",
      resize: "both",
      minWidth: "280px",
      minHeight: "240px",
    });

    // Полоска сверху: за неё панель перетаскивают, × закрывает.
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      all: "initial",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "0 4px 0 12px",
      height: "30px",
      flex: "0 0 auto",
      background: "#2a2a30",
      color: "#ececf1",
      font: "600 12px/1 system-ui, 'Segoe UI', sans-serif",
      cursor: "move",
      userSelect: "none",
    });
    const title = document.createElement("span");
    title.textContent = "YouTube → транскрипция";
    Object.assign(title.style, { all: "initial", flex: "1", color: "inherit", font: "inherit", cursor: "inherit" });
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Закрыть (озвучка продолжится)";
    Object.assign(close.style, {
      all: "initial",
      width: "26px",
      height: "26px",
      borderRadius: "6px",
      color: "#ececf1",
      font: "20px/26px system-ui, sans-serif",
      textAlign: "center",
      cursor: "pointer",
    });
    close.addEventListener("click", hidePanel);
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.append(title, close);

    frame = document.createElement("iframe");
    const tabId = await browser.runtime.sendMessage({ cmd: "whoami" }).catch(() => null);
    frame.src = browser.runtime.getURL(`popup.html?embedded=1${tabId != null ? `&tab=${tabId}` : ""}`);
    frame.setAttribute("allow", "clipboard-write");
    Object.assign(frame.style, { all: "initial", flex: "1", width: "100%", border: "0", display: "block", background: "#1f1f23" });

    host.append(bar, frame);
    enableDrag(bar);
    // Конец растягивания за уголок — запоминаем размер.
    host.addEventListener("pointerup", () => setTimeout(rememberRect, 0));
    placeWithinViewport(await savedRect());
    mount();
  }

  function enableDrag(bar) {
    let start = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = host.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      bar.setPointerCapture(e.pointerId);
      frame.style.pointerEvents = "none"; // иначе фрейм «съест» движение мыши
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!start) return;
      const left = Math.min(Math.max(0, start.left + e.clientX - start.x), window.innerWidth - 60);
      const top = Math.min(Math.max(0, start.top + e.clientY - start.y), window.innerHeight - 30);
      Object.assign(host.style, { left: `${left}px`, top: `${top}px` });
    });
    const end = () => {
      if (!start) return;
      start = null;
      frame.style.pointerEvents = "";
      rememberRect();
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  // В полноэкранном режиме видно только содержимое полноэкранного элемента.
  // Перенос фрейма перезагружает его, но черновик и настройки сохранены.
  function mount() {
    const parent = document.fullscreenElement || document.body;
    if (host && host.parentElement !== parent) parent.appendChild(host);
  }

  async function showPanel() {
    if (!host) await createPanel();
    host.style.display = "flex";
    mount();
    updateButton();
  }

  function hidePanel() {
    if (host) host.style.display = "none";
    updateButton();
  }

  const isOpen = () => !!host && host.style.display !== "none";
  const togglePanel = () => (isOpen() ? hidePanel() : showPanel());

  // ── Кнопка в плеере ─────────────────────────────────────────────────
  function makeButton() {
    const b = document.createElement("button");
    b.className = "ytp-button ytt-player-button";
    b.title = "Транскрипция и озвучка";
    b.setAttribute("aria-label", "Транскрипция и озвучка");
    Object.assign(b.style, { display: "inline-flex", alignItems: "center", justifyContent: "center", alignSelf: "center", padding: "0", margin: "0" });
    const svg = svgEl("svg", { viewBox: "0 0 24 24", width: "24", height: "24" });
    svg.style.display = "block";
    // Облачко реплики с двумя строками текста.
    svg.append(
      svgEl("path", { d: "M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z", fill: "none", stroke: "#fff", "stroke-width": "2", "stroke-linejoin": "round" }),
      svgEl("path", { d: "M7.5 9h9M7.5 12.5h6", stroke: "#fff", "stroke-width": "2", "stroke-linecap": "round" }),
    );
    b.append(svg);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel();
    });
    return b;
  }

  function updateButton() {
    if (!button) return;
    button.style.opacity = isOpen() ? "1" : "";
    button.setAttribute("aria-pressed", String(isOpen()));
  }

  // Размер берём у соседней кнопки плеера (например, «Субтитры»): у старого и
  // нового оформления YouTube кнопки и значки разного размера.
  function matchSiblings(controls) {
    const ref = [...controls.querySelectorAll(".ytp-button")]
      .find((b) => b !== button && b.offsetWidth > 0 && b.querySelector("svg")?.getBoundingClientRect().height > 0);
    if (!ref) return;
    const rs = getComputedStyle(ref);
    const icon = ref.querySelector("svg").getBoundingClientRect();
    const size = Math.round(Math.min(icon.width, icon.height));
    Object.assign(button.style, { width: rs.width, height: rs.height });
    const svg = button.querySelector("svg");
    if (size >= 12 && svg.getAttribute("width") !== String(size)) {
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
    }
  }

  // YouTube перестраивает плеер при переходах, поэтому кнопку проверяем почаще.
  function ensureButton() {
    const controls = document.querySelector("#movie_player .ytp-right-controls");
    if (!controls) return;
    if (!(button?.isConnected && button.parentElement === controls)) {
      button ??= makeButton();
      controls.prepend(button);
      updateButton();
    }
    matchSiblings(controls);
  }

  setInterval(ensureButton, 1500);
  document.addEventListener("yt-navigate-finish", ensureButton);
  document.addEventListener("fullscreenchange", () => isOpen() && mount());
  window.addEventListener("resize", () => {
    if (isOpen()) placeWithinViewport({ ...DEFAULT_RECT, ...readRect() });
  });

  function readRect() {
    const r = host.getBoundingClientRect();
    return { top: r.top, right: window.innerWidth - r.right, width: r.width, height: r.height };
  }

  // Адрес страницы панель узнаёт отсюда, а не из tabs.get: Firefox отдаёт
  // адрес вкладки не всегда (зависит от выданных разрешений).
  // Переход к другому видео без перезагрузки — даём панели знать.
  const notifyFrame = () => frame?.contentWindow?.postMessage({ ytt: "page-changed" }, "*");
  document.addEventListener("yt-navigate-finish", notifyFrame);
  window.addEventListener("popstate", notifyFrame);

  browser.runtime.onMessage.addListener((msg) => {
    // Значок расширения на панели инструментов Firefox — тоже открывает панель.
    if (msg?.cmd === "panel-toggle") return Promise.resolve(togglePanel()).then(() => ({ ok: true }));
    if (msg?.cmd === "page-url") return Promise.resolve({ ok: true, url: location.href });
    return undefined;
  });
})();
