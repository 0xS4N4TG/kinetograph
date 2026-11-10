import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { FolderTreeIcon, SparklesIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { CopyButton } from '@/components/docs/copy-button';
import { cn } from '@/lib/utils';

/** The plain text of a React node, so a code block's highlighted spans turn back into the source. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** A line that starts with a tree branch. Rehype code passes no language to `pre`, so the branches mark a tree. */
const TREE_LINE = /^[│\s]*[├└]─/m;

/**
 * A file tree: a plain-text code block with box-drawing branches (├─ └─), found by `TREE_LINE`. A name that ends in `/`
 * is a folder; text after two or more spaces is a comment. A title works as on any block.
 *
 * ```txt
 * my-video/
 * ├─ src/
 * │  ├─ index.tsx     registerRoot and the compositions
 * │  └─ scenes/       one component per scene
 * └─ package.json
 * ```
 */
function Tree({ code, ...props }: { code: string } & Omit<ComponentProps<typeof CodeBlock>, 'children'>) {
  const lines = code.replace(/\n+$/, '').split('\n');
  return (
    <CodeBlock icon={<FolderTreeIcon className="size-3.5" />} {...props} className={cn('kg-tree', props.className)}>
      <Pre>
        <code>
          {lines.map((line, i) => {
            const [, branch = '', name = '', gap = '', note = ''] = line.match(/^([│├└─\s]*)(\S+(?: \S+)*)?(?:(\s{2,})(\S.*))?\s*$/) ?? [line, '', line];
            const isFolder = name.endsWith('/');
            return (
              <span key={i} className="line">
                <span className="kg-tree-branch">{branch}</span>
                <span className={isFolder ? 'kg-tree-folder' : undefined}>{name}</span>
                {gap && note ? (
                  <>
                    {gap}
                    <span className="kg-tree-note">{note}</span>
                  </>
                ) : (
                  gap + note
                )}
                {'\n'}
              </span>
            );
          })}
        </code>
      </Pre>
    </CodeBlock>
  );
}

/**
 * A suggested prompt for an agent: the skill name highlighted, the prompt after it, a copy button, and a caption.
 * Written as a ```txt block titled "Suggested prompt" whose text starts with `/skill-name`, or as
 * `<Prompt skill="kinetograph-markup">Add motion blur to my text</Prompt>`.
 */
export function PromptBox({ skill, children }: { skill?: string; children?: ReactNode }) {
  let text = textOf(children).trim();
  let name = skill;
  if (!name) {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (m) [, name, text] = m;
  }
  const full = name ? `/${name} ${text}` : text;
  return (
    <figure className="not-prose my-6">
      <div className="kg-box flex items-start gap-3 px-4 py-5 sm:items-center sm:px-6">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fd-accent text-fd-primary">
          <SparklesIcon className="size-4" />
        </span>
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-fd-foreground">
          {name ? (
            <code className="mr-1.5 rounded-md bg-fd-accent px-1.5 py-0.5 font-mono text-[0.8125rem] font-medium text-fd-primary">
              /{name}
            </code>
          ) : null}
          {text}
        </p>
        <CopyButton text={full} label="Copy prompt" />
      </div>
      <figcaption className="mt-2 text-center text-xs text-fd-muted-foreground">Suggested prompt</figcaption>
    </figure>
  );
}

/**
 * The docs' `pre`. Fumadocs' own already renders `title="src/MyComp.tsx"` as a file-name header with a copy button.
 * On top of it: a text block drawn with ├─ branches is a file tree, and a block titled "Suggested prompt" is a prompt box.
 */
export function DocsPre(props: ComponentProps<'pre'> & { title?: string; icon?: ReactNode }) {
  const { title, children, icon, ...rest } = props;
  if (title === 'Suggested prompt') return <PromptBox>{textOf(children)}</PromptBox>;
  const code = textOf(children);
  if (TREE_LINE.test(code)) return <Tree code={code} title={title} {...(rest as object)} />;
  return (
    <CodeBlock title={title} icon={icon} {...(rest as object)}>
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}
