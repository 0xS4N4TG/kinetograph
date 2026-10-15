import type { ReactNode } from 'react';

import type { InspectResult } from '@/api';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

// `media` (video and gif layers, AUTHORING.md section 3) is in the contract; `kinetograph`'s own type gets it with the video
// layers, so it is added here until then.
type InspectLayer = InspectResult['layers'][number] & { media?: { time: number } };

function findLayer(layers: InspectLayer[], id: string): InspectLayer | null {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    const inside = layer.children ? findLayer(layer.children, id) : null;
    if (inside) return inside;
  }
  return null;
}

interface SceneTreeProps {
  inspect: InspectResult | null;
  frame: number;
  selected: string | null;
  onSelect(id: string): void;
}

/** The layers of the current frame (topmost first) and the selected layer's resolved fields. */
export function SceneTree({ inspect, frame, selected, onSelect }: SceneTreeProps) {
  if (inspect === null) return <p className="text-muted-foreground p-3 text-sm">Scene not loaded.</p>;
  const layer = selected === null ? null : findLayer(inspect.layers, selected);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="scene-tree">
      <div className="text-muted-foreground flex flex-wrap gap-x-3 px-3 py-2 font-mono text-xs">
        <span>
          {inspect.width}x{inspect.height}
        </span>
        <span>{inspect.fps} fps</span>
        <span>frame {inspect.frame}</span>
        <span>margin {inspect.margin}</span>
        {inspect.camera && (
          <span>
            camera p{formatNumber(inspect.camera.perspective)} ({formatNumber(inspect.camera.x)},{' '}
            {formatNumber(inspect.camera.y)})
          </span>
        )}
      </div>
      <Separator />
      <ScrollArea className="h-2/5 shrink-0">
        <Layers layers={inspect.layers} selected={selected} onSelect={onSelect} />
      </ScrollArea>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        {layer ? (
          <LayerDetails layer={layer} />
        ) : (
          <p className="text-muted-foreground p-3 text-sm">
            {selected === null ? 'Select a layer to see its resolved fields.' : `Layer "${selected}" is not in the scene at frame ${frame}.`}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}

function Layers({ layers, selected, onSelect }: { layers: InspectLayer[]; selected: string | null; onSelect(id: string): void }) {
  if (layers.length === 0) return <p className="text-muted-foreground p-3 text-sm">No layers at this frame.</p>;
  return (
    <ul className="flex flex-col p-1 text-sm" role="tree">
      {[...layers].reverse().map((layer) => (
        <li key={layer.id} role="treeitem" aria-selected={layer.id === selected}>
          <button
            type="button"
            onClick={() => onSelect(layer.id)}
            className={cn(
              'hover:bg-accent/50 focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-[3px]',
              layer.id === selected && 'bg-accent text-accent-foreground',
            )}
          >
            <span className="truncate">{layer.id}</span>
            <Badge variant="outline" className="ml-auto px-1 py-0 text-[10px]">
              {layer.type}
            </Badge>
          </button>
          {layer.children && layer.children.length > 0 && (
            <div className="border-border ml-3 border-l pl-1">
              <Layers layers={layer.children} selected={selected} onSelect={onSelect} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

type Box = { x: number; y: number; width: number; height: number };

function box(b: Box | null): string {
  return b ? `${formatNumber(b.x, 2)}, ${formatNumber(b.y, 2)}  ${formatNumber(b.width, 2)} x ${formatNumber(b.height, 2)}` : 'none';
}

function LayerDetails({ layer }: { layer: InspectLayer }) {
  const t = layer.transform;
  return (
    <dl data-testid="layer-details" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 font-mono text-xs">
      <Field name="id">{layer.id}</Field>
      <Field name="type">
        <Badge variant="secondary">{layer.type}</Badge>
      </Field>
      <Field name="opacity">{formatNumber(layer.opacity)}</Field>
      <Field name="blendMode">{layer.blendMode}</Field>
      <Field name="position">
        {formatNumber(t.x, 2)}, {formatNumber(t.y, 2)}
      </Field>
      <Field name="scale">{formatNumber(t.scale)}</Field>
      <Field name="rotation">{formatNumber(t.rotation)}</Field>
      <Field name="anchor">
        {formatNumber(t.anchorX, 2)}, {formatNumber(t.anchorY, 2)}
      </Field>
      <Field name="rotateX / Y / z">
        {formatNumber(t.rotateX)} / {formatNumber(t.rotateY)} / {formatNumber(t.z)}
      </Field>
      <Field name="matrix">{layer.matrix.map((n) => formatNumber(n)).join(', ')}</Field>
      <Field name="box">{box(layer.box)}</Field>
      <Field name="bounds">{box(layer.bounds)}</Field>
      <Field name="effects">
        {layer.effects.length === 0 ? (
          'none'
        ) : (
          <span className="flex flex-wrap gap-1">
            {layer.effects.map((effect, index) => (
              <Badge key={index} variant="outline">
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
          <Field name="text">{layer.text.text}</Field>
          <Field name="font">
            {layer.text.font} {formatNumber(layer.text.size)}
          </Field>
          <Field name="text size">
            {formatNumber(layer.text.width, 2)} x {formatNumber(layer.text.height, 2)}
            {layer.text.maxWidth !== null && `, max ${formatNumber(layer.text.maxWidth, 2)}`}
          </Field>
          <Field name="lines">{layer.text.lines.length}</Field>
        </>
      )}
      {layer.src !== undefined && <Field name="src">{layer.src}</Field>}
      {layer.media && <Field name="media time">{formatNumber(layer.media.time)} s</Field>}
      {layer.children && <Field name="children">{layer.children.length}</Field>}
    </dl>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}
