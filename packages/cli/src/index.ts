// kinetograph: the agent CLI and MCP server (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §9).

import { cliVersion } from './version.js';

export { createMcpServer, toolCommands, toolName } from './mcp.js';
export { bundleProject, cacheDir, resolveSpecifier, syntheticEntry, watchProject } from './bundle.js';
export type { BundleResult, ProjectBuild } from './bundle.js';
export { CliError, toErrorObject } from './errors.js';
export { native } from './native.js';
export type { InspectLayer, InspectResult, Native } from './native.js';
export { bundlePanel, findPlugins, loadPluginTools, mcpToolName, pluginToolNames } from './plugins.js';
export type { PluginInfo, PluginTool } from './plugins.js';
export { renderSource } from './render-job.js';
export type { RenderJobOptions } from './render-job.js';
export { checkFrame, frameRange, isSceneFile, listCompositions, openSource, parseProps, projectRootOf } from './source.js';
export type { FrameOutput, OpenOptions, Source } from './source.js';

export { cliVersion };
export { run, type Io } from './run.js';

