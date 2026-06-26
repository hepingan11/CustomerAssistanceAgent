let observer = null;
let knownMessageIds = new Set();
let currentConversationId = null;
let lastSuggestion = null;

const LOG_KEY = "debugLogs";
const MAX_LOGS = 120;

const DEFAULT_SETTINGS = {
  enabled: false,
  apiBaseUrl: "http://localhost:8000",
  apiKey: "dev-api-key",
  contextBudget: 262144,
  containerSelector: "",
  messageSelector: "",
  textSelector: "",
  senderSelector: "",
  timeSelector: ""
};

const zh = {
  customer: "\u5ba2\u6237",
  agent: "\u5ba2\u670d",
  unknownSender: "\u672a\u77e5\u53d1\u9001\u4eba",
  suggestionReady: "\u5df2\u751f\u6210\u5efa\u8bae",
  containerNotFound: "\u672a\u627e\u5230\u6d88\u606f\u5bb9\u5668",
  notEnabled: "\u672a\u542f\u7528",
  configFirst: "\u8bf7\u5148\u914d\u7f6e selector",
  capturing: "\u6355\u6349\u4e2d",
  stopped: "\u5df2\u505c\u6b62",
  sent: "\u5df2\u53d1\u9001",
  duplicate: "\u91cd\u590d\u6d88\u606f",
  waitingSuggestion: "\u5df2\u6355\u6349\u5ba2\u6237\u6d88\u606f\uff0c\u7b49\u5f85 AI \u5efa\u8bae",
  autoNotFound: "\u6ca1\u6709\u5728\u5f53\u524d\u9875\u9762\u627e\u5230\u8fd9\u6bb5\u6d88\u606f\u6587\u672c"
};

async function addLog(level, message, data = {}) {
  const entry = { time: new Date().toLocaleTimeString(), level, message, data };
  const result = await chrome.storage.local.get([LOG_KEY]);
  const logs = [...(result[LOG_KEY] || []), entry].slice(-MAX_LOGS);
  await chrome.storage.local.set({ [LOG_KEY]: logs });
  const logFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logFn("[CAA]", message, data);
}

function hashText(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function safeText(root, selector) {
  if (!selector) return "";
  const el = root.querySelector(selector);
  return el ? normalizeText(el.textContent) : "";
}

function inferSenderType(senderName, messageEl) {
  const value = `${senderName || ""} ${messageEl.className || ""}`.toLowerCase();
  if (value.includes("agent") || value.includes("service") || value.includes("staff") || value.includes(zh.agent)) return "agent";
  if (value.includes("customer") || value.includes("client") || value.includes("user") || value.includes(zh.customer)) return "customer";
  return "unknown";
}

function cleanRawPayload(raw) {
  const blocked = ["cookie", "cookies", "token", "authorization", "password", "secret"];
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !blocked.includes(key.toLowerCase())));
}

async function getSettings() {
  const result = await chrome.storage.sync.get(["settings", "siteConfigs"]);
  const base = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
  const siteConfigs = result.siteConfigs || [];
  const matched = matchSiteConfigForUrl(siteConfigs, location.href);
  if (matched) {
    Object.assign(base, matched.selectors || {});
  }
  return base;
}

// URL 规范化：去掉 hash 与 query，去掉末尾斜杠，保留 origin+path
function normalizeSiteUrl(rawUrl) {
  if (!rawUrl) return "";
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_e) {
    return "";
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

// 在 siteConfigs 中找出匹配指定 URL 的配置（最长前缀匹配）
function matchSiteConfigForUrl(siteConfigs, pageUrl) {
  const target = normalizeSiteUrl(pageUrl);
  if (!target) return null;
  let best = null;
  let bestLen = -1;
  for (const config of siteConfigs) {
    const saved = normalizeSiteUrl(config.url);
    if (!saved) continue;
    if (
      target === saved ||
      target.startsWith(saved + "/") ||
      target.startsWith(saved + "?") ||
      target.startsWith(saved + "#")
    ) {
      if (saved.length > bestLen) {
        best = config;
        bestLen = saved.length;
      }
    }
  }
  return best;
}

async function apiFetch(settings, path, options = {}) {
  const base = settings.apiBaseUrl.replace(/\/$/, "");
  await addLog("info", "API request", { method: options.method || "GET", path });
  try {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": settings.apiKey,
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const body = await response.text();
      await addLog("error", "API failed", { status: response.status, path, body });
      throw new Error(`${response.status} ${body}`);
    }
    const json = await response.json();
    await addLog("info", "API ok", { path });
    return json;
  } catch (error) {
    await addLog("error", "API exception", { path, error: error.message });
    throw error;
  }
}

async function ensureConversation(settings) {
  if (currentConversationId) return currentConversationId;
  const externalId = hashText(`${location.origin}${location.pathname}${document.title}`);
  const conversation = await apiFetch(settings, "/api/conversations", {
    method: "POST",
    body: JSON.stringify({ external_id: externalId, page_url: location.href, title: document.title })
  });
  currentConversationId = conversation.id;
  await addLog("info", "Conversation ready", { conversationId: currentConversationId, externalId });
  return currentConversationId;
}

async function refreshSuggestion(settings) {
  if (!currentConversationId) {
    await addLog("warn", "Skip suggestion query: no conversation id");
    return null;
  }
  const suggestion = await apiFetch(settings, `/api/conversations/${currentConversationId}/suggestion`);
  lastSuggestion = suggestion;
  await chrome.storage.local.set({ lastSuggestion: suggestion });
  await addLog("info", "Suggestion query finished", { status: suggestion?.status, hasContent: Boolean(suggestion?.content) });
  if (suggestion?.content) {
    await chrome.storage.local.set({ captureStatus: `${zh.suggestionReady}: ${new Date().toLocaleTimeString()}` });
  }
  return suggestion;
}

function pollSuggestion(settings, attempts = 8, delayMs = 1500) {
  let attempt = 0;
  const tick = async () => {
    attempt += 1;
    await addLog("info", "Poll suggestion", { attempt, attempts });
    try {
      const suggestion = await refreshSuggestion(settings);
      if (suggestion?.content || attempt >= attempts) return;
    } catch (_error) {
      if (attempt >= attempts) return;
    }
    setTimeout(tick, delayMs);
  };
  setTimeout(tick, delayMs);
}

async function sendMessage(settings, messageEl) {
  const content = safeText(messageEl, settings.textSelector) || normalizeText(messageEl.textContent);
  if (!content) {
    await addLog("warn", "Skip empty message", { selector: settings.textSelector });
    return;
  }

  const senderName = safeText(messageEl, settings.senderSelector) || null;
  const timeText = safeText(messageEl, settings.timeSelector) || null;
  const sourceMessageId = messageEl.dataset.caaId || hashText(`${senderName || ""}|${timeText || ""}|${content}`);
  messageEl.dataset.caaId = sourceMessageId;
  if (knownMessageIds.has(sourceMessageId)) {
    await addLog("info", "Frontend dedupe skipped", { sourceMessageId });
    return;
  }
  knownMessageIds.add(sourceMessageId);

  const conversationId = await ensureConversation(settings);
  const senderType = inferSenderType(senderName, messageEl);
  const payload = {
    conversation_id: conversationId,
    sender_type: senderType,
    sender_name: senderName,
    content,
    source: "browser_extension",
    source_message_id: sourceMessageId,
    context_budget: Number(settings.contextBudget) || 262144,
    raw_payload: cleanRawPayload({
      page_url: location.href,
      title: document.title,
      time_text: timeText,
      classes: messageEl.className || ""
    })
  };

  await addLog("info", "Send message", { senderType, senderName, sourceMessageId, contentPreview: content.slice(0, 80) });
  const result = await apiFetch(settings, "/api/messages", { method: "POST", body: JSON.stringify(payload) });
  const typeLabel = senderType === "agent" ? zh.agent : senderType === "customer" ? zh.customer : zh.unknownSender;
  const duplicateLabel = result.duplicate ? zh.duplicate : zh.sent;
  await chrome.storage.local.set({ captureStatus: `${duplicateLabel}: ${typeLabel} ${new Date().toLocaleTimeString()}` });
  await addLog("info", "Message sent", { duplicate: result.duplicate, messageId: result.id, senderType });

  if (!result.duplicate && senderType !== "agent") {
    await chrome.storage.local.set({ captureStatus: `${zh.waitingSuggestion}: ${new Date().toLocaleTimeString()}` });
    pollSuggestion(settings);
  }
}

async function scanExisting(settings) {
  const container = document.querySelector(settings.containerSelector);
  if (!container) {
    await chrome.storage.local.set({ captureStatus: zh.containerNotFound });
    await addLog("error", "Container not found", { containerSelector: settings.containerSelector });
    return;
  }
  const messages = Array.from(container.querySelectorAll(settings.messageSelector));
  await addLog("info", "Scan existing messages", {
    containerSelector: settings.containerSelector,
    messageSelector: settings.messageSelector,
    count: messages.length
  });
  for (const messageEl of messages) {
    await sendMessage(settings, messageEl).catch((error) => addLog("error", "Send existing message failed", { error: error.message }));
  }
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function usefulClasses(el) {
  return Array.from(el.classList || [])
    .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name))
    .filter((name) => !/^(active|selected|hover|focus|show|hide|open|closed)$/i.test(name))
    .slice(0, 3);
}

function selectorFor(el, stopAt = document.body) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  if (el.id) return `${el.tagName.toLowerCase()}#${cssEscape(el.id)}`;
  const parts = [];
  let current = el;
  while (current && current !== document.documentElement && current !== stopAt.parentElement) {
    let part = current.tagName.toLowerCase();
    const classes = usefulClasses(current);
    if (classes.length > 0) {
      part += `.${classes.map(cssEscape).join(".")}`;
    } else if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    const candidate = parts.join(" > ");
    const scope = stopAt && stopAt !== document.body ? stopAt : document;
    try {
      if (scope.querySelectorAll(candidate).length === 1) break;
    } catch (_error) {
      break;
    }
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function reusableSelectorFor(el, scope) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = el.tagName.toLowerCase();
  const classes = usefulClasses(el);
  const candidates = [];
  if (classes.length > 0) {
    candidates.push(`${tag}.${classes.map(cssEscape).join(".")}`);
    candidates.push(...classes.map((name) => `${tag}.${cssEscape(name)}`));
    candidates.push(...classes.map((name) => `.${cssEscape(name)}`));
  }
  candidates.push(tag);

  for (const candidate of candidates) {
    try {
      const matches = Array.from(scope.querySelectorAll(candidate));
      if (matches.includes(el) && matches.length >= 2) return candidate;
    } catch (_error) {
      // Try the next candidate.
    }
  }

  for (const candidate of candidates) {
    try {
      if (scope.querySelectorAll(candidate).length === 1 && scope.querySelector(candidate) === el) return candidate;
    } catch (_error) {
      // Try the next candidate.
    }
  }

  return selectorFor(el, scope);
}

function findSmallestElementByText(sampleText) {
  const sample = normalizeText(sampleText);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!normalizeText(node.nodeValue).includes(sample)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const matches = [];
  while (walker.nextNode()) matches.push(walker.currentNode.parentElement);
  return matches.sort((a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length)[0] || null;
}

function scoreMessageCandidate(el, textEl) {
  if (!el || el === document.body) return -1;
  const text = normalizeText(el.textContent);
  let score = 0;
  if (el !== textEl) score += 2;
  if (text.length >= normalizeText(textEl.textContent).length) score += 1;
  if (text.length < 2000) score += 1;
  if (el.querySelector("time,[datetime],.time,.date,.date-created,.created,.author,.author-name,.sender,.user,.username")) score += 3;
  if (usefulClasses(el).some((name) => /message|msg|item|comment|content|post|row|bubble/i.test(name))) score += 3;
  if (el.parentElement && Array.from(el.parentElement.children).filter((child) => child.tagName === el.tagName).length >= 2) score += 2;
  return score;
}

function inferMessageElement(textEl) {
  const ancestors = [];
  let current = textEl;
  for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
    ancestors.push(current);
    current = current.parentElement;
  }
  return ancestors.sort((a, b) => scoreMessageCandidate(b, textEl) - scoreMessageCandidate(a, textEl))[0] || textEl;
}

function inferContainerElement(messageEl) {
  let current = messageEl.parentElement;
  let best = current;
  while (current && current !== document.body) {
    const similarChildren = Array.from(current.children).filter((child) => {
      const sameTag = child.tagName === messageEl.tagName;
      const sharedClass = usefulClasses(messageEl).some((name) => child.classList.contains(name));
      return sameTag || sharedClass;
    });
    if (similarChildren.length >= 2) best = current;
    current = current.parentElement;
  }
  return best || messageEl.parentElement || document.body;
}

function currentSelectorsFromSettings(settings) {
  return {
    containerSelector: settings.containerSelector || "",
    messageSelector: settings.messageSelector || "",
    textSelector: settings.textSelector || "",
    senderSelector: settings.senderSelector || "",
    timeSelector: settings.timeSelector || ""
  };
}

function elementSignature(el) {
  return `${el.tagName} ${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("datetime") || ""}`.toLowerCase();
}

function looksLikeTimeText(text) {
  const value = normalizeText(text).toLowerCase();
  const chineseTimeWords = ["\u79d2\u524d", "\u5206\u949f\u524d", "\u5c0f\u65f6\u524d", "\u5929\u524d", "\u521a\u521a", "\u6628\u5929", "\u4eca\u5929"];
  return (
    /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(value) ||
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/.test(value) ||
    /\b\d+\s*(s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago\b/.test(value) ||
    /\b(just now|yesterday|today)\b/.test(value) ||
    chineseTimeWords.some((word) => value.includes(word))
  );
}

function scoreMetadataCandidate(el, kind, messageText) {
  const text = normalizeText(el.textContent);
  if (!text || text.length >= Math.max(80, messageText.length * 0.8)) return -1;
  const signature = elementSignature(el);
  let score = 0;
  if (kind === "sender") {
    if (/author|sender|user|username|name|nick|from|avatar|profile|member/.test(signature)) score += 10;
    if (/time|date|created|reply|like|menu|content|post|body/.test(signature)) score -= 5;
    if (text.length <= 40) score += 3;
    if (looksLikeTimeText(text)) score -= 8;
    if (el.tagName === "A") score += 2;
  } else {
    if (/time|date|created|datetime|timestamp/.test(signature)) score += 10;
    if (el.tagName === "TIME" || el.hasAttribute("datetime")) score += 8;
    if (looksLikeTimeText(text)) score += 8;
    if (/author|sender|user|name|nick|content|post|body/.test(signature)) score -= 4;
    if (text.length <= 40) score += 2;
  }
  return score;
}

function collectNearbyElements(messageEl) {
  const candidates = [];
  let current = messageEl;
  for (let depth = 0; current && current !== document.body && depth < 5; depth += 1) {
    candidates.push({ el: current, depth });
    Array.from(current.children).forEach((child) => candidates.push({ el: child, depth }));
    Array.from(current.querySelectorAll("*"))
      .slice(0, 80)
      .forEach((child) => candidates.push({ el: child, depth: depth + 0.5 }));
    current = current.parentElement;
  }
  const seen = new Set();
  return candidates.filter(({ el }) => {
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  });
}

function nearestCommonAncestor(elements, fallback) {
  const realElements = elements.filter(Boolean);
  if (realElements.length <= 1) return fallback;
  let anchor = realElements[0];
  for (const el of realElements.slice(1)) {
    while (anchor && !anchor.contains(el)) anchor = anchor.parentElement;
    if (!anchor) return fallback;
  }
  if (anchor === document.body || anchor === document.documentElement) return fallback.parentElement || fallback;
  return anchor;
}

function findMetadataWithAnchor(messageEl) {
  const messageText = normalizeText(messageEl.textContent);
  const pick = (kind) => {
    const scored = collectNearbyElements(messageEl)
      .filter(({ el }) => el !== messageEl)
      .map(({ el, depth }) => ({ el, score: scoreMetadataCandidate(el, kind, messageText) - depth }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || normalizeText(a.el.textContent).length - normalizeText(b.el.textContent).length);
    return scored[0]?.el || null;
  };
  const senderEl = pick("sender");
  const timeEl = pick("time");
  const anchorEl = nearestCommonAncestor([messageEl, senderEl, timeEl], messageEl);
  return { senderEl, timeEl, anchorEl };
}

function summarizeElement(el) {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    className: typeof el.className === "string" ? el.className : "",
    text: normalizeText(el.textContent).slice(0, 180),
    children: Array.from(el.children)
      .slice(0, 8)
      .map((child) => ({
        tag: child.tagName.toLowerCase(),
        id: child.id || "",
        className: typeof child.className === "string" ? child.className : "",
        text: normalizeText(child.textContent).slice(0, 100)
      }))
  };
}

function collectPageDom() {
  // Build a compact representation of the current page so the AI can locate
  // message elements by structure instead of guessing from summaries.
  const root = document.body ? document.body.cloneNode(true) : document.documentElement.cloneNode(true);
  // Strip nodes that carry no useful layout/text signal for selector inference.
  root.querySelectorAll("script, style, noscript, iframe, svg, canvas, link, meta, template").forEach((n) => n.remove());
  // Drop comments and collapse whitespace nodes.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT, null);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode && c.parentNode.removeChild(c));
  let html = root.outerHTML || "";
  // Collapse runs of whitespace inside text so the payload stays compact.
  html = html.replace(/\s{2,}/g, " ").replace(/>\s+</g, "><").trim();
  return html;
}

function collectSelectorStats(selectors) {
  const containers = selectors.containerSelector ? Array.from(document.querySelectorAll(selectors.containerSelector)) : [];
  const container = containers[0] || null;
  const messages = container && selectors.messageSelector ? Array.from(container.querySelectorAll(selectors.messageSelector)) : [];
  const preview = messages.slice(0, 5).map((messageEl, index) => {
    const text = safeText(messageEl, selectors.textSelector) || normalizeText(messageEl.textContent);
    return {
      index,
      text: text.slice(0, 240),
      sender: safeText(messageEl, selectors.senderSelector).slice(0, 100),
      time: safeText(messageEl, selectors.timeSelector).slice(0, 80),
      messageTag: messageEl.tagName.toLowerCase(),
      messageId: messageEl.id || "",
      messageClass: typeof messageEl.className === "string" ? messageEl.className : ""
    };
  });
  return {
    selector_stats: {
      containerCount: containers.length,
      messageCount: messages.length,
      textEmptyCount: preview.filter((item) => !item.text).length,
      senderEmptyCount: preview.filter((item) => !item.sender).length,
      timeEmptyCount: preview.filter((item) => !item.time).length
    },
    extraction_preview: preview,
    dom_summary: [
      ...(container ? [summarizeElement(container)] : []),
      ...messages.slice(0, 3).map(summarizeElement)
    ]
  };
}

function autoDetectSelectors(sampleText) {
  const textEl = findSmallestElementByText(sampleText);
  if (!textEl) return { ok: false, error: zh.autoNotFound };

  const messageEl = inferMessageElement(textEl);
  const containerEl = inferContainerElement(messageEl);
  const containerSelector = selectorFor(containerEl);
  const messageSelector = reusableSelectorFor(messageEl, containerEl);
  const textSelector = selectorFor(textEl, messageEl);
  const messageCount = containerEl.querySelectorAll(messageSelector).length;

  return {
    ok: true,
    mode: "message",
    selectors: { containerSelector, messageSelector, textSelector, senderSelector: "", timeSelector: "" },
    preview: {
      messageCount,
      text: normalizeText(textEl.textContent).slice(0, 120),
      sender: "",
      time: ""
    }
  };
}

function findMessageForElement(el, settings) {
  if (settings.containerSelector && settings.messageSelector) {
    const container = document.querySelector(settings.containerSelector);
    if (container) {
      const messages = Array.from(container.querySelectorAll(settings.messageSelector));
      const matched = messages.find((message) => message.contains(el) || message === el);
      if (matched) return { containerEl: container, messageEl: matched };
    }
  }
  const messageEl = inferMessageElement(el);
  return { containerEl: inferContainerElement(messageEl), messageEl };
}

function detectFieldSelector(sampleText, mode, settings) {
  const targetEl = findSmallestElementByText(sampleText);
  if (!targetEl) return { ok: false, error: zh.autoNotFound };
  const { containerEl, messageEl } = findMessageForElement(targetEl, settings);
  const selector = selectorFor(targetEl, messageEl);
  const key = mode === "sender" ? "senderSelector" : "timeSelector";
  const selectors = currentSelectorsFromSettings(settings);
  selectors[key] = selector;
  return {
    ok: true,
    mode,
    selectors,
    preview: {
      messageCount: containerEl.querySelectorAll(settings.messageSelector || reusableSelectorFor(messageEl, containerEl)).length,
      text: safeText(messageEl, settings.textSelector) || normalizeText(messageEl.textContent).slice(0, 120),
      sender: mode === "sender" ? normalizeText(targetEl.textContent).slice(0, 60) : safeText(messageEl, selectors.senderSelector).slice(0, 60),
      time: mode === "time" ? normalizeText(targetEl.textContent).slice(0, 60) : safeText(messageEl, selectors.timeSelector).slice(0, 60)
    },
    updatedField: key
  };
}

async function autoDetectByMode(sampleText, mode = "message") {
  const settings = await getSettings();
  if (mode === "sender" || mode === "time") {
    return detectFieldSelector(sampleText, mode, settings);
  }
  const result = autoDetectSelectors(sampleText);
  result.mode = "message";
  result.updatedField = "message";
  return result;
}

async function collectReviewContext(sampleText = "") {
  const settings = await getSettings();
  const selectors = currentSelectorsFromSettings(settings);
  const collected = collectSelectorStats(selectors);
  let autoDetectResult = null;
  if (sampleText) {
    autoDetectResult = autoDetectSelectors(sampleText);
  }
  const payload = {
    page_url: location.href,
    title: document.title,
    sample_text: sampleText,
    selectors,
    selector_stats: collected.selector_stats,
    extraction_preview: collected.extraction_preview,
    dom_summary: collected.dom_summary,
    auto_detect_result: autoDetectResult,
    page_html: collectPageDom()
  };
  await addLog("info", "Collected selector review context", {
    stats: collected.selector_stats,
    hasAutoDetect: Boolean(autoDetectResult)
  });
  return payload;
}

async function startCapture() {
  const settings = await getSettings();
  await addLog("info", "Apply capture settings", {
    enabled: settings.enabled,
    apiBaseUrl: settings.apiBaseUrl,
    containerSelector: settings.containerSelector,
    messageSelector: settings.messageSelector,
    textSelector: settings.textSelector,
    senderSelector: settings.senderSelector,
    timeSelector: settings.timeSelector
  });
  if (!settings.enabled) {
    await stopCapture(zh.notEnabled);
    return;
  }
  if (!settings.containerSelector || !settings.messageSelector) {
    await stopCapture(zh.configFirst);
    await addLog("warn", "Selector config incomplete");
    return;
  }
  const container = document.querySelector(settings.containerSelector);
  if (!container) {
    await stopCapture(zh.containerNotFound);
    await addLog("error", "Start failed: container not found", { containerSelector: settings.containerSelector });
    return;
  }
  await chrome.storage.local.set({ captureStatus: zh.capturing });
  await scanExisting(settings);
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const candidates = node.matches(settings.messageSelector) ? [node] : Array.from(node.querySelectorAll(settings.messageSelector));
        if (candidates.length > 0) addLog("info", "New message nodes found", { count: candidates.length });
        candidates.forEach((el) => sendMessage(settings, el).catch((error) => addLog("error", "Send new message failed", { error: error.message })));
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  await addLog("info", "DOM observer started");
}

async function stopCapture(reason = zh.stopped) {
  if (observer) observer.disconnect();
  observer = null;
  await chrome.storage.local.set({ captureStatus: reason });
  await addLog("info", "Capture stopped", { reason });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CAA_RELOAD") {
    knownMessageIds = new Set();
    currentConversationId = null;
    startCapture().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CAA_GET_STATE") {
    chrome.storage.local.get(["captureStatus", "lastSuggestion", LOG_KEY], (result) => {
      sendResponse({
        status: result.captureStatus || zh.notEnabled,
        suggestion: result.lastSuggestion || lastSuggestion,
        logs: result[LOG_KEY] || [],
        conversationId: currentConversationId
      });
    });
    return true;
  }
  if (message.type === "CAA_AUTO_DETECT") {
    autoDetectByMode(message.sampleText || "", message.mode || "message")
      .then((result) => {
      addLog(result.ok ? "info" : "warn", "Auto detect selectors", result);
      sendResponse(result);
      })
      .catch((error) => {
        addLog("error", "Auto detect failed", { error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message.type === "CAA_COLLECT_REVIEW_CONTEXT") {
    collectReviewContext(message.sampleText || "")
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => {
        addLog("error", "Collect review context failed", { error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.settings || changes.siteConfigs) {
    startCapture().catch((error) => addLog("error", "Start after settings change failed", { error: error.message }));
  }
});

startCapture().catch((error) => addLog("error", "Initial start failed", { error: error.message }));


