// 答えガチャ クローラー
// ニュースRSS（見出しと概要のみ）から言葉を抜き出し、日本語版Wikipediaに記事がある言葉だけを残して docs/words.json に書き出す。
// AIは使いません。形態素解析は kuromoji、意味は Wikipedia の冒頭文、難しさは Wikipedia の閲覧数で判定します。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kuromoji from "kuromoji";
import { XMLParser } from "fast-xml-parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = path.join(ROOT, "crawler/feeds.json");
const CACHE = path.join(ROOT, "crawler/cache.json");
const OUT = path.join(ROOT, "docs/words.json");

const CONTACT = process.env.CRAWLER_CONTACT || "https://github.com/";
const UA = `KotaeGachaBot/1.0 (quiz brainstorming tool; ${CONTACT})`;
const MAX_LOOKUPS_PER_RUN = 400;     // 1回の実行でWikipediaに問い合わせる候補の上限
const RECHECK_DAYS = 14;             // 一度調べた候補を再チェックしない日数
const KEEP_DAYS = 60;                // words.json に残す日数
const MAX_WORDS = 3000;

// 難しさの目安（1日あたりの平均閲覧数）
function levelOf(views) {
  if (views == null) return 3;
  if (views >= 2000) return 1;   // やさしい
  if (views >= 300) return 2;    // ふつう
  if (views >= 40) return 3;     // 難しい
  return 4;                      // 激ムズ
}

// ---------- ふつうすぎる言葉・偏りを減らすための判定 ----------
// 日本語でよく使われる度合い（Zipf値）。wordfreq のデータから作った表（crawler/wordfreq-ja.json）。
// 表に無い言葉は「めったに使われない」とみなします。
let ZIPF = {};
const zipfOf = w => ZIPF[w] ?? null;
function levelOfZipf(z) {
  if (z == null) return null;
  if (z >= 3.0) return 2;
  if (z >= 2.4) return 3;
  return 4;
}
// 閲覧数とよく使われる度合いの両方を見て難しさを決める（両方わかるときは平均）
function combinedLevel(views, zipf) {
  const a = levelOf(views), b = levelOfZipf(zipf);
  return b == null ? a : Math.round((a + b) / 2);
}
const DEFAULT_QUALITY = {
  commonZipf: 3.6, minArticleBytes: 4000, minViews: 3,
  maxPerCategory: 4, maxPerSourcePerRun: 4,
  blockCategoryPatterns: ["存命人物", "曖昧さ回避"]
};

const STOP = new Set(`日本 政府 東京 大阪 今年 去年 来年 今月 先月 午前 午後 今回 関係 発表 会見 記者 首相 大臣 会社 企業 事件 事故 問題 情報 対応 状況 影響 可能 必要 予定 調査 結果 方針 理由 一部 全国 地域 世界 海外 国内 市場 価格 経済 政治 社会 文化 科学 技術 ニュース 番組 動画 写真 映像 記事 速報 最新 公開 開始 終了 実施 検討 確認 発生 増加 減少 年度 時間 時代 人気 話題 注目`.split(/\s+/));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readJson(p, fallback) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } }

async function get(url, { json = false, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": json ? "application/json" : "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json ? await res.json() : await res.text();
  } finally { clearTimeout(t); }
}

function hostAllowed(url, hosts) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return hosts.some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

function stripHtml(s) {
  return String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

// ---------- robots.txt の確認 ----------
// 各サイトの robots.txt で RSS の取得が禁止されていたら、そのフィードは読まない。
const robotsCache = new Map();
async function robotsAllows(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const txt = await get(u.origin + "/robots.txt", { timeout: 10000 });
      rules = parseRobots(txt);
    } catch { rules = []; } // robots.txt が無い・取れない場合は制限なしとみなす
    robotsCache.set(u.origin, rules);
  }
  const target = u.pathname + u.search;
  let best = null;
  for (const r of robotsCache.get(u.origin)) {
    if (r.path && target.startsWith(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
export function parseRobots(txt) {
  // 自分向け（KotaeGachaBot）のグループがあればそれを、なければ * のグループを使う
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "disallow") cur.rules.push({ allow: false, path: val });
      if (key === "allow") cur.rules.push({ allow: true, path: val });
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a.startsWith("kotaegachabot")));
  const pick = mine.length ? mine : groups.filter(g => g.agents.includes("*"));
  return pick.flatMap(g => g.rules).filter(r => r.path);
}

// ---------- 1. RSS ----------
async function fetchFeeds(cfg) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
  const articles = [];
  for (const f of cfg.feeds) {
    try {
      if (!(await robotsAllows(f.url))) { console.warn(`  ${f.site}/${f.label}: robots.txt で取得が禁止されているため読みません`); continue; }
      const xml = await get(f.url);
      const doc = parser.parse(xml);
      let items = doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item ?? doc?.feed?.entry ?? [];
      if (!Array.isArray(items)) items = [items];
      let n = 0;
      for (const it of items) {
        const link = typeof it.link === "string" ? it.link : (it.link?.["@href"] ?? it.guid?.["#text"] ?? it.guid);
        if (!link || !hostAllowed(link, f.allowedHosts)) continue;
        const title = stripHtml(it.title?.["#text"] ?? it.title);
        const desc = stripHtml(it.description ?? it.summary ?? "");
        const date = it.pubDate ?? it["dc:date"] ?? it.updated ?? null;
        articles.push({ site: f.site, label: f.label, title, desc, url: link, date: date ? new Date(date).toISOString() : new Date().toISOString() });
        n++;
      }
      console.log(`  ${f.site}/${f.label}: ${n}件`);
    } catch (e) {
      console.warn(`  ${f.site}/${f.label}: 取得失敗 (${e.message})`);
    }
    await sleep(800);
  }
  return articles;
}

// ---------- 1b. Wikipedia から言葉を拾う ----------
// Wikimedia が公開している API（公式に認められた取得方法）だけを使います。
const WIKI_API = "https://ja.wikipedia.org/w/api.php";
const wikiArticleUrl = t => "https://ja.wikipedia.org/wiki/" + encodeURIComponent(t.replace(/ /g, "_"));
async function wikiApi(params) {
  const q = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  return get(WIKI_API + "?" + q, { json: true });
}
function pick(arr, n) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }

async function categoryTitles(cat) {
  // 記事本体（名前空間0）を取り、無ければノートページ（名前空間1）から記事名を取り出す
  const out = [];
  for (const ns of ["0", "1"]) {
    let cont = {};
    for (let page = 0; page < 10; page++) {
      const d = await wikiApi({ action: "query", list: "categorymembers", cmtitle: cat, cmnamespace: ns, cmlimit: "500", cmtype: "page", ...cont });
      for (const m of d.query?.categorymembers ?? []) out.push(ns === "1" ? m.title.replace(/^ノート:/, "") : m.title);
      if (!d.continue) break;
      cont = { cmcontinue: d.continue.cmcontinue };
      await sleep(300);
    }
    if (out.length) break;
  }
  return out;
}

async function fetchWikipedia(wcfg, cache) {
  const items = []; // {word, reading, article}
  if (!wcfg || wcfg.enabled === false) return items;
  const nowIso = new Date().toISOString();

  // (1) 良質な記事・秀逸な記事 の本文からリンクされている言葉
  if (wcfg.goodArticles?.perRun > 0) {
    try {
      cache.wikiLists ??= {};
      const stale = !cache.wikiLists.t || Date.now() - cache.wikiLists.t > 7 * 86400000;
      if (stale) {
        const titles = [];
        for (const cat of wcfg.goodArticles.categories) titles.push(...await categoryTitles(cat));
        cache.wikiLists = { t: Date.now(), good: [...new Set(titles)] };
      }
      if (!(cache.wikiLists.good ?? []).length) console.warn("  Wikipedia/良質な記事: カテゴリから記事が見つかりません（feeds.json のカテゴリ名を確認してください）");
      const chosen = pick(cache.wikiLists.good ?? [], wcfg.goodArticles.perRun);
      for (const art of chosen) {
        const d = await wikiApi({ action: "query", prop: "links", titles: art, plnamespace: "0", pllimit: "max" });
        const links = (d.query?.pages?.[0]?.links ?? []).map(l => l.title).filter(t => !/^(\d|一覧|.*一覧$)/.test(t));
        const article = { site: "Wikipedia", label: "良質な記事", title: art, url: wikiArticleUrl(art), date: nowIso };
        for (const t of pick(links, wcfg.goodArticles.linksPerArticle)) items.push({ word: t, reading: "", article });
        console.log(`  Wikipedia/良質な記事「${art}」: リンク ${links.length}件から抽出`);
        await sleep(300);
      }
    } catch (e) { console.warn("  Wikipedia/良質な記事: 取得失敗", e.message); }
  }

  // (2) 新しく作られた記事
  if (wcfg.newArticles?.limit > 0) {
    try {
      const d = await wikiApi({ action: "query", list: "recentchanges", rctype: "new", rcnamespace: "0", rcshow: "!redirect|!bot", rcprop: "title|timestamp", rclimit: String(wcfg.newArticles.limit) });
      const rc = d.query?.recentchanges ?? [];
      for (const r of rc) items.push({ word: r.title, reading: "", article: { site: "Wikipedia", label: "新着記事", title: r.title, url: wikiArticleUrl(r.title), date: r.timestamp ?? nowIso } });
      console.log(`  Wikipedia/新着記事: ${rc.length}件`);
    } catch (e) { console.warn("  Wikipedia/新着記事: 取得失敗", e.message); }
  }

  // (3) おまかせ（ランダムな記事）
  if (wcfg.random?.limit > 0) {
    try {
      const d = await wikiApi({ action: "query", list: "random", rnnamespace: "0", rnlimit: String(Math.min(wcfg.random.limit, 50)) });
      const rs = d.query?.random ?? [];
      for (const r of rs) items.push({ word: r.title, reading: "", article: { site: "Wikipedia", label: "おまかせ", title: r.title, url: wikiArticleUrl(r.title), date: nowIso } });
      console.log(`  Wikipedia/おまかせ: ${rs.length}件`);
    } catch (e) { console.warn("  Wikipedia/おまかせ: 取得失敗", e.message); }
  }
  // 年号・数字入り・一覧・年表のような記事名は除く
  return items.filter(it => !/[0-9０-９]/.test(it.word) && !/一覧|年表|の歴史$|の戦績$/.test(it.word));
}

// ---------- 2. 言葉の候補を抜き出す ----------
function buildTokenizer() {
  const dicPath = path.join(ROOT, "node_modules/kuromoji/dict");
  return new Promise((res, rej) => kuromoji.builder({ dicPath }).build((e, t) => e ? rej(e) : res(t)));
}

const JOINABLE = new Set(["一般", "固有名詞", "サ変接続", "形容動詞語幹"]);
function kataToHira(s) { return s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)); }

export function extractCandidates(tokenizer, text) {
  const tokens = tokenizer.tokenize(text);
  const out = [];
  let seq = [];
  const flush = () => {
    if (seq.length) {
      // 人名だけの並びは調べない（存命人物はWikipedia側のカテゴリでも除外）
      const onlyPerson = seq.every(t => t.pos_detail_2 === "人名" || t.pos_detail_1 === "接尾");
      const word = seq.map(t => t.surface_form).join("");
      const reading = seq.every(t => t.reading && t.reading !== "*") ? kataToHira(seq.map(t => t.reading).join("")) : "";
      if (!onlyPerson) out.push({ word, reading });
      // 複合語の部分（2語以上の連なり）と、目立つ単語も候補に
      const n = seq.length;
      if (n > 1 && n <= 7) {
        for (let i = 0; i < n; i++) for (let j = i + 2; j <= n; j++) {
          if (i === 0 && j === n) continue;
          const part = seq.slice(i, j);
          if (part[0].pos_detail_1 === "接尾" || part.every(t => t.pos_detail_2 === "人名" || t.pos_detail_1 === "接尾")) continue;
          out.push({ word: part.map(t => t.surface_form).join(""), reading: part.every(t => t.reading && t.reading !== "*") ? kataToHira(part.map(t => t.reading).join("")) : "" });
        }
        for (const t of seq) {
          const s = t.surface_form;
          const notable = (t.pos_detail_1 === "固有名詞" && t.pos_detail_2 !== "人名") || /^[\u30a1-\u30fc]{3,}$/.test(s) || /^[\u4e00-\u9fff]{3,}$/.test(s);
          if (notable) out.push({ word: s, reading: t.reading && t.reading !== "*" ? kataToHira(t.reading) : "" });
        }
      }
    }
    seq = [];
  };
  for (const t of tokens) {
    const isNoun = t.pos === "名詞";
    if (isNoun && (JOINABLE.has(t.pos_detail_1) || (t.pos_detail_1 === "接尾" && seq.length && t.pos_detail_2 !== "助数詞"))) seq.push(t);
    else flush();
  }
  flush();
  return out.filter(({ word }) =>
    word.length >= 2 && word.length <= 20 &&
    !STOP.has(word) &&
    !/^[\u3041-\u309f]+$/.test(word) &&          // ひらがなだけ
    !/[0-9０-９]/.test(word) &&                  // 数字入り
    !/^[A-Za-zＡ-Ｚａ-ｚ]{1,3}$/.test(word) &&      // 短いアルファベット略語
    !/[「」『』（）()【】・、。!?！？"]/.test(word)
  );
}

// ---------- 3. Wikipedia で確認 ----------
async function wikiLookup(titles) {
  // 記事の有無・冒頭文・記事の長さ・カテゴリ（隠しカテゴリ以外）をまとめて取得する
  const base = {
    action: "query", format: "json", formatversion: "2", redirects: "1",
    prop: "extracts|pageprops|categories|info", exintro: "1", explaintext: "1", exsentences: "2", exlimit: "20",
    ppprop: "disambiguation", clshow: "!hidden", cllimit: "max",
    titles: titles.join("|"), origin: "*"
  };
  const map = new Map(titles.map(t => [t, t]));
  const pages = new Map();
  let cont = {};
  for (let round = 0; round < 8; round++) {
    const data = await get("https://ja.wikipedia.org/w/api.php?" + new URLSearchParams({ ...base, ...cont }), { json: true });
    const q = data.query ?? {};
    if (round === 0) {
      for (const n of q.normalized ?? []) for (const [k, v] of map) if (v === n.from) map.set(k, n.to);
      for (const r of q.redirects ?? []) for (const [k, v] of map) if (v === r.from) map.set(k, r.to);
    }
    for (const p of q.pages ?? []) {
      const cur = pages.get(p.title) ?? { ...p, categories: [] };
      cur.categories = cur.categories.concat((p.categories ?? []).map(c => c.title.replace(/^Category:/, "")));
      if (p.extract && !cur.extract) cur.extract = p.extract;
      pages.set(p.title, cur);
    }
    if (!data.continue) break;
    cont = data.continue;
    await sleep(200);
  }
  const result = new Map();
  for (const [orig, final] of map) {
    const p = pages.get(final);
    if (!p || p.missing || p.invalid) { result.set(orig, { reject: "記事なし" }); continue; }
    if (p.pageprops && "disambiguation" in p.pageprops) { result.set(orig, { reject: "曖昧さ回避" }); continue; }
    let extract = (p.extract ?? "").replace(/\s+/g, " ").trim();
    if (extract.length < 15) { result.set(orig, { reject: "説明が短い" }); continue; }
    if (extract.length > 220) extract = extract.slice(0, 218) + "…";
    result.set(orig, { title: p.title, extract, length: p.length ?? 0, categories: [...new Set(p.categories)] });
  }
  return result;
}

async function pageviews(title) {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 29 * 86400000);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/ja.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/daily/${fmt(start)}/${fmt(end)}`;
  try {
    const d = await get(url, { json: true });
    const items = d.items ?? [];
    return items.length ? Math.round(items.reduce((s, i) => s + i.views, 0) / 30) : 0;
  } catch { return 0; }
}

// ---------- main ----------
async function main() {
  const cfg = await readJson(FEEDS, { feeds: [] });
  const cache = await readJson(CACHE, { checked: {} });
  const store = await readJson(OUT, { updatedAt: null, words: [] });
  const now = Date.now();
  const Q = { ...DEFAULT_QUALITY, ...(cfg.quality ?? {}) };
  const blockRe = Q.blockCategoryPatterns.map(p => new RegExp(p));
  ZIPF = (await readJson(path.join(ROOT, "crawler/wordfreq-ja.json"), { zipf: {} })).zipf;

  // 選び方のルールを変えたときは、過去の言葉と調査済みの記録を作り直す
  const FILTER_VERSION = 2;
  if (store.filterVersion !== FILTER_VERSION) {
    console.log("選び方のルールが更新されたので、収録語を作り直します");
    store.words = []; cache.checked = {}; store.filterVersion = FILTER_VERSION;
  }

  console.log("RSSを取得中…");
  const articles = await fetchFeeds(cfg);
  console.log(`記事 ${articles.length}件`);

  const tokenizer = await buildTokenizer();
  const newsCand = new Map(); // word -> {reading, article}
  for (const a of articles) {
    for (const c of extractCandidates(tokenizer, `${a.title}。${a.desc}`)) {
      if (!newsCand.has(c.word)) newsCand.set(c.word, { reading: c.reading, article: a });
    }
  }

  console.log("Wikipediaを取得中…");
  const wikiCand = new Map();
  for (const it of await fetchWikipedia(cfg.wikipedia, cache)) {
    if (!newsCand.has(it.word) && !wikiCand.has(it.word)) wikiCand.set(it.word, { reading: it.reading, article: it.article });
  }

  const cand = new Map([...newsCand, ...wikiCand]);
  const byTitle = new Map(store.words.map(w => [w.word, w]));
  // 既に収録済みの言葉は出典だけ更新し、未調査のものだけWikipediaで確認する
  const pending = m => {
    const todo = [];
    for (const [word, info] of m) {
      const known = byTitle.get(word);
      if (known) { addSource(known, info.article); continue; }
      const c = cache.checked[word];
      if (c && now - c.t < RECHECK_DAYS * 86400000) continue;
      const z = zipfOf(word);
      if (z != null && z >= Q.commonZipf) { cache.checked[word] = { t: now, ok: false, why: "ふつうすぎる" }; continue; }
      todo.push(word);
    }
    return todo;
  };
  const newsTodo = pending(newsCand).sort((a, b) => b.length - a.length);
  const wikiTodo = pending(wikiCand);
  // ニュース由来を優先し、残りの枠をWikipedia由来に回す
  const newsPart = newsTodo.slice(0, Math.floor(MAX_LOOKUPS_PER_RUN * 0.6));
  const lookups = newsPart.concat(wikiTodo).slice(0, MAX_LOOKUPS_PER_RUN);
  console.log(`候補 ニュース${newsCand.size}語・Wikipedia${wikiCand.size}語 / 新しく調べる ${lookups.length}語`);

  // カテゴリごとの収録数（同じカテゴリの言葉ばかりにならないように）
  const catCount = new Map();
  for (const w of store.words) for (const c of w.cats ?? []) catCount.set(c, (catCount.get(c) ?? 0) + 1);
  const perSource = new Map();
  const why = {};
  const reject = (word, reason) => { cache.checked[word] = { t: now, ok: false, why: reason }; why[reason] = (why[reason] ?? 0) + 1; };

  let added = 0;
  for (let i = 0; i < lookups.length; i += 20) {
    const batch = lookups.slice(i, i + 20);
    let res;
    try { res = await wikiLookup(batch); } catch (e) { console.warn("  Wikipedia取得失敗:", e.message); await sleep(3000); continue; }
    for (const word of batch) {
      const hit = res.get(word);
      const info = cand.get(word);
      if (!hit || hit.reject) { reject(word, hit?.reject ?? "記事なし"); continue; }
      if (byTitle.has(hit.title)) { cache.checked[word] = { t: now, ok: true }; addSource(byTitle.get(hit.title), info.article); continue; }

      const z = zipfOf(hit.title);
      if (z != null && z >= Q.commonZipf) { reject(word, "ふつうすぎる"); continue; }
      if (hit.categories.some(c => blockRe.some(r => r.test(c)))) { reject(word, "除外カテゴリ"); continue; }
      if (hit.length < Q.minArticleBytes) { reject(word, "記事が短い"); continue; }
      const crowded = hit.categories.find(c => (catCount.get(c) ?? 0) >= Q.maxPerCategory);
      if (crowded) { reject(word, "同じカテゴリが多い"); continue; }
      const srcKey = info.article.url;
      if ((perSource.get(srcKey) ?? 0) >= Q.maxPerSourcePerRun) { why["同じ記事から多い"] = (why["同じ記事から多い"] ?? 0) + 1; continue; } // 次回また候補になれるよう記録しない

      const views = await pageviews(hit.title);
      await sleep(150);
      if (views < Q.minViews) { reject(word, "ほとんど読まれていない"); continue; }

      cache.checked[word] = { t: now, ok: true };
      const cats = hit.categories.slice(0, 10);
      const entry = {
        word: hit.title,
        reading: /[\u4e00-\u9fff]/.test(hit.title) && word === hit.title ? info.reading : "",
        meaning: hit.extract,
        wiki: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(hit.title.replace(/ /g, "_")),
        views, zipf: z, level: combinedLevel(views, z),
        cats,
        addedAt: new Date(now).toISOString(),
        sources: []
      };
      addSource(entry, info.article);
      store.words.push(entry); byTitle.set(hit.title, entry); added++;
      for (const c of cats) catCount.set(c, (catCount.get(c) ?? 0) + 1);
      perSource.set(srcKey, (perSource.get(srcKey) ?? 0) + 1);
    }
    await sleep(500);
  }
  console.log("除外した理由:", Object.entries(why).map(([k, v]) => `${k} ${v}`).join(" / ") || "なし");

  // 古いもの・キャッシュの整理
  const cutoff = now - KEEP_DAYS * 86400000;
  store.words = store.words.filter(w => new Date(w.sources[0]?.date ?? w.addedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.sources[0]?.date ?? b.addedAt) - new Date(a.sources[0]?.date ?? a.addedAt))
    .slice(0, MAX_WORDS);
  for (const [k, v] of Object.entries(cache.checked)) if (now - v.t > RECHECK_DAYS * 86400000) delete cache.checked[k];

  store.updatedAt = new Date(now).toISOString();
  store.feeds = [...new Set(cfg.feeds.map(f => f.site))].concat(cfg.wikipedia?.enabled === false ? [] : ["Wikipedia"]);
  store.license = {
    meaning: "各語の meaning はウィキペディア日本語版の記事冒頭を抜粋したもので、CC BY-SA 4.0 に従います（各語の wiki が出典）。",
    sources: "site が Wikipedia の出典は CC BY-SA 4.0 です。それ以外の sources の見出し（title）とリンク先の記事の著作権は各報道機関に帰属します。"
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(store));
  await fs.writeFile(CACHE, JSON.stringify(cache));
  console.log(`追加 ${added}語 / 収録 ${store.words.length}語`);
}

function addSource(entry, a) {
  if (entry.sources.some(s => s.url === a.url)) return;
  entry.sources.unshift({ site: a.site, label: a.label, title: a.title, url: a.url, date: a.date });
  entry.sources = entry.sources.slice(0, 3);
}

if (process.argv[1] === fileURLToPath(import.meta.url) || process.env.KG_RUN) {
  main().catch(e => { console.error(e); process.exit(1); });
}
