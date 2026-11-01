import { answerRows } from './custom-model';
import { planFileOf } from '../../../../src/panels/placement.ts';
import type { Brief, CustomAnswer, CustomDraft, OpenPanel, ReviewAnswer, ScriptAnswer, StoryboardAnswer, StyleframesAnswer } from './types';

type Row = [label: string, value: string];

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a saved answer says, as rows of label and text, and the notes that went with it. */
function rowsOf(panel: OpenPanel): { rows: Row[]; notes: string[] } {
  switch (panel.panel) {
    case 'brief': {
      const a = panel.answer as Brief;
      return {
        rows: [
          ['Purpose', a.purpose],
          ['Audience', a.audience],
          ['Format', `${a.platform}, ${a.size.width} by ${a.size.height} at ${a.size.fps} fps, ${a.seconds} s`],
          ['Takeaway', a.takeaway],
          ['References', plural(a.references.length, 'reference')],
          ...(a.notes ? ([['Notes', a.notes]] as Row[]) : []),
        ],
        notes: [],
      };
    }
    case 'script': {
      const a = panel.answer as ScriptAnswer;
      return { rows: a.lines.map((l, i) => [String(i + 1), l.text]), notes: a.notes.map((n) => `${n.line}: ${n.text}`) };
    }
    case 'storyboard': {
      const a = panel.answer as StoryboardAnswer;
      return {
        rows: a.shots.map((s, i) => [String(i + 1), `${s.what}, ${s.seconds} s, then ${s.transition.replace('-', ' ')}`]),
        notes: a.notes.map((n) => `${n.shot}: ${n.text}`),
      };
    }
    case 'styleframes': {
      const a = panel.answer as StyleframesAnswer;
      return { rows: [[a.pick !== null ? 'Picked' : 'Mixed', a.pick ?? a.mix ?? 'nothing']], notes: a.notes.map((n) => `${n.frame}: ${n.text}`) };
    }
    case 'custom':
      return { rows: answerRows(panel.data as CustomDraft, panel.answer as CustomAnswer), notes: [] };
    case 'review': {
      const a = panel.answer as ReviewAnswer;
      return { rows: [['Verdict', a.verdict === 'approved' ? 'approved' : 'changes wanted']], notes: [...a.notes].sort((x, y) => x.frame - y.frame).map((n) => `frame ${n.frame}: ${n.text}`) };
    }
  }
}

/** The answer saved for an approved stage, read-only: a short summary, not the panel with its controls off. */
export function AnswerView({ panel }: { panel: OpenPanel }) {
  const { rows, notes } = rowsOf(panel);
  return (
    <div data-testid="answer-view" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-3 text-sm">
      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([label, value], i) => (
          <div key={i} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words whitespace-pre-line">{value}</dd>
          </div>
        ))}
      </dl>
      {notes.length > 0 && (
        <section aria-label="Notes">
          <h3 className="text-muted-foreground mb-1 text-xs font-medium">Notes</h3>
          <ul className="flex flex-col gap-1">
            {notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-muted-foreground text-xs">Saved in plan/{planFileOf(panel)}.json. Ask the agent to open it again to change it.</p>
    </div>
  );
}
