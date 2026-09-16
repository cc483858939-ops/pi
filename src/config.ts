export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  maxRounds: number;
  bashTimeoutMs: number;
  maxToolOutputBytes: number;
}

function positiveNumber(name: string, value: string, options: { integer?: boolean; max?: number } = {}): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite number greater than 0.`);
  }
  if (options.integer && !Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${name} must not exceed ${options.max}.`);
  }
  return parsed;
}

function requireApiKey(env: NodeJS.ProcessEnv): string {
  const miniPiKey = env.MINI_PI_API_KEY?.trim();
  if (miniPiKey) {
    return miniPiKey;
  }

  const atriaKey = env.ATRIA_API_KEY?.trim();
  if (atriaKey) {
    return atriaKey;
  }

  throw new Error("MINI_PI_API_KEY or ATRIA_API_KEY must be set.");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseURL: env.MINI_PI_BASE_URL ?? "https://api.atria-asi.ai/v1",
    apiKey: requireApiKey(env),
    model: env.MINI_PI_MODEL ?? "Atria-Dawn-Preview",
    maxRounds: positiveNumber("MINI_PI_MAX_ROUNDS", env.MINI_PI_MAX_ROUNDS ?? "20", { integer: true }),
    bashTimeoutMs: positiveNumber("MINI_PI_BASH_TIMEOUT_MS", env.MINI_PI_BASH_TIMEOUT_MS ?? "30000", { max: 300000 }),
    maxToolOutputBytes: positiveNumber("MINI_PI_MAX_TOOL_OUTPUT_BYTES", env.MINI_PI_MAX_TOOL_OUTPUT_BYTES ?? "65536", { integer: true }),
  };
}
