const fs = require("fs");
const path = require("path");
const { z } = require("zod");

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  AI_ENDPOINT: z.string().default(""),
  AI_API_KEY: z.string().default(""),
});

const env = envSchema.parse(process.env);

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
function loadAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

module.exports = { env, loadAppConfig };
