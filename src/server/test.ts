/**
 * Environment diagnostics for the Paperclip "Test environment" button.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseDeepSeekAdapterConfig, resolveDeepSeekApiKey } from "./config.js";
import { DeepSeekApiError, DeepSeekClient } from "./deepseek-client.js";
import { findDeepSeekModel } from "./models.js";
import { defaultSessionsDir } from "./session-store.js";
import { resolveShell } from "./tools/shell.js";

export interface TestEnvironmentDeps {
  fetchImpl?: typeof fetch;
  processEnv?: NodeJS.ProcessEnv;
  /** Skip the paid hello probe (used by tests). */
  skipHelloProbe?: boolean;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironmentWith(
  ctx: AdapterEnvironmentTestContext,
  deps: TestEnvironmentDeps = {},
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseDeepSeekAdapterConfig(ctx.config);
  const processEnv = deps.processEnv ?? process.env;

  if (ctx.executionTarget && ctx.executionTarget.kind !== "local") {
    checks.push({
      code: "deepseek_remote_target_unsupported",
      level: "error",
      message: `deepseek_api runs on the Paperclip host only; execution target "${ctx.executionTarget.kind}" is not supported.`,
      hint: "Select a local execution environment for this agent.",
    });
  }

  const keyInfo = resolveDeepSeekApiKey(config, processEnv);
  if (!keyInfo) {
    checks.push({
      code: "deepseek_api_key_missing",
      level: "error",
      message: `${config.apiKeyEnvVar} is not set.`,
      hint: `Add ${config.apiKeyEnvVar} to the agent environment variables (a secret binding is recommended) or export it for the Paperclip server process.`,
    });
  } else {
    checks.push({
      code: "deepseek_api_key_present",
      level: "info",
      message: `${config.apiKeyEnvVar} found in ${keyInfo.source === "adapter_env" ? "the agent environment" : "the server process environment"}.`,
    });
  }

  let baseUrlOk = true;
  try {
    const url = new URL(config.baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    checks.push({ code: "deepseek_base_url", level: "info", message: `API base URL: ${config.baseUrl}` });
  } catch {
    baseUrlOk = false;
    checks.push({
      code: "deepseek_base_url_invalid",
      level: "error",
      message: `baseUrl "${config.baseUrl}" is not a valid http(s) URL.`,
    });
  }

  const catalogModel = findDeepSeekModel(config.model);
  checks.push({
    code: catalogModel ? "deepseek_model_known" : "deepseek_model_custom",
    level: "info",
    message: catalogModel
      ? `Model: ${catalogModel.id} (${catalogModel.label}).`
      : `Model: ${config.model} (not in the built-in catalog; availability is checked against the API).`,
  });
  checks.push({
    code: "deepseek_reasoning_effort",
    level: "info",
    message: `Reasoning effort: ${config.reasoningEffort}${config.reasoningEffort === "none" ? " (thinking disabled)" : ""}.`,
  });

  if (config.cwd) {
    if (!path.isAbsolute(config.cwd)) {
      checks.push({
        code: "deepseek_cwd_relative",
        level: "error",
        message: `Working directory must be absolute: "${config.cwd}".`,
      });
    } else {
      try {
        const stats = await fs.stat(config.cwd);
        if (stats.isDirectory()) {
          checks.push({ code: "deepseek_cwd_ok", level: "info", message: `Working directory exists: ${config.cwd}` });
        } else {
          checks.push({ code: "deepseek_cwd_not_directory", level: "error", message: `Working directory is not a directory: ${config.cwd}` });
        }
      } catch {
        checks.push({
          code: "deepseek_cwd_missing",
          level: "warn",
          message: `Working directory does not exist yet: ${config.cwd}. It will be created on the first run when permissions allow.`,
        });
      }
    }
  } else {
    checks.push({
      code: "deepseek_cwd_unset",
      level: "warn",
      message: "No working directory configured; runs use the Paperclip execution workspace or the server's cwd.",
      hint: "Set cwd to the project checkout the agent should work in.",
    });
  }

  const sessionsDir = config.sessionsDir || defaultSessionsDir(processEnv);
  try {
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.access(sessionsDir);
    checks.push({ code: "deepseek_sessions_dir", level: "info", message: `Session transcripts directory: ${sessionsDir}` });
  } catch (err) {
    checks.push({
      code: "deepseek_sessions_dir_unwritable",
      level: "error",
      message: `Cannot create the session transcripts directory ${sessionsDir}: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Set sessionsDir to a writable path.",
    });
  }

  if (!config.disabledTools.includes("run_shell")) {
    const shell = await resolveShell(config.shell || undefined);
    try {
      await fs.access(shell.command);
      checks.push({ code: "deepseek_shell", level: "info", message: `Shell for run_shell: ${shell.command}` });
    } catch {
      checks.push({
        code: "deepseek_shell_missing",
        level: "warn",
        message: `Shell "${shell.command}" was not found; run_shell will fail until a shell is available.`,
      });
    }
  }

  if (config.strictTools) {
    checks.push({
      code: "deepseek_strict_tools",
      level: "info",
      message: "Strict function calling enabled: requests go to the DeepSeek beta endpoint.",
    });
  }

  if (keyInfo && baseUrlOk) {
    const client = new DeepSeekClient({
      apiKey: keyInfo.apiKey,
      baseUrl: config.baseUrl,
      fetchImpl: deps.fetchImpl,
      requestTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
      maxRetries: 1,
      retryBaseDelayMs: 200,
    });
    try {
      const models = await client.listModels();
      const available = models.includes(config.model);
      checks.push({
        code: "deepseek_auth_ok",
        level: "info",
        message: `DeepSeek API reachable; ${models.length} model${models.length === 1 ? "" : "s"} available to this key.`,
        detail: models.length > 0 ? models.join(", ") : null,
      });
      checks.push({
        code: available ? "deepseek_model_available" : "deepseek_model_unlisted",
        level: available ? "info" : "warn",
        message: available
          ? `Model "${config.model}" is available.`
          : `Model "${config.model}" is not in the /models list returned for this key; runs may fail with an invalid model error.`,
        hint: available ? null : `Pick one of: ${models.join(", ") || "(none listed)"}`,
      });
    } catch (err) {
      const apiError = err instanceof DeepSeekApiError ? err : null;
      checks.push({
        code: apiError?.kind === "auth" ? "deepseek_auth_failed" : "deepseek_models_probe_failed",
        level: apiError?.kind === "auth" ? "error" : "warn",
        message: apiError?.kind === "auth"
          ? `DeepSeek rejected the API key: ${apiError.message}`
          : `Could not list DeepSeek models: ${err instanceof Error ? err.message : String(err)}`,
        hint: apiError?.kind === "auth" ? "Check the key at https://platform.deepseek.com/api_keys" : null,
      });
    }

    if (!deps.skipHelloProbe && !checks.some((check) => check.code === "deepseek_auth_failed")) {
      try {
        const startedAt = Date.now();
        const result = await client.chat(
          {
            model: config.model,
            messages: [{ role: "user", content: "Respond with the single word: hello" }],
            thinking: { type: "disabled" },
            max_tokens: 16,
            stream: false,
          },
          { beta: config.strictTools },
        );
        checks.push({
          code: "deepseek_hello_probe_ok",
          level: "info",
          message: `Chat completion probe succeeded in ${Date.now() - startedAt}ms (reply: ${result.content.trim().slice(0, 40) || "(empty)"}).`,
        });
      } catch (err) {
        const apiError = err instanceof DeepSeekApiError ? err : null;
        checks.push({
          code: "deepseek_hello_probe_failed",
          level: apiError && (apiError.kind === "auth" || apiError.kind === "insufficient_balance" || apiError.kind === "invalid_request") ? "error" : "warn",
          message: `Chat completion probe failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: apiError?.kind === "insufficient_balance"
            ? "Top up the DeepSeek account balance."
            : apiError?.kind === "invalid_request"
              ? "Check the model id and baseUrl."
              : null,
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  return testEnvironmentWith(ctx);
}
