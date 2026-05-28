// Chart.js wrapper — consistent styling for all charts
const Charts = {
  _charts: {},

  defaults() {
    Chart.defaults.color = "#9aa0b0";
    Chart.defaults.borderColor = "#2a2d3a";
    Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif";
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.padding = 16;
  },

  destroyAll() {
    for (const key of Object.keys(this._charts)) {
      if (this._charts[key]) { this._charts[key].destroy(); delete this._charts[key]; }
    }
  },

  trend(canvasId, labels, revenueData, readerData) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (this._charts[canvasId]) this._charts[canvasId].destroy();

    this._charts[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "收益 (¥)",
            data: revenueData,
            borderColor: "#667eea",
            backgroundColor: "rgba(102,126,234,0.1)",
            fill: true,
            tension: 0.3,
            yAxisID: "y",
          },
          {
            label: "阅读人数",
            data: readerData,
            borderColor: "#27ae60",
            backgroundColor: "rgba(39,174,96,0.05)",
            fill: true,
            tension: 0.3,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: "index" },
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: { type: "linear", position: "left", title: { display: true, text: "收益 ¥" }, grid: { color: "#2a2d3a" } },
          y1: { type: "linear", position: "right", title: { display: true, text: "阅读人数" }, grid: { display: false } },
          x: { grid: { color: "#2a2d3a" } },
        },
      },
    });
  },

  completion(canvasId, curve) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !curve.length) return;
    if (this._charts[canvasId]) this._charts[canvasId].destroy();

    this._charts[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels: curve.map((c) => `第${c.chapter}章`),
        datasets: [
          {
            label: "读完率 %",
            data: curve.map((c) => c.completionRate),
            borderColor: "#667eea",
            pointRadius: 1,
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: "#2a2d3a" } },
          x: { grid: { display: false }, ticks: { callback: (v, i) => i % Math.ceil(curve.length / 8) === 0 ? curve[i].chapter : "" } },
        },
      },
    });
  },

  traffic(canvasId, sources) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !Object.keys(sources).length) return;
    if (this._charts[canvasId]) this._charts[canvasId].destroy();

    const colors = ["#667eea", "#27ae60", "#f39c12", "#e74c3c", "#3498db", "#9b59b6", "#1abc9c", "#e67e22"];
    this._charts[canvasId] = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: Object.keys(sources),
        datasets: [{ data: Object.values(sources), backgroundColor: colors.slice(0, Object.keys(sources).length), borderWidth: 0 }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: "bottom" } },
      },
    });
  },

  funnel(canvasId, data) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !data) return;
    if (this._charts[canvasId]) this._charts[canvasId].destroy();

    this._charts[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: ["阅读人数", "追更人数", "加书架", "评论"],
        datasets: [{
          data: [data.readers || 0, data.followers || 0, data.bookmarks || 0, data.comments || 0],
          backgroundColor: ["rgba(102,126,234,0.6)", "rgba(39,174,96,0.6)", "rgba(243,156,18,0.6)", "rgba(231,76,60,0.6)"],
          borderWidth: 0,
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: "#2a2d3a" } },
          y: { grid: { display: false } },
        },
      },
    });
  },
};
