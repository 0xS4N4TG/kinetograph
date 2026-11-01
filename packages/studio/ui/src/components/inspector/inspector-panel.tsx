import { memo } from 'react';

import type { CatalogPlugin, CompositionInfo, InspectResult, PluginSummary, ProjectInfo, RenderJob, StudioApi, TimelineData } from '@/api';
import { PropsPanel } from '@/components/inspector/props-panel';
import { RenderQueue } from '@/components/inspector/render-queue';
import { SceneTree } from '@/components/inspector/scene-tree';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type InspectorTab = 'props' | 'scene' | 'renders';

interface InspectorPanelProps {
  /** For the Props tab's presets and plugin panels. */
  api: StudioApi;
  tab: InspectorTab;
  onTabChange(tab: InspectorTab): void;
  comp: CompositionInfo | null;
  inspect: InspectResult | null;
  project: ProjectInfo | null;
  /** The timeline once read, to name the Sequence a layer is in. */
  timeline: TimelineData | null;
  selectedLayer: string | null;
  selectedLayers: string[];
  onSelectLayer(id: string | null, additive?: boolean): void;
  /** Several layers at once (a folded group of identical siblings). */
  onSelectLayers?(ids: string[]): void;
  propValues: Record<string, unknown>;
  /** Whether the props differ from the composition's defaults. */
  propsEdited: boolean;
  onChangeProps(values: Record<string, unknown>): void;
  onResetProps(): void;
  renders: RenderJob[];
  /** Opens the export dialog. */
  onNewRender(): void;
  onCancelRender(id: string): Promise<void>;
  /** Plugins: the installed ones, the selected names, and the actions of the plugin cards. */
  plugins?: PluginSummary[];
  /** The site's plugin catalog; null while it loads. */
  catalog?: CatalogPlugin[] | null;
  selectedPlugins?: ReadonlySet<string>;
  onSelectPlugin?(name: string): void;
  onAskAgent?(text: string): void;
}

/** Props first, then the Scene tree and the Renders: the panel on the right. */
export const InspectorPanel = memo(function InspectorPanel({
  api,
  tab,
  onTabChange,
  comp,
  inspect,
  project,
  timeline,
  selectedLayer,
  selectedLayers,
  onSelectLayer,
  onSelectLayers,
  propValues,
  propsEdited,
  onChangeProps,
  onResetProps,
  renders,
  onNewRender,
  onCancelRender,
  plugins,
  catalog,
  selectedPlugins,
  onSelectPlugin,
  onAskAgent,
}: InspectorPanelProps) {
  const activeRenders = renders.filter((job) => job.status === 'queued' || job.status === 'running').length;

  return (
    <Tabs value={tab} onValueChange={(next) => onTabChange(next as InspectorTab)} className="h-full min-h-0 gap-0">
      <div className="shrink-0 px-3 pt-3">
        <TabsList className="w-full rounded-full p-1">
          <TabsTrigger value="props" className="rounded-full">
            Props
          </TabsTrigger>
          <TabsTrigger value="scene" className="rounded-full">
            Scene
          </TabsTrigger>
          <TabsTrigger value="renders" className="rounded-full">
            Renders
            {activeRenders > 0 && (
              <Badge className="ml-1.5 rounded-full" size="sm">
                {activeRenders}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="props" className="min-h-0 pt-2">
        <PropsPanel
          api={api}
          comp={comp}
          values={propValues}
          edited={propsEdited}
          onChange={onChangeProps}
          onReset={onResetProps}
          inspect={inspect}
          {...(plugins ? { plugins } : {})}
          {...(catalog !== undefined ? { catalog } : {})}
          {...(selectedPlugins ? { selectedPlugins } : {})}
          {...(onSelectPlugin ? { onSelectPlugin } : {})}
          {...(onAskAgent ? { onAskAgent } : {})}
        />
      </TabsContent>
      <TabsContent value="scene" className="min-h-0 pt-2">
        <SceneTree
          inspect={inspect}
          frame={inspect?.frame ?? 0}
          selected={selectedLayer}
          selectedLayers={selectedLayers}
          onSelect={onSelectLayer}
          {...(onSelectLayers ? { onSelectMany: onSelectLayers } : {})}
          agent={project && comp ? { entry: project.entry, cwd: project.cwd, comp, timeline } : null}
        />
      </TabsContent>
      <TabsContent value="renders" className="min-h-0 pt-2">
        <RenderQueue comp={comp} jobs={renders} onNew={onNewRender} onCancel={onCancelRender} />
      </TabsContent>
    </Tabs>
  );
});
