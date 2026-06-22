// 全局字段：所有站点共享
const globalFields = [
  "enabled",
  "apiBaseUrl",
  "apiKey",
  "contextBudget"
];

// 站点字段：按 URL 单独保存
const siteFields = [
  "containerSelector",
  "messageSelector",
  "textSelector",
  "senderSelector",
  "timeSelector"
];

const fields = [...globalFields, ...siteFields];

const defaults = {
  enabled: false,
  apiBaseUrl: "http://localhost:8000",
  apiKey: "dev-api-key",
  contextBudget: "262144",
  containerSelector: "",
  messageSelector: "",
  textSelector: "",
  senderSelector: "",
  timeSelector: ""
};

// 站点配置默认值
const SITE_CONFIG_KEY = "siteConfigs";

const t = {
  noLogs: "\u6682\u65e0\u65e5\u5fd7",
  detectHint: "\u8f93\u5165\u6d88\u606f\u6587\u672c\u540e\u53ef\u81ea\u52a8\u63a8\u65ad selector",
  detectModeMessage: "\u6d88\u606f\u6587\u672c",
  detectModeSender: "\u53d1\u9001\u4eba",
  detectModeTime: "\u65f6\u95f4",
  detectFailed: "\u5b9a\u4f4d\u5931\u8d25",
  matchCount: "\u5339\u914d\u6d88\u606f\u6570",
  textPreview: "\u6587\u672c\u9884\u89c8",
  senderPreview: "\u53d1\u9001\u4eba\u9884\u89c8",
  timePreview: "\u65f6\u95f4\u9884\u89c8",
  container: "\u5bb9\u5668",
  message: "\u5355\u6761\u6d88\u606f",
  messageText: "\u6d88\u606f\u6587\u672c",
  sender: "\u53d1\u9001\u4eba",
  time: "\u65f6\u95f4",
  reviewFailed: "AI \u68c0\u67e5\u5931\u8d25",
  reviewing: "\u6b63\u5728\u91c7\u96c6\u9875\u9762\u8bc1\u636e\u5e76\u8bf7\u6c42 AI \u68c0\u67e5...",
  reviewDone: "AI \u68c0\u67e5\u5b8c\u6210",
  applied: "\u5df2\u5e94\u7528\u63a8\u8350 selector",
  inputSample: "\u8bf7\u5148\u8f93\u5165\u5f53\u524d\u9875\u9762\u91cc\u5b58\u5728\u7684\u4e00\u6bb5\u6d88\u606f\u6587\u672c",
  detecting: "\u6b63\u5728\u5f53\u524d\u9875\u9762\u5b9a\u4f4d...",
  noContentScript: "\u5f53\u524d\u9875\u9762\u672a\u6ce8\u5165 content script",
  pageCommFailed: "\u5f53\u524d\u9875\u9762\u65e0\u6cd5\u901a\u4fe1\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u6216\u91cd\u65b0\u52a0\u8f7d\u63d2\u4ef6\u540e\u91cd\u8bd5",
  injecting: "\u5f53\u524d\u9875\u9762\u672a\u6ce8\u5165\u811a\u672c\uff0c\u6b63\u5728\u5c1d\u8bd5\u4e3b\u52a8\u6ce8\u5165...",
  copied: "\u5df2\u590d\u5236",
  copy: "\u590d\u5236"
};

function el(id) {
  return document.getElementById(id);
}

// 将任意 URL 规范化为用于匹配/保存的基础 URL：
// 去掉 hash 和 query，去掉末尾斜杠，保留 origin+path
function normalizeSiteUrl(rawUrl) {
  if (!rawUrl) return "";
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_e) {
    return "";
  }
  // 仅保留 origin + pathname，去掉末尾斜杠
  let path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

// 在 siteConfigs 中找出匹配当前页面 URL 的配置（最长前缀匹配）
// 返回 { config, index } 或 null
function matchSiteConfig(siteConfigs, pageUrl) {
  const target = normalizeSiteUrl(pageUrl);
  if (!target) return null;
  let best = null;
  let bestLen = -1;
  siteConfigs.forEach((config, index) => {
    const saved = normalizeSiteUrl(config.url);
    if (!saved) return;
    // 保存的 URL 需是当前页面 URL 的前缀（按 path 段匹配）
    if (target === saved || target.startsWith(saved + "/") || target.startsWith(saved + "?") || target.startsWith(saved + "#")) {
      if (saved.length > bestLen) {
        best = { config, index };
        bestLen = saved.length;
      }
    }
  });
  return best;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!String(error.message || "").includes("Receiving end does not exist")) {
      throw error;
    }
    await injectContentScript(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content.js"]
  });
}

function formatLogs(logs) {
  if (!logs || logs.length === 0) return t.noLogs;
  return logs
    .slice()
    .reverse()
    .map((log) => {
      const data = log.data && Object.keys(log.data).length > 0 ? ` ${JSON.stringify(log.data)}` : "";
      return `[${log.time}] ${String(log.level).toUpperCase()} ${log.message}${data}`;
    })
    .join("\n");
}

function formatDetectPreview(result) {
  if (!result) return t.detectHint;
  if (!result.ok) return `${t.detectFailed}: ${result.error}`;
  const modeLabel = result.mode === "sender" ? t.detectModeSender : result.mode === "time" ? t.detectModeTime : t.detectModeMessage;
  const lines = [`定位类型: ${modeLabel}`, `${t.matchCount}: ${result.preview.messageCount}`];
  if (result.mode === "sender") {
    lines.push(`${t.senderPreview}: ${result.preview.sender || "-"}`, "", `${t.sender}: ${result.selectors.senderSelector || "-"}`);
  } else if (result.mode === "time") {
    lines.push(`${t.timePreview}: ${result.preview.time || "-"}`, "", `${t.time}: ${result.selectors.timeSelector || "-"}`);
  } else {
    lines.push(
      `${t.textPreview}: ${result.preview.text || "-"}`,
      "",
      `${t.container}: ${result.selectors.containerSelector}`,
      `${t.message}: ${result.selectors.messageSelector}`,
      `${t.messageText}: ${result.selectors.textSelector}`
    );
  }
  return lines.join("\n");
}

function getSettingsFromForm() {
  const settings = {};
  fields.forEach((field) => {
    const input = el(field);
    settings[field] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  return settings;
}

// 从表单读取当前站点 selector 字段
function getSiteConfigFromForm() {
  const config = {};
  siteFields.forEach((field) => {
    config[field] = el(field).value.trim();
  });
  return config;
}

// 把站点 selector 字段写回表单
function applySiteConfigToForm(config) {
  siteFields.forEach((field) => {
    el(field).value = config?.[field] || "";
  });
}

// 读取全局设置（含当前匹配到的站点 selector，供 content.js 使用）
async function loadGlobalSettings() {
  const result = await chrome.storage.sync.get(["settings"]);
  return { ...defaults, ...(result.settings || {}) };
}

// 读取所有站点配置
async function loadSiteConfigs() {
  const result = await chrome.storage.sync.get([SITE_CONFIG_KEY]);
  return result[SITE_CONFIG_KEY] || [];
}

async function saveSiteConfigs(siteConfigs) {
  await chrome.storage.sync.set({ [SITE_CONFIG_KEY]: siteConfigs });
}

async function apiFetch(path, options = {}) {
  const settings = getSettingsFromForm();
  const base = settings.apiBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": settings.apiKey,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

function formatReviewResult(result) {
  const selectors = result.recommended_selectors || {};
  const issues = result.issues?.length ? result.issues.map((item) => `- ${item}`).join("\n") : "- none";
  return [
    `${t.reviewDone}`,
    `confidence: ${result.confidence}`,
    `summary: ${result.summary}`,
    "",
    "recommended selectors:",
    `container: ${selectors.containerSelector || "-"}`,
    `message: ${selectors.messageSelector || "-"}`,
    `text: ${selectors.textSelector || "-"}`,
    `sender: ${selectors.senderSelector || "-"}`,
    `time: ${selectors.timeSelector || "-"}`,
    "",
    "issues:",
    issues
  ].join("\n");
}

async function loadSettings() {
  // 先加载全局字段
  const global = await loadGlobalSettings();
  globalFields.forEach((field) => {
    const input = el(field);
    if (input.type === "checkbox") input.checked = Boolean(global[field]);
    else input.value = global[field] || "";
  });

  // 再根据当前活动标签页 URL 匹配站点配置
  await refreshSiteMatch();
}

// 根据当前活动标签页 URL，匹配站点配置并刷新 UI
async function refreshSiteMatch() {
  const tab = await getActiveTab();
  const pageUrl = tab?.url || "";
  const normalized = normalizeSiteUrl(pageUrl);
  el("siteUrl").value = normalized;

  const siteConfigs = await loadSiteConfigs();
  const matched = matchSiteConfig(siteConfigs, pageUrl);

  const hint = el("siteMatchHint");
  if (!pageUrl || !normalized) {
    hint.textContent = "无法读取当前页面 URL";
    applySiteConfigToForm(null);
  } else if (matched) {
    hint.textContent = `已匹配站点配置：${matched.config.url}`;
    applySiteConfigToForm(matched.config.selectors || {});
  } else {
    hint.textContent = "当前页面未匹配到任何已保存的站点配置";
    applySiteConfigToForm(null);
  }

  // 渲染站点列表
  renderSiteList(siteConfigs, normalized);

  // 把当前匹配到的完整 settings（全局 + 站点）写回 storage.settings，
  // 这样 content.js 启动/重载时能直接拿到合并后的配置
  const merged = { ...defaults, ...(await loadGlobalSettings()) };
  if (matched) Object.assign(merged, matched.config.selectors || {});
  await chrome.storage.sync.set({ settings: merged });
}

function renderSiteList(siteConfigs, currentNormalized) {
  const list = el("siteList");
  if (!siteConfigs.length) {
    list.innerHTML = `<li class="empty">暂无已保存的站点配置</li>`;
    return;
  }
  list.innerHTML = siteConfigs
    .map((config) => {
      const isCurrent = normalizeSiteUrl(config.url) === currentNormalized;
      return `<li class="${isCurrent ? "current" : ""}">
        <span class="site-url">${config.url}</span>
      </li>`;
    })
    .join("");
}

async function saveSettings() {
  // 保存全局字段
  const global = {};
  globalFields.forEach((field) => {
    const input = el(field);
    global[field] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  await chrome.storage.sync.set({ settings: { ...defaults, ...(await loadGlobalSettings()), ...global } });
  await sendToContent({ type: "CAA_RELOAD" }).catch(() => null);
  await refreshState();
}

// 保存当前表单中的 selector 到当前 siteUrl 对应的站点配置
async function saveSiteConfig() {
  const url = el("siteUrl").value.trim();
  const normalized = normalizeSiteUrl(url);
  if (!normalized) {
    el("siteMatchHint").textContent = "请填写有效的站点 URL";
    return;
  }
  const selectors = getSiteConfigFromForm();
  if (!selectors.containerSelector || !selectors.messageSelector) {
    el("siteMatchHint").textContent = "container 与 message selector 不能为空";
    return;
  }
  const siteConfigs = await loadSiteConfigs();
  const idx = siteConfigs.findIndex((c) => normalizeSiteUrl(c.url) === normalized);
  if (idx >= 0) {
    siteConfigs[idx] = { ...siteConfigs[idx], url: normalized, selectors };
  } else {
    siteConfigs.push({ url: normalized, selectors });
  }
  await saveSiteConfigs(siteConfigs);
  await refreshSiteMatch();
  await sendToContent({ type: "CAA_RELOAD" }).catch(() => null);
  await refreshState();
}

// 删除当前 siteUrl 对应的站点配置
async function deleteSiteConfig() {
  const url = el("siteUrl").value.trim();
  const normalized = normalizeSiteUrl(url);
  if (!normalized) return;
  const siteConfigs = await loadSiteConfigs();
  const filtered = siteConfigs.filter((c) => normalizeSiteUrl(c.url) !== normalized);
  if (filtered.length === siteConfigs.length) {
    el("siteMatchHint").textContent = "未找到对应站点配置";
    return;
  }
  await saveSiteConfigs(filtered);
  await refreshSiteMatch();
  await sendToContent({ type: "CAA_RELOAD" }).catch(() => null);
  await refreshState();
}

async function autoDetect() {
  const preview = el("detectPreview");
  try {
    const sampleText = el("sampleText").value.trim();
    const mode = el("detectMode").value;
    if (!sampleText) {
      preview.textContent = t.inputSample;
      return;
    }
    preview.textContent = t.detecting;
    setTimeout(() => {
      if (preview.textContent === t.detecting) preview.textContent = t.injecting;
    }, 400);
    const result = await sendToContent({ type: "CAA_AUTO_DETECT", sampleText, mode }).catch((error) => ({
      ok: false,
      error: error.message || t.pageCommFailed
    }));
    preview.textContent = formatDetectPreview(result);
    if (!result?.ok) return;

    Object.entries(result.selectors).forEach(([key, value]) => {
      if (!el(key)) return;
      const shouldApply =
        mode === "message" ||
        (mode === "sender" && key === "senderSelector") ||
        (mode === "time" && key === "timeSelector");
      if (shouldApply) {
        el(key).value = value || "";
      }
    });
    // selector 字段已填入表单，立即保存到当前站点配置
    await saveSiteConfig();
  } catch (error) {
    preview.textContent = `${t.detectFailed}: ${error.message}`;
  }
}

async function reviewSelectors() {
  const preview = el("detectPreview");
  try {
    preview.textContent = t.reviewing;
    // 同步表单到 storage.settings，供 content.js 采集上下文时使用
    await chrome.storage.sync.set({ settings: { ...(await loadGlobalSettings()), ...getSettingsFromForm() } });
    const sampleText = el("sampleText").value.trim();
    const contextResult = await sendToContent({ type: "CAA_COLLECT_REVIEW_CONTEXT", sampleText });
    if (!contextResult?.ok) {
      preview.textContent = `${t.reviewFailed}: ${contextResult?.error || "failed to collect page context"}`;
      return;
    }
    const review = await apiFetch("/api/selector-review", {
      method: "POST",
      body: JSON.stringify(contextResult.payload)
    });
    preview.textContent = formatReviewResult(review);
    Object.entries(review.recommended_selectors || {}).forEach(([key, value]) => {
      if (el(key) && value) el(key).value = value;
    });
    // 把推荐结果保存到当前站点配置
    await saveSiteConfig();
  } catch (error) {
    preview.textContent = `${t.reviewFailed}: ${error.message}`;
  }
}

async function refreshState() {
  const local = await chrome.storage.local.get(["captureStatus", "lastSuggestion", "debugLogs"]);
  let state = null;
  try {
    state = await sendToContent({ type: "CAA_GET_STATE" });
  } catch (_error) {
    state = null;
  }
  const status = state?.status || local.captureStatus || t.noContentScript;
  const suggestion = state?.suggestion || local.lastSuggestion;
  const logs = state?.logs || local.debugLogs || [];
  el("captureStatus").textContent = status;
  el("suggestionText").value = suggestion?.content || "";
  el("debugLogs").textContent = formatLogs(logs);
}

async function clearLogs() {
  await chrome.storage.local.set({ debugLogs: [] });
  await refreshState();
}

async function copySuggestion() {
  const value = el("suggestionText").value;
  if (!value) return;
  await navigator.clipboard.writeText(value);
  el("copySuggestion").textContent = t.copied;
  setTimeout(() => {
    el("copySuggestion").textContent = t.copy;
  }, 1200);
}

async function previewContext() {
  const previewSection = el("contextPreview");
  const stats = el("previewStats");
  const content = el("previewContent");
  try {
    const state = await sendToContent({ type: "CAA_GET_STATE" });
    const conversationId = state?.conversationId;
    if (!conversationId) {
      stats.textContent = "当前页面还未建立会话，请先启用捕捉并等待消息上报";
      content.textContent = "";
      previewSection.hidden = false;
      return;
    }
    const settings = getSettingsFromForm();
    const budget = Number(settings.contextBudget) || 262144;
    const base = settings.apiBaseUrl.replace(/\/$/, "");
    stats.textContent = "正在请求预览...";
    content.textContent = "";
    previewSection.hidden = false;
    const resp = await fetch(
      `${base}/api/conversations/${conversationId}/context-preview?budget=${budget}`,
      { headers: { "X-API-Key": settings.apiKey } }
    );
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    stats.textContent =
      `预算: ${data.budget} | 已用: ${data.used_tokens} | ` +
      `进入上下文: ${data.kept_messages}/${data.total_messages} 条消息 | ` +
      `知识片段: ${data.kept_chunks}/${data.total_chunks}`;
    const lines = [];
    lines.push("=== 对话消息（预算内）===");
    data.messages.forEach((m) => {
      const sender = m.sender_name ? `${m.sender_type}(${m.sender_name})` : m.sender_type;
      lines.push(`[${m.created_at?.slice(11, 19) || ""}] ${sender}: ${m.content}`);
    });
    if (data.chunks.length) {
      lines.push("");
      lines.push("=== 知识片段（预算内）===");
      data.chunks.forEach((c, i) => {
        lines.push(`[片段 ${i + 1}] ${c.content.slice(0, 300)}${c.content.length > 300 ? "..." : ""}`);
      });
    }
    lines.push("");
    lines.push("=== 实际发送给 LLM 的 prompt ===");
    lines.push(data.prompt);
    content.textContent = lines.join("\n");
  } catch (error) {
    stats.textContent = "预览失败";
    content.textContent = error.message || String(error);
    previewSection.hidden = false;
  }
}

function closePreview() {
  el("contextPreview").hidden = true;
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await refreshState();
  el("autoDetect").addEventListener("click", autoDetect);
  el("reviewSelectors").addEventListener("click", reviewSelectors);
  el("save").addEventListener("click", saveSettings);
  el("saveSite").addEventListener("click", saveSiteConfig);
  el("deleteSite").addEventListener("click", deleteSiteConfig);
  el("refresh").addEventListener("click", refreshState);
  el("refreshLogs").addEventListener("click", refreshState);
  el("clearLogs").addEventListener("click", clearLogs);
  el("copySuggestion").addEventListener("click", copySuggestion);
  el("previewContext").addEventListener("click", previewContext);
  el("closePreview").addEventListener("click", closePreview);
});
