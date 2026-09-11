import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_REASONING_EFFORT } from "../server/models.js";

/**
 * Converts the Paperclip agent form values into the adapterConfig blob. Used
 * when the adapter is registered as a built-in; external installs rely on the
 * declarative config schema instead.
 */
export function buildDeepSeekConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  ac.model = v.model || DEFAULT_DEEPSEEK_MODEL;
  ac.reasoningEffort = v.thinkingEffort || DEFAULT_DEEPSEEK_REASONING_EFFORT;
  ac.timeoutSec = typeof v.timeoutSec === "number" ? v.timeoutSec : 3600;
  ac.graceSec = 15;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.adapterSchemaValues) {
    for (const [key, value] of Object.entries(v.adapterSchemaValues)) {
      if (value === undefined || value === null || value === "") continue;
      ac[key] = value;
    }
  }
  return ac;
}
