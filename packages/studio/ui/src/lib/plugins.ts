// Plugins as the Studio shows them (contract section 11): which layers a plugin draws, which plugin drew a layer, and
// which plugins a composition uses. Pure, so the Props tab, the scene tree and the agent's context agree.

import { useEffect, useState } from 'react';

import type { InspectResult, PluginSummary, StudioApi } from '@/api';
import { findLayer, type InspectLayer } from '@/lib/inspect';
import { layerComponent } from '@/lib/selection';
import type { JsonSchema } from '@/lib/props-schema';

/** The installed plugins (empty until they load, and when the server cannot list them). */
export function usePlugins(api: StudioApi): PluginSummary[] {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  useEffect(() => {
    let live = true;
    api.plugins().then(
      (list) => live && setPlugins(list),
      () => live && setPlugins([]),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return plugins;
}

/** The plugin whose `components` include this layer's component, or undefined. */
export function pluginOfLayer(plugins: PluginSummary[], layer: InspectLayer): PluginSummary | undefined {
  const component = layerComponent(layer);
  return component === null ? undefined : plugins.find((p) => p.components.includes(component));
}

function walk(layers: InspectLayer[], visit: (layer: InspectLayer) => void): void {
  for (const layer of layers) {
    visit(layer);
    if (layer.children) walk(layer.children, visit);
  }
}

/** The ids of the layers a plugin draws in this frame: those whose component it exports. */
export function layersOfPlugin(plugin: PluginSummary, inspect: InspectResult | null): string[] {
  const ids: string[] = [];
  if (inspect) {
    walk(inspect.layers, (layer) => {
      const component = layerComponent(layer);
      if (component !== null && plugin.components.includes(component)) ids.push(layer.id);
    });
  }
  return ids;
}

/** The names of the plugins that drew any of the selected layers. */
export function pluginsOfSelection(plugins: PluginSummary[], inspect: InspectResult | null, selected: string[]): string[] {
  if (!inspect) return [];
  const names = new Set<string>();
  for (const id of selected) {
    const layer = findLayer(inspect.layers, id);
    const plugin = layer ? pluginOfLayer(plugins, layer) : undefined;
    if (plugin) names.add(plugin.name);
  }
  return [...names];
}

/** True when the composition's props schema has a field the plugin's panel owns. */
export function schemaUsesPlugin(schema: JsonSchema | undefined, name: string): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.kinetographPanel === name) return true;
  const props = schema.properties;
  return typeof props === 'object' && props !== null && Object.values(props).some((p) => schemaUsesPlugin(p as JsonSchema, name));
}

/** Whether the plugin is used in this composition: a field of its panel, or a layer it draws now. */
export function pluginUsed(plugin: PluginSummary, schema: JsonSchema | undefined, inspect: InspectResult | null): boolean {
  return schemaUsesPlugin(schema, plugin.name) || layersOfPlugin(plugin, inspect).length > 0;
}
