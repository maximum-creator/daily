// Plan definitions and quota checking for multi-tenant billing.
// Each plan tier maps to concrete limits enforced at API level.

const PLANS = {
  trial: {
    name: "试用版",
    monthlyFee: 0,
    maxBooks: 3,
    maxCollectionsPerDay: 1,
    maxApiCallsPerDay: 200,
    maxDataDays: 7,
  },
  basic: {
    name: "基础版",
    monthlyFee: 199,
    maxBooks: 20,
    maxCollectionsPerDay: 4,
    maxApiCallsPerDay: 2000,
    maxDataDays: 30,
  },
  pro: {
    name: "专业版",
    monthlyFee: 499,
    maxBooks: 100,
    maxCollectionsPerDay: 12,
    maxApiCallsPerDay: 10000,
    maxDataDays: 90,
  },
  enterprise: {
    name: "企业版",
    monthlyFee: 999,
    maxBooks: Infinity,
    maxCollectionsPerDay: Infinity,
    maxApiCallsPerDay: Infinity,
    maxDataDays: 365,
    whiteLabel: true,
    sla: true,
  },
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.trial;
}

function getPlanLimits(planId) {
  const plan = getPlan(planId);
  return {
    maxBooks: plan.maxBooks,
    maxCollectionsPerDay: plan.maxCollectionsPerDay,
    maxApiCallsPerDay: plan.maxApiCallsPerDay,
    maxDataDays: plan.maxDataDays,
  };
}

module.exports = { PLANS, getPlan, getPlanLimits };
