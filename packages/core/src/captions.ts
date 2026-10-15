// `@remotion/captions`: SRT parsing and writing, and TikTok-style paging of word
// timings. Written from the documented behaviour and checked against values
// recorded from the published package (test/fixtures/captions.json).

export interface Caption {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
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
}

export interface TikTokPage {
  text: string;
  startMs: number;
  durationMs: number;
  tokens: TikTokToken[];
}

/**
 * Groups word captions into pages. A page takes words until one ends more than
 * `combineTokensWithinMilliseconds` after the page began; that word is the last
 * of its page. (With no limit, everything is one page.) A page lasts until the
 * next one begins.
 */
export function createTikTokStyleCaptions({
  captions,
  combineTokensWithinMilliseconds = Infinity,
}: {
  captions: Caption[];
  combineTokensWithinMilliseconds?: number;
}): { pages: TikTokPage[] } {
  const pages: TikTokPage[] = [];
  let current: TikTokPage | null = null;
  let lastEnd = 0;
  for (const caption of captions) {
    if (current === null) current = { text: '', startMs: caption.startMs, durationMs: 0, tokens: [] };
    // A page opens with its first word's leading space removed; a word without text only counts for timing.
    if (caption.text !== '') {
      const text = current.tokens.length === 0 ? caption.text.trimStart() : caption.text;
      current.tokens.push({ text, fromMs: caption.startMs, toMs: caption.endMs });
    }
    lastEnd = caption.endMs;
    if (caption.endMs - current.startMs > combineTokensWithinMilliseconds) {
      pages.push(current);
      current = null;
    }
  }
  if (current !== null) pages.push(current);
  pages.forEach((page, index) => {
    page.text = page.tokens.map((token) => token.text).join('');
    const next = pages[index + 1];
    const end = next ? next.startMs : (page.tokens[page.tokens.length - 1]?.toMs ?? lastEnd);
    page.durationMs = end - page.startMs;
  });
  return { pages };
}
