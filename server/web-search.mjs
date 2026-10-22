import { XMLParser, XMLValidator } from "fast-xml-parser";

const xml = new XMLParser({ processEntities: false, parseTagValue: false });
const labels = { deepseek: "DeepSeek", bing: "必应", brave: "Brave" };
const maxBytes = 1024 * 1024;

// Only reuse credentials explicitly configured for the official DeepSeek host.
// Never send a compatible provider's key to a different service.
export function resolveSearchConfig(settings) {
  const config = { ...settings.search };
  if (!config.deepseekApiKey?.trim()) {
    try {
      const profile = settings.models?.daily;
      const url = new URL(profile?.baseUrl);
      if (url.origin === "https://api.deepseek.com" && !url.username && !url.password)
        config.deepseekApiKey = profile.apiKey;
    } catch {}
  }
  return config;
}

export function searchStatus(config = {}) {
  const provider = !config.provider || config.provider === "auto"
    ? (config.deepseekApiKey?.trim() ? "deepseek" : config.apiKey?.trim() ? "brave" : "bing") : config.provider;
  const reason = config.enabled === false ? "联网搜索已关闭"
    : !Object.hasOwn(labels, provider) ? "未知的搜索服务"
    : provider === "deepseek" && !config.deepseekApiKey?.trim() ? "请配置 DeepSeek 搜索密钥，或先保存官方 DeepSeek 对话模型密钥"
    : provider === "brave" && !config.apiKey?.trim() ? "请先配置 Brave Search API Key" : "";
  return { provider, available: !reason, reason };
}

export function forbidsWebSearch(text) {
  return /(?:不要|不用|无需|不必|不需要|别|禁止|先不|不能).{0,6}(?:联网|上网|搜索网络|网络搜索|网上搜)|(?:do not|don't|without)\s+(?:web\s+search|searching|browsing|internet)/i.test(text);
}

export function needsWebSearch(text) {
  if (forbidsWebSearch(text)) return false;
  if (/(?:联网|上网)(?:查|搜|找|检索)|(?:请|帮我).{0,6}(?:联网|上网)|网上(?:查|搜|找)|\bsearch (?:the )?(?:web|internet)\b/i.test(text)) return true;
  if (/记忆|聊天记录|对话记录|之前|以前|上次|我说过|我提过|本地|电脑任务|Orca|欧卡/i.test(text)) return false;
  return /搜(?:索)?一下|查一下|帮我(?:查|搜)|最新.{0,16}(?:新闻|消息|版本|价格|政策|进展)|(?:今天|明天|后天|本周|现在|实时|当前|最近).{0,16}(?:天气|气温|新闻|消息|汇率|股价|金价|油价|价格|赛程|比分|政策)|(?:天气|汇率|股价|金价|油价|赛程|比分).{0,8}(?:多少|怎样|怎么样|如何)|\b(?:look up|latest news|current (?:weather|price|exchange rate))\b/i.test(text);
}

function decode(value) {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|(lt|gt|amp|quot|apos|nbsp));/gi, (match, numeric, named) => {
    if (named) return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " })[named.toLowerCase()];
    const code = numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
const plain = (value, max) => typeof value === "string"
  ? decode(value).replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

function normalize(rows, provider, limit) {
  const seen = new Set(), results = [], retrievedAt = new Date().toISOString();
  for (const row of rows) {
    if (!row || typeof row.url !== "string" || row.url.length > 4096) continue;
    let url;
    try { url = new URL(decode(row.url)); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    url.hash = "";
    const title = plain(row.title, 300);
    if (!title || seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({ title, url: url.href, snippet: plain(row.snippet, 1200), provider, retrievedAt,
      ...(typeof row.summary === "string" ? { summary: plain(row.summary, 1600) } : {}),
      ...(typeof row.date === "string" && Number.isFinite(Date.parse(row.date)) ? { publishedAt: new Date(row.date).toISOString() } : {}) });
    if (results.length >= limit) break;
  }
  return results;
}

async function responseText(response, signal) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("搜索结果过大");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("搜索结果过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Only the query and the chosen provider's credential are sent. All backends
// return search excerpts, not independently verified full-page facts.
export async function searchWeb(config, query, signal, { fetchImpl = globalThis.fetch, limit = 5, timeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  const { provider, available, reason } = searchStatus(config);
  if (!available) throw new Error(reason);
  const maxQuery = provider === "deepseek" ? 128 : 600;
  if (typeof query !== "string" || !query.trim() || [...query.trim()].length > maxQuery || query.trim().split(/\s+/).length > 75)
    throw new Error(`搜索词需要 1–${maxQuery} 字，且不超过 75 个词`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("搜索结果数量应为 1–10 条");
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const url = new URL(provider === "deepseek" ? "https://api.deepseek.com/v1/tools/search"
    : provider === "brave" ? "https://api.search.brave.com/res/v1/web/search" : "https://www.bing.com/search");
  const headers = { Accept: provider !== "bing" ? "application/json" : "application/rss+xml, application/xml, text/xml" };
  const options = { headers, signal: requestSignal, redirect: "manual" };
  if (provider === "deepseek") {
    headers.Authorization = "Bearer " + config.deepseekApiKey.trim();
    headers["Content-Type"] = "application/json";
    options.method = "POST";
    options.body = JSON.stringify({ query: query.trim(), count: limit, need_content: false });
  } else {
    url.searchParams.set("q", query.trim());
    url.searchParams.set("count", String(limit));
    if (provider === "brave") headers["X-Subscription-Token"] = config.apiKey.trim();
    else { url.searchParams.set("format", "rss"); url.searchParams.set("setlang", "zh-hans"); }
  }
  try {
    let endpoint = url, response;
    for (let hop = 0; hop < 3; hop++) {
      response = await fetchImpl(endpoint, options);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const next = new URL(response.headers.get("location"), endpoint);
      if (provider !== "bing" || next.protocol !== "https:" || next.username || next.password || next.port ||
          !["www.bing.com", "cn.bing.com"].includes(next.hostname) || hop === 2)
        throw new Error("搜索服务返回无效数据");
      endpoint = next;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`搜索服务返回 HTTP ${response.status}`);
    }
    const body = await responseText(response, requestSignal);
    let rows;
    if (provider === "deepseek") {
      const data = JSON.parse(body);
      if (data.error || !Array.isArray(data.results)) throw new Error("搜索服务返回无效数据");
      rows = data.results.map(r => ({ title: r?.title, url: r?.url, snippet: r?.snippet || r?.summary, summary: r?.summary, date: r?.date }));
    } else if (provider === "brave") {
      const data = JSON.parse(body);
      if (data.error || (data.web?.results != null && !Array.isArray(data.web.results))) throw new Error("搜索服务返回无效数据");
      rows = (data.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
    } else {
      if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new Error("搜索服务未返回有效 RSS");
      const channel = xml.parse(body)?.rss?.channel;
      if (!channel || typeof channel !== "object") throw new Error("搜索服务未返回有效 RSS");
      const items = channel.item == null ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];
      rows = items.map(r => ({ title: r.title, url: r.link, snippet: r.description }));
    }
    requestSignal.throwIfAborted();
    return normalize(rows, provider, limit);
  } catch (error) {
    signal?.throwIfAborted();
    if (requestSignal.aborted) throw new Error(`${labels[provider]}搜索超时，请稍后重试`);
    // Do not expose upstream bodies, request headers or provider diagnostics.
    const detail = /^(搜索服务返回 HTTP \d{3}|搜索服务(?:未返回有效 RSS|返回无效数据)|搜索结果过大)$/.test(error.message) ? error.message : "无法连接或解析搜索结果";
    throw new Error(`${labels[provider]}：${detail}`);
  }
}
