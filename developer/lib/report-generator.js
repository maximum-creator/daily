// AI 竞品日报生成器
// 将聚合后的信号 → 自然语言日报

function generateDailyBrief(brand, date, comparison, trends, suggestions, previousBrief) {
  const signals = comparison?.signals || [];
  const isNew = comparison?.isNew;

  const sections = [];

  // ── Headline ──
  let headline;
  if (isNew) {
    headline = `${brand} 竞品监测已启动。今日完成首次数据采集，明日起将生成变动对比报告。`;
  } else {
    const highCount = signals.filter(s => s.severity === "high").length;
    const totalCount = signals.length;
    if (totalCount === 0) {
      headline = `${brand} 今日无重大变动。产品线和价格保持稳定。`;
    } else if (highCount > 0) {
      headline = `${brand} 今日监测到 ${totalCount} 个变动信号，其中 ${highCount} 个高优先级。`;
    } else {
      headline = `${brand} 今日监测到 ${totalCount} 个变动信号，无高优先级异常。`;
    }
  }
  sections.push({ emoji: "📊", title: "今日概览", body: headline });

  // ── High Priority Signals ──
  const highSignals = signals.filter(s => s.severity === "high");
  if (highSignals.length > 0) {
    const items = highSignals.map(s => `• ${s.title}\n  ${s.detail}`).join("\n\n");
    sections.push({ emoji: "🔴", title: "高优先级信号", body: items });
  }

  // ── Medium Priority Signals ──
  const medSignals = signals.filter(s => s.severity === "medium");
  if (medSignals.length > 0) {
    const items = medSignals.slice(0, 5).map(s => `• ${s.title}\n  ${s.detail}`).join("\n\n");
    sections.push({ emoji: "🟡", title: "一般变动", body: items });
  }

  // ── Trends ──
  if (trends && !isNew) {
    const trendLines = [];
    for (const [key, t] of Object.entries(trends)) {
      if (!t || t.trend === "stable") continue;
      const labels = { productCount: "商品数量", avgPrice: "均价", totalSales: "总销量" };
      const label = labels[key] || key;
      const dir = { rising: "↑ 上升", falling: "↓ 下降" }[t.trend] || "→ 持平";
      trendLines.push(`• ${label}: ${dir}`);
    }
    if (trendLines.length > 0) {
      sections.push({ emoji: "📈", title: "近期趋势", body: trendLines.join("\n") });
    }
  }

  // ── Suggestions ──
  if (suggestions && suggestions.length > 0) {
    const items = suggestions.slice(0, 3).map(s =>
      `• [${s.category}] ${s.title}\n  ${s.detail}`
    ).join("\n\n");
    sections.push({ emoji: "💡", title: "策略建议", body: items });
  }

  // ── Footer ──
  const footer = `📋 监测品牌: ${brand}\n📅 报告日期: ${date}\n⏰ 生成时间: ${new Date().toLocaleString("zh-CN")}`;

  return {
    brand,
    date,
    headline: sections[0]?.body || "",
    sections,
    footer,
    signalCount: signals.length,
    highCount: highSignals.length,
    raw: { comparison, trends, suggestions },
  };
}

// ── Plain text version (for email) ───────────────────────────

function briefToText(brief) {
  const lines = [];
  lines.push(`📊 竞品日报 | ${brief.brand} | ${brief.date}`);
  lines.push("═".repeat(50));
  for (const section of brief.sections) {
    lines.push(`\n${section.emoji} ${section.title}`);
    lines.push("─".repeat(40));
    lines.push(section.body);
  }
  lines.push(`\n${brief.footer}`);
  return lines.join("\n");
}

// ── HTML email version ────────────────────────────────────────

function briefToHtml(brief) {
  const sectionsHtml = brief.sections.map(s => `
    <div style="margin:16px 0;padding:12px;background:#f8f9fa;border-radius:8px">
      <h3 style="margin:0 0 8px;color:#333">${s.emoji} ${s.title}</h3>
      <pre style="margin:0;white-space:pre-wrap;font-family:inherit;color:#555;line-height:1.6">${s.body}</pre>
    </div>
  `).join("");

  return `
    <div style="max-width:600px;margin:0 auto;padding:20px;font-family:'Microsoft YaHei',sans-serif">
      <h2 style="color:#667eea;margin:0 0 4px">📊 竞品日报 · ${brief.brand}</h2>
      <p style="color:#999;margin:0 0 20px;font-size:14px">${brief.date}</p>
      ${sectionsHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
      <p style="color:#999;font-size:12px;white-space:pre-wrap">${brief.footer}</p>
    </div>
  `;
}

module.exports = { generateDailyBrief, briefToText, briefToHtml };
