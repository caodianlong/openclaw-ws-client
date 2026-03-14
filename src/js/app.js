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
  trafficChart: null,
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
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  statusBtn: document.getElementById("status-btn"),
  copyFramesBtn: document.getElementById("copy-frames-btn"),
  settingsModal: document.getElementById("settings-modal"),
  statusModal: document.getElementById("status-modal"),
  sessionList: document.getElementById("session-list"),
  historyList: document.getElementById("history-list"),
  historySummary: document.getElementById("history-summary"),
  historySubtitle: document.getElementById("history-subtitle"),
  sessionModel: document.getElementById("session-model"),
  statusDot: document.getElementById("status-dot"),
  statusDotDetail: document.getElementById("status-dot-detail"),
  statusText: document.getElementById("status-text"),
  statusTextHeader: document.getElementById("status-text-header"),
  statusDetail: document.getElementById("status-detail"),
  protocolVersion: document.getElementById("protocol-version"),
  connId: document.getElementById("conn-id"),
  deviceId: document.getElementById("device-id"),
  frameCount: document.getElementById("frame-count"),
};

function setConnectButtonBusy(busy) {
  if (!els.connectBtn) return;
  els.connectBtn.disabled = busy;
  els.connectBtn.textContent = busy ? "Connecting..." : "Connect Now";
  els.connectBtn.classList.toggle("opacity-50", busy);
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
  if (els.statusText) els.statusText.textContent = status;
  if (els.statusTextHeader) els.statusTextHeader.textContent = status;
  if (els.statusDetail) els.statusDetail.textContent = detail;
  
  let colorClass = "bg-slate-400";
  if (status === "connecting" || status === "handshaking") colorClass = "bg-amber-400";
  else if (status === "connected") colorClass = "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
  else if (status === "error" || status === "closed") colorClass = "bg-rose-500";
  
  if (els.statusDot) els.statusDot.className = `w-2 h-2 rounded-full ${colorClass}`;
  if (els.statusDotDetail) els.statusDotDetail.className = `w-3 h-3 rounded-full ${colorClass}`;
}

function renderPollingButton() {
  const active = state.pollEnabled;
  els.pollToggleBtn.classList.toggle("border-brand", active);
  els.pollToggleBtn.classList.toggle("text-brand", active);
  els.pollDot.className = `w-2 h-2 rounded-full ${active ? "bg-brand" : "bg-slate-300"}`;
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
  els.copyFramesBtn.innerHTML = ok ? '<i class="fa-solid fa-check text-emerald-500"></i>' : text;
  window.setTimeout(() => {
    els.copyFramesBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
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
    copyFramesLabel('<i class="fa-solid fa-xmark text-rose-500"></i>');
  }
}

function renderFrames() {
  if (els.frameCount) els.frameCount.textContent = String(state.frameCount);
}

function renderSessions() {
  if (!state.sessions.length) {
    els.sessionList.innerHTML = `<div class="px-2 py-2 text-sm text-slate-500 italic">No sessions found</div>`;
    return;
  }

  els.sessionList.innerHTML = state.sessions
    .map((session) => {
      const active = session.key === state.activeSessionKey;
      const activeClass = active 
        ? "bg-brand/10 text-brand border-brand/20 shadow-sm" 
        : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-transparent";
      
      return `
        <article class="session-item group px-3 py-2.5 rounded-lg border text-sm font-medium cursor-pointer flex justify-between items-center ${activeClass}" data-key="${escapeHtml(session.key)}">
          <span class="truncate pr-2">${escapeHtml(session.displayName || session.key)}</span>
          ${active ? '<i class="fa-solid fa-chevron-right text-[10px] text-brand"></i>' : ""}
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
  const existing = state.sessions.find((session) => sessionKeysMatch(session.key, sessionKey));
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

function renderContentParts(entry, isStreaming = false) {
  const content = entry?.content;
  if (!Array.isArray(content)) {
    const fallback = extractMessageText(entry);
    return `<div class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm text-sm leading-relaxed prose prose-slate dark:prose-invert max-w-none break-words">${marked.parse(fallback)}</div>`;
  }

  const blocks = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        const text = String(item ?? "");
        return `<div class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm text-sm leading-relaxed prose prose-slate dark:prose-invert max-w-none break-words">${marked.parse(text)}</div>`;
      }

      if (item.type === "text") {
        return `<div class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm text-sm leading-relaxed prose prose-slate dark:prose-invert max-w-none break-words">${marked.parse(item.text || "")}</div>`;
      }

      if (item.type === "thinking") {
        const thinkingText = item.thinking || "";
        const summary = summarizeThinking(thinkingText);
        return `
          <details class="group bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer list-none">
              <span class="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] font-bold uppercase tracking-wider text-slate-500">Thinking</span>
              <span class="text-xs text-slate-500 truncate italic">${escapeHtml(summary)}</span>
              <i class="fa-solid fa-chevron-down ml-auto text-[10px] text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <div class="px-3 pb-3 text-xs text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-2 whitespace-pre-wrap leading-relaxed">${escapeHtml(thinkingText)}</div>
          </details>
        `;
      }

      if (item.type === "toolCall") {
        const args = JSON.stringify(item.arguments || {}, null, 2);
        const summary = summarizeToolCall(item);
        return `
          <details class="group bg-indigo-50/30 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-900/30 rounded-xl overflow-hidden">
            <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer list-none">
              <span class="px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-[10px] font-bold uppercase tracking-wider text-indigo-500 dark:text-indigo-400">Call</span>
              <span class="text-xs font-bold text-slate-700 dark:text-slate-300">${escapeHtml(item.name || "unknown")}</span>
              <span class="text-[10px] text-slate-500 truncate italic">${escapeHtml(summary)}</span>
              <i class="fa-solid fa-chevron-down ml-auto text-[10px] text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <div class="px-3 pb-3 border-t border-indigo-50 dark:border-indigo-900/20 pt-2">
              ${item.id ? `<div class="mb-1"><span class="text-[9px] font-bold text-slate-400 uppercase mr-2">ID</span><code class="text-[10px] text-slate-500">${escapeHtml(item.id)}</code></div>` : ""}
              <pre class="p-2 bg-slate-900 text-indigo-300 rounded-lg text-[10px] font-mono overflow-x-auto">${escapeHtml(args)}</pre>
            </div>
          </details>
        `;
      }

      return `<pre class="p-3 bg-slate-100 dark:bg-slate-800 rounded-xl text-[10px] font-mono">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`;
    })
    .join("");

  return `<div class="space-y-2">${blocks}</div>`;
}

function renderToolResult(entry) {
  const text = Array.isArray(entry?.content) ? extractContentText(entry.content) : extractMessageText(entry);
  const isError = entry?.isError;
  const { summary, lineCount } = summarizeToolResult(text);
  const shouldOpen = isError || lineCount <= 3;
  
  const bgClass = isError ? "bg-rose-50/30 dark:bg-rose-900/10 border-rose-100 dark:border-rose-900/30" : "bg-emerald-50/30 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900/30";
  const badgeClass = isError ? "bg-rose-100 dark:bg-rose-900/40 text-rose-500 dark:text-rose-400" : "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-500 dark:text-emerald-400";
  
  return `
    <details class="group ${bgClass} border rounded-xl overflow-hidden" ${shouldOpen ? "open" : ""}>
      <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer list-none">
        <span class="px-2 py-0.5 rounded ${badgeClass} text-[10px] font-bold uppercase tracking-wider">${isError ? "Error" : "Result"}</span>
        <span class="text-xs font-bold text-slate-700 dark:text-slate-300">${escapeHtml(entry?.toolName || "tool")}</span>
        <span class="text-[10px] text-slate-500 truncate italic">${escapeHtml(summary)}</span>
        <span class="text-[9px] text-slate-400 ml-auto">${lineCount} lines</span>
        <i class="fa-solid fa-chevron-down text-[10px] text-slate-400 group-open:rotate-180 transition-transform"></i>
      </summary>
      <div class="px-3 pb-3 border-t border-slate-100 dark:border-slate-800/50 pt-2">
        ${entry?.toolCallId ? `<div class="mb-1"><span class="text-[9px] font-bold text-slate-400 uppercase mr-2">Call ID</span><code class="text-[10px] text-slate-500">${escapeHtml(entry.toolCallId)}</code></div>` : ""}
        <pre class="p-2 bg-slate-900 text-slate-300 rounded-lg text-[10px] font-mono overflow-x-auto leading-relaxed">${escapeHtml(text)}</pre>
      </div>
    </details>
  `;
}

function getRoleIcon(role, isError = false) {
  switch (role) {
    case "user": return '<i class="fa-solid fa-circle-user text-blue-500"></i>';
    case "assistant": return '<i class="fa-solid fa-robot text-emerald-500"></i>';
    case "system": return '<i class="fa-solid fa-gears text-slate-400"></i>';
    case "tool": return '<i class="fa-solid fa-screwdriver-wrench text-indigo-500"></i>';
    case "toolResult": return isError ? '<i class="fa-solid fa-circle-exclamation text-rose-500"></i>' : '<i class="fa-solid fa-circle-check text-emerald-500"></i>';
    default: return '<i class="fa-solid fa-circle-question text-slate-300"></i>';
  }
}

function renderMessage(entry) {
  const role = entry?.role || "unknown";
  const isError = role === "toolResult" && entry.isError;
  const isStreaming = entry.runId && !entry.final;
  const statusLabel = entry.final ? "final" : entry.runId ? "streaming" : "";
  const isUser = role === "user";
  const liveKey = entry.liveKey || "";
  
  let bodyHtml = "";
  if (role === "toolResult") {
    bodyHtml = renderToolResult(entry);
  } else {
    bodyHtml = renderContentParts(entry, isStreaming);
  }
  
  return `
    <article class="flex gap-4 ${isUser ? "flex-row-reverse" : "flex-row"} group" data-live-key="${escapeHtml(liveKey)}">
      <div class="flex-shrink-0 w-8 h-8 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-sm shadow-sm">
        ${getRoleIcon(role, isError)}
      </div>
      <div class="flex-1 min-w-0 max-w-[85%] space-y-1.5">
        <header class="flex items-center gap-2 px-1 ${isUser ? "flex-row-reverse" : "flex-row"}">
          <span class="text-[10px] font-black uppercase tracking-widest text-slate-400">${escapeHtml(role)}</span>
          ${statusLabel ? `
            <span class="history-status-badge px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-tighter ${entry.final ? "bg-slate-100 dark:bg-slate-800 text-slate-400" : "bg-brand/10 text-brand"}">
              ${escapeHtml(statusLabel)}
            </span>` : ""}
        </header>
        <div class="message-body-container ${isUser ? "flex justify-end" : ""}">
          ${bodyHtml}
        </div>
      </div>
    </article>
  `;
}

function scrollToBottom({ force = false, instant = false } = {}) {
  const list = els.historyList;
  if (!list) return;
  
  // Use requestAnimationFrame to ensure the DOM has updated its scrollHeight
  requestAnimationFrame(() => {
    const threshold = 300;
    const isAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < threshold;
    
    if (force || isAtBottom) {
      list.scrollTo({ 
        top: list.scrollHeight, 
        behavior: instant ? "auto" : "smooth" 
      });
    }
  });
}

function upsertMessageDOM(entry) {
  const liveKey = entry.liveKey;
  if (!liveKey) {
    renderHistory();
    return;
  }

  const existingNode = els.historyList.querySelector(`[data-live-key="${liveKey}"]`);
  let isNewNode = false;

  if (existingNode) {
    const bodyContainer = existingNode.querySelector(".message-body-container");
    if (bodyContainer) {
      const role = entry?.role || "unknown";
      const isStreaming = entry.runId && !entry.final;
      bodyContainer.innerHTML = (role === "toolResult") ? renderToolResult(entry) : renderContentParts(entry, isStreaming);
    }
    const badge = existingNode.querySelector(".history-status-badge");
    if (badge) {
      const statusLabel = entry.final ? "final" : entry.runId ? "streaming" : "";
      badge.textContent = statusLabel;
      badge.className = `history-status-badge px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-tighter ${entry.final ? "bg-slate-100 dark:bg-slate-800 text-slate-400" : "bg-brand/10 text-brand"}`;
      if (!statusLabel) badge.remove();
    } else if (entry.runId) {
      const header = existingNode.querySelector("header");
      const statusLabel = entry.final ? "final" : "streaming";
      const badgeHtml = `<span class="history-status-badge px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-tighter ${entry.final ? "bg-slate-100 dark:bg-slate-800 text-slate-400" : "bg-brand/10 text-brand"}">${statusLabel}</span>`;
      header.insertAdjacentHTML('beforeend', badgeHtml);
    }
  } else {
    isNewNode = true;
    const temp = document.createElement("div");
    temp.innerHTML = renderMessage(entry);
    const newNode = temp.firstElementChild;
    
    if (entry._insertBeforeLiveKey) {
      const referenceNode = els.historyList.querySelector(`[data-live-key="${entry._insertBeforeLiveKey}"]`);
      if (referenceNode) {
        els.historyList.insertBefore(newNode, referenceNode);
      } else {
        els.historyList.appendChild(newNode);
      }
    } else {
      els.historyList.appendChild(newNode);
    }
  }
  
  const isStreaming = entry.runId && !entry.final;
  // Force scroll if it's a new message. Use instant scroll during active streaming to prevent stutter.
  scrollToBottom({ force: isNewNode, instant: isStreaming });
}

function renderHistory() {
  if (!state.activeSessionKey) {
    if (els.historySummary) els.historySummary.textContent = "No active session";
    if (els.sessionModel) els.sessionModel.classList.add("hidden");
    if (els.historySubtitle) els.historySubtitle.textContent = "Live conversation history";
    if (els.historyList) els.historyList.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center space-y-3 opacity-50">
        <i class="fa-solid fa-message-dots text-3xl text-slate-400"></i>
        <p class="text-sm">Select a session from the sidebar to view history</p>
      </div>`;
    return;
  }

  const currentSession = state.sessions.find(s => s.key === state.activeSessionKey);
  let provider = currentSession?.provider || currentSession?.metadata?.provider || "";
  let model = currentSession?.model || currentSession?.metadata?.model || "";
  
  if (!provider || !model) {
    const lastAssistantMsg = [...state.history].reverse().find(m => m.role === "assistant" && (m.provider || m.model || m.extra?.model));
    if (lastAssistantMsg) {
      provider = provider || lastAssistantMsg.provider || lastAssistantMsg.extra?.provider || "";
      model = model || lastAssistantMsg.model || lastAssistantMsg.extra?.model || "";
    }
  }

  const modelDisplay = (provider && model) ? `${provider}/${model}` : (provider || model);
  
  if (els.sessionModel) {
    if (modelDisplay) {
      els.sessionModel.textContent = modelDisplay;
      els.sessionModel.classList.remove("hidden");
    } else {
      els.sessionModel.classList.add("hidden");
    }
  }

  if (els.historySummary) els.historySummary.textContent = `${state.activeSessionKey}`;
  const count = state.history.length;
  if (els.historySubtitle) els.historySubtitle.textContent = `${count} messages in this thread`;

  if (!state.history.length) {
    if (els.historyList) els.historyList.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center space-y-3 opacity-30">
        <i class="fa-solid fa-inbox text-3xl"></i>
        <p class="text-sm font-medium">This session has no messages yet</p>
      </div>`;
    return;
  }

  if (els.historyList) {
    els.historyList.innerHTML = state.history.map((entry) => renderMessage(entry)).join("");
    scrollToBottom({ force: true, instant: true });
  }
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

function sessionKeyVariants(sessionKey) {
  const raw = String(sessionKey || "").trim();
  if (!raw) return [];
  const parts = raw.split(":").filter(Boolean);
  if (!parts.length) return [raw];
  const variants = new Set([raw]);
  for (let index = 1; index < parts.length; index += 1) {
    variants.add(parts.slice(index).join(":"));
  }
  variants.add(parts[parts.length - 1]);
  return Array.from(variants);
}

function sessionKeysMatch(incoming, current) {
  if (!incoming || !current) return false;
  const incomingVariants = new Set(sessionKeyVariants(incoming));
  return sessionKeyVariants(current).some((variant) => incomingVariants.has(variant));
}

function resolveVisibleSessionKey(sessionKey) {
  if (sessionKeysMatch(sessionKey, state.activeSessionKey)) {
    return state.activeSessionKey || sessionKey;
  }
  return sessionKey;
}

function mergeLiveText(previousText, nextText) {
  const prev = String(previousText || "");
  const next = String(nextText || "");
  if (!prev) return next;
  if (!next) return prev;
  if (next === prev) return prev;
  if (next.startsWith(prev)) return next;
  if (prev.endsWith(next)) return prev;

  const overlapLimit = Math.min(prev.length, next.length);
  for (let size = overlapLimit; size > 0; size -= 1) {
    if (prev.slice(-size) === next.slice(0, size)) {
      return prev + next.slice(size);
    }
  }
  return prev + next;
}

function upsertLiveMessage({ sessionKey, runId, role, text, final }) {
  const visibleSessionKey = resolveVisibleSessionKey(sessionKey);
  if (!visibleSessionKey || visibleSessionKey !== state.activeSessionKey) {
    return;
  }
  markRealtimeActivity();
  const liveKey = `${visibleSessionKey}:${runId}:${role}`;
  const existingIndex = state.history.findIndex((item) => item.liveKey === liveKey);
  const previousEntry =
    existingIndex >= 0 ? state.history[existingIndex] : state.liveRuns.get(liveKey);
  const mergedText = mergeLiveText(previousEntry?.text, text);
  const nextEntry = {
    role,
    content: [{ type: "text", text: mergedText }],
    text: mergedText,
    final,
    runId,
    sessionKey: visibleSessionKey,
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
  upsertMessageDOM(nextEntry);
}

function upsertLiveEntry(liveKey, nextEntry) {
  const existingIndex = state.history.findIndex((item) => item.liveKey === liveKey);
  
  if (existingIndex >= 0) {
    state.history[existingIndex] = {
      ...state.history[existingIndex],
      ...nextEntry,
      final: nextEntry.final || state.history[existingIndex].final,
    };
  } else {
    // If inserting a tool/toolResult, check if there's an active assistant message for this runId at the end.
    // To match backend final history order, tool calls should appear BEFORE the assistant's final text.
    let insertIndex = state.history.length;
    let insertBeforeLiveKey = null;
    
    if (nextEntry.role === "tool" || nextEntry.role === "toolResult") {
      let assistantIdx = -1;
      for (let i = state.history.length - 1; i >= 0; i--) {
        if (state.history[i].runId === nextEntry.runId) {
          if (state.history[i].role === "assistant") {
            assistantIdx = i;
          }
        } else {
          break; // Stop if we hit a different run
        }
      }
      
      if (assistantIdx >= 0) {
        insertIndex = assistantIdx;
        insertBeforeLiveKey = state.history[assistantIdx].liveKey;
        nextEntry._insertBeforeLiveKey = insertBeforeLiveKey;
      }
    }
    
    if (insertIndex < state.history.length) {
      state.history.splice(insertIndex, 0, nextEntry);
    } else {
      state.history.push(nextEntry);
    }
  }
  
  state.liveRuns.set(liveKey, nextEntry);
  upsertMessageDOM(nextEntry);
}

function summarizeJson(value, fallback = "") {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function upsertToolEvent(payload) {
  const visibleSessionKey = resolveVisibleSessionKey(payload?.sessionKey);
  const runId = payload?.runId;
  if (!visibleSessionKey || !runId || visibleSessionKey !== state.activeSessionKey) {
    return;
  }

  markRealtimeActivity();
  const data = payload?.data || {};
  const phase = data.phase || payload?.phase || "update";
  const toolId = data.toolCallId || data.id || payload?.toolCallId || payload?.id || `${payload?.stream || "tool"}:${phase}`;
  const toolName = data.toolName || data.name || payload?.toolName || payload?.name || "tool";
  const isTerminal = phase === "end" || phase === "result" || phase === "error";
  const input = data.arguments || data.input || data.params || payload?.arguments || payload?.input || {};
  const output =
    data.result ?? data.output ?? data.text ?? data.delta ?? data.error ?? payload?.result ?? payload?.output ?? payload?.error;

  if (phase === "start" || phase === "call") {
    const liveKey = `${visibleSessionKey}:${runId}:tool:${toolId}:call`;
    upsertLiveEntry(liveKey, {
      role: "tool",
      content: [{ type: "toolCall", id: String(toolId), name: toolName, arguments: input }],
      final: isTerminal,
      runId,
      sessionKey: visibleSessionKey,
      liveKey,
    });
    return;
  }

  const liveKey = `${visibleSessionKey}:${runId}:tool:${toolId}:result`;
  upsertLiveEntry(liveKey, {
    role: "toolResult",
    toolName,
    toolCallId: String(toolId),
    isError: phase === "error",
    content: [{ type: "text", text: summarizeJson(output, phase) }],
    final: isTerminal,
    runId,
    sessionKey: visibleSessionKey,
    liveKey,
  });
}

function extractAgentText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.delta === "string") return data.delta;
  if (typeof data.text === "string") return data.text;
  if (typeof data.reasoning === "string") return data.reasoning;
  return "";
}

function handleChatEvent(payload) {
  const sessionKey = payload?.sessionKey;
  const runId = payload?.runId;
  const stateValue = payload?.state;
  const role = payload?.message?.role || "assistant";
  const text = extractMessageText(payload?.message || {});
  if (!sessionKey || !runId) {
    return;
  }
  ensureSessionVisible(sessionKey);
  console.debug("[openclaw-ws] chat event", payload);
  const visibleSessionKey = resolveVisibleSessionKey(sessionKey);
  if (visibleSessionKey !== state.activeSessionKey) {
    return;
  }

  if (text) {
    upsertLiveMessage({
      sessionKey: visibleSessionKey,
      runId,
      role,
      text,
      final: stateValue === "final",
    });
  }

  if (stateValue === "final" || stateValue === "aborted" || stateValue === "error") {
    const prefix = `${visibleSessionKey}:${runId}:`;
    for (const [liveKey, entry] of state.liveRuns.entries()) {
      if (!liveKey.startsWith(prefix)) continue;
      upsertLiveEntry(liveKey, {
        ...entry,
        final: true,
      });
    }
    refreshActiveHistory({ silent: true }).catch((error) => {
      appendFrame({ direction: "system", label: "chat.final.refresh.error", body: String(error), kind: "system" });
    });
  }
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
  const visibleSessionKey = resolveVisibleSessionKey(sessionKey);
  if (visibleSessionKey !== state.activeSessionKey) {
    return;
  }

  if (stream === "assistant") {
    const text = extractAgentText(data);
    if (!text) {
      return;
    }
    upsertLiveMessage({
      sessionKey: visibleSessionKey,
      runId,
      role: "assistant",
      text,
      final: false,
    });
    return;
  }

  if (stream === "tool") {
    upsertToolEvent({
      ...payload,
      sessionKey: visibleSessionKey,
    });
    return;
  }

  if (stream === "lifecycle" && data.phase === "end") {
    const prefix = `${visibleSessionKey}:${runId}:`;
    for (const [liveKey, entry] of state.liveRuns.entries()) {
      if (!liveKey.startsWith(prefix)) continue;
      upsertLiveEntry(liveKey, {
        ...entry,
        final: true,
      });
    }
    refreshActiveHistory({ silent: true }).catch((error) => {
      appendFrame({ direction: "system", label: "agent.lifecycle.refresh.error", body: String(error), kind: "system" });
    });
  }

  if (stream === "lifecycle" && data.phase === "error") {
    appendFrame({
      direction: "system",
      label: "agent.lifecycle.error",
      body: payload,
      kind: "system",
      topic: "agent",
    });
    refreshActiveHistory({ silent: true }).catch((error) => {
      appendFrame({ direction: "system", label: "agent.lifecycle.refresh.error", body: String(error), kind: "system" });
    });
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

function initTheme() {
  const savedTheme = localStorage.getItem("openclaw.browser.theme");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = savedTheme === "dark" || (!savedTheme && systemDark);
  document.documentElement.classList.toggle("dark", isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("openclaw.browser.theme", isDark ? "dark" : "light");
}

function init() {
  initTheme();
  loadConfig();
  if (els.deviceId) els.deviceId.textContent = state.deviceId || "-";
  if (els.protocolVersion) els.protocolVersion.textContent = state.protocolVersion;
  if (els.connId) els.connId.textContent = state.connId;
  
  renderFrames();
  renderSessions();
  renderHistory();
  renderPollingButton();
  setConnectButtonBusy(false);

  // Initialize Traffic Chart
  requestAnimationFrame(() => {
    const ctx = document.getElementById('traffic-chart')?.getContext('2d');
    if (ctx) {
      state.trafficChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: Array(20).fill(''),
          datasets: [{
            data: Array(20).fill(0),
            borderColor: '#ff7442',
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            backgroundColor: 'rgba(255, 116, 66, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { display: false },
            y: { display: false, min: 0 }
          }
        }
      });
    }
  });

  // Traffic update loop
  setInterval(() => {
    if (state.trafficChart) {
      const dataset = state.trafficChart.data.datasets[0].data;
      dataset.push(state.frameCount);
      if (dataset.length > 20) dataset.shift();
      state.trafficChart.update('none');
    }
  }, 2000);

  els.saveSettingsBtn?.addEventListener("click", () => {
    syncConfigFromInputs();
    setStatus("idle", "Configuration saved locally");
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
  els.themeToggleBtn.addEventListener("click", toggleTheme);
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

