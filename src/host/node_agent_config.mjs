import { loadConfig, resolveActiveConfig } from '../config.mjs';

// Credential discovery and model fallback belong to the default Node adapter.
// Custom config loaders supply their own ready-to-use model list and routing.
export async function loadNodeAgentConfig(root, mode = 'mock') {
  const rawConfig = await loadConfig(root, mode);
  const { config, routing } = resolveActiveConfig(rawConfig, mode);
  const activeIds = new Set(routing.activeModels);
  return { ...config, models: config.models.filter(model => activeIds.has(model.id)) };
}
