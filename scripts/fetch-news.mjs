// ============================================================
// Apple 热点脉搏 · 每日采集脚本
// 从固定 RSS 信源抓取近 7 天资讯，规则化分类/评级/打标签，
// 合并去重后输出 data/news.json（供前端动态加载）
// 用法：node scripts/fetch-news.mjs
// ============================================================

import { XMLParser } from 'fast-xml-parser';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'news.json');

const DAYS_WINDOW = 7;      // 抓取最近 N 天
const MAX_ITEMS = 400;      // 归档上限，防止无限膨胀

// ---------- RSS 信源 ----------
const FEEDS = [
  { url: 'https://www.apple.com/newsroom/rss-feed.rss', source: 'Apple Newsroom', sourceType: 'Apple 官方' },
  { url: 'https://9to5mac.com/feed/', source: '9to5Mac', sourceType: '媒体' },
  { url: 'https://www.macrumors.com/macrumors.xml', source: 'MacRumors', sourceType: '媒体' },
  { url: 'https://appleinsider.com/rss/news', source: 'AppleInsider', sourceType: '媒体' },
  { url: 'https://developer.apple.com/news/rss/news.rss', source: 'Apple Developer News', sourceType: 'Apple 官方' },
  { url: 'https://www.ifanr.com/feed', source: '爱范儿', sourceType: '媒体' },
];

// ---------- 分类规则（按优先级匹配） ----------
const CATEGORY_RULES = [
  { category: '监管 & 商业', pattern: /(antitrust|lawsuit|sue[sd]?|court|ruling|judge|fine[d]?|regulat|dma|monopol|commission|epic games|doj|justice department|罚款|诉讼|反垄断|监管|法院)/i },
  { category: '开发者 & 生态', pattern: /(xcode|swift(?!ui)|swiftui|wwdc|sdk|api\b|developer|app store connect|testflight|编程|开发者)/i },
  { category: 'Apple 服务 & 软件', pattern: /(apple music|apple tv\+|tv\+|arcade|icloud|podcast|apple pay|apple card|fitness\+|news\+|maps|siri|services|订阅|服务)/i },
  { category: 'iOS 系统', pattern: /(ios|ipados|macos|watchos|visionos|beta|firmware|系统更新|公测)/i },
  { category: 'iPhone 硬件', pattern: /(iphone|ipad|macbook|imac|airpods|vision pro|watch|chip|\ba\d{2}\b|m[1-9]\b|camera|display|battery|芯片|摄像头|续航|发布)/i },
];
const DEFAULT_CATEGORY = 'iOS 系统';

// ---------- 重要度规则 ----------
const HEADLINE_RE = /(break|major|record|billion|\$\d+(\.\d+)?\s*(billion|million)|lawsuit|sues|ruling|fined|antitrust|keynote|event|unveil|announce[sd]?|launch(?:es|ed)?|biggest|first look|review)/i;
const IMPORTANT_RE = /(update|beta|feature|report|leak|rumor|deal|partner|expands|adds|rollout|released|available now|升级|推送|上线)/i;

// ---------- 标签提取：优先命中已知关键词，否则取标题中的大写词 ----------
const KNOWN_TAGS = [
  'iOS 26', 'iOS 27', 'iPadOS 27', 'macOS Tahoe', 'watchOS', 'visionOS',
  'Siri', 'Apple Intelligence', 'AI', 'App Store', 'Xcode', 'SwiftUI', 'Swift',
  'WWDC', 'iPhone 17', 'iPhone 18', 'AirPods', 'Vision Pro', 'Apple Watch',
  'Apple Music', 'Apple TV+', 'Apple Arcade', 'iCloud', 'Apple Pay',
  'Epic Games', '欧盟', '反垄断', '诉讼', 'M5', 'A19', 'Fold', '折叠屏',
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'be', 'been', 'new', 'how', 'what', 'why',
  'this', 'that', 'it', 'its', 'you', 'your', 'we', 'our', 'can', 'will', 'may',
  'apple', 'here', 'more', 'than', 'into', 'up', 'out', 'about', 'after', 'before',
]);

function classify(title) {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(title)) return rule.category;
  }
  return DEFAULT_CATEGORY;
}

function rateImportance(title) {
  if (HEADLINE_RE.test(title)) return '头条';
  if (IMPORTANT_RE.test(title)) return '重要';
  return '一般';
}

function extractTags(title) {
  const tags = [];
  for (const tag of KNOWN_TAGS) {
    if (title.toLowerCase().includes(tag.toLowerCase()) && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 3) break;
  }
  if (tags.length > 0) return tags;
  // 兜底：英文标题只取首字母大写的专有名词；中文标题用类别名
  const words = title.replace(/[^A-Za-z\s]/g, ' ').split(/\s+/)
    .filter(w => /^[A-Z][A-Za-z]{3,}$/.test(w) && !STOPWORDS.has(w.toLowerCase()));
  if (words.length > 0) {
    return words.slice(0, 3);
  }
  return [classify(title)];
}

function stripHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max = 160) {
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- 翻译：使用 Google 翻译免费接口（无需密钥） ----------
const CHINESE_RATIO_RE = /[\u4e00-\u9fff]/g;

function isMostlyChinese(text) {
  const cn = text.match(CHINESE_RATIO_RE);
  return cn && cn.length / text.length > 0.3;
}

async function translateText(text) {
  // 已是中文则跳过
  if (isMostlyChinese(text)) return text;
  const url = 'https://translate.googleapis.com/translate_a/single'
    + '?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = (data[0] ?? []).map(seg => seg?.[0] ?? '').join('');
    return out.trim() || text;
  } finally {
    clearTimeout(timer);
  }
}

// 带并发限制的批量翻译，单条失败时保留英文原文
async function translateItems(items) {
  const CONCURRENCY = 4;
  let done = 0;
  async function worker(queue) {
    while (queue.length) {
      const item = queue.shift();
      try {
        item.summary = await translateText(item.summary);
        item.title = await translateText(item.title);
      } catch (err) {
        console.warn(`翻译失败（保留原文）：${item.titleEn.slice(0, 40)}… · ${err.message}`);
      }
      done++;
      if (done % 10 === 0) console.log(`翻译进度 ${done}`);
      await new Promise(r => setTimeout(r, 300)); // 轻微限速，避免被接口限流
    }
  }
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AppleHotspotPulse/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: true });
    const doc = parser.parse(xml);
    const channel = doc.rss?.channel ?? doc.feed;
    if (!channel) throw new Error('无法识别的 feed 格式');

    const rawItems = channel.item ?? channel.entry ?? [];
    return (Array.isArray(rawItems) ? rawItems : [rawItems]).map(item => ({
      title: stripHtml(item.title ?? ''),
      link: item.link?.['#text'] ?? (typeof item.link === 'string' ? item.link : (item.link?.href ?? '')),
      pubDate: item.pubDate ?? item.published ?? item.updated ?? null,
      description: item.description ?? item.summary ?? '',
      source: feed.source,
      sourceType: feed.sourceType,
    })).filter(i => i.title && i.link);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`开始采集 · ${new Date().toISOString()}`);

  // 读取已有归档（跨天去重 + 历史保留）
  let archived = [];
  try {
    const prev = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    archived = prev.items ?? [];
    console.log(`已有归档 ${archived.length} 条`);
  } catch { console.log('无历史数据，首次采集'); }

  const seenLinks = new Set(archived.map(i => i.sourceUrl));

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const cutoff = Date.now() - DAYS_WINDOW * 24 * 60 * 60 * 1000;

  const fresh = [];
  results.forEach((r, idx) => {
    const feed = FEEDS[idx];
    if (r.status === 'rejected') {
      console.warn(`✗ ${feed.source}: ${r.reason?.message ?? r.reason}`);
      return;
    }
    let count = 0;
    for (const item of r.value) {
      const ts = item.pubDate ? new Date(item.pubDate).getTime() : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);

      const title = item.title;
      fresh.push({
        title,
        titleEn: title, // 保留英文原标题
        summary: truncate(stripHtml(item.description)) || title,
        date: toDateStr(new Date(ts)),
        source: item.source,
        sourceUrl: item.link,
        category: classify(title),
        importance: rateImportance(title),
        sourceType: item.sourceType,
        tags: extractTags(title),
      });
      count++;
    }
    console.log(`✓ ${feed.source}: 新增 ${count} 条`);
  });

  // 翻译新增条目为中文（分类/评级/标签已基于英文原文完成）
  if (fresh.length > 0) {
    console.log(`开始翻译 ${fresh.length} 条新资讯…`);
    await translateItems(fresh);
  }

  // 分配自增 id 并合并排序
  const startId = archived.reduce((m, i) => Math.max(m, i.id), 0);
  const merged = [...fresh.map((item, i) => ({ id: startId + 1 + i, ...item })), ...archived]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_ITEMS);

  const output = { generatedAt: new Date().toISOString(), items: merged };
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`完成：新增 ${fresh.length} 条，总计 ${merged.length} 条 → data/news.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
