"""Скачивание транскрипции (субтитров) с YouTube.

Примеры:
    python yt_transcript.py https://www.youtube.com/watch?v=dQw4w9WgXcQ
    python yt_transcript.py dQw4w9WgXcQ -l ru en -f srt
    python yt_transcript.py URL1 URL2 -o transcripts --timestamps
    python yt_transcript.py URL --list
    python yt_transcript.py URL --proxy http://127.0.0.1:8080
"""

import argparse
import json
import os
import re
import socket
import sys
import threading
from html import unescape
from pathlib import Path

import requests
from youtube_transcript_api import NoTranscriptFound, TranscriptsDisabled, YouTubeTranscriptApi
from youtube_transcript_api.proxies import GenericProxyConfig
from youtube_transcript_api.formatters import (
    JSONFormatter,
    SRTFormatter,
    TextFormatter,
    WebVTTFormatter,
)

FORMATS = {
    "txt": TextFormatter,
    "srt": SRTFormatter,
    "vtt": WebVTTFormatter,
    "json": JSONFormatter,
}

ID_RE = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([\w-]{11})")


def extract_video_id(value: str) -> str:
    match = ID_RE.search(value)
    if match:
        return match.group(1)
    if re.fullmatch(r"[\w-]{11}", value):
        return value
    raise ValueError(f"Не удалось распознать ID видео: {value}")


def youtube_reachable(timeout: float = 3) -> bool:
    """Резолвится ли youtube.com без прокси (DNS при блокировке может висеть долго)."""
    result = []

    def probe():
        try:
            socket.getaddrinfo("www.youtube.com", 443)
            result.append(True)
        except OSError:
            pass

    thread = threading.Thread(target=probe, daemon=True)
    thread.start()
    thread.join(timeout)
    return bool(result)


def system_proxy():
    """Прокси из настроек Windows (его прописывают VPN-клиенты вроде v2RayN/v2RayTun)."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        server = winreg.QueryValueEx(key, "ProxyServer")[0].strip()
    except Exception:
        return None
    if not server:
        return None
    if "=" in server:  # формат "http=host:port;https=host:port"
        parts = dict(p.split("=", 1) for p in server.split(";") if "=" in p)
        server = parts.get("https") or parts.get("http") or next(iter(parts.values()), "")
    return server if "://" in server else f"http://{server}"


def resolve_proxy(proxy):
    """Явный прокси, иначе системный — если YouTube напрямую недоступен."""
    if proxy:
        return proxy
    if youtube_reachable():
        return None
    return system_proxy()


def fetch_meta(video_id, proxy):
    """Название видео и канала: oEmbed, а если не отдал — со страницы видео."""
    proxies = {"http": proxy, "https": proxy} if proxy else None
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        r = requests.get("https://www.youtube.com/oembed",
                         params={"url": url, "format": "json"}, proxies=proxies, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("title"), data.get("author_name")
    except Exception:
        pass
    try:
        html = requests.get(url, proxies=proxies, timeout=20,
                            headers={"Accept-Language": "ru,en;q=0.8"},
                            cookies={"CONSENT": "YES+"}).text
        title = re.search(r'<meta name="title" content="([^"]*)"', html)
        channel = re.search(r'"ownerChannelName":("(?:[^"\\]|\\.)*")', html)
        return (
            unescape(title.group(1)) if title else None,
            json.loads(channel.group(1)) if channel else None,
        )
    except Exception:
        return None, None


def file_stem(title, channel):
    if channel and not title.lower().startswith(channel.lower()):
        return safe_name(f"{channel} - {title}")
    return safe_name(title)


def safe_name(text: str, max_len: int = 150) -> str:
    """Убирает символы, недопустимые в именах файлов Windows."""
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:max_len].rstrip(" .") or "untitled"


def fmt_time(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def fetch(api, video_id, languages, translate):
    transcript_list = api.list(video_id)
    try:
        transcript = transcript_list.find_transcript(languages)
    except Exception:
        # Нужного языка нет — берём первую доступную дорожку
        transcript = next(iter(transcript_list))
    if translate:
        transcript = transcript.translate(translate)
    return transcript, transcript.fetch()


def render(fetched, fmt, timestamps):
    if fmt == "txt" and timestamps:
        return "\n".join(f"[{fmt_time(s.start)}] {s.text}" for s in fetched)
    kwargs = {"indent": 2, "ensure_ascii": False} if fmt == "json" else {}
    return FORMATS[fmt]().format_transcript(fetched, **kwargs)


def make_api(proxy=None):
    config = GenericProxyConfig(http_url=proxy, https_url=proxy) if proxy else None
    return YouTubeTranscriptApi(proxy_config=config)


def download(api, video_id, out_dir, languages, fmt="txt", timestamps=False,
             translate=None, id_name=False, proxy=None, groq_key=None, log=print):
    """Скачивает транскрипцию в файл. Возвращает (путь, язык).

    Если субтитров нет и задан ключ Groq — распознаёт речь через Whisper.
    """
    try:
        transcript, fetched = fetch(api, video_id, languages, translate)
        lang = translate or transcript.language_code
    except (TranscriptsDisabled, NoTranscriptFound):
        if not groq_key:
            raise
        from groq_asr import transcribe_video  # тяжёлые зависимости — грузим только по делу
        transcript = fetched = transcribe_video(video_id, groq_key, proxy, log)
        lang = "whisper"
    text = render(fetched, fmt, timestamps)
    title, channel = (None, None) if id_name else fetch_meta(video_id, proxy)
    stem = file_stem(title, channel) if title else video_id
    path = Path(out_dir) / f"{stem} [{lang}].{fmt}"
    path.write_text(text, encoding="utf-8")
    return path, transcript.language


def error_text(e: Exception) -> str:
    msg = str(e).strip()
    return f"{type(e).__name__}: {msg.splitlines()[0]}" if msg else type(e).__name__


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Скачать транскрипцию YouTube-видео")
    parser.add_argument("videos", nargs="+", help="Ссылки или ID видео")
    parser.add_argument("-l", "--lang", nargs="+", default=["ru", "en"],
                        help="Предпочитаемые языки по приоритету (по умолчанию: ru en)")
    parser.add_argument("-f", "--format", choices=FORMATS, default="txt",
                        help="Формат вывода (по умолчанию: txt)")
    parser.add_argument("-o", "--out", default=".", help="Папка для сохранения")
    parser.add_argument("-t", "--timestamps", action="store_true",
                        help="Добавить таймкоды в txt")
    parser.add_argument("--translate", metavar="LANG",
                        help="Перевести транскрипцию на язык (автоперевод YouTube)")
    parser.add_argument("--list", action="store_true",
                        help="Только показать доступные языки")
    parser.add_argument("--stdout", action="store_true",
                        help="Печатать в консоль вместо файла")
    parser.add_argument("--id-name", action="store_true",
                        help="Называть файл по ID видео, а не «Канал - Название»")
    parser.add_argument("--proxy", metavar="URL",
                        help="Прокси, напр. http://127.0.0.1:8080 или socks5://127.0.0.1:1080")
    parser.add_argument("--groq-key", metavar="KEY", default=os.environ.get("GROQ_API_KEY"),
                        help="Ключ Groq: распознавать речь у видео без субтитров "
                             "(по умолчанию из переменной GROQ_API_KEY)")
    args = parser.parse_args()

    if not args.proxy:
        args.proxy = resolve_proxy(None)
        if args.proxy:
            print(f"YouTube напрямую недоступен, использую системный прокси {args.proxy}")
    api = make_api(args.proxy)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    failed = 0

    for raw in args.videos:
        try:
            video_id = extract_video_id(raw)
            if args.list:
                print(f"\n{video_id}:")
                for t in api.list(video_id):
                    kind = "авто" if t.is_generated else "ручные"
                    print(f"  {t.language_code:8} {t.language} ({kind})")
                continue

            if args.stdout:
                _, fetched = fetch(api, video_id, args.lang, args.translate)
                print(render(fetched, args.format, args.timestamps))
            else:
                path, language = download(
                    api, video_id, out_dir, args.lang, args.format,
                    args.timestamps, args.translate, args.id_name, args.proxy,
                    args.groq_key,
                )
                print(f"OK  {video_id} [{language}] -> {path}")
        except Exception as e:
            failed += 1
            print(f"ERR {raw}: {error_text(e)}", file=sys.stderr)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
