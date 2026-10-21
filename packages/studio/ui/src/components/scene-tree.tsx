import type { ReactNode } from 'react';
import { ChevronDownIcon, EyeIcon, LayersIcon, LockIcon, SparklesIcon, TimerIcon } from 'lucide-react';

import type { InspectResult } from '@/api';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

type InspectLayer = InspectResult['layers'][number];

function findLayer(layers: InspectLayer[], id: string): InspectLayer | null {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    const inside = layer.children ? findLayer(layer.children, id) : null;
    if (inside) return inside;
  }
  return null;
}

const TYPE_SWATCH: Record<string, string> = {
  text: 'bg-rose-500',
  shape: 'bg-indigo-400',
  group: 'bg-amber-400',
  image: 'bg-emerald-400',
  video: 'bg-sky-400',
};

interface SceneTreeProps {
  inspect: InspectResult | null;
  frame: number;
  selected: string | null;
  onSelect(id: string): void;
}

/** The layers of the current frame (topmost first) and the selected layer's resolved fields. */
export function SceneTree({ inspect, frame, selected, onSelect }: SceneTreeProps) {
  if (inspect === null) return <p className="text-muted-foreground p-3 text-xs">Scene not loaded.</p>;
  const layer = selected === null ? null : findLayer(inspect.layers, selected);
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
        <span className="text-[#4da3ff]">frame {inspect.frame}</span>
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
        <Layers layers={inspect.layers} selected={selected} onSelect={onSelect} />
      </ScrollArea>

      <Separator />

      {/* EffectCraft / After Effects Properties Header */}
      <div className="bg-secondary/50 flex h-7 shrink-0 items-center justify-between border-b px-2.5 text-[11px]">
        <span className="truncate font-medium">
          {layer ? `Properties: ${layer.id}` : 'Effect Controls & Transform'}
        </span>
        <span
          className="text-muted-foreground flex items-center gap-1 rounded-xs bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px]"
          title="Resolved frame values (read-only)"
        >
          <LockIcon className="size-2.5 text-amber-400/80" aria-hidden="true" />
          <span>Inspect</span>
        </span>
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
}: {
  layers: InspectLayer[];
  selected: string | null;
  onSelect(id: string): void;
}) {
  if (layers.length === 0) return <p className="text-muted-foreground p-3 text-xs">No layers at this frame.</p>;
  return (
    <ul className="flex flex-col p-1 text-xs" role="tree">
      {[...layers].reverse().map((layer) => {
        const isSelected = layer.id === selected;
        const swatch = TYPE_SWATCH[layer.type] ?? 'bg-sky-400';
        return (
          <li key={layer.id} role="treeitem" aria-selected={isSelected}>
            <button
              type="button"
              onClick={() => onSelect(layer.id)}
              className={cn(
                'hover:bg-white/[0.05] focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left outline-none transition-colors focus-visible:ring-2',
                isSelected && 'bg-[#2680eb]/25 text-foreground shadow-[inset_2px_0_0_#2680eb]',
              )}
            >
              <span className="truncate font-medium">{layer.id}</span>
              <EyeIcon className="text-muted-foreground/60 ml-auto size-3 shrink-0" aria-hidden="true" />
              <span className={cn('size-2 shrink-0 rounded-[2px]', swatch)} aria-hidden="true" />
              <Badge variant="outline" className="rounded-xs px-1 py-0 font-mono text-[9px]">
                {layer.type}
              </Badge>
            </button>
            {layer.children && layer.children.length > 0 && (
              <div className="border-border ml-3 border-l pl-1">
                <Layers layers={layer.children} selected={selected} onSelect={onSelect} />
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

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="col-span-2 mt-1.5 mb-0.5 flex items-center gap-1 border-b border-white/[0.06] pb-1 font-sans text-[11px] font-semibold tracking-tight text-white/90 first:mt-0">
      <ChevronDownIcon className="text-muted-foreground size-3" aria-hidden="true" />
      <span>{title}</span>
    </div>
  );
}

function LayerDetails({ layer }: { layer: InspectLayer }) {
  const t = layer.transform;
  return (
    <dl data-testid="layer-details" className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 p-2.5 font-mono text-[11px]">
      <SectionTitle title="Layer Identity" />
      <Field name="id">{layer.id}</Field>
      <Field name="type">
        <Badge variant="secondary" className="rounded-xs px-1.5 py-0 text-[10px]">
          {layer.type}
        </Badge>
      </Field>

      <SectionTitle title="Layer Transform" />
      <Field name="anchor" stopwatch>
        <span className="text-[#4da3ff]">
          {formatNumber(t.anchorX, 2)}, {formatNumber(t.anchorY, 2)}
        </span>
      </Field>
      <Field name="position" stopwatch>
        <span className="text-[#4da3ff]">
          {formatNumber(t.x, 2)}, {formatNumber(t.y, 2)}
        </span>
      </Field>
      <Field name="scale" stopwatch>
        <span className="text-[#4da3ff]">{formatNumber(t.scale)}</span>
      </Field>
      <Field name="rotation" stopwatch>
        <span className="text-[#4da3ff]">{formatNumber(t.rotation)}</span>
      </Field>
      <Field name="opacity" stopwatch>
        <span className="text-[#4da3ff]">{formatNumber(layer.opacity)}</span>
      </Field>
      <Field name="rotateX / Y / z" stopwatch>
        <span className="text-[#4da3ff]">
          {formatNumber(t.rotateX)} / {formatNumber(t.rotateY)} / {formatNumber(t.z)}
        </span>
      </Field>

      <SectionTitle title="Compositing & Effects" />
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

      {layer.text && (
        <>
          <SectionTitle title="Text & Typography" />
          <Field name="text">{layer.text.text}</Field>
          <Field name="font">
            <span className="text-[#4da3ff]">
              {layer.text.font} {formatNumber(layer.text.size)}
            </span>
          </Field>
          <Field name="text size">
            {formatNumber(layer.text.width, 2)} x {formatNumber(layer.text.height, 2)}
            {layer.text.maxWidth !== null && `, max ${formatNumber(layer.text.maxWidth, 2)}`}
          </Field>
          <Field name="lines">{layer.text.lines.length}</Field>
        </>
      )}

      <SectionTitle title="Geometry & Bounds" />
      <Field name="box">{box(layer.box)}</Field>
      <Field name="bounds">{box(layer.bounds)}</Field>
      <Field name="matrix">{layer.matrix.map((n) => formatNumber(n)).join(', ')}</Field>
      {layer.src !== undefined && <Field name="src">{layer.src}</Field>}
      {layer.media && <Field name="media time">{formatNumber(layer.media.time)} s</Field>}
      {layer.children && <Field name="children">{layer.children.length}</Field>}
    </dl>
  );
}

function Field({ name, stopwatch, children }: { name: string; stopwatch?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground flex items-center gap-1.5 font-sans text-[11px]">
        {stopwatch ? (
          <TimerIcon className="text-muted-foreground/60 size-3 shrink-0" aria-hidden="true" />
        ) : (
          <span className="inline-block size-3 shrink-0" aria-hidden="true" />
        )}
        <span>{name}</span>
      </dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}
