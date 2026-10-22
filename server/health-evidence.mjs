import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { string, date } from "./health-store.mjs";
import { searchWeb, searchStatus, resolveSearchConfig } from "./web-search.mjs";

const xml = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false });
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
function plain(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return Object.entries(value).filter(([k]) => !k.startsWith("@")).map(([, v]) => Array.isArray(v) ? v.map(plain).join(" ") : plain(v)).join(" ");
}
const strip = value => String(value || "").replace(/&(lt|gt|amp|quot|apos|nbsp);/g, (_, key) => ({lt:"<",gt:">",amp:"&",quot:'"',apos:"'",nbsp:" "})[key])
  .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const idFor = value => createHash("sha256").update(value).digest("hex").slice(0, 20);
export const medicalDomains = ["nhc.gov.cn", "nmpa.gov.cn", "msdmanuals.cn", "medlineplus.gov", "nice.org.uk", "who.int", "cochrane.org"];
export function sourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("资料来源必须是有效的 HTTPS 链接");
  return url.href;
}
export function referenceData(input) {
  if (input.authorized !== true) throw new Error("请确认拥有保存和使用这份资料的权限");
  if (!["guideline", "label", "patient", "review"].includes(input.category)) throw new Error("请选择资料类型");
  return { title: string(input.title, 300, true), organization: string(input.organization, 200, true),
    url: sourceUrl(input.url), published: date(input.published, true), reviewAfter: date(input.reviewAfter, true),
    region: string(input.region, 80, true), category: input.category, version: string(input.version, 150, true),
    population: string(input.population, 200), text: string(input.text, 60000, true),
    license: string(input.license, 500, true), authorized: true, status: input.status === "retired" ? "retired" : "active" };
}
async function request(url, signal, fetcher, type = "json", headers = {}) {
  const response = await fetcher(url, { headers, redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`资料服务返回 ${response.status}`);
  const bytes = await response.text();
  if (bytes.length > 4_000_000) throw new Error("资料响应过大");
  return type === "json" ? JSON.parse(bytes) : bytes;
}
export class HealthEvidence {
  constructor(vault, { fetcher = fetch } = {}) { this.vault = vault; this.fetch = fetcher; }
  async pubmed(query, signal) {
    const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
    const search = new URL(base + "esearch.fcgi");
    search.search = new URLSearchParams({ db: "pubmed", retmode: "json", retmax: "5", sort: "relevance", term: query, tool: "douli" });
    const found = await request(search, signal, this.fetch);
    const ids = (found.esearchresult?.idlist || []).filter(id => /^\d+$/.test(id));
    if (!ids.length) return [];
    // Two requests per search; queue below serializes searches and spaces NCBI requests.
    await new Promise(resolve => setTimeout(resolve, 400));
    signal?.throwIfAborted();
    const endpoint = new URL(base + "efetch.fcgi");
    endpoint.search = new URLSearchParams({ db: "pubmed", retmode: "xml", id: ids.join(","), tool: "douli" });
    const data = xml.parse(await request(endpoint, signal, this.fetch, "text"));
    return array(data.PubmedArticleSet?.PubmedArticle).map(item => {
      const citation = item.MedlineCitation, article = citation?.Article;
      const pmid = plain(citation?.PMID);
      const abstract = array(article?.Abstract?.AbstractText).map(plain).join("\n");
      const publication = plain(article?.Journal?.JournalIssue?.PubDate);
      const types = array(article?.PublicationTypeList?.PublicationType).map(plain);
      const retracted = types.some(v => /retracted|retraction/i.test(v));
      return { id: "pubmed-" + pmid, title: plain(article?.ArticleTitle), url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        organization: plain(article?.Journal?.Title), published: publication, region: "研究人群见原文",
        category: "research", types, pmid, text: abstract.slice(0, 7000), coverage: "abstract",
        status: retracted ? "retired" : "active", retrievedAt: new Date().toISOString(),
        limitation: "论文摘要；收录不代表结论已确立，研究人群和适用性需核对全文。" };
    }).filter(x => x.text && x.status === "active");
  }
  async drugs(name, signal) {
    // DailyMed contains U.S. labels; always keep jurisdiction visible.
    const endpoint = new URL("https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json");
    endpoint.search = new URLSearchParams({ drug_name: name, pagesize: "20" });
    const data = await request(endpoint, signal, this.fetch);
    const result = [];
    const candidates = (data.data || []).sort((a, b) => {
      const single = row => String(row.title).match(/\(([^)]+)\)/)?.[1].trim().toLowerCase() === name.toLowerCase();
      return Number(single(b)) - Number(single(a));
    });
    for (const row of candidates.slice(0, 2)) {
      if (!/^[0-9a-f-]{36}$/i.test(row.setid)) continue;
      const raw = await request(`https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${row.setid}.xml`, signal, this.fetch, "text");
      const document = xml.parse(raw);
      const sections = [];
      function visit(node) {
        if (!node || typeof node !== "object") return;
        if (node.title && node.text) sections.push({ title: plain(node.title), text: plain(node.text) });
        for (const child of Object.values(node)) if (typeof child === "object") array(child).forEach(visit);
      }
      visit(document);
      const selected = sections.filter(s => /warning|contraindication|interaction|ingredient|dosage|adverse|pregnan|renal|hepatic/i.test(s.title));
      result.push({ id: "dailymed-" + row.setid, title: row.title, organization: "DailyMed / NLM",
        url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${row.setid}`, published: row.published_date,
        category: "label", region: "美国", coverage: "label_sections", status: "active",
        text: (selected.length ? selected : sections).map(s => s.title + "\n" + s.text).join("\n\n").slice(0, 14000),
        retrievedAt: new Date().toISOString(), limitation: "美国具体制剂说明书节选；名称检索可能返回不同规格、厂家或复方，必须核对，不能代替国内实际药品说明书。" });
    }
    return result.filter(r => r.text);
  }
  async patient(query, signal) {
    const endpoint = new URL("https://wsearch.nlm.nih.gov/ws/query");
    endpoint.search = new URLSearchParams({ db: "healthTopics", term: query, retmax: "4", tool: "douli" });
    const data = xml.parse(await request(endpoint, signal, this.fetch, "text"));
    return array(data.nlmSearchResult?.list?.document).map(row => {
      const fields = array(row.content);
      const get = key => strip(plain(fields.find(v => v["@_name"]?.toLowerCase() === key.toLowerCase())));
      return { id: "medline-" + idFor(row["@_url"] || ""), title: get("title"),
        url: row["@_url"], organization: "MedlinePlus.gov / 美国国家医学图书馆", region: "美国",
        text: get("FullSummary"), published: "接口未提供发布日期", category: "patient", coverage: "topic_summary",
        status: "active", retrievedAt: new Date().toISOString(),
        limitation: "MedlinePlus 健康主题摘要；一般健康解释，不能代替个人诊疗或中国具体制剂说明书。" };
    }).filter(r => r.text && /^https:\/\/medlineplus.gov\//.test(r.url));
  }
  async trustedWeb(query, signal) {
    const config = resolveSearchConfig(this.vault.store.settings());
    const deepseek = searchStatus(config).provider === "deepseek";
    // DeepSeek limits queries to 128 Unicode characters. Split domain clauses
    // without dropping the trusted-domain restriction or truncating operators.
    const groups = deepseek ? Array.from({ length: Math.ceil(medicalDomains.length / 2) }, (_, i) => medicalDomains.slice(i * 2, i * 2 + 2)) : [medicalDomains];
    const rows = (await Promise.all(groups.map(domains => {
      const suffix = " " + domains.map(d => "site:" + d).join(" OR ");
      const terms = [...query].slice(0, deepseek ? 128 - suffix.length : 300).join("");
      return searchWeb(config, terms + suffix, signal, { fetchImpl: this.fetch, limit: 8 });
    }))).flat();
    const seen = new Set();
    return rows.filter(row => {
      if (seen.has(row.url)) return false;
      seen.add(row.url);
      try { const host = new URL(row.url).hostname; return medicalDomains.some(d => host === d || host.endsWith("." + d)); }
      catch { return false; }
    }).slice(0, 8).map(row => ({ id: "web-" + idFor(row.url), title: row.title, url: row.url,
      organization: new URL(row.url).hostname, text: row.snippet, published: "未核实",
      category: /nmpa/.test(row.url) ? "label" : "reference", region: /\.cn\//.test(row.url) ? "中国" : "见原文",
      coverage: "search_snippet", status: "active", retrievedAt: new Date().toISOString(),
      limitation: "搜索摘要，未核对全文，不能作为具体剂量或禁忌结论的唯一依据。" }));
  }
  local(terms) {
    const keywords = terms.toLowerCase().split(/[\s,，;；]+/).filter(t => t.length > 1);
    return this.vault.list("reference").filter(r => r.status === "active").map(r => ({ ...r,
      score: keywords.reduce((s, term) => s + (r.title.toLowerCase().includes(term) ? 6 : 0) + (r.text.toLowerCase().includes(term) ? 1 : 0), 0),
      stale: r.reviewAfter < new Date().toISOString().slice(0, 10), coverage: "user_document",
      limitation: "用户导入并确认的资料；需核对发布机构、适用地区和人群。" }))
      .filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  }
  async search(plan, signal, { refresh = false } = {}) {
    const key = idFor(JSON.stringify(plan));
    const cached = this.vault.list("evidence").find(r => r.cacheKey === key);
    const fresh = cached && Date.now() - Date.parse(cached.updatedAt) < 24 * 60 * 60 * 1000;
    if (fresh && !refresh) return { ...cached.result, cached: true, local: undefined,
      sources: [...this.local(plan.zh + " " + plan.en), ...cached.result.sources.filter(s => s.coverage !== "user_document")] };
    const sources = this.local(plan.zh + " " + plan.en), services = [];
    const jobs = [["权威网站", () => this.trustedWeb(plan.zh, signal)]];
    if (plan.en) jobs.push(["MedlinePlus", () => this.patient(plan.en, signal)], ["PubMed", async () => {
      const prior = this.queue || Promise.resolve();
      const task = prior.catch(() => {}).then(() => this.pubmed(plan.en, signal));
      this.queue = task.then(() => new Promise(resolve => setTimeout(resolve, 400)), () => {});
      return task;
    }]);
    for (const name of (plan.drugs || []).slice(0, 3)) jobs.push(["DailyMed: " + name, () => this.drugs(name, signal)]);
    const results = await Promise.allSettled(jobs.map(([, run]) => run()));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      services.push({ name: jobs[i][0], status: r.status === "fulfilled" ? (r.value.length ? "retrieved" : "empty") : "failed",
        message: r.status === "rejected" ? r.reason.message : undefined });
      if (r.status === "fulfilled") sources.push(...r.value);
    }
    signal?.throwIfAborted();
    const result = { sources, services, cached: false, searchedAt: new Date().toISOString() };
    this.vault.put("evidence", { cacheKey: key, result }, cached?.id, cached?.revision);
    for (const item of this.vault.list("evidence").slice(100)) this.vault.remove(item.id, item.revision);
    return result;
  }
}
