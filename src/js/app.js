const STORAGE_CONFIG_KEY = "openclaw.browser.config";
const STORAGE_IDENTITY_KEY = "openclaw.browser.identity";
const MAX_FRAMES = 2000;
const PROTOCOL_VERSION = 3;
const HISTORY_POLL_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

const state = {
  socket: null,
  status: "idle",
  frameCount: 0,
  frames: [],
  sessions: [],
  history: [],
  activeSessionKey: "",
  liveRuns: new Map(),
  historyPollTimer: null,
  historyLoading: false,
  lastRealtimeEventAt: 0,
  reconnectTimer: null,
  manualDisconnect: false,
  pollEnabled: false,
  protocolVersion: "-",
  connId: "-",
  deviceId: "-",
  pendingRequests: new Map(),
  config: {
    gateway: "",
    token: "",
    scopes: "operator.read,operator.write",
  },
};

const els = {
  gatewayUrl: document.getElementById("gateway-url"),
  gatewayToken: document.getElementById("gateway-token"),
  gatewayScopes: document.getElementById("gateway-scopes"),
  connectBtn: document.getElementById("connect-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  saveSettingsBtn: document.getElementById("save-settings-btn"),
  pollToggleBtn: document.getElementById("poll-toggle-btn"),
  pollDot: document.getElementById("poll-dot"),
  settingsBtn: document.getElementById("settings-btn"),
  statusBtn: document.getElementById("status-btn"),
  copyFramesBtn: document.getElementById("copy-frames-btn"),
  settingsModal: document.getElementById("settings-modal"),
  statusModal: document.getElementById("status-modal"),
  sessionList: document.getElementById("session-list"),
  historyList: document.getElementById("history-list"),
  historySummary: document.getElementById("history-summary"),
  statusDot: document.getElementById("status-dot"),
  statusDotDetail: document.getElementById("status-dot-detail"),
  statusText: document.getElementById("status-text"),
  statusDetail: document.getElementById("status-detail"),
  protocolVersion: document.getElementById("protocol-version"),
  connId: document.getElementById("conn-id"),
  deviceId: document.getElementById("device-id"),
  frameCount: document.getElementById("frame-count"),
};

function setConnectButtonBusy(busy) {
  if (!els.connectBtn) return;
  els.connectBtn.disabled = busy;
  els.connectBtn.textContent = busy ? "Connecting..." : "Connect";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

function setStatus(status, detail) {
  state.status = status;
  els.statusText.textContent = status;
  els.statusDetail.textContent = detail;
  els.statusDot.className = `status-dot ${status}`;
  els.statusDotDetail.className = `status-dot ${status}`;
}

function renderPollingButton() {
  els.pollToggleBtn.classList.toggle("active", state.pollEnabled);
  els.pollDot.className = `toggle-dot ${state.pollEnabled ? "on" : "off"}`;
}

function clearReconnectTimer() {
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (state.manualDisconnect || state.reconnectTimer !== null || !state.config.gateway) {
    return;
  }
  setStatus("connecting", `reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    connect({ preserveState: true }).catch((error) => {
      appendFrame({ direction: "system", label: "reconnect.error", body: String(error), kind: "system" });
      setStatus("error", String(error));
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

function setModalVisible(name, visible) {
  const modal = name === "settings" ? els.settingsModal : els.statusModal;
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

function copyFramesLabel(text, ok = false) {
  els.copyFramesBtn.textContent = text;
  els.copyFramesBtn.classList.toggle("copy-ok", ok);
  window.setTimeout(() => {
    els.copyFramesBtn.textContent = "Copy";
    els.copyFramesBtn.classList.remove("copy-ok");
  }, 1600);
}

async function copyFrames() {
  const payload = state.frames.map((frame) => ({
    direction: frame.direction,
    label: frame.label,
    topic: frame.topic,
    time: frame.time,
    body: safeJsonParse(frame.body) ?? frame.body,
  }));
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    copyFramesLabel("Copied", true);
  } catch {
    copyFramesLabel("Copy failed");
  }
}

function renderFrames() {
  els.frameCount.textContent = String(state.frameCount);
}

function renderSessions() {
  if (!state.sessions.length) {
    els.sessionList.innerHTML = `<div class="session-item"><span>暂无会话</span></div>`;
    return;
  }

  els.sessionList.innerHTML = state.sessions
    .map((session) => {
      const active = session.key === state.activeSessionKey ? "active" : "";
      return `
        <article class="session-item ${active}" data-key="${escapeHtml(session.key)}">
          <strong>${escapeHtml(session.displayName || session.key)}</strong>
        </article>
      `;
    })
    .join("");

  for (const node of els.sessionList.querySelectorAll(".session-item[data-key]")) {
    node.addEventListener("click", () => {
      const key = node.dataset.key;
      if (!key) return;
      loadHistory(key).catch((error) => {
        appendFrame({ direction: "system", label: "history-error", body: String(error), kind: "system" });
      });
    });
  }
}

function ensureSessionVisible(sessionKey) {
  if (!sessionKey) return;
  const existing = state.sessions.find((session) => session.key === sessionKey);
  if (existing) return;
  state.sessions = [{ key: sessionKey, displayName: sessionKey }, ...state.sessions];
  renderSessions();
}

function extractMessageText(message) {
  const content = message?.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && item.type === "text") {
          return item.text || "";
        }
        return JSON.stringify(item);
      })
      .join("");
  }
  if (typeof content === "string") return content;
  return typeof message?.text === "string" ? message.text : JSON.stringify(message, null, 2);
}

function summarizeToolCall(item) {
  const args = item?.arguments || {};
  if (typeof args.command === "string" && args.command.trim()) {
    return args.command.trim();
  }
  const entries = Object.entries(args).slice(0, 2);
  if (!entries.length) return "无参数";
  return entries.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ");
}

function extractContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && item.type === "text") return item.text || "";
      return "";
    })
    .join("");
}

function summarizeToolResult(text) {
  const lines = text.split("\n").filter(Boolean);
  const firstLine = lines[0] || "";
  const summary = firstLine.length > 96 ? `${firstLine.slice(0, 96)}...` : firstLine;
  return {
    summary: summary || "空输出",
    lineCount: lines.length,
  };
}

function summarizeThinking(text) {
  const normalized = String(text || "").replace(/\*\*/g, "").trim();
  if (!normalized) return "思考过程";
  const firstLine = normalized.split("\n").find(Boolean) || normalized;
  return firstLine.length > 72 ? `${firstLine.slice(0, 72)}...` : firstLine;
}

function renderContentParts(entry) {
  const content = entry?.content;
  if (!Array.isArray(content)) {
    const fallback = extractMessageText(entry);
    return `<div class="history-text">${escapeHtml(fallback)}</div>`;
  }

  const blocks = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return `<div class="history-text">${escapeHtml(String(item ?? ""))}</div>`;
      }

      if (item.type === "text") {
        return `<div class="history-text">${escapeHtml(item.text || "")}</div>`;
      }

      if (item.type === "thinking") {
        const thinkingText = item.thinking || "";
        const summary = summarizeThinking(thinkingText);
        return `
          <details class="thinking-card">
            <summary>
              <span class="thinking-label">thinking</span>
              <span class="thinking-summary">${escapeHtml(summary)}</span>
            </summary>
            <div class="thinking-body">${escapeHtml(thinkingText)}</div>
          </details>
        `;
      }

      if (item.type === "toolCall") {
        const args = JSON.stringify(item.arguments || {}, null, 2);
        const summary = summarizeToolCall(item);
        return `
          <details class="tool-card call">
            <summary>
              <span class="tool-label">tool call</span>
              <span class="tool-name">${escapeHtml(item.name || "unknown")}</span>
              <span class="tool-summary">${escapeHtml(summary)}</span>
            </summary>
            <div class="tool-card-body">
              ${item.id ? `<div class="tool-meta-row"><span class="tool-meta-label">id</span><span class="tool-meta">${escapeHtml(item.id)}</span></div>` : ""}
              <pre class="tool-body">${escapeHtml(args)}</pre>
            </div>
          </details>
        `;
      }

      return `<pre class="tool-body">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`;
    })
    .join("");

  return `<div class="history-blocks">${blocks}</div>`;
}

function renderToolResult(entry) {
  const text = Array.isArray(entry?.content) ? extractContentText(entry.content) : extractMessageText(entry);
  const errorClass = entry?.isError ? "error" : "";
  const { summary, lineCount } = summarizeToolResult(text);
  const shouldOpen = entry?.isError || lineCount <= 3;
  return `
    <details class="tool-card result ${errorClass}" ${shouldOpen ? "open" : ""}>
      <summary>
        <span class="tool-label result ${errorClass}">${entry?.isError ? "tool error" : "tool result"}</span>
        <span class="tool-name">${escapeHtml(entry?.toolName || "tool")}</span>
        <span class="tool-summary">${escapeHtml(summary)}</span>
        <span class="tool-size">${lineCount} lines</span>
      </summary>
      <div class="tool-card-body">
        ${entry?.toolCallId ? `<div class="tool-meta-row"><span class="tool-meta-label">call</span><span class="tool-meta">${escapeHtml(entry.toolCallId)}</span></div>` : ""}
        <pre class="tool-body">${escapeHtml(text)}</pre>
      </div>
    </details>
  `;
}

function renderHistory() {
  if (!state.activeSessionKey) {
    els.historySummary.textContent = "未选择会话";
    els.historyList.innerHTML = `<article class="history-item"><span>从左侧选择一个会话</span></article>`;
    return;
  }

  els.historySummary.textContent = `${state.activeSessionKey} · ${state.history.length} messages`;
  if (!state.history.length) {
    els.historyList.innerHTML = `<article class="history-item"><span>会话暂无历史消息</span></article>`;
    return;
  }

  els.historyList.innerHTML = state.history
    .map((entry) => {
      const role = entry?.role || "unknown";
      const statusLabel = entry.final ? "final" : entry.runId ? "streaming" : "";
      let bodyHtml = "";
      if (role === "toolResult") {
        bodyHtml = renderToolResult(entry);
      } else {
        bodyHtml = renderContentParts(entry);
      }
      return `
        <article class="history-item ${escapeHtml(role)} ${entry.final ? "" : "live"}">
          <header>
            <strong>${escapeHtml(role)}</strong>
            ${statusLabel ? `<span class="history-badge ${entry.final ? "final" : ""}">${escapeHtml(statusLabel)}</span>` : ""}
          </header>
          ${bodyHtml}
        </article>
      `;
    })
    .join("");

  requestAnimationFrame(() => {
    els.historyList.scrollTop = els.historyList.scrollHeight;
  });
}

function markRealtimeActivity() {
  state.lastRealtimeEventAt = Date.now();
}

function detectTopic(body) {
  if (!body || typeof body !== "object") return "system";
  if (body.event === "chat") return "chat";
  if (body.event === "agent") return "agent";
  if (body.event || body.method || body.type === "res") return "system";
  return "system";
}

function appendFrame({ direction, label, body, kind = "system", topic = null }) {
  const resolvedTopic = topic || (typeof body === "object" ? detectTopic(body) : "system");
  state.frameCount += 1;
  state.frames.push({
    direction,
    label,
    body: typeof body === "string" ? body : JSON.stringify(body, null, 2),
    time: nowTime(),
    kind,
    topic: resolvedTopic,
  });
  if (state.frames.length > MAX_FRAMES) {
    state.frames = state.frames.slice(-MAX_FRAMES);
  }
  renderFrames();
}

function sendRequest(method, params = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("socket not connected"));
  }

  const id = crypto.randomUUID();
  const frame = {
    type: "req",
    id,
    method,
    params,
  };

  appendFrame({ direction: "outbound", label: method, body: frame, kind: "outbound", topic: "system" });
  state.socket.send(JSON.stringify(frame));

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      state.pendingRequests.delete(id);
      reject(new Error(`${method} timeout`));
    }, 10000);

    state.pendingRequests.set(id, {
      method,
      resolve: (payload) => {
        window.clearTimeout(timeout);
        resolve(payload);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
  });
}

async function loadSessions() {
  const result = await sendRequest("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    includeLastMessage: true,
    limit: 50,
  });
  state.sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  if (!state.sessions.some((session) => session.key === state.activeSessionKey)) {
    state.activeSessionKey = state.sessions[0]?.key || "";
  }
  renderSessions();
  if (state.activeSessionKey) {
    await loadHistory(state.activeSessionKey);
    if (state.pollEnabled) {
      startHistoryPolling();
    }
  } else {
    state.history = [];
    renderHistory();
    stopHistoryPolling();
  }
}

async function loadHistory(sessionKey) {
  state.activeSessionKey = sessionKey;
  state.liveRuns = new Map();
  state.lastRealtimeEventAt = 0;
  renderSessions();
  els.historySummary.textContent = `${sessionKey} · loading`;
  const result = await sendRequest("chat.history", {
    sessionKey,
    limit: 100,
  });
  state.history = normalizeHistoryMessages(Array.isArray(result?.messages) ? result.messages : []);
  renderHistory();
}

async function refreshActiveHistory({ silent = false } = {}) {
  if (!state.activeSessionKey) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.historyLoading) return;

  state.historyLoading = true;
  try {
    if (!silent) {
      els.historySummary.textContent = `${state.activeSessionKey} · loading`;
    }
    const result = await sendRequest("chat.history", {
      sessionKey: state.activeSessionKey,
      limit: 100,
    });
    state.history = normalizeHistoryMessages(Array.isArray(result?.messages) ? result.messages : []);
    renderHistory();
  } finally {
    state.historyLoading = false;
  }
}

function stopHistoryPolling() {
  if (state.historyPollTimer !== null) {
    window.clearInterval(state.historyPollTimer);
    state.historyPollTimer = null;
  }
}

function startHistoryPolling() {
  stopHistoryPolling();
  if (!state.pollEnabled || !state.activeSessionKey) return;
  state.historyPollTimer = window.setInterval(() => {
    const now = Date.now();
    if (state.lastRealtimeEventAt && now - state.lastRealtimeEventAt < HISTORY_POLL_INTERVAL_MS) {
      return;
    }
    refreshActiveHistory({ silent: true }).catch((error) => {
      appendFrame({
        direction: "system",
        label: "chat.history.poll.error",
        body: String(error),
        kind: "system",
      });
    });
  }, HISTORY_POLL_INTERVAL_MS);
}

function normalizeHistoryMessages(messages) {
  return messages.map((message) => ({
    ...message,
    final: true,
    runId: "",
  }));
}

function upsertLiveMessage({ sessionKey, runId, role, text, final }) {
  if (!sessionKey || sessionKey !== state.activeSessionKey) {
    return;
  }
  markRealtimeActivity();
  const liveKey = `${sessionKey}:${runId}:${role}`;
  const existingIndex = state.history.findIndex((item) => item.liveKey === liveKey);
  const nextEntry = {
    role,
    content: [{ type: "text", text }],
    text,
    final,
    runId,
    liveKey,
  };

  if (existingIndex >= 0) {
    state.history[existingIndex] = {
      ...state.history[existingIndex],
      ...nextEntry,
      final: final || state.history[existingIndex].final,
    };
  } else {
    state.history.push(nextEntry);
  }

  state.liveRuns.set(liveKey, nextEntry);
  renderHistory();
}

function extractAgentText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.delta === "string") return data.delta;
  if (typeof data.text === "string") return data.text;
  return "";
}

function handleChatEvent(payload) {
  const sessionKey = payload?.sessionKey;
  const runId = payload?.runId;
  const stateValue = payload?.state;
  const role = payload?.message?.role || "assistant";
  const text = extractMessageText(payload?.message || {});
  if (!sessionKey || !runId || !text) {
    return;
  }
  ensureSessionVisible(sessionKey);
  console.debug("[openclaw-ws] chat event", payload);
  if (sessionKey !== state.activeSessionKey) {
    return;
  }
  upsertLiveMessage({
    sessionKey,
    runId,
    role,
    text,
    final: stateValue === "final",
  });
}

function handleAgentEvent(payload) {
  const sessionKey = payload?.sessionKey;
  const runId = payload?.runId;
  const stream = payload?.stream;
  const data = payload?.data || {};
  if (!sessionKey || !runId) {
    return;
  }
  ensureSessionVisible(sessionKey);
  console.debug("[openclaw-ws] agent event", payload);
  if (sessionKey !== state.activeSessionKey) {
    return;
  }

  if (stream === "assistant") {
    const text = extractAgentText(data);
    if (!text) {
      return;
    }
    upsertLiveMessage({
      sessionKey,
      runId,
      role: "assistant",
      text,
      final: false,
    });
    return;
  }

  if (stream === "lifecycle" && data.phase === "end") {
    const prefix = `${sessionKey}:${runId}:`;
    for (const [liveKey, entry] of state.liveRuns.entries()) {
      if (!liveKey.startsWith(prefix)) continue;
      upsertLiveMessage({
        sessionKey,
        runId,
        role: entry.role || "assistant",
        text: entry.text || extractMessageText(entry),
        final: true,
      });
    }
  }
}

function loadConfig() {
  const stored = safeJsonParse(localStorage.getItem(STORAGE_CONFIG_KEY)) || {};
  const params = new URLSearchParams(window.location.search);
  const gateway = params.get("gateway") || params.get("url") || stored.gateway || "";
  const token = params.get("token") || stored.token || "";
  const scopes = params.get("scopes") || stored.scopes || "operator.read,operator.write";
  state.config = { gateway, token, scopes };
  saveConfig();
  els.gatewayUrl.value = gateway;
  els.gatewayToken.value = token;
  els.gatewayScopes.value = scopes;
}

function saveConfig() {
  localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(state.config));
}

function syncConfigFromInputs() {
  state.config = {
    gateway: els.gatewayUrl.value.trim(),
    token: els.gatewayToken.value.trim(),
    scopes: els.gatewayScopes.value.trim() || "operator.read,operator.write",
  };
  saveConfig();
  return state.config;
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function b64url(bytes) {
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

async function loadOrCreateIdentity() {
  const stored = safeJsonParse(localStorage.getItem(STORAGE_IDENTITY_KEY));
  if (stored?.privateJwk && stored?.deviceId) {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      stored.privateJwk,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(stored.publicKey),
      { name: "Ed25519" },
      true,
      ["verify"]
    );
    state.deviceId = stored.deviceId;
    return {
      ...stored,
      publicKeyText: stored.publicKey,
      privateKey,
      publicKey,
    };
  }

  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKey = b64url(rawPublic);
  const deviceId = await sha256Hex(rawPublic);
  const identity = { privateJwk, publicKey, deviceId };
  localStorage.setItem(STORAGE_IDENTITY_KEY, JSON.stringify(identity));
  state.deviceId = deviceId;
  return {
    ...identity,
    publicKeyText: publicKey,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function platformName() {
  return navigator.platform || "web";
}

function deviceFamilyName() {
  return "";
}

function clientMode() {
  return "cli";
}

function clientId() {
  return "cli";
}

function scopesList() {
  return els.gatewayScopes.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function buildConnectRequest({ identity, nonce }) {
  const signedAt = Date.now();
  const gatewayToken = state.config.token || "";
  const scopes = scopesList();
  const payloadV3 = [
    "v3",
    identity.deviceId,
    clientId(),
    clientMode(),
    "operator",
    scopes.join(","),
    String(signedAt),
    gatewayToken,
    nonce,
    platformName().toLowerCase(),
    deviceFamilyName().toLowerCase(),
  ].join("|");

  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, identity.privateKey, new TextEncoder().encode(payloadV3))
  );

  return {
    type: "req",
    id: crypto.randomUUID(),
    method: "connect",
    params: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: clientId(),
        version: "1.0.0",
        platform: navigator.platform || platformName(),
        mode: clientMode(),
      },
      role: "operator",
      scopes,
      caps: ["tool-events"],
      commands: [],
      permissions: {},
      auth: { token: gatewayToken },
      locale: navigator.language || "en-US",
      userAgent: navigator.userAgent || "openclaw-ws-monitor/1.0",
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKeyText,
        signature: b64url(signatureBytes),
        signedAt,
        nonce,
      },
    },
  };
}

async function connect({ preserveState = false } = {}) {
  setConnectButtonBusy(true);
  if (!window.isSecureContext) {
    setStatus("error", "WebCrypto 需要安全上下文（https 或 localhost）");
    setModalVisible("status", true);
    setConnectButtonBusy(false);
    return;
  }

  if (!("crypto" in window) || !crypto.subtle) {
    setStatus("error", "当前浏览器不支持 WebCrypto");
    setModalVisible("status", true);
    setConnectButtonBusy(false);
    return;
  }

  syncConfigFromInputs();

  if (!state.config.gateway) {
    setStatus("error", "请先输入 Gateway URL");
    setModalVisible("status", true);
    setConnectButtonBusy(false);
    return;
  }

  clearReconnectTimer();
  state.manualDisconnect = false;
  disconnect(false, preserveState);
  if (!preserveState) {
    state.sessions = [];
    state.history = [];
    state.activeSessionKey = "";
    state.liveRuns = new Map();
    state.lastRealtimeEventAt = 0;
    stopHistoryPolling();
    renderSessions();
    renderHistory();
  }

  const identity = await loadOrCreateIdentity();
  els.deviceId.textContent = identity.deviceId;

  setStatus("connecting", `connecting ${state.config.gateway}`);
  setModalVisible("status", true);
  appendFrame({
    direction: "outbound",
    label: "config",
    body: {
      gateway: state.config.gateway,
      token: state.config.token,
      scopes: scopesList(),
      deviceId: identity.deviceId,
    },
    kind: "system",
    topic: "system",
  });

  const socket = new WebSocket(state.config.gateway);
  state.socket = socket;

  socket.addEventListener("open", () => {
    clearReconnectTimer();
    setStatus("handshaking", "waiting for connect.challenge");
  });

  socket.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      appendFrame({ direction: "inbound", label: "message", body: event.data, kind: "inbound", topic: "system" });
      return;
    }
    appendFrame({ direction: "inbound", label: payload.event || payload.method || payload.type || "message", body: payload, kind: "inbound" });

    if (payload?.type === "event" && payload?.event === "connect.challenge") {
      const nonce = payload?.payload?.nonce;
      if (!nonce) {
        setStatus("error", "challenge 缺少 nonce");
        return;
      }
      const connectRequest = await buildConnectRequest({ identity, nonce });
      socket.send(JSON.stringify(connectRequest));
      appendFrame({ direction: "outbound", label: "connect", body: connectRequest, kind: "outbound", topic: "system" });
      setStatus("handshaking", "connect request sent");
      return;
    }

    if (payload?.type === "event" && payload?.event === "chat") {
      handleChatEvent(payload.payload || {});
      return;
    }

    if (payload?.type === "event" && payload?.event === "agent") {
      handleAgentEvent(payload.payload || {});
      return;
    }

    if (payload?.type === "res" && payload?.payload?.type === "hello-ok" && payload?.ok === true) {
      state.protocolVersion = String(payload.payload.protocol ?? "-");
      state.connId = payload.payload.server?.connId || "-";
      els.protocolVersion.textContent = state.protocolVersion;
      els.connId.textContent = state.connId;
      if (payload.payload?.auth?.deviceToken) {
        appendFrame({
          direction: "system",
          label: "device-token.received",
          body: {
            note: "deviceToken received from hello-ok but not persisted; keep using the configured gateway token",
            role: payload.payload.auth.role || "",
            scopes: payload.payload.auth.scopes || [],
          },
          kind: "system",
          topic: "system",
        });
      }
      setStatus("connected", "handshake complete");
      setConnectButtonBusy(false);
      await loadSessions().catch((error) => {
        appendFrame({ direction: "system", label: "sessions.list.error", body: String(error), kind: "system" });
      });
      return;
    }

    if (payload?.type === "res" && typeof payload?.id === "string") {
      const pending = state.pendingRequests.get(payload.id);
      if (pending) {
        state.pendingRequests.delete(payload.id);
        if (payload.ok) {
          pending.resolve(payload.payload);
        } else {
          pending.reject(payload.error || payload);
        }
        return;
      }
    }

    if (payload?.type === "res" && payload?.ok === false) {
      setStatus("error", JSON.stringify(payload.error || payload));
    }
  });

  socket.addEventListener("close", (event) => {
    setStatus("closed", `closed ${event.code} ${event.reason || ""}`.trim());
    setConnectButtonBusy(false);
    if (state.socket === socket) {
      state.socket = null;
    }
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setStatus("error", "websocket error");
    setConnectButtonBusy(false);
  });
}

function disconnect(manual = true, preserveState = false) {
  if (manual) {
    state.manualDisconnect = true;
  }
  clearReconnectTimer();
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
  setConnectButtonBusy(false);
  for (const [, pending] of state.pendingRequests) {
    pending.reject(new Error("socket disconnected"));
  }
  state.pendingRequests.clear();
  if (preserveState) {
    return;
  }
  state.sessions = [];
  state.history = [];
  state.activeSessionKey = "";
  state.liveRuns = new Map();
  state.lastRealtimeEventAt = 0;
  stopHistoryPolling();
  renderSessions();
  renderHistory();
}

function togglePolling() {
  state.pollEnabled = !state.pollEnabled;
  renderPollingButton();
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.activeSessionKey) {
    return;
  }
  if (state.pollEnabled) {
    startHistoryPolling();
    appendFrame({
      direction: "system",
      label: "chat.history.polling.enabled",
      body: { intervalMs: HISTORY_POLL_INTERVAL_MS, sessionKey: state.activeSessionKey },
      kind: "system",
      topic: "system",
    });
    return;
  }
  stopHistoryPolling();
  appendFrame({
    direction: "system",
    label: "chat.history.polling.disabled",
    body: { sessionKey: state.activeSessionKey },
    kind: "system",
    topic: "system",
  });
}

function init() {
  loadConfig();
  els.deviceId.textContent = state.deviceId || "-";
  els.protocolVersion.textContent = state.protocolVersion;
  els.connId.textContent = state.connId;
  renderFrames();
  renderSessions();
  renderHistory();
  renderPollingButton();
  setConnectButtonBusy(false);

  els.saveSettingsBtn?.addEventListener("click", () => {
    syncConfigFromInputs();
    setStatus("idle", "配置已保存");
  });

  els.connectBtn.addEventListener("click", (event) => {
    event.preventDefault();
    connect().catch((error) => {
      appendFrame({ direction: "system", label: "error", body: String(error), kind: "system" });
      setStatus("error", String(error));
      setConnectButtonBusy(false);
    });
  });
  els.disconnectBtn.addEventListener("click", () => disconnect(true));
  els.pollToggleBtn.addEventListener("click", togglePolling);
  els.settingsBtn.addEventListener("click", () => setModalVisible("settings", true));
  els.statusBtn.addEventListener("click", () => setModalVisible("status", true));
  els.copyFramesBtn.addEventListener("click", copyFrames);
  document.querySelectorAll("[data-close-modal]").forEach((node) => {
    node.addEventListener("click", () => setModalVisible(node.getAttribute("data-close-modal"), false));
  });

  if (state.config.gateway && state.config.token) {
    connect().catch((error) => {
      appendFrame({ direction: "system", label: "error", body: String(error), kind: "system" });
      setStatus("error", String(error));
    });
  }
}

init();
