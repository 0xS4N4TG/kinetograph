import { useState, type ReactNode } from 'react';
import { ChevronDownIcon, LayersIcon, SparklesIcon } from 'lucide-react';

import type { InspectResult } from '@/api';
import { CopyForAgent } from '@/components/inspector/agent-copy';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { buildAgentMessage, type AgentMessageInput } from '@/lib/agent-message';
import { formatNumber } from '@/lib/format';
import { findLayer, type InspectLayer } from '@/lib/inspect';
import { layerColors } from '@/lib/layer-colors';
import { displayName, fullSource, secondLine, tooltip } from '@/lib/names';
import { foldSiblings } from '@/lib/tree';
import { cn } from '@/lib/utils';

interface SceneTreeProps {
  inspect: InspectResult | null;
  frame: number;
  selected: string | null;
  /** Every selected layer: all are highlighted; `selected` is the one whose details show. */
  selectedLayers?: string[];
  onSelect(id: string, additive?: boolean): void;
  /** Picks several layers at once (a folded group); without it a fold picks its first layer. */
  onSelectMany?(ids: string[]): void;
  /** What the "Copy for agent" message needs besides the layer; null before the project is known. */
  agent: Omit<AgentMessageInput, 'frame' | 'layer'> | null;
}

/** The layers of the current frame (topmost first) and the selected layer's resolved fields. */
export function SceneTree({ inspect, frame, selected, selectedLayers = selected === null ? [] : [selected], onSelect, onSelectMany, agent }: SceneTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (inspect === null) {
    // With a composition open the scene is on its way: rows shaped like the layer list. Without one there is nothing coming.
    if (agent === null) return <p className="text-muted-foreground p-4 text-[13px]">Scene not loaded.</p>;
    return (
      <div data-testid="scene-skeleton" aria-busy="true" aria-label="Loading the scene" className="flex flex-col gap-2 p-4">
        {[100, 82, 64, 82, 64].map((width, i) => (
          <div key={i} className="flex items-center gap-2" style={{ paddingLeft: width === 100 ? 0 : 16 }}>
            <Skeleton className="size-4 shrink-0 rounded-md" />
            <Skeleton className="h-3.5 rounded-md" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    );
  }
  const layer = selected === null ? null : findLayer(inspect.layers, selected);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="bg-card flex h-full min-h-0 flex-col select-none" data-testid="scene-tree">
      {/* Composition Frame Metadata Bar */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 pb-2 font-mono text-[11px]">
        <span className="text-foreground font-semibold">
          {inspect.width}x{inspect.height}
        </span>
        <span>·</span>
        <span>{inspect.fps} fps</span>
        <span>·</span>
        <span className="text-accent-foreground">frame {inspect.frame}</span>
        <span>·</span>
        <span>margin {inspect.margin}</span>
        {inspect.camera && (
          <span>
            camera p{formatNumber(inspect.camera.perspective)} ({formatNumber(inspect.camera.x)},{' '}
            {formatNumber(inspect.camera.y)})
          </span>
        )}
      </div>

      {/* Scene Hierarchy Section Header */}
      <div className="flex h-9 shrink-0 items-center justify-between px-4 text-[11px] font-semibold tracking-wide uppercase">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <LayersIcon className="size-3.5" aria-hidden="true" />
          Layers at this frame
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">{inspect.layers.length} top</span>
      </div>

      <ScrollArea className="h-2/5 shrink-0">
        <Layers layers={inspect.layers} selected={selectedLayers} onSelect={onSelect} collapsed={collapsed} onToggle={toggle} {...(onSelectMany ? { onSelectMany } : {})} />
      </ScrollArea>

      <Separator className="my-1" />

      {/* Properties header */}
      <div className="flex h-11 shrink-0 items-center px-4 text-[13px]">
        <span className="truncate font-medium">{layer ? `Properties: ${displayName(layer)}` : 'Select a layer'}</span>
        {layer && agent && (
          <span className="ml-auto pl-2">
            <CopyForAgent message={buildAgentMessage({ ...agent, frame: inspect.frame, layer })} />
          </span>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {layer ? (
          <LayerDetails layer={layer} />
        ) : (
          <p className="text-muted-foreground p-4 text-[13px]">
            {selected === null
              ? 'Select a layer to see its resolved fields.'
              : `Layer "${selected}" is not in the scene at frame ${frame}.`}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}

function Layers({
  layers,
  selected,
  onSelect,
  collapsed,
  onToggle,
  onSelectMany,
  fold = true,
}: {
  layers: InspectLayer[];
  selected: string[];
  onSelect(id: string, additive: boolean): void;
  /** Layers and folds are open or closed by id; a fold (`fold:...`) is closed unless its id is in this set. */
  collapsed: Set<string>;
  onToggle(id: string): void;
  onSelectMany?(ids: string[]): void;
  /** False for the members of an open fold, already in display order. */
  fold?: boolean;
}) {
  if (layers.length === 0) return <p className="text-muted-foreground p-4 text-[13px]">No layers at this frame.</p>;
  const ordered = fold ? [...layers].reverse() : layers;
  const items = fold ? foldSiblings(ordered) : ordered.map((layer) => ({ fold: false as const, layer }));
  return (
    <ul className="flex flex-col p-1 text-[13px]" role="tree">
      {items.map((item) => {
        if (item.fold) {
          const open = collapsed.has(item.key);
          const ids = item.layers.map((l) => l.id);
          const all = ids.every((id) => selected.includes(id));
          const { swatch } = layerColors(item.layers[0]!.type);
          const name = `${item.label} ×${item.layers.length}`;
          return (
            <li key={item.key} role="treeitem" aria-selected={all} aria-expanded={open} data-testid="scene-fold">
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
                  onClick={() => onToggle(item.key)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-5 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
                >
                  <ChevronDownIcon className={cn('size-3 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => (onSelectMany ? onSelectMany(ids) : onSelect(ids[0]!, false))}
                  title={tooltip(name, 'folded', item.layers[0]!)}
                  className={cn(
                    'hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2',
                    all && 'bg-accent text-accent-foreground',
                  )}
                >
                  <span className={cn('size-2.5 shrink-0 rounded-full', swatch)} aria-hidden="true" />
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate font-medium">{name}</span>
                    {secondLine(item.layers[0]!) && <span className="text-muted-foreground truncate text-[11px]">{secondLine(item.layers[0]!)}</span>}
                  </span>
                </button>
              </div>
              {open && (
                <div className="border-border ml-3 border-l pl-1">
                  <Layers layers={item.layers} selected={selected} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} {...(onSelectMany ? { onSelectMany } : {})} fold={false} />
                </div>
              )}
            </li>
          );
        }
        const layer = item.layer;
        const isSelected = selected.includes(layer.id);
        const children = layer.children ?? [];
        const isCollapsed = collapsed.has(layer.id);
        const { swatch } = layerColors(layer.type);
        return (
          <li key={layer.id} role="treeitem" aria-selected={isSelected} aria-expanded={children.length > 0 ? !isCollapsed : undefined}>
            <div className="flex items-center">
              {children.length > 0 ? (
                <button
                  type="button"
                  aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${displayName(layer)}`}
                  onClick={() => onToggle(layer.id)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-5 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
                >
                  <ChevronDownIcon className={cn('size-3 transition-transform', isCollapsed && '-rotate-90')} aria-hidden="true" />
                </button>
              ) : (
                <span className="size-6 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={(event) => onSelect(layer.id, event.shiftKey)}
                title={tooltip(displayName(layer), layer.type, layer)}
                className={cn(
                  'hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2',
                  isSelected && 'bg-accent text-accent-foreground',
                )}
              >
                <span className={cn('size-2.5 shrink-0 rounded-full', swatch)} aria-hidden="true" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate font-medium">{displayName(layer)}</span>
                  {secondLine(layer) && <span className="text-muted-foreground truncate text-[11px]">{secondLine(layer)}</span>}
                </span>
                <Badge variant="outline" className="ml-auto rounded-full px-1.5 font-mono text-[10px]">
                  {layer.type}
                </Badge>
              </button>
            </div>
            {children.length > 0 && !isCollapsed && (
              <div className="border-border ml-3 border-l pl-1">
                <Layers layers={children} selected={selected} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} {...(onSelectMany ? { onSelectMany } : {})} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type Box = { x: number; y: number; width: number; height: number };

function box(b: Box | null): string {
  return b ? `${formatNumber(b.x, 2)}, ${formatNumber(b.y, 2)}  ${formatNumber(b.width, 2)} x ${formatNumber(b.height, 2)}` : 'none';
}

/** A group of fields under a heading that opens and closes. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="focus-visible:ring-ring/50 flex w-full items-center gap-1 pb-1 text-left font-sans text-[12px] font-semibold tracking-tight text-foreground outline-none focus-visible:ring-2"
      >
        <ChevronDownIcon className={cn('text-muted-foreground size-3 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {open && <dl className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 pt-1.5">{children}</dl>}
    </section>
  );
}

function LayerDetails({ layer }: { layer: InspectLayer }) {
  const t = layer.transform;
  return (
    <div data-testid="layer-details" className="flex min-w-0 flex-col gap-4 p-4 font-mono text-[12px]">
      <Section title="Layer Identity">
        <Field name="name">{displayName(layer)}</Field>
        {layer.component !== undefined && <Field name="component">{layer.component}</Field>}
        {layer.source && <Field name="source">{fullSource(layer.source)}</Field>}
        {!layer.id.startsWith('$') && layer.id !== displayName(layer) && <Field name="id">{layer.id}</Field>}
        <Field name="type">
          <Badge variant="secondary" className="rounded-full px-2 text-[11px]">
            {layer.type}
          </Badge>
        </Field>
      </Section>

      <Section title="Layer Transform">
        <Field name="anchor">
          <span className="text-accent-foreground">
            {formatNumber(t.anchorX, 2)}, {formatNumber(t.anchorY, 2)}
          </span>
        </Field>
        <Field name="position">
          <span className="text-accent-foreground">
            {formatNumber(t.x, 2)}, {formatNumber(t.y, 2)}
          </span>
        </Field>
        <Field name="scale">
          <span className="text-accent-foreground">{formatNumber(t.scale)}</span>
        </Field>
        <Field name="rotation">
          <span className="text-accent-foreground">{formatNumber(t.rotation)}</span>
        </Field>
        <Field name="opacity">
          <span className="text-accent-foreground">{formatNumber(layer.opacity)}</span>
        </Field>
        <Field name="rotateX / Y / z">
          <span className="text-accent-foreground">
            {formatNumber(t.rotateX)} / {formatNumber(t.rotateY)} / {formatNumber(t.z)}
          </span>
        </Field>
      </Section>

      <Section title="Compositing & Effects">
        <Field name="blendMode">{layer.blendMode}</Field>
        <Field name="effects">
          {layer.effects.length === 0 ? (
            <span className="text-muted-foreground">none</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {layer.effects.map((effect, index) => (
                <Badge key={index} variant="outline" className="border-info/40 bg-info/10 text-info-foreground">
                  <SparklesIcon className="mr-1 size-2.5" aria-hidden="true" />
                  {effect}
                </Badge>
              ))}
            </span>
          )}
        </Field>
        <Field name="clip">{layer.clip ?? 'none'}</Field>
        {layer.clip && <Field name="clipBounds">{box(layer.clipBounds)}</Field>}
        <Field name="mask">{String(layer.mask)}</Field>
        <Field name="matte">{layer.matte ? `${layer.matte.layer} (${layer.matte.mode})` : 'none'}</Field>
        <Field name="matteSource">{String(layer.matteSource)}</Field>
        <Field name="motionBlur">
          {layer.motionBlur ? `${layer.motionBlur.samples} samples, shutter ${formatNumber(layer.motionBlur.shutter)}` : 'none'}
        </Field>
      </Section>

      {layer.text && (
        <Section title="Text & Typography">
          <Field name="text">{layer.text.text}</Field>
          <Field name="font">
            <span className="text-accent-foreground">
              {layer.text.font} {formatNumber(layer.text.size)}
            </span>
          </Field>
          <Field name="text size">
            {formatNumber(layer.text.width, 2)} x {formatNumber(layer.text.height, 2)}
            {layer.text.maxWidth !== null && `, max ${formatNumber(layer.text.maxWidth, 2)}`}
          </Field>
          <Field name="lines">{layer.text.lines.length}</Field>
        </Section>
      )}

      <Section title="Geometry & Bounds">
        <Field name="box">{box(layer.box)}</Field>
        <Field name="bounds">{box(layer.bounds)}</Field>
        <Field name="matrix">{layer.matrix.map((n) => formatNumber(n)).join(', ')}</Field>
        {layer.src !== undefined && <Field name="src">{layer.src}</Field>}
        {layer.media && <Field name="media time">{formatNumber(layer.media.time)} s</Field>}
        {layer.children && <Field name="children">{layer.children.length}</Field>}
      </Section>
    </div>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground truncate font-sans text-[11px]" title={name}>
        {name}
      </dt>
      <dd className="min-w-0 truncate" title={typeof children === 'string' ? children : undefined}>
        {children}
      </dd>
    </>
  );
}
