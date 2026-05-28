// API client — wraps all REST calls to the backend
const API = {
  _base: "",
  _key: localStorage.getItem("fanqie_api_key") || "",

  get key() { return this._key; },
  set key(k) { this._key = k; localStorage.setItem("fanqie_api_key", k); },

  _headers() {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this._key}`,
    };
  },

  async _fetch(path, opts = {}) {
    const res = await fetch(`${this._base}${path}`, {
      ...opts,
      headers: { ...this._headers(), ...(opts.headers || {}) },
    });
    const json = await res.json();
    if (json.code && json.code >= 400) throw new Error(json.message || `HTTP ${res.status}`);
    return json;
  },

  async health() {
    return this._fetch("/api/v1/health");
  },

  async scanBooks() {
    return this._fetch("/api/v1/books/scan", { method: "POST" });
  },

  async collect(books = "", force = false) {
    const params = new URLSearchParams();
    if (books) params.set("books", books);
    if (force) params.set("force", "true");
    const qs = params.toString();
    return this._fetch(`/api/v1/collect${qs ? "?" + qs : ""}`, { method: "POST" });
  },

  async getProgress() {
    return this._fetch("/api/v1/collect/progress");
  },

  async getAnalysis(book = "", ai = true) {
    const params = new URLSearchParams();
    if (book) params.set("book", book);
    if (!ai) params.set("ai", "false");
    const qs = params.toString();
    return this._fetch(`/api/v1/analysis${qs ? "?" + qs : ""}`);
  },

  async getSummary(book = "") {
    const qs = book ? `?book=${encodeURIComponent(book)}` : "";
    return this._fetch(`/api/v1/summary${qs}`);
  },

  async getBooks() {
    return this._fetch("/api/v1/books");
  },

  async getForceIndex() {
    return this._fetch("/api/v1/force-index");
  },

  async getAdminUsage() {
    return this._fetch("/api/v1/admin/usage");
  },

  async getAuditLog(limit = 50) {
    return this._fetch(`/api/v1/admin/audit?limit=${limit}`);
  },
};
