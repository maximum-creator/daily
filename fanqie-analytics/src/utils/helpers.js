function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeBookName(name) {
  return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { today, localISO, safeBookName, sleep };
