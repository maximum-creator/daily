const express = require("express");
const morgan = require("morgan");
const path = require("path");

const { globalLimiter } = require("./middleware/rate-limit");
const { authMiddleware } = require("./middleware/auth");
const { usageTrackerMiddleware } = require("./middleware/usage-tracker");
const { syncTenantsFromJson } = require("./repos/tenant.repo");
const { loadTenantsJson } = require("./middleware/auth");

// Controllers
const healthController = require("./controllers/health");
const collectController = require("./controllers/collect");
const analysisController = require("./controllers/analysis");
const adminController = require("./controllers/admin");

const { collectLimiter } = require("./middleware/rate-limit");

async function createApp() {
  // Sync tenants from JSON to SQLite on startup
  const tenantsJson = loadTenantsJson();
  await syncTenantsFromJson(tenantsJson);

  const app = express();

  // Global middleware
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("combined"));
  app.use(globalLimiter);

  // CORS
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Static files
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Health check (no auth)
  app.use("/api/v1", healthController);

  // Auth + Usage tracking for API routes
  app.use("/api/v1", authMiddleware);
  app.use("/api/v1", usageTrackerMiddleware);

  // Collect endpoint (stricter rate limit)
  app.use("/api/v1", collectLimiter, collectController);

  // Analysis endpoints
  app.use("/api/v1", analysisController);

  // Admin endpoints
  app.use("/api/v1", adminController);

  return app;
}

module.exports = { createApp };
