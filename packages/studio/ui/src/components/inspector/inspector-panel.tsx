import { MenuIcon } from 'lucide-react';

import type { CompositionInfo, InspectResult, RenderJob, RenderRequest } from '@/api';
import { PropsPanel } from '@/components/inspector/props-panel';
import { RenderQueue } from '@/components/inspector/render-queue';
import { SceneTree } from '@/components/inspector/scene-tree';
import { PanelHeader } from '@/components/shell/panel-header';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TAB_CLASS =
  'data-[state=active]:border-primary h-full rounded-none border-b-2 border-transparent px-2.5 text-[11px] data-[state=active]:bg-transparent data-[state=active]:shadow-none';

interface InspectorPanelProps {
  tab: string;
  onTabChange(tab: string): void;
  comp: CompositionInfo | null;
  frame: number;
  inspect: InspectResult | null;
  selectedLayer: string | null;
  onSelectLayer(id: string | null): void;
  propValues: Record<string, unknown>;
  /** Whether the props differ from the composition's defaults. */
  propsEdited: boolean;
  onChangeProps(values: Record<string, unknown>): void;
  onResetProps(): void;
  renders: RenderJob[];
  onStartRender(request: Omit<RenderRequest, 'comp' | 'props'>): Promise<unknown>;
  onCancelRender(id: string): Promise<void>;
}

/** The Scene, Props and Renders tabs of the right-hand panel. */
export function InspectorPanel({
  tab,
  onTabChange,
  comp,
  frame,
  inspect,
  selectedLayer,
  onSelectLayer,
  propValues,
  propsEdited,
  onChangeProps,
  onResetProps,
  renders,
  onStartRender,
  onCancelRender,
}: InspectorPanelProps) {
  const activeRenders = renders.filter((job) => job.status === 'queued' || job.status === 'running').length;

  return (
    <Tabs value={tab} onValueChange={onTabChange} className="bg-card h-full gap-0">
      <PanelHeader
        className="px-2"
        title={
          <TabsList className="h-7 rounded-none bg-transparent p-0">
            <TabsTrigger value="scene" className={TAB_CLASS}>
              Scene
            </TabsTrigger>
            <TabsTrigger value="props" className={TAB_CLASS}>
              Props
            </TabsTrigger>
            <TabsTrigger value="renders" className={TAB_CLASS}>
              Renders
              {activeRenders > 0 && <Badge className="ml-1 px-1.5 py-0 text-[9px]">{activeRenders}</Badge>}
            </TabsTrigger>
          </TabsList>
        }
      >
        <MenuIcon className="text-muted-foreground size-3" aria-hidden="true" />
      </PanelHeader>
      <TabsContent value="scene" className="min-h-0">
        <SceneTree inspect={inspect} frame={frame} selected={selectedLayer} onSelect={onSelectLayer} />
      </TabsContent>
      <TabsContent value="props" className="min-h-0">
        <PropsPanel comp={comp} values={propValues} edited={propsEdited} onChange={onChangeProps} onReset={onResetProps} />
      </TabsContent>
      <TabsContent value="renders" className="min-h-0">
        <RenderQueue
          comp={comp}
          jobs={renders}
          propsEdited={propsEdited}
          onStart={onStartRender}
          onCancel={onCancelRender}
        />
      </TabsContent>
    </Tabs>
  );
}
