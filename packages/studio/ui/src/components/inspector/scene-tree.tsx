import { useState, type ReactNode } from 'react';
import { ChevronDownIcon, LayersIcon, SparklesIcon } from 'lucide-react';

import type { InspectResult } from '@/api';
import { CopyForAgent } from '@/components/inspector/agent-copy';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { buildAgentMessage, type AgentMessageInput } from '@/lib/agent-message';
import { formatNumber } from '@/lib/format';
import { findLayer, type InspectLayer } from '@/lib/inspect';
import { layerColors } from '@/lib/layer-colors';
import { cn } from '@/lib/utils';

interface SceneTreeProps {
  inspect: InspectResult | null;
  frame: number;
  selected: string | null;
  onSelect(id: string): void;
  /** What the "Copy for agent" message needs besides the layer; null before the project is known. */
  agent: Omit<AgentMessageInput, 'frame' | 'layer'> | null;
}

/** The layers of the current frame (topmost first) and the selected layer's resolved fields. */
export function SceneTree({ inspect, frame, selected, onSelect, agent }: SceneTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (inspect === null) return <p className="text-muted-foreground p-3 text-xs">Scene not loaded.</p>;
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
      <div className="bg-background/50 text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-1.5 font-mono text-[10px]">
        <span className="text-foreground font-semibold">
          {inspect.width}x{inspect.height}
        </span>
        <span>·</span>
        <span>{inspect.fps} fps</span>
        <span>·</span>
        <span className="text-nle-value">frame {inspect.frame}</span>
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
      <div className="bg-secondary/40 flex h-6 shrink-0 items-center justify-between border-b px-2.5 text-[10px] font-semibold tracking-wider uppercase">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <LayersIcon className="size-3" aria-hidden="true" />
          Active Frame Layers
        </span>
        <span className="text-muted-foreground font-mono text-[9px]">{inspect.layers.length} top</span>
      </div>

      <ScrollArea className="h-2/5 shrink-0">
        <Layers layers={inspect.layers} selected={selected} onSelect={onSelect} collapsed={collapsed} onToggle={toggle} />
      </ScrollArea>

      <Separator />

      {/* Properties header */}
      <div className="bg-secondary/50 flex h-7 shrink-0 items-center border-b px-2.5 text-[11px]">
        <span className="truncate font-medium">{layer ? `Properties: ${layer.id}` : 'Effect Controls & Transform'}</span>
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
          <p className="text-muted-foreground p-3 text-xs">
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
}: {
  layers: InspectLayer[];
  selected: string | null;
  onSelect(id: string): void;
  collapsed: Set<string>;
  onToggle(id: string): void;
}) {
  if (layers.length === 0) return <p className="text-muted-foreground p-3 text-xs">No layers at this frame.</p>;
  return (
    <ul className="flex flex-col p-1 text-xs" role="tree">
      {[...layers].reverse().map((layer) => {
        const isSelected = layer.id === selected;
        const children = layer.children ?? [];
        const isCollapsed = collapsed.has(layer.id);
        const { swatch } = layerColors(layer.type);
        return (
          <li key={layer.id} role="treeitem" aria-selected={isSelected} aria-expanded={children.length > 0 ? !isCollapsed : undefined}>
            <div className="flex items-center">
              {children.length > 0 ? (
                <button
                  type="button"
                  aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${layer.id}`}
                  onClick={() => onToggle(layer.id)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-5 shrink-0 items-center justify-center rounded-xs outline-none focus-visible:ring-2"
                >
                  <ChevronDownIcon className={cn('size-3 transition-transform', isCollapsed && '-rotate-90')} aria-hidden="true" />
                </button>
              ) : (
                <span className="size-5 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => onSelect(layer.id)}
                className={cn(
                  'hover:bg-white/[0.05] focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-xs px-2 py-1 text-left outline-none transition-colors focus-visible:ring-2',
                  isSelected && 'bg-nle-blue/25 text-foreground shadow-[inset_2px_0_0_var(--nle-blue)]',
                )}
              >
                <span className={cn('size-2 shrink-0 rounded-[2px]', swatch)} aria-hidden="true" />
                <span className="truncate font-medium">{layer.id}</span>
                <Badge variant="outline" className="ml-auto rounded-xs px-1 py-0 font-mono text-[9px]">
                  {layer.type}
                </Badge>
              </button>
            </div>
            {children.length > 0 && !isCollapsed && (
              <div className="border-border ml-3 border-l pl-1">
                <Layers layers={children} selected={selected} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} />
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
        className="focus-visible:ring-ring/50 flex w-full items-center gap-1 border-b border-white/[0.06] pb-1 text-left font-sans text-[11px] font-semibold tracking-tight text-white/90 outline-none focus-visible:ring-2"
      >
        <ChevronDownIcon className={cn('text-muted-foreground size-3 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
        <span>{title}</span>
      </button>
      {open && <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 pt-1.5">{children}</dl>}
    </section>
  );
}

function LayerDetails({ layer }: { layer: InspectLayer }) {
  const t = layer.transform;
  return (
    <div data-testid="layer-details" className="flex flex-col gap-3 p-2.5 font-mono text-[11px]">
      <Section title="Layer Identity">
        <Field name="id">{layer.id}</Field>
        <Field name="type">
          <Badge variant="secondary" className="rounded-xs px-1.5 py-0 text-[10px]">
            {layer.type}
          </Badge>
        </Field>
      </Section>

      <Section title="Layer Transform">
        <Field name="anchor">
          <span className="text-nle-value">
            {formatNumber(t.anchorX, 2)}, {formatNumber(t.anchorY, 2)}
          </span>
        </Field>
        <Field name="position">
          <span className="text-nle-value">
            {formatNumber(t.x, 2)}, {formatNumber(t.y, 2)}
          </span>
        </Field>
        <Field name="scale">
          <span className="text-nle-value">{formatNumber(t.scale)}</span>
        </Field>
        <Field name="rotation">
          <span className="text-nle-value">{formatNumber(t.rotation)}</span>
        </Field>
        <Field name="opacity">
          <span className="text-nle-value">{formatNumber(layer.opacity)}</span>
        </Field>
        <Field name="rotateX / Y / z">
          <span className="text-nle-value">
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
                <Badge key={index} variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-300">
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
            <span className="text-nle-value">
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
      <dt className="text-muted-foreground font-sans text-[11px]">{name}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}
