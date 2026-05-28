// ═══════════════════════════════════════════
// AuthorIQ v2.0 — Main Application Logic
// ═══════════════════════════════════════════

Charts.defaults();

// ── State ──
let currentPage = "collect";
let selectedBooks = [];
let allBooks = [];
let currentAnalysis = null;

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── API Key ──
function checkApiKey() {
  const key = API.key;
  if (!key) {
    $("#apiKeyModal").style.display = "flex";
    return false;
  }
  $("#apiKeyModal").style.display = "none";
  return true;
}

$("#btnSaveKey").addEventListener("click", () => {
  const key = $("#apiKeyInput").value.trim();
  if (!key) { $("#keyError").textContent = "请输入 API Key"; return; }
  API.key = key;
  $("#keyError").textContent = "";
  checkApiKey();
  init();
});

$("#apiKeyInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btnSaveKey").click();
});

// ── Navigation ──
function navigateTo(page) {
  currentPage = page;
  $$(".nav-item").forEach((b) => b.classList.remove("active"));
  const navBtn = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add("active");
  $$(".page").forEach((p) => p.classList.add("hidden"));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.remove("hidden");
}

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    navigateTo(btn.dataset.page);
    if (currentPage === "dashboard") loadDashboard();
    else if (currentPage === "force") loadForceIndex();
    else if (currentPage === "admin") loadAdmin();
    else if (currentPage === "collect") loadBooks();
  });
});

// ── Init ──
let initialized = false;

async function init() {
  if (!checkApiKey()) return;
  if (initialized) { await loadBooks(); return; }
  initialized = true;

  // Connect WebSocket
  WSClient.connect("demo");

  // WS status
  WSClient.on("connected", () => {
    $("#wsDot").className = "dot online";
    $("#wsStatus").textContent = "已连接";
  });
  WSClient.on("disconnected", () => {
    $("#wsDot").className = "dot offline";
    $("#wsStatus").textContent = "未连接";
  });

  // Load initial data
  await loadBooks();
}

// ── Book Loading ──
async function loadBooks() {
  allBooks = [];

  // Try scanning books from browser first
  try {
    const scanRes = await API.scanBooks();
    if (scanRes.data?.novels?.length > 0) {
      allBooks = scanRes.data.novels;
    }
  } catch (e) { /* fall through to fallback */ }

  // Fallback: load from SQLite if scan returned nothing
  if (allBooks.length === 0) {
    try {
      const booksRes = await API.getBooks();
      if (booksRes.data?.length > 0) {
        allBooks = booksRes.data.map((b) => ({ name: b.name, status: "" }));
      }
    } catch (e2) {
      console.warn("无法获取作品列表:", e2.message);
    }
  }

  renderBookSelector();
}

function renderBookSelector() {
  if (allBooks.length === 0) {
    $("#bookSelector").innerHTML = '<p class="text-muted">暂无作品。请先在番茄后台登录后刷新。</p>';
    return;
  }

  selectedBooks = allBooks.map((b) => b.name);
  $("#bookSelector").innerHTML = allBooks
    .map(
      (b, i) => `
    <label class="book-chip selected">
      <span class="bc-check"></span>
      <span class="bc-name">${b.name}</span>
      ${b.status ? `<span class="bc-status">${b.status}</span>` : ""}
      <input type="checkbox" value="${b.name}" checked data-idx="${i}">
    </label>`
    )
    .join("");

  // Click handlers
  $$("#bookSelector .book-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      const cb = chip.querySelector("input");
      cb.checked = !cb.checked;
      chip.classList.toggle("selected", cb.checked);
      updateSelectedBooks();
    });
  });

  updateSelectedBooks();
}

function updateSelectedBooks() {
  selectedBooks = [];
  $$("#bookSelector input:checked").forEach((cb) => selectedBooks.push(cb.value));
  $("#btnQuickAnalyze").disabled = selectedBooks.length === 0;
  if (selectedBooks.length > 0) {
    $("#emptyState").style.display = "none";
  }
}

$("#btnSelectAll").addEventListener("click", () => {
  $$("#bookSelector input").forEach((cb) => { cb.checked = true; cb.closest(".book-chip").classList.add("selected"); });
  updateSelectedBooks();
});
$("#btnDeselectAll").addEventListener("click", () => {
  $$("#bookSelector input").forEach((cb) => { cb.checked = false; cb.closest(".book-chip").classList.remove("selected"); });
  updateSelectedBooks();
});
$("#btnRefreshBooks").addEventListener("click", loadBooks);

// ── Collection ──
$("#btnCollect").addEventListener("click", startCollection);
$("#btnQuickAnalyze").addEventListener("click", async () => {
  const started = await startCollection();
  if (!started) return;
  // Note: pollProgress will auto-navigate on completion
});

async function startCollection() {
  if (selectedBooks.length === 0) {
    alert("请先选择作品");
    return false;
  }

  try {
    const res = await API.collect(selectedBooks.join(","));
    if (res.code !== 0) {
      alert(res.message);
      return false;
    }
    showProgressOverlay();
    pollProgress();
    return true;
  } catch (e) {
    alert("启动采集失败: " + e.message);
    return false;
  }
}

// ── Progress Overlay ──
let progressTimer = null;
let progressStartTime = 0;
let progressPollTimer = null;
let progressCancelled = false;

$("#btnCloseProgress").addEventListener("click", () => {
  progressCancelled = true;
  if (progressTimer) clearInterval(progressTimer);
  if (progressPollTimer) clearTimeout(progressPollTimer);
  $("#progressOverlay").classList.remove("active");
});

function showProgressOverlay() {
  progressCancelled = false;
  $("#progressOverlay").classList.add("active");
  progressStartTime = Date.now();
  $("#progSteps").innerHTML = `
    <div class="prog-step" data-step="browser"><span class="ps-icon">&#9202;</span><span class="ps-label">启动无头浏览器</span><span class="ps-status">等待中</span></div>
    <div class="prog-step" data-step="login"><span class="ps-icon">&#128274;</span><span class="ps-label">导航到作者后台</span><span class="ps-status">等待中</span></div>
    <div class="prog-step" data-step="login_check"><span class="ps-icon">&#10003;</span><span class="ps-label">验证登录态</span><span class="ps-status">等待中</span></div>
    <div class="prog-step" data-step="data_page"><span class="ps-icon">&#128195;</span><span class="ps-label">进入数据中心</span><span class="ps-status">等待中</span></div>
    <div class="prog-step" data-step="collecting"><span class="ps-icon">&#128260;</span><span class="ps-label">采集作品数据</span><span class="ps-status">等待中</span></div>
    <div class="prog-step" data-step="done"><span class="ps-icon">&#10004;</span><span class="ps-label">采集完成</span><span class="ps-status">等待中</span></div>
  `;

  progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - progressStartTime) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const sec = String(elapsed % 60).padStart(2, "0");
    $("#progTimer").textContent = `${min}:${sec}`;
  }, 200);
}

function updateProgressStep(step, status) {
  const el = $(`.prog-step[data-step="${step}"]`);
  if (!el) return;
  el.className = "prog-step " + status;
  const statusText = { done: "完成", active: "进行中", error: "失败" };
  el.querySelector(".ps-status").textContent = statusText[status] || "";
}

// Map server phase names to DOM data-step values
const PHASE_TO_STEP = {
  starting: "browser", browser: "browser", navigate: "login",
  login_check: "login_check", data_page: "data_page",
  dashboard: "data_page", collecting: "collecting", done: "done", error: null,
};
const STEP_ORDER = ["browser", "login", "login_check", "data_page", "collecting", "done"];

async function pollProgress() {
  try {
    const res = await API.getProgress();
    const data = res.data;
    if (!data || data.phase === "idle") return;

    const currentStep = PHASE_TO_STEP[data.phase];
    const currentIdx = currentStep ? STEP_ORDER.indexOf(currentStep) : -1;

    for (let i = 0; i < STEP_ORDER.length; i++) {
      if (i < currentIdx) updateProgressStep(STEP_ORDER[i], "done");
      else if (i === currentIdx) updateProgressStep(STEP_ORDER[i], "active");
    }

    // Update bar
    if (data.totalBooks > 0) {
      const pct = Math.round((data.currentBook / data.totalBooks) * 100);
      $("#progFill").style.width = pct + "%";
      $("#progPct").textContent = pct + "%";
    }

    if (data.message) $("#progMessage").textContent = data.message;

    if (data.done) {
      for (const p of STEP_ORDER) updateProgressStep(p, "done");
      $("#progFill").style.width = "100%";
      $("#progPct").textContent = "100%";
      $("#progMessage").textContent = data.message || "采集完成";

      if (progressTimer) clearInterval(progressTimer);

      setTimeout(() => {
        $("#progressOverlay").classList.remove("active");
        if (data.error) {
          alert("采集出错: " + data.message);
        } else if (!progressCancelled) {
          navigateTo("dashboard");
          loadDashboard();
        }
      }, 1500);
      return;
    }

    // Continue polling
    progressPollTimer = setTimeout(pollProgress, 800);
  } catch (e) {
    progressPollTimer = setTimeout(pollProgress, 1500);
  }
}

// Also handle WebSocket progress updates
WSClient.on("message", (data) => {
  if (!data.step) return;
  const mapped = PHASE_TO_STEP[data.step];
  if (!mapped) return;

  if (data.step === "done") {
    updateProgressStep(mapped, "done");
    $("#progFill").style.width = "100%";
    $("#progPct").textContent = "100%";
    if (progressTimer) clearInterval(progressTimer);
    setTimeout(() => {
      $("#progressOverlay").classList.remove("active");
      navigateTo("dashboard");
      loadDashboard();
    }, 1500);
  } else {
    updateProgressStep(mapped, "active");
    const idx = STEP_ORDER.indexOf(mapped);
    for (let i = 0; i < idx; i++) updateProgressStep(STEP_ORDER[i], "done");
  }
  if (data.progress && data.total) {
    const pct = Math.round((data.progress / data.total) * 100);
    $("#progFill").style.width = pct + "%";
    $("#progPct").textContent = pct + "%";
  }
  if (data.message) $("#progMessage").textContent = data.message;
});

// ── Dashboard ──
async function loadDashboard() {
  if (!checkApiKey()) return;

  try {
    const res = await API.getAnalysis(selectedBooks[0] || "", false);
    if (res.code !== 0) {
      $("#dashBookInfo").textContent = res.message || "暂无数据";
      return;
    }
    currentAnalysis = res.data;
    renderDashboard(res.data);
  } catch (e) {
    $("#dashBookInfo").textContent = "加载失败: " + e.message;
  }
}

$("#btnRefreshAnalysis").addEventListener("click", loadDashboard);

async function requestAIAnalysis() {
  if (!currentAnalysis) return;
  const btn = $("#btnAIAnalysis");
  btn.disabled = true;
  btn.textContent = "AI 分析中…";
  $("#aiPanel").classList.remove("hidden");
  $("#aiContent").innerHTML = '<div class="ai-loading">正在调用 AI 分析…</div>';

  try {
    // Build a fetch with ai=true
    const res = await API._fetch(
      `/api/v1/analysis?book=${encodeURIComponent(currentAnalysis.book || "")}&ai=true`,
    );
    if (res.code === 0 && res.data?.aiAnalysis?.available) {
      const ai = res.data.aiAnalysis;
      let info = ai.analysis;
      if (ai.cached) {
        info = `[缓存 · ${new Date().toLocaleTimeString()}] 累计成本 ¥${ai.totalCost || 0}\n\n${ai.analysis}`;
      } else {
        info = `[本次 ¥${ai.costEstimate || 0} · 累计 ¥${ai.totalCost || 0} · ${ai.tokens?.input || 0}+${ai.tokens?.output || 0} tokens]\n\n${ai.analysis}`;
      }
      $("#aiContent").textContent = info;
    } else if (res.data?.aiAnalysis?.message) {
      $("#aiContent").textContent = res.data.aiAnalysis.message;
    } else {
      $("#aiContent").textContent = "AI 分析暂不可用";
    }
  } catch (e) {
    $("#aiContent").textContent = "AI 调用失败: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "AI 深度分析";
  }
}

$("#btnAIAnalysis").addEventListener("click", requestAIAnalysis);

function renderDashboard(data) {
  const a = data.analysis;
  if (!a) return;

  const dataDate = data.date;
  const today = new Date().toISOString().slice(0, 10);
  const daysOld = dataDate ? Math.round((new Date(today) - new Date(dataDate)) / 86400000) : 999;

  $("#dashBookInfo").innerHTML = `${a.book} · <strong>${dataDate}</strong> · ${data.collectedAt ? new Date(data.collectedAt).toLocaleTimeString() : ""}`;

  // Data freshness warning
  if (daysOld > 1) {
    $("#stageBanner").insertAdjacentHTML("beforebegin",
      `<div style="background:rgba(231,76,60,0.1);border-left:4px solid var(--danger);padding:12px 18px;border-radius:var(--radius);margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--danger)"><span style="font-size:18px">&#9888;</span> 数据已过 <strong>${daysOld} 天</strong>，建议重新采集以获取最新数据</div>`
    );
  } else if (daysOld === 1) {
    $("#stageBanner").insertAdjacentHTML("beforebegin",
      `<div style="background:rgba(243,156,18,0.1);border-left:4px solid var(--warning);padding:12px 18px;border-radius:var(--radius);margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--warning)"><span style="font-size:18px">&#9888;</span> 数据来自昨天，可重新采集获取今日最新数据</div>`
    );
  }

  // Stage banner
  const stageLabels = { signed: "已签约", finished: "已完结", unsigned: "未签约" };
  const stageIcons = { signed: "📝", finished: "📚", unsigned: "🌱" };
  const stage = a.stage || "unsigned";
  $("#stageBanner").innerHTML = `
    <div class="stage-banner stage-${stage}">
      <span class="st-icon">${stageIcons[stage] || "📖"}</span>
      <div><strong>${stageLabels[stage] || stage}</strong><br><span style="font-size:12px">发布 ${a.daysSinceFirstPublish || "?"} 天 · 算法评分 ${a.forceIndex?.score || "?"}/100</span></div>
    </div>`;

  // KPI cards
  const r = a.revenue || {};
  const q = a.quality || {};
  const e = a.engagement || {};
  const t = a.traffic || {};
  const decay = q.decay || 0;
  $("#kpiGrid").innerHTML = `
    <div class="kpi-card"><div class="kpi-value">¥${r.recent7d || 0}</div><div class="kpi-label">近7日收益</div><div class="kpi-change up">累计 ¥${r.total || 0}</div></div>
    <div class="kpi-card"><div class="kpi-value">${q.avgCompletion}%</div><div class="kpi-label">平均读完率</div><div class="kpi-change ${decay > 30 ? 'down' : 'up'}">衰减 ${decay}%</div></div>
    <div class="kpi-card"><div class="kpi-value">${e.readers || 0}</div><div class="kpi-label">阅读人数</div><div class="kpi-change">追更 ${e.followers || 0} 人</div></div>
    <div class="kpi-card"><div class="kpi-value">${t.searchRatio || 0}%</div><div class="kpi-label">搜索占比</div><div class="kpi-change ${(t.searchRatio || 0) > 60 ? 'down' : 'up'}">总流量 ${t.total || 0}</div></div>
  `;

  // Charts
  Charts.completion("completionChart", a.completionCurve || []);
  Charts.traffic("trafficChart", data.raw?.traffic?.sources || {});
  Charts.funnel("funnelChart", e);

  // Trend from daily revenue
  const dailyRev = data.raw?.revenue?.dailyRevenue || [];
  const trendLabels = dailyRev.slice(-14).map((d) => d.date || "").filter(Boolean);
  const trendRevenue = dailyRev.slice(-14).map((d) => d.total || 0);
  // Estimate daily readers from total/(1-searchRatio) if available, otherwise 0
  const dailyReaders = trendRevenue.map(() => 0);
  Charts.trend("trendChart", trendLabels.length > 0 ? trendLabels : ["暂无数据"], trendRevenue.length > 0 ? trendRevenue : [0], dailyReaders);

  // Anomalies
  const anomalies = a.anomalies || [];
  if (anomalies.length > 0) {
    $("#anomalyCard").style.display = "";
    $("#anomalyList").innerHTML = anomalies.map((an) => `
      <div class="suggestion-item priority-${an.severity || 'medium'}">
        <span class="sg-badge badge-${an.severity || 'medium'}">${an.severity === "high" ? "严重" : "关注"}</span>
        <div class="sg-title">第${an.chapter}章「${an.title || ''}」${an.type === "completion_drop" ? "读完率" : "跟读率"}异常</div>
        <div class="sg-detail">值: ${an.value}% | 均值: ${an.avg}% | z-score: ${an.zScore}</div>
      </div>`).join("");
  } else {
    $("#anomalyCard").style.display = "none";
  }

  // Suggestions
  const suggestions = a.suggestions || [];
  if (suggestions.length > 0) {
    $("#suggestionCard").style.display = "";
    $("#suggestionList").innerHTML = suggestions.map((s) => `
      <div class="suggestion-item priority-${s.priority || 'info'}">
        <span class="sg-badge badge-${s.priority || 'info'}">${s.category || ""}</span>
        <div class="sg-title">${s.title}</div>
        <div class="sg-detail">${s.detail}</div>
      </div>`).join("");
  }

  // AI Analysis panel — always visible, user clicks to trigger
  $("#aiPanel").classList.remove("hidden");
  if (data.aiAnalysis?.available) {
    let info = data.aiAnalysis.analysis;
    if (data.aiAnalysis.cached) {
      info = `[缓存 · ¥${data.aiAnalysis.totalCost || 0} 累计]\n\n${data.aiAnalysis.analysis}`;
    }
    $("#aiContent").textContent = info;
  } else if (data.aiAnalysis?.message) {
    if (data.aiAnalysis.message.includes("未配置")) {
      $("#aiPanel").classList.add("hidden");
    } else {
      $("#aiContent").textContent = data.aiAnalysis.message;
    }
  } else {
    $("#aiContent").textContent = "点击上方「AI 深度分析」按钮获取智能诊断（约 ¥0.01/次，结果缓存 6 小时）。";
  }
}

// ── Force Index ──
async function loadForceIndex() {
  if (!checkApiKey()) return;
  try {
    const res = await API.getForceIndex();
    if (res.code !== 0) { $("#forceScore").textContent = "--"; return; }
    renderForceIndex(res.data);
  } catch (e) { /* ignore */ }
}

function renderForceIndex(data) {
  const score = data.score || 0;
  const ring = $("#forceScore");
  ring.textContent = score;
  ring.className = `gauge-ring ${score > 70 ? "score-high" : score > 45 ? "score-medium" : "score-low"}`;

  const bd = data.breakdown || {};
  $("#forceBreakdown").innerHTML = `
    ${renderBreakdownItem("读完率贡献", bd.completion || 0, 30)}
    ${renderBreakdownItem("追读率贡献", bd.follow || 0, 25)}
    ${renderBreakdownItem("加书架贡献", bd.bookmark || 0, 15)}
    ${renderBreakdownItem("更新稳定性", bd.consistency || 0, 10)}
    ${renderBreakdownItem("流量多样性", bd.trafficDiversity || 0, 20)}
  `;

  $("#forcePrediction").textContent = data.prediction || "暂无预测";

  // Stage benchmarks
  const bm = data.benchmarks || {};
  $("#stageBenchmarks").innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:10px">
      <div style="text-align:center"><div style="font-size:24px;font-weight:700">${bm.completion || 0}%</div><div style="font-size:11px;color:var(--text-secondary)">读完率基准</div></div>
      <div style="text-align:center"><div style="font-size:24px;font-weight:700">${bm.follow || 0}%</div><div style="font-size:11px;color:var(--text-secondary)">追读率基准</div></div>
      <div style="text-align:center"><div style="font-size:24px;font-weight:700">≤${bm.searchRatioMax || 0}%</div><div style="font-size:11px;color:var(--text-secondary)">搜索占比上限</div></div>
      <div style="text-align:center"><div style="font-size:24px;font-weight:700">≥${bm.bookmarkRate || 0}%</div><div style="font-size:11px;color:var(--text-secondary)">加书架率基准</div></div>
    </div>`;
}

function renderBreakdownItem(label, value, max) {
  const pct = Math.round((value / max) * 100);
  return `<div class="breakdown-item"><span style="font-size:13px;width:100px">${label}</span><div class="bar-wrap"><div class="fill" style="width:${pct}%"></div></div><span style="font-size:12px;color:var(--text-muted);width:40px;text-align:right">${value}/${max}</span></div>`;
}

// ── Admin ──
async function loadAdmin() {
  if (!checkApiKey()) return;
  try {
    const usageRes = await API.getAdminUsage();
    if (usageRes.code === 0 && usageRes.data) {
      const u = usageRes.data;
      $("#usageStats").innerHTML = `
        <div class="grid-3">
          <div style="text-align:center;padding:16px"><div style="font-size:32px;font-weight:700">${u.monthlyApiCalls || 0}</div><div style="font-size:12px;color:var(--text-secondary)">本月 API 调用</div></div>
          <div style="text-align:center;padding:16px"><div style="font-size:32px;font-weight:700">${Object.keys(u.monthlyEndpoints || {}).length}</div><div style="font-size:12px;color:var(--text-secondary)">调用端点</div></div>
          <div style="text-align:center;padding:16px"><div style="font-size:32px;font-weight:700">${u.dataDays || 0}</div><div style="font-size:12px;color:var(--text-secondary)">数据天数</div></div>
        </div>`;
    }

    const auditRes = await API.getAuditLog(20);
    if (auditRes.code === 0 && auditRes.data) {
      $("#auditLog").innerHTML = auditRes.data.length > 0
        ? auditRes.data.map((a) => `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px"><span style="color:var(--accent-light)">${a.timestamp || ""}</span> · ${a.action} · <span style="color:var(--text-muted)">${a.detail || ""}</span></div>`).join("")
        : '<p class="text-muted">暂无操作记录</p>';
    }
  } catch (e) { /* ignore */ }
}

// ── Boot ──
init();
