// `@remotion/captions`: SRT and WebVTT parsing, SRT writing, and TikTok-style paging of word
// timings. Written from the documented behaviour and checked against values
// recorded from the published package (test/fixtures/captions.json).

export interface Caption {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
  /** For `createTikTokStyleCaptions`: end the page after this caption. */
  pageBreakAfter?: boolean;
}

// ---- SRT ----

const TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/;
const TIMING_LINE = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}\\s*$`);

const toMs = (h: string, m: string, s: string, ms: string) =>
  ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);

/** Blocks of `index`, `start --> end` and text lines. A block that does not start with an index line is skipped. */
export function parseSrt({ input }: { input: string }): { captions: Caption[] } {
  const captions: Caption[] = [];
  const blocks = input.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (!/^\s*\d+\s*$/.test(lines[0] ?? '')) continue;
    const match = TIMING_LINE.exec(lines[1] ?? '');
    if (!match) continue;
    const startMs = toMs(match[1]!, match[2]!, match[3]!, match[4]!);
    const endMs = toMs(match[5]!, match[6]!, match[7]!, match[8]!);
    captions.push({
      text: lines.slice(2).join('\n').trim(),
      startMs,
      endMs,
      confidence: 1,
      timestampMs: (startMs + endMs) / 2,
    });
  }
  return { captions };
}

// ---- WebVTT ----

function parseVttTimestamp(time: string): number {
  const parts = time.trim().split(':');
  if (parts.length < 2 || parts.length > 3) throw new Error(`Invalid timestamp:${time}`);
  const [hours, minutes, rest] = parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : ['0', parts[0]!, parts[1]!];
  const [seconds, millis] = rest.split(/[,.]/);
  if (!hours || !minutes || !seconds || !millis) throw new Error(`Invalid timestamp:${time}`);
  return parseInt(hours, 10) * 3_600_000 + parseInt(minutes, 10) * 60_000 + parseInt(seconds, 10) * 1000 + parseInt(millis, 10);
}

const VTT_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };

/** Cue text without its markup (`<i>`, `<v Speaker>`, inline `<00:00:01.000>` timestamps), with character references decoded. */
function vttCueText(lines: string[]): string {
  return (
    lines
      .join('\n')
      // Tags go first, so an escaped `&lt;i&gt;` stays the text `<i>`.
      .replace(/<[^>]*>/g, '')
      // One pass, so `&amp;lt;` is `&lt;` and not `<`. A reference to no character (0, a surrogate, past U+10FFFF) is kept as written.
      .replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(amp|lt|gt|quot|apos|nbsp|lrm|rlm));/g, (match, decimal?: string, hex?: string, name?: string) => {
        if (name) return VTT_ENTITIES[name]!;
        const codePoint = decimal ? parseInt(decimal, 10) : parseInt(hex!, 16);
        const none = codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
        return none ? match : String.fromCodePoint(codePoint);
      })
      .trim()
  );
}

/**
 * The cues of a WebVTT file. A `WEBVTT` header, `NOTE`, `STYLE` and `REGION` blocks, cue identifiers and cue settings are
 * skipped. A cue runs to the next empty line, so a line of only spaces (YouTube's automatic captions start cues with one)
 * belongs to the cue. The timestamps are `hh:mm:ss.mmm` or `mm:ss.mmm`.
 */
export function parseVtt({ input }: { input: string }): { captions: Caption[] } {
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const captions: Caption[] = [];
  let i = 0;
  if (lines[i]?.trim().startsWith('WEBVTT')) i++;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      i++;
      while (i < lines.length && lines[i]!.trim() !== '') i++;
      continue;
    }
    const arrow = line.indexOf('-->');
    if (arrow === -1) {
      // A cue identifier: the timing line is the next one.
      i++;
      continue;
    }
    const startMs = parseVttTimestamp(line.slice(0, arrow));
    const endMs = parseVttTimestamp(line.slice(arrow + 3).trim().split(/\s+/)[0]!);
    i++;
    const text: string[] = [];
    while (i < lines.length && lines[i] !== '') text.push(lines[i++]!);
    captions.push({ text: vttCueText(text), startMs, endMs, timestampMs: (startMs + endMs) / 2, confidence: 1 });
  }
  return { captions };
}

function formatTime(ms: number): string {
  const total = Math.floor(ms);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(total % 1000, 3)}`;
}

/** One SRT block per line; the captions of a line are joined as written and share its start and end. */
export function serializeSrt({ lines }: { lines: Caption[][] }): string {
  return lines
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const text = line.map((caption) => caption.text).join('');
      return `${index + 1}\n${formatTime(line[0]!.startMs)} --> ${formatTime(line[line.length - 1]!.endMs)}\n${text}`;
    })
    .join('\n\n');
}

// ---- TikTok-style pages ----

export interface TikTokToken {
  text: string;
  fromMs: number;
  toMs: number;
  /** Set (true) when the caption it comes from asked for the page to end after it. */
  pageBreakAfter?: boolean;
}

export interface TikTokPage {
  text: string;
  startMs: number;
  durationMs: number;
  tokens: TikTokToken[];
}

/**
 * Groups word captions into pages (`@remotion/captions`, written from its documentation and checked against the
 * published package). Spaces are the delimiters: only a caption that starts with a space can begin a new page, and it
 * does once the page's duration (from its first word to the end of the caption before) exceeds
 * `combineTokensWithinMilliseconds`, or, with `breakOnSilenceAfterMilliseconds`, when at least that long a gap separates
 * the caption from the one before. A caption with `pageBreakAfter` ends its page whatever follows. A page opens with its
 * first word's leading space removed and lasts until the next one begins (the last, until the last caption ends). A caption
 * without text only counts for timing. With no limit, everything is one page.
 */
export function createTikTokStyleCaptions({
  captions,
  combineTokensWithinMilliseconds = Infinity,
  breakOnSilenceAfterMilliseconds,
}: {
  captions: Caption[];
  combineTokensWithinMilliseconds?: number;
  breakOnSilenceAfterMilliseconds?: number;
}): { pages: TikTokPage[] } {
  const pages: TikTokPage[] = [];
  let tokens: TikTokToken[] = [];
  let text = '';
  let lastEnd = 0;
  let breakNext = false;
  const close = (): void => {
    pages.push({ text, startMs: tokens[0]!.fromMs, durationMs: 0, tokens });
    tokens = [];
    text = '';
  };
  for (const caption of captions) {
    // Only a space (not a newline or a tab) marks the start of a word where a page may break.
    const opensWithSpace = caption.text.startsWith(' ');
    if (tokens.length > 0) {
      const pageMs = lastEnd - tokens[0]!.fromMs;
      const silent = breakOnSilenceAfterMilliseconds !== undefined && caption.startMs - lastEnd >= breakOnSilenceAfterMilliseconds;
      if (breakNext || (opensWithSpace && (pageMs > combineTokensWithinMilliseconds || silent))) close();
    }
    breakNext = caption.pageBreakAfter === true;
    lastEnd = caption.endMs;
    const shown = tokens.length === 0 ? caption.text.trimStart() : caption.text;
    text += shown;
    // A caption of only whitespace is in the page's text but is not a token.
    if (shown.trim() !== '') {
      tokens.push({ text: shown, fromMs: caption.startMs, toMs: caption.endMs, ...(caption.pageBreakAfter === true ? { pageBreakAfter: true } : {}) });
    }
  }
  if (tokens.length > 0) close();
  pages.forEach((page, index) => {
    const next = pages[index + 1];
    page.durationMs = (next ? next.startMs : lastEnd) - page.startMs;
  });
  return { pages };
}
