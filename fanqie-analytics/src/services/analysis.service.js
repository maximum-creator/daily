// Analysis engine — ported from server.js smart analysis endpoint
// Computes: lifecycle detection, anomaly detection, trend analysis, suggestions

function analyzeTenantData(collectionData, historicalMetrics) {
  if (!collectionData) return null;

  const latest = collectionData;
  const bookName = latest.book || "";
  const status = latest.status || "";

  // ── Extract core metrics ──
  const worksData = latest.worksData || {};
  const quality = latest.quality || {};
  const traffic = latest.traffic || { sources: {} };
  const revenue = latest.revenue || { overview: {}, dailyRevenue: [] };
  const chapters = quality.chapters || [];
  const chapterList = quality.chapterList || [];
  const dailyWords = quality.dailyWords || {};

  const wordValues = Object.values(dailyWords);
  const sortedDailyWords = [...wordValues].sort((a, b) => a - b);
  const avgDailyWords = sortedDailyWords.length > 0
    ? sortedDailyWords[Math.floor(sortedDailyWords.length / 2)]
    : 0;

  // ── Revenue ──
  const allDailyRevenue = revenue.dailyRevenue || [];
  let totalRevenue = allDailyRevenue.reduce((a, b) => a + (b.total || 0), 0);
  const recent7Revenue = allDailyRevenue.slice(-7).reduce((a, b) => a + (b.total || 0), 0);

  // ── Traffic ──
  const trafficSources = traffic.sources || {};
  const totalTraffic = Object.values(trafficSources).reduce((a, b) => a + b, 0);
  const searchTraffic = trafficSources["搜索"] || 0;
  const searchRatio = totalTraffic > 0 ? searchTraffic / totalTraffic : 0;

  // ── Lifecycle Detection ──
  const isSigned = status.includes("已签约");
  const isFinished = status.includes("已完结");
  const isRecommendation = status.includes("推荐中");
  const explicitVerification = status.includes("验证中") || status.includes("审核中");

  let daysSinceFirstPublish = 999;
  if (chapterList.length > 0) {
    const publishDates = chapterList.map((c) => c.publishTime).filter(Boolean).sort();
    if (publishDates.length > 0) {
      daysSinceFirstPublish = Math.round((Date.now() - new Date(publishDates[0])) / 86400000);
    }
  }
  const dwKeys = Object.keys(dailyWords).sort();
  if (dwKeys.length > 0) {
    const dwDays = Math.round((Date.now() - new Date(dwKeys[0])) / 86400000);
    daysSinceFirstPublish = Math.min(daysSinceFirstPublish, dwDays);
  }

  const stage = isFinished ? "finished"
    : isSigned ? "signed"
    : isRecommendation ? "recommendation"
    : (explicitVerification || (daysSinceFirstPublish <= 10 && !isSigned)) ? "verification"
    : "unsigned";

  // ── Completion / Follow rates ──
  const rates = chapters.map((c) => c.completionRate).filter((r) => r > 0);
  const avgCompletion = rates.length > 0 ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 10) / 10 : 0;
  const followRates = chapters.map((c) => c.followReadRate).filter((r) => r > 0);
  const avgFollow = followRates.length > 0 ? Math.round(followRates.reduce((a, b) => a + b, 0) / followRates.length * 10) / 10 : 0;

  // ── Early/Mid/Late completion decay ──
  let earlyRate = 0, midRate = 0, lateRate = 0;
  if (chapters.length > 0) {
    const third = Math.ceil(chapters.length / 3);
    const earlyR = chapters.slice(0, third).map((c) => c.completionRate).filter((r) => r > 0);
    const midR = chapters.slice(third, third * 2).map((c) => c.completionRate).filter((r) => r > 0);
    const lateR = chapters.slice(third * 2).map((c) => c.completionRate).filter((r) => r > 0);
    earlyRate = earlyR.length > 0 ? avg(earlyR) : 0;
    midRate = midR.length > 0 ? avg(midR) : 0;
    lateRate = lateR.length > 0 ? avg(lateR) : 0;
  }

  // ── Anomaly detection (z-score) ──
  const anomalies = detectAnomalies(chapters, rates, followRates);

  // ── Engagement ──
  const bookmarkCount = worksData["加书架人数"] || 0;
  const urgeCount = worksData["催更人数"] || 0;
  const followCount = worksData["追更人数"] || 0;
  const commentCount = worksData["评论次数"] || 0;
  const readerCount = worksData["阅读人数"] || totalTraffic;

  // ── Completion curve ──
  const completionCurve = chapters.map((c) => ({
    chapter: c.chapter, title: c.title || "",
    completionRate: c.completionRate || 0, followReadRate: c.followReadRate || 0,
  }));

  // ── Biggest drop ──
  let biggestDrop = null;
  for (let i = 1; i < completionCurve.length; i++) {
    const prev = completionCurve[i - 1], curr = completionCurve[i];
    if (prev.completionRate > 0 && curr.completionRate > 0) {
      const drop = prev.completionRate - curr.completionRate;
      if (drop > 0 && (!biggestDrop || drop > biggestDrop.drop)) {
        biggestDrop = { from: prev, to: curr, drop: Math.round(drop * 10) / 10 };
      }
    }
  }

  // ── Force Index (番茄算法模拟) ──
  const forceIndex = computeForceIndex({
    avgCompletion, avgFollow, bookmarkCount, readerCount,
    updateConsistency: computeUpdateScore(dailyWords),
    searchRatio, stage, daysSinceFirstPublish,
  });

  return {
    book: bookName, stage, daysSinceFirstPublish,
    revenue: { total: Math.round(totalRevenue * 100) / 100, recent7d: Math.round(recent7Revenue * 100) / 100 },
    quality: {
      avgCompletion, avgFollow, earlyRate, midRate, lateRate,
      decay: earlyRate > 0 ? Math.round((1 - lateRate / earlyRate) * 100) : 0,
      totalChapters: quality.totalChapters || 0,
      cumulativeWords: quality.cumulativeWords || 0,
    },
    traffic: { total: totalTraffic, searchRatio: Math.round(searchRatio * 100) },
    engagement: { readers: readerCount, followers: followCount, bookmarks: bookmarkCount, comments: commentCount, urges: urgeCount },
    anomalies: anomalies.slice(0, 10),
    completionCurve: completionCurve.slice(-30),
    biggestDrop,
    forceIndex,
    suggestions: generateSuggestions({ stage, avgCompletion, avgFollow, earlyRate, lateRate, searchRatio, bookmarkCount, readerCount, avgDailyWords, biggestDrop, anomalies, forceIndex, daysSinceFirstPublish }),
    stageBenchmarks: getStageBenchmarks(stage),
  };
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr, mean) {
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}

function detectAnomalies(chapters, rates, followRates) {
  const anomalies = [];
  if (rates.length < 3) return anomalies;

  const cMean = avg(rates);
  const cStd = stdDev(rates, cMean);
  const fMean = avg(followRates);
  const fStd = stdDev(followRates, fMean);

  for (const ch of chapters) {
    if (ch.completionRate > 0 && cStd > 1) {
      const zScore = (ch.completionRate - cMean) / cStd;
      if (zScore < -2) {
        anomalies.push({
          chapter: ch.chapter, title: ch.title,
          type: "completion_drop", value: ch.completionRate,
          avg: Math.round(cMean * 10) / 10, zScore: Math.round(zScore * 10) / 10,
          severity: zScore < -2.5 ? "high" : "medium",
        });
      }
    }
    if (ch.followReadRate > 0 && fStd > 1) {
      const zScore = (ch.followReadRate - fMean) / fStd;
      if (zScore < -2) {
        anomalies.push({
          chapter: ch.chapter, title: ch.title,
          type: "follow_drop", value: ch.followReadRate,
          avg: Math.round(fMean * 10) / 10, zScore: Math.round(zScore * 10) / 10,
          severity: zScore < -2.5 ? "high" : "medium",
        });
      }
    }
  }
  anomalies.sort((a, b) => (a.zScore || 0) - (b.zScore || 0));
  return anomalies;
}

function computeUpdateScore(dailyWords) {
  const days = Object.keys(dailyWords).sort();
  if (days.length < 2) return 50;
  let gaps = 0;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((new Date(days[i]) - new Date(days[i - 1])) / 86400000);
    if (diff > 2) gaps++;
  }
  return Math.max(0, 100 - gaps * 25);
}

function computeForceIndex({ avgCompletion, avgFollow, bookmarkCount, readerCount, updateConsistency, searchRatio, stage }) {
  // 归一化各项指标到 0-100
  const bookmarkRate = readerCount > 0 ? bookmarkCount / readerCount * 100 : 0;
  const score =
    Math.min(100, avgCompletion * 2.5) * 0.30 +
    Math.min(100, avgFollow * 2.2) * 0.25 +
    Math.min(100, bookmarkRate * 10) * 0.15 +
    updateConsistency * 0.10 +
    Math.max(0, (1 - searchRatio) * 100) * 0.20;

  const prediction = score > 70 ? "平台推荐概率高" : score > 50 ? "在推荐边缘，需要提升关键指标" : "当前信号不足，建议先稳定更新+优化开头";

  return {
    score: Math.round(score),
    breakdown: {
      completion: Math.round(Math.min(100, avgCompletion * 2.5) * 0.30),
      follow: Math.round(Math.min(100, avgFollow * 2.2) * 0.25),
      bookmark: Math.round(Math.min(100, bookmarkRate * 10) * 0.15),
      consistency: Math.round(updateConsistency * 0.10),
      trafficDiversity: Math.round(Math.max(0, (1 - searchRatio) * 100) * 0.20),
    },
    prediction,
  };
}

function getStageBenchmarks(stage) {
  const map = {
    unsigned: { completion: 20, follow: 25, searchRatioMax: 85, bookmarkRate: 5 },
    verification: { completion: 30, follow: 35, searchRatioMax: 55, bookmarkRate: 8 },
    recommendation: { completion: 32, follow: 38, searchRatioMax: 40, bookmarkRate: 9 },
    signed: { completion: 35, follow: 40, searchRatioMax: 30, bookmarkRate: 10 },
    ongoing: { completion: 25, follow: 30, searchRatioMax: 25, bookmarkRate: 8 },
    finished: { completion: 15, follow: 20, searchRatioMax: 50, bookmarkRate: 5 },
  };
  return map[stage] || map.ongoing;
}

function generateSuggestions(ctx) {
  const suggestions = [];
  const { stage, avgCompletion, avgFollow, earlyRate, lateRate, searchRatio, bookmarkCount, readerCount, avgDailyWords, biggestDrop, anomalies, forceIndex, daysSinceFirstPublish } = ctx;

  // ═══ 验证期 ═══
  if (stage === "verification") {
    if (searchRatio > 0.6) {
      suggestions.push({
        priority: "high", category: "traffic",
        title: `搜索占比 ${Math.round(searchRatio * 100)}% — 平台推荐流量不足`,
        detail: searchRatio > 0.75
          ? "搜索占比超过75%，平台几乎未给推荐流量。核心原因通常是读完率太低，算法不敢推。建议优先提升前5章的读完率。"
          : "验证期搜索占比偏高，平台尚未大量开放推荐。提升读完率是触发流量倾斜的关键。",
      });
    }
    if (earlyRate > 0 && lateRate > 0) {
      const decay = Math.round((1 - lateRate / earlyRate) * 100);
      if (decay > 50) {
        suggestions.push({
          priority: "high", category: "retention",
          title: `读完率暴跌 ${decay}%（${earlyRate}% → ${lateRate}%）`,
          detail: "验证期读完率是番茄算法最重要的信号。建议检查前3-5章是否有劝退情节，每章结尾设置悬念钩子。",
        });
      } else if (decay > 30) {
        suggestions.push({
          priority: "medium", category: "retention",
          title: `读完率下滑 ${decay}%，需关注`,
          detail: "验证期读完率应保持稳定或上升。检查中期章节是否出现节奏疲劳。",
        });
      }
    }
    if (!bookmarkCount && readerCount > 10) {
      suggestions.push({
        priority: "high", category: "engagement",
        title: "零互动 — 读者完全沉默",
        detail: "加书架0、催更0——读者连收藏的意愿都没有，说明开篇或简介没抓住读者。检查书名和简介是否准确传达了题材卖点。",
      });
    }
  }

  // ═══ All stages ═══
  if (biggestDrop && biggestDrop.drop > 5) {
    suggestions.push({
      priority: "high", category: "chapter_specific",
      title: `最大流失点：第${biggestDrop.from.chapter}→${biggestDrop.to.chapter}章，读完率跌 ${biggestDrop.drop}%`,
      detail: `大量读者在此流失。重点检查第${biggestDrop.to.chapter}章：是否平淡段落过长、是否有大段背景设定倾泻、剧情逻辑是否跳跃。`,
    });
  }

  const severeAnomalies = anomalies.filter((a) => a.severity === "high").slice(0, 2);
  for (const an of severeAnomalies) {
    suggestions.push({
      priority: "high", category: "chapter_specific",
      title: `第${an.chapter}章「${an.title || ""}」${an.type === "completion_drop" ? "读完率" : "跟读率"}异常 z=${an.zScore}`,
      detail: `该章${an.type === "completion_drop" ? "读完率" : "跟读率"}仅 ${an.value}%，远低于均值 ${an.avg}%。建议优先检查并修改。`,
    });
  }

  if (avgDailyWords < 2000 && stage !== "unsigned") {
    suggestions.push({
      priority: "medium", category: "update",
      title: `日均更新仅 ${avgDailyWords} 字，量偏少`,
      detail: "稳定且充足的更新量是算法推流的基础。建议每日至少3000-5000字。",
    });
  }

  return suggestions;
}

module.exports = { analyzeTenantData, computeForceIndex };
