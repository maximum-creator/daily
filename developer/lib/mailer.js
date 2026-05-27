// 邮件推送模块 — 日报邮件发送
const nodemailer = require("nodemailer");

// ── SMTP config (via env vars) ─────────────────────────────────

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.qq.com",
    port: parseInt(process.env.SMTP_PORT || "465"),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    },
  });
}

// ── Send daily brief email ──────────────────────────────────────

async function sendDailyBrief(to, brief) {
  const transport = getTransport();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@example.com";

  const html = emailTemplate(brief);

  const info = await transport.sendMail({
    from: `"竞品情报" <${from}>`,
    to,
    subject: `📊 竞品日报 · ${brief.brand} · ${brief.date}`,
    html,
  });

  return { messageId: info.messageId, accepted: info.accepted };
}

// ── HTML email template ─────────────────────────────────────────

function emailTemplate(brief) {
  const sectionsHtml = (brief.sections || []).map(s => `
    <div style="margin:16px 0;padding:14px;background:#f8f9fa;border-radius:8px;border-left:4px solid #667eea">
      <h3 style="margin:0 0 8px;color:#333;font-size:15px">${s.emoji} ${s.title}</h3>
      <pre style="margin:0;white-space:pre-wrap;font-family:'Microsoft YaHei',sans-serif;color:#555;font-size:13px;line-height:1.7">${s.body}</pre>
    </div>
  `).join("");

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f2f5">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:24px;border-radius:12px 12px 0 0">
      <h2 style="margin:0 0 4px;font-size:20px">📊 竞品日报 · ${brief.brand}</h2>
      <p style="margin:0;opacity:.85;font-size:14px">${brief.date}</p>
    </div>
    <!-- Body -->
    <div style="background:#fff;padding:20px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,.06)">
      ${sectionsHtml}
      <!-- Signal summary -->
      <div style="margin:16px 0;padding:12px;background:#f0f2f5;border-radius:8px;text-align:center">
        <span style="color:#e74c3c;font-weight:600;margin:0 12px">🔴 ${brief.highCount || 0} 高优</span>
        <span style="color:#666;margin:0 12px">📶 ${brief.signalCount || 0} 信号</span>
      </div>
    </div>
    <!-- Footer -->
    <div style="text-align:center;padding:16px;color:#999;font-size:12px">
      ${brief.footer}<br>
      由 竞品情报 SaaS 自动生成
    </div>
  </div>
</body>
</html>`;
}

// ── Validate SMTP config ────────────────────────────────────────

async function verifyConnection() {
  try {
    const transport = getTransport();
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendDailyBrief, emailTemplate, verifyConnection };
