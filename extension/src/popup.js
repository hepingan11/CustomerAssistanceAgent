const fields = [
  "enabled",
  "apiBaseUrl",
  "apiKey",
  "containerSelector",
  "messageSelector",
  "textSelector",
  "senderSelector",
  "timeSelector"
];

const defaults = {
  enabled: false,
  apiBaseUrl: "http://localhost:8000",
  apiKey: "dev-api-key",
  containerSelector: "",
  messageSelector: "",
  textSelector: "",
  senderSelector: "",
  timeSelector: ""
};

const t = {
  noLogs: "\u6682\u65e0\u65e5\u5fd7",
  detectHint: "\u8f93\u5165\u6d88\u606f\u6587\u672c\u540e\u53ef\u81ea\u52a8\u63a8\u65ad selector",
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
  return [
    `${t.matchCount}: ${result.preview.messageCount}`,
    `${t.textPreview}: ${result.preview.text || "-"}`,
    `${t.senderPreview}: ${result.preview.sender || "-"}`,
    `${t.timePreview}: ${result.preview.time || "-"}`,
    "",
    `${t.container}: ${result.selectors.containerSelector}`,
    `${t.message}: ${result.selectors.messageSelector}`,
    `${t.messageText}: ${result.selectors.textSelector}`,
    `${t.sender}: ${result.selectors.senderSelector || "-"}`,
    `${t.time}: ${result.selectors.timeSelector || "-"}`
  ].join("\n");
}

function getSettingsFromForm() {
  const settings = {};
  fields.forEach((field) => {
    const input = el(field);
    settings[field] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  return settings;
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
  const result = await chrome.storage.sync.get(["settings"]);
  const settings = { ...defaults, ...(result.settings || {}) };
  fields.forEach((field) => {
    const input = el(field);
    if (input.type === "checkbox") input.checked = Boolean(settings[field]);
    else input.value = settings[field] || "";
  });
}

async function saveSettings() {
  const settings = getSettingsFromForm();
  await chrome.storage.sync.set({ settings });
  await sendToContent({ type: "CAA_RELOAD" }).catch(() => null);
  await refreshState();
}

async function autoDetect() {
  const preview = el("detectPreview");
  try {
    const sampleText = el("sampleText").value.trim();
    if (!sampleText) {
      preview.textContent = t.inputSample;
      return;
    }
    preview.textContent = t.detecting;
    setTimeout(() => {
      if (preview.textContent === t.detecting) preview.textContent = t.injecting;
    }, 400);
    const result = await sendToContent({ type: "CAA_AUTO_DETECT", sampleText }).catch((error) => ({
      ok: false,
      error: error.message || t.pageCommFailed
    }));
    preview.textContent = formatDetectPreview(result);
    if (!result?.ok) return;

    Object.entries(result.selectors).forEach(([key, value]) => {
      if (el(key)) el(key).value = value || "";
    });
    await saveSettings();
  } catch (error) {
    preview.textContent = `${t.detectFailed}: ${error.message}`;
  }
}

async function reviewSelectors() {
  const preview = el("detectPreview");
  try {
    preview.textContent = t.reviewing;
    await chrome.storage.sync.set({ settings: getSettingsFromForm() });
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
    await chrome.storage.sync.set({ settings: getSettingsFromForm() });
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

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await refreshState();
  el("autoDetect").addEventListener("click", autoDetect);
  el("reviewSelectors").addEventListener("click", reviewSelectors);
  el("save").addEventListener("click", saveSettings);
  el("refresh").addEventListener("click", refreshState);
  el("refreshLogs").addEventListener("click", refreshState);
  el("clearLogs").addEventListener("click", clearLogs);
  el("copySuggestion").addEventListener("click", copySuggestion);
});
