"""Распознавание речи видео через Groq Whisper — для роликов без субтитров.

Звук скачивается yt-dlp, пережимается в лёгкий opus (16 кГц, моно) и отправляется
в Groq. Бесплатный тариф принимает файлы до 25 МБ, поэтому длинные ролики режутся на куски.
"""

import tempfile
import time
from pathlib import Path

import av
import requests
import yt_dlp
from youtube_transcript_api import FetchedTranscript, FetchedTranscriptSnippet

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3"
CHUNK_SECONDS = 60 * 60  # ~20 МБ в ogg/opus — с запасом до лимита Groq в 25 МБ
BITRATE = 32_000
RATE = 16_000


def download_audio(video_id, workdir, proxy=None):
    opts = {
        "format": "bestaudio[abr<=80]/worstaudio/bestaudio",
        "outtmpl": str(Path(workdir) / "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 30,
        "retries": 3,
    }
    if proxy:
        opts["proxy"] = proxy
    try:
        import deno  # JS-движок: без него YouTube отдаёт урезанный/замедленный список форматов
        opts["js_runtimes"] = {"deno": {"path": deno.find_deno_bin()}}
    except Exception:
        pass
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
            return Path(ydl.prepare_filename(info))
    except yt_dlp.utils.DownloadError as e:
        if "googlevideo.com" in str(e) and "timed out" in str(e):
            raise RuntimeError(
                "звук не скачивается: сервер googlevideo.com не отвечает. Обычно это значит, "
                "что VPN пускает googlevideo.com мимо туннеля — включи в VPN глобальный режим "
                "или добавь googlevideo.com в проксируемые домены"
            ) from None
        raise


def split_to_opus(src, workdir, chunk_seconds=CHUNK_SECONDS):
    """Перекодирует звук в куски opus. Возвращает [(путь, смещение в секундах)]."""
    chunks = []
    out = stream = None
    chunk_start = 0.0

    def close():
        for packet in stream.encode(None):
            out.mux(packet)
        out.close()

    with av.open(str(src)) as inp:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE, frame_size=320)
        for frame in inp.decode(audio=0):
            t = float(frame.time or 0)
            if out is None or t - chunk_start >= chunk_seconds:
                if out is not None:
                    close()
                chunk_start = t if out is not None else 0.0
                path = Path(workdir) / f"chunk{len(chunks):03d}.ogg"
                out = av.open(str(path), "w", format="ogg")
                stream = out.add_stream("libopus", rate=RATE, layout="mono")
                stream.bit_rate = BITRATE
                chunks.append((path, chunk_start))
            for f in resampler.resample(frame):
                f.pts = None
                for packet in stream.encode(f):
                    out.mux(packet)
        if out is not None:
            for f in resampler.resample(None):
                f.pts = None
                for packet in stream.encode(f):
                    out.mux(packet)
            close()
    return chunks


def groq_transcribe(path, api_key, proxy=None, retries=5):
    proxies = {"http": proxy, "https": proxy} if proxy else None
    for attempt in range(retries):
        with open(path, "rb") as f:
            r = requests.post(
                GROQ_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (path.name, f, "audio/ogg")},
                data={"model": MODEL, "response_format": "verbose_json", "temperature": "0"},
                proxies=proxies,
                timeout=600,
            )
        if r.status_code == 429 and attempt < retries - 1:
            wait = float(r.headers.get("retry-after", 30))
            time.sleep(min(wait, 600))
            continue
        if r.status_code == 401:
            raise RuntimeError("Groq отклонил ключ (401) — проверь API key")
        if not r.ok:
            raise RuntimeError(f"Groq ответил {r.status_code}: {r.text[:300]}")
        return r.json()
    raise RuntimeError("Groq: превышен лимит запросов, попробуй позже")


def transcribe_video(video_id, api_key, proxy=None, log=print):
    """Скачивает звук и распознаёт его. Возвращает FetchedTranscript."""
    snippets = []
    language = "unknown"
    with tempfile.TemporaryDirectory(prefix="yt_asr_") as workdir:
        log("   субтитров нет — скачиваю звук…")
        src = download_audio(video_id, workdir, proxy)
        log("   готовлю звук для распознавания…")
        chunks = split_to_opus(src, workdir)
        for i, (path, offset) in enumerate(chunks, 1):
            suffix = f" (часть {i}/{len(chunks)})" if len(chunks) > 1 else ""
            log(f"   распознаю через Groq{suffix}…")
            data = groq_transcribe(path, api_key, proxy)
            language = data.get("language") or language
            for seg in data.get("segments") or []:
                text = seg["text"].strip()
                if text:
                    snippets.append(FetchedTranscriptSnippet(
                        text=text,
                        start=offset + seg["start"],
                        duration=seg["end"] - seg["start"],
                    ))
    return FetchedTranscript(
        snippets=snippets,
        video_id=video_id,
        language=f"{language} (Whisper)",
        language_code="whisper",
        is_generated=True,
    )
