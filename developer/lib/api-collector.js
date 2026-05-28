// API-first collector framework — 官方联盟 API 采集
// 优先级高于 Playwright 爬虫，结构化数据 + 100% 合规
// 每个平台都有免费注册的联盟推广 API

const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { localISO, today, sanitize, parsePrice, parseSales, classifyStore } = require("./utils");

// ── API Key 管理 ────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, "..", "config", "api-keys.json");

function loadApiKeys() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch (e) { return {}; }
}

function saveApiKeys(keys) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(keys, null, 2));
}

// ── Taobao Open Platform ────────────────────────────────────────

function taobaoSign(params, secret) {
  // Sort params alphabetically, concat as key=value, wrap with secret, MD5 → uppercase
  const sorted = Object.keys(params).sort();
  let str = secret;
  for (const k of sorted) {
    if (k === "sign") continue;
    str += k + (params[k] != null ? String(params[k]) : "");
  }
  str += secret;
  return crypto.createHash("md5").update(str, "utf8").digest("hex").toUpperCase();
}

async function taobaoApiCall(method, params, appKey, appSecret) {
  const endpoint = "https://eco.taobao.com/router/rest";

  const allParams = {
    method,
    app_key: appKey,
    timestamp: new Date().toISOString().replace(/T/, " ").replace(/\..+/, ""),
    format: "json",
    v: "2.0",
    sign_method: "md5",
    ...params,
  };
  allParams.sign = taobaoSign(allParams, appSecret);

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(allParams)) {
    body.append(k, String(v));
  }

  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      timeout: 15000,
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error_response) {
            reject(new Error(`Taobao API ${json.error_response.code}: ${json.error_response.msg} (sub_code: ${json.error_response.sub_code || "none"})`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Taobao API parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Taobao API timeout")); });
    req.write(body.toString());
    req.end();
  });
}

/**
 * Search TMall/Taobao products via 淘宝客 API
 * Uses: taobao.tbk.dg.material.optional (keyword product search)
 * Docs: https://open.taobao.com/api.htm?docId=35896
 */
async function searchTmallApi(brandName, maxPages = 2) {
  const keys = loadApiKeys();
  const appKey = keys.taobao?.appKey;
  const appSecret = keys.taobao?.appSecret;
  const adzoneId = keys.taobao?.adzoneId;

  if (!appKey || !appSecret) {
    throw new Error("天猫API未配置：需要 taobao AppKey/AppSecret，请前往 open.taobao.com 创建应用");
  }
  if (!adzoneId) {
    throw new Error("天猫API未配置：需要 adzoneId（推广位ID），请前往 alimama.com 创建推广位");
  }

  const allProducts = [];
  const pageSize = 50; // max per page

  for (let pg = 1; pg <= maxPages; pg++) {
    try {
      const result = await taobaoApiCall(
        "taobao.tbk.dg.material.optional",
        {
          q: brandName,
          adzone_id: adzoneId,
          page_no: pg,
          page_size: pageSize,
          platform: 2, // 2 = 天猫/淘宝合并搜索
          sort: "total_sales_des", // 按销量排序
          has_coupon: "false",
          need_free_ship: "false",
          need_prepay: "false",
          include_pay_rate_30: "false",
          include_rfd_rate: "false",
          include_good_rate: "false",
        },
        appKey,
        appSecret
      );

      const items = result?.tbk_dg_material_optional_response?.result_list?.map_data || [];
      if (items.length === 0) break;

      for (const item of items) {
        // Parse sales from volume field (e.g., "1000" or "1万+")
        let salesVolume = 0;
        let salesDisplay = "";
        if (item.volume) {
          const vol = String(item.volume);
          if (vol.includes("万")) {
            salesVolume = Math.round(parseFloat(vol) * 10000);
          } else {
            salesVolume = parseInt(vol, 10) || 0;
          }
          salesDisplay = vol + "件";
        }

        // Classify store type from seller ID / shop info
        const shopName = item.shop_title || item.nick || "";
        const isTmall = (item.user_type || 0) === 1; // 1 = TMall shop

        allProducts.push({
          name: String(item.title || "").slice(0, 150),
          price: parseFloat(item.zk_final_price || item.reserve_price || 0),
          priceDisplay: String(item.zk_final_price || item.reserve_price || ""),
          sales: salesVolume,
          salesDisplay,
          shop: shopName,
          goodsId: String(item.num_iid || ""),
          storeType: isTmall ? "flagship" : classifyStore(shopName),
          imgSrc: item.pict_url || "",
          linkUrl: item.coupon_share_url || item.url || "",
          // Extra API-only fields
          commissionRate: item.commission_rate ? parseFloat(item.commission_rate) / 100 : 0,
          couponAmount: item.coupon_amount ? parseInt(item.coupon_amount) : 0,
        });
      }

      console.log(`[api-tmall] pg${pg}: ${items.length} 个商品`);
      if (items.length < pageSize) break;

      // Rate limit: 1 req/s for basic tier
      await new Promise(r => setTimeout(r, 1100));

    } catch (e) {
      console.error(`[api-tmall] pg${pg} 失败: ${e.message}`);
      throw e;
    }
  }

  return allProducts;
}

// ── Snapshot interface (matches existing collector pattern) ─────

async function collectBrandSnapshot(brandName, maxPages = 2) {
  const products = await searchTmallApi(brandName, maxPages);

  const cleaned = products.map(p => ({
    name: String(p.name || ""),
    price: p.price || 0,
    priceDisplay: String(p.priceDisplay || ""),
    sales: p.sales || 0,
    salesDisplay: String(p.salesDisplay || ""),
    shop: String(p.shop || ""),
    goodsId: String(p.goodsId || ""),
    storeType: p.storeType || "unknown",
  }));

  const validPrices = cleaned.map(p => p.price).filter(v => v > 0);

  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "tmall-api",
    productCount: cleaned.length,
    products: cleaned,
    priceRange: {
      min: validPrices.length > 0 ? Math.min(...validPrices) : 0,
      max: validPrices.length > 0 ? Math.max(...validPrices) : 0,
      avg: validPrices.length > 0 ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length) : 0,
    },
  };
}

// ── Persistence (same pattern as crawler collectors) ────────────

function saveSnapshot(dataDir, tenantId, brandName, snapshot) {
  const brandDir = path.join(dataDir, tenantId, sanitize(brandName));
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
  const fp = path.join(brandDir, `snapshot-tmall-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-tmall-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

// ── Status check ────────────────────────────────────────────────

function isConfigured() {
  const keys = loadApiKeys();
  return !!(keys.taobao?.appKey && keys.taobao?.appSecret && keys.taobao?.adzoneId);
}

function getConfig() {
  const keys = loadApiKeys();
  return {
    configured: isConfigured(),
    hasAppKey: !!keys.taobao?.appKey,
    hasAdzone: !!keys.taobao?.adzoneId,
  };
}

module.exports = {
  // Main collection
  searchTmallApi,
  collectBrandSnapshot,
  saveSnapshot,
  loadSnapshot,

  // Config
  isConfigured,
  getConfig,
  loadApiKeys,
  saveApiKeys,

  // Helpers
  taobaoApiCall,
  taobaoSign,
};
