const rateLimit = require("express-rate-limit");

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: "请求过于频繁，请稍后再试" },
});

const collectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  skip: (req) => {
    const plan = req.tenant?.plan || "trial";
    return plan === "enterprise";
  },
  keyGenerator: (req) => req.tenant?.id || "anonymous",
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: "采集请求过于频繁（每客户每分钟最多2次）" },
});

module.exports = { globalLimiter, collectLimiter };
