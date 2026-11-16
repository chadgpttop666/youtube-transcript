// Форматы вывода и имена файлов — те же правила, что в yt_transcript.py.
const YTT = (() => {
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  function fmtTime(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function cueTime(sec, sep) {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
  }

  // У автосубтитров фразы налезают друг на друга — обрезаем конец по началу следующей.
  function withEnds(snippets) {
    return snippets.map((s, i) => {
      let end = s.start + Math.max(s.duration, 0.5);
      const next = snippets[i + 1];
      if (next && next.start > s.start && next.start < end) end = next.start;
      return { ...s, end };
    });
  }

  function render(snippets, format, timestamps) {
    if (format === "json") {
      return JSON.stringify(snippets.map(({ text, start, duration }) => ({ text, start, duration })), null, 2);
    }
    if (format === "srt") {
      return withEnds(snippets)
        .map((s, i) => `${i + 1}\n${cueTime(s.start, ",")} --> ${cueTime(s.end, ",")}\n${s.text}\n`)
        .join("\n");
    }
    if (format === "vtt") {
      return "WEBVTT\n\n" + withEnds(snippets)
        .map((s) => `${cueTime(s.start, ".")} --> ${cueTime(s.end, ".")}\n${s.text}\n`)
        .join("\n");
    }
    return snippets.map((s) => (timestamps ? `[${fmtTime(s.start)}] ${s.text}` : s.text)).join("\n");
  }

  function safeName(text, maxLen = 150) {
    text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
    return text.slice(0, maxLen).replace(/[ .]+$/, "") || "untitled";
  }

  function fileStem(title, channel) {
    if (!title) return null;
    if (channel && !title.toLowerCase().startsWith(channel.toLowerCase())) {
      return safeName(`${channel} - ${title}`);
    }
    return safeName(title);
  }

  return { render, safeName, fileStem };
})();
