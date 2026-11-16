// Перевод для озвучки → фразы с временем: [{ start, text }], по возрастанию.
// Понимает строки «[мм:сс] текст» (так сохраняют таймкоды и это расширение,
// и yt_gui), «мм:сс текст», «(чч:мм:сс) текст», а также SRT и VTT.
const YTTCues = (() => {
  const TIME = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`;
  const STAMPED_LINE = new RegExp(String.raw`^\s*[\[(]?${TIME}[\])]?\s*(?:[-–—|:]\s*)?(.*)$`);
  const CUE_LINE = new RegExp(String.raw`${TIME}\s*-->\s*${TIME}`);
  const SENTENCE_END = /[.!?…;:»"')\]]$/;

  const seconds = (h, m, s, ms) => (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, "0")) / 1000 : 0);
  // Пометки звуков вместо речи: [Музыка], [Аплодисменты], (смех), ♪ … ♪.
  // Их не зачитываем: квадратные скобки — всегда пометка, круглые — только
  // если внутри одно из звуковых слов (в круглых бывает и обычный текст).
  const SOUND_WORDS = String.raw`музык\S*|music|аплодисмент\S*|applause|смех|смеётся|смеется|laugh\S*|` +
    String.raw`вздох\S*|вздыхает|sigh\S*|шум\S*|noise|тишина|silence|песня|пение|singing|звук\S*|sound\S*|` +
    String.raw`крики|кричит|cheer\S*|инструментал\S*|instrumental|неразборчиво|inaudible`;
  const PAREN_SOUND = new RegExp(String.raw`\(\s*(?:${SOUND_WORDS})(?:\s+(?:${SOUND_WORDS}|и|and|&|,))*\s*\)`, "giu");
  const clean = (text) => text
    .replace(/<[^>]*>|\{\\[^}]*\}/g, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(PAREN_SOUND, " ")
    .replace(/[♪♫♬]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  function parseCueFile(text) {
    const cues = [];
    for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
      const lines = block.split("\n");
      const at = lines.findIndex((line) => CUE_LINE.test(line));
      if (at < 0) continue;
      const m = lines[at].match(CUE_LINE);
      cues.push({ start: seconds(m[1], m[2], m[3], m[4]), end: seconds(m[5], m[6], m[7], m[8]), text: clean(lines.slice(at + 1).join(" ")) });
    }
    return cues;
  }

  function parseStamped(text) {
    const cues = [];
    let skipped = 0;
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(STAMPED_LINE);
      if (m) {
        cues.push({ start: seconds(m[1], m[2], m[3], m[4]), text: clean(m[5]) });
      } else if (cues.length) {
        // перевод одной фразы на нескольких строках
        cues[cues.length - 1].text = clean(`${cues[cues.length - 1].text} ${line}`);
      } else {
        skipped += 1;
      }
    }
    return { cues, skipped };
  }

  // Автосубтитры режут речь на обрывки по 2–3 секунды. Озвученные по
  // отдельности, они звучат рвано — склеиваем до конца предложения.
  function mergeSentences(cues, maxSeconds = 12) {
    const out = [];
    for (const cue of cues) {
      const last = out[out.length - 1];
      if (last && !SENTENCE_END.test(last.text) && cue.start - last.start < maxSeconds) {
        last.text = `${last.text} ${cue.text}`;
        if (cue.end !== undefined) last.end = cue.end;
      } else {
        out.push({ ...cue });
      }
    }
    return out;
  }

  /**
   * @returns {{ cues: {start:number, end?:number, text:string}[], format: string, skipped: number }}
   * @throws если таймкодов нет вовсе
   */
  function parse(text, { merge = true } = {}) {
    const isCueFile = CUE_LINE.test(text);
    const parsed = isCueFile ? { cues: parseCueFile(text), skipped: 0 } : parseStamped(text);
    let cues = parsed.cues.filter((cue) => cue.text).sort((a, b) => a.start - b.start);
    if (!cues.length && parsed.cues.length) {
      throw new Error("Здесь только пометки вроде [Музыка] — озвучивать нечего.");
    }
    if (!cues.length) {
      throw new Error("Не нашёл таймкодов. Нужны строки вида «[01:23] текст» или SRT — без них непонятно, когда что говорить.");
    }
    if (merge) cues = mergeSentences(cues);
    return {
      cues: cues.map(({ start, end, text }) => (end > start ? { start, end, text } : { start, text })),
      format: isCueFile ? "srt" : "stamped",
      skipped: parsed.skipped,
    };
  }

  return { parse };
})();

if (typeof module !== "undefined") module.exports = YTTCues;
