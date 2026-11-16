"""Окно для скачивания транскрипций YouTube. Запуск: двойной клик или `python yt_gui.pyw`."""

import json
import os
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, ttk

from yt_transcript import (FORMATS, download, error_text, extract_video_id, make_api,
                           resolve_proxy)

HERE = Path(__file__).resolve().parent
SETTINGS_FILE = HERE / "settings.json"
DEFAULTS = {
    "out": str(HERE / "transcripts"),
    "lang": "ru en",
    "format": "txt",
    "timestamps": False,
    "id_name": False,
    "translate": "",
    "proxy": "",
    "groq_key": "",
}


def load_settings():
    try:
        return {**DEFAULTS, **json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))}
    except Exception:
        return dict(DEFAULTS)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("YouTube → транскрипция")
        self.minsize(560, 480)
        self.events = queue.Queue()
        self.worker = None

        s = load_settings()
        self.out = tk.StringVar(value=s["out"])
        self.lang = tk.StringVar(value=s["lang"])
        self.fmt = tk.StringVar(value=s["format"])
        self.timestamps = tk.BooleanVar(value=s["timestamps"])
        self.id_name = tk.BooleanVar(value=s["id_name"])
        self.translate = tk.StringVar(value=s["translate"])
        self.proxy = tk.StringVar(value=s["proxy"])
        self.groq_key = tk.StringVar(value=s["groq_key"])

        self.build()
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.after(100, self.poll)

    # ---------- интерфейс ----------
    def build(self):
        root = ttk.Frame(self, padding=12)
        root.pack(fill="both", expand=True)
        root.columnconfigure(1, weight=1)

        head = ttk.Frame(root)
        head.grid(row=0, column=0, columnspan=3, sticky="ew")
        ttk.Label(head, text="Ссылки на видео (по одной на строку):").pack(side="left")
        ttk.Button(head, text="Вставить", command=self.paste).pack(side="right")
        ttk.Button(head, text="Очистить", command=lambda: self.links.delete("1.0", "end")).pack(side="right", padx=4)

        self.links = tk.Text(root, height=7, wrap="none", undo=True)
        self.links.grid(row=1, column=0, columnspan=3, sticky="nsew", pady=(4, 10))
        root.rowconfigure(1, weight=1)

        ttk.Label(root, text="Папка:").grid(row=2, column=0, sticky="w")
        ttk.Entry(root, textvariable=self.out).grid(row=2, column=1, sticky="ew", padx=6)
        ttk.Button(root, text="Выбрать…", command=self.choose_dir).grid(row=2, column=2)

        opts = ttk.Frame(root)
        opts.grid(row=3, column=0, columnspan=3, sticky="ew", pady=8)
        ttk.Label(opts, text="Языки:").pack(side="left")
        ttk.Entry(opts, textvariable=self.lang, width=10).pack(side="left", padx=(4, 12))
        ttk.Label(opts, text="Формат:").pack(side="left")
        ttk.Combobox(opts, textvariable=self.fmt, values=list(FORMATS), width=6,
                     state="readonly").pack(side="left", padx=(4, 12))
        ttk.Checkbutton(opts, text="Таймкоды", variable=self.timestamps).pack(side="left", padx=(0, 12))
        ttk.Checkbutton(opts, text="Имя по ID", variable=self.id_name).pack(side="left")

        extra = ttk.Frame(root)
        extra.grid(row=4, column=0, columnspan=3, sticky="ew")
        extra.columnconfigure(3, weight=1)
        ttk.Label(extra, text="Перевести на:").grid(row=0, column=0, sticky="w")
        ttk.Entry(extra, textvariable=self.translate, width=6).grid(row=0, column=1, padx=(4, 12))
        ttk.Label(extra, text="Прокси (пусто = авто):").grid(row=0, column=2, sticky="w")
        ttk.Entry(extra, textvariable=self.proxy).grid(row=0, column=3, sticky="ew", padx=(4, 0))
        ttk.Label(extra, text="Ключ Groq:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        key_entry = ttk.Entry(extra, textvariable=self.groq_key, show="•")
        key_entry.grid(row=1, column=1, columnspan=3, sticky="ew", padx=(4, 0), pady=(6, 0))
        ttk.Label(extra, text="для видео без субтитров — распознать речь (console.groq.com)",
                  foreground="#777").grid(row=2, column=1, columnspan=3, sticky="w", padx=(4, 0))

        btns = ttk.Frame(root)
        btns.grid(row=5, column=0, columnspan=3, sticky="ew", pady=10)
        self.go_btn = ttk.Button(btns, text="Скачать", command=self.start)
        self.go_btn.pack(side="left")
        ttk.Button(btns, text="Открыть папку", command=self.open_dir).pack(side="left", padx=6)
        self.progress = ttk.Progressbar(btns, mode="determinate")
        self.progress.pack(side="left", fill="x", expand=True, padx=(6, 0))

        self.log = tk.Text(root, height=8, state="disabled", wrap="word", bg="#f6f6f6")
        self.log.grid(row=6, column=0, columnspan=3, sticky="nsew")
        self.log.tag_config("ok", foreground="#1a7f37")
        self.log.tag_config("err", foreground="#c62828")
        root.rowconfigure(6, weight=1)

        self.bind("<Control-Return>", lambda e: self.start())

    def write(self, text, tag=None):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n", tag)
        self.log.see("end")
        self.log.configure(state="disabled")

    def paste(self):
        try:
            text = self.clipboard_get().strip()
        except tk.TclError:
            return
        current = self.links.get("1.0", "end").strip()
        self.links.insert("end", ("\n" if current else "") + text)

    def choose_dir(self):
        path = filedialog.askdirectory(initialdir=self.out.get() or str(HERE))
        if path:
            self.out.set(path)

    def open_dir(self):
        path = Path(self.out.get())
        path.mkdir(parents=True, exist_ok=True)
        os.startfile(path)

    # ---------- скачивание ----------
    def start(self):
        if self.worker and self.worker.is_alive():
            return
        urls = [u.strip() for u in self.links.get("1.0", "end").split() if u.strip()]
        if not urls:
            self.write("Вставь хотя бы одну ссылку.", "err")
            return
        self.save_settings()
        self.go_btn.configure(state="disabled")
        self.progress.configure(maximum=len(urls), value=0)
        params = dict(
            out_dir=Path(self.out.get() or DEFAULTS["out"]),
            languages=self.lang.get().split() or ["ru", "en"],
            fmt=self.fmt.get(),
            timestamps=self.timestamps.get(),
            translate=self.translate.get().strip() or None,
            id_name=self.id_name.get(),
            proxy=self.proxy.get().strip() or None,
            groq_key=self.groq_key.get().strip() or None,
        )
        self.worker = threading.Thread(target=self.run, args=(urls, params), daemon=True)
        self.worker.start()

    def run(self, urls, params):
        ok = 0
        try:
            params["out_dir"].mkdir(parents=True, exist_ok=True)
            if not params["proxy"]:
                params["proxy"] = resolve_proxy(None)
                if params["proxy"]:
                    self.events.put(("log", f"YouTube напрямую недоступен, использую системный прокси {params['proxy']}", None))
            api = make_api(params["proxy"])
        except Exception as e:
            self.events.put(("log", f"Ошибка: {error_text(e)}", "err"))
            self.events.put(("done", 0, len(urls)))
            return
        for i, url in enumerate(urls, 1):
            self.events.put(("log", f"[{i}/{len(urls)}] {url}", None))
            try:
                video_id = extract_video_id(url)
                log = lambda msg: self.events.put(("log", msg, None))
                path, language = download(api, video_id, log=log, **params)
                self.events.put(("log", f"   ✓ {path.name}  ({language})", "ok"))
                ok += 1
            except Exception as e:
                self.events.put(("log", f"   ✗ {error_text(e)}", "err"))
            self.events.put(("progress", i))
        self.events.put(("done", ok, len(urls)))

    def poll(self):
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "log":
                    self.write(event[1], event[2])
                elif event[0] == "progress":
                    self.progress.configure(value=event[1])
                elif event[0] == "done":
                    ok, total = event[1], event[2]
                    self.write(f"Готово: {ok} из {total}.\n", "ok" if ok == total else "err")
                    self.go_btn.configure(state="normal")
        except queue.Empty:
            pass
        self.after(100, self.poll)

    # ---------- настройки ----------
    def save_settings(self):
        data = {
            "out": self.out.get(),
            "lang": self.lang.get(),
            "format": self.fmt.get(),
            "timestamps": self.timestamps.get(),
            "id_name": self.id_name.get(),
            "translate": self.translate.get(),
            "proxy": self.proxy.get(),
            "groq_key": self.groq_key.get().strip(),
        }
        try:
            SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def on_close(self):
        self.save_settings()
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
