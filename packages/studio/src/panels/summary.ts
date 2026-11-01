// What the agent is told when a panel closes (docs/proposals/studio-panels.md, "How the answer reaches the agent"): one
// line the skill describes, then the changes in short form. The whole answer is in plan/<kind>.json.

import type { Brief, OpenPanel, ReviewAnswer, ScriptAnswer, Storyboard, StoryboardAnswer, StyleframesAnswer } from './types.js';

/** The longest detail sent; the plan file has the rest. */
const DETAIL_MAX = 1500;

const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `[panel storyboard p_3 dismissed]`. */
const tag = (panel: OpenPanel, what: 'submitted' | 'dismissed'): string => `[panel ${panel.panel} ${panel.id} ${what}]`;

/** The one-line summary of a submitted answer and the lines that follow it. */
function describe(panel: OpenPanel): { line: string; detail: string[] } {
  switch (panel.panel) {
    case 'brief': {
      const a = panel.answer as Brief;
      return {
        line: `brief approved: ${a.platform} ${a.size.width}x${a.size.height} at ${a.size.fps} fps, ${a.seconds} s, ${plural(a.references.length, 'reference')}`,
        detail: [`purpose: ${clip(a.purpose)}`, `audience: ${clip(a.audience)}`, `takeaway: ${clip(a.takeaway)}`, ...(a.notes ? [`notes: ${clip(a.notes)}`] : [])],
      };
    }
    case 'script': {
      const a = panel.answer as ScriptAnswer;
      return {
        line: `${a.approved ? 'approved' : 'changes wanted:'} ${plural(a.lines.length, 'line')}, ${plural(a.notes.length, 'note')}`,
        detail: a.notes.map((n) => `${n.line}: ${clip(n.text)}`),
      };
    }
    case 'storyboard': {
      const a = panel.answer as StoryboardAnswer;
      const total = a.shots.length + a.removed.length;
      const asked = (panel.data as Storyboard).shots.map((s) => s.id).filter((id) => !a.removed.includes(id));
      const order = a.shots.map((s) => s.id);
      const reordered = order.length === asked.length && order.some((id, i) => id !== asked[i]);
      return {
        line: a.approved ? `approved ${a.shots.length} of ${total} shots` : `changes wanted: ${a.shots.length} of ${total} shots kept, not approved`,
        detail: [
          ...(a.removed.length > 0 ? [`removed: ${a.removed.join(', ')}`] : []),
          ...(reordered ? [`order: ${order.join(', ')}`] : []),
          ...a.notes.map((n) => `${n.shot}: ${clip(n.text)}`),
        ],
      };
    }
    case 'styleframes': {
      const a = panel.answer as StyleframesAnswer;
      const chose = a.pick !== null ? `picked ${a.pick}` : a.mix ? `mixed: ${clip(a.mix, 80)}` : 'no pick';
      return { line: `${a.approved ? 'approved' : 'changes wanted:'} ${chose}`, detail: a.notes.map((n) => `${n.frame}: ${clip(n.text)}`) };
    }
    case 'review': {
      const a = panel.answer as ReviewAnswer;
      const notes = [...a.notes].sort((x, y) => x.frame - y.frame);
      return {
        line: a.verdict === 'approved' ? `approved, ${plural(a.notes.length, 'note')}` : `changes wanted, ${plural(a.notes.length, 'note')}`,
        detail: notes.map((n) => `frame ${n.frame}${n.layer ? ` (${n.layer})` : ''}: ${clip(n.text)}`),
      };
    }
  }
}

/** The message for the agent when `panel` was submitted or dismissed. */
export function closingMessage(panel: OpenPanel): string {
  if (panel.status !== 'submitted' || panel.answer === null) return tag(panel, 'dismissed');
  const { line, detail } = describe(panel);
  const body = detail.join('\n');
  return `${tag(panel, 'submitted')} ${line}; see plan/${panel.panel}.json${body ? `\n${clip(body, DETAIL_MAX)}` : ''}`;
}
