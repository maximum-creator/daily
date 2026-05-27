// Plan definitions for competitive intelligence SaaS

const PLANS = {
  trial: {
    name: "试用版",
    monthlyFee: 0,
    maxBrands: 3,
    maxSearchesPerDay: 5,
    maxApiCallsPerDay: 200,
    maxDataDays: 7,
  },
  pro: {
    name: "专业版",
    monthlyFee: 1999,
    maxBrands: 20,
    maxSearchesPerDay: 4,
    maxApiCallsPerDay: 5000,
    maxDataDays: 90,
  },
  enterprise: {
    name: "企业版",
    monthlyFee: 4999,
    maxBrands: Infinity,
    maxSearchesPerDay: Infinity,
    maxApiCallsPerDay: Infinity,
    maxDataDays: 365,
    sla: true,
    customReports: true,
  },
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.trial;
}

function getPlanLimits(planId) {
  const plan = getPlan(planId);
  return {
    maxBrands: plan.maxBrands,
    maxSearchesPerDay: plan.maxSearchesPerDay,
    maxApiCallsPerDay: plan.maxApiCallsPerDay,
    maxDataDays: plan.maxDataDays,
  };
}

module.exports = { PLANS, getPlan, getPlanLimits };
