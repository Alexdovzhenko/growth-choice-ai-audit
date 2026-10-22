// Standalone audit engine for the CLI — no Next.js deps.
// Mirrors lib/audit/ in the parent project.

import dns from 'node:dns/promises'
import net from 'node:net'

// ── Types ──────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type CategoryStatus = 'pass' | 'warn' | 'fail' | 'unknown'
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface Finding {
  id: string
  category: string
  severity: Severity
  title: string
  description: string
  url: string
  evidence?: string
  recommendation: string
  verification?: string
}

export interface CategoryResult {
  name: string
  key: string
  score: number
  max_score: number
  status: CategoryStatus
  summary: string
}

export interface AuditResult {
  url: string
  timestamp: string
  duration_ms: number
  score: number
  grade: Grade
  categories: Record<string, CategoryResult>
  findings: Finding[]
  metadata: {
    final_url: string
    status_code: number
    https: boolean
    redirect_count: number
    fetch_duration_ms: number
    content_type?: string
    audit_scope: 'homepage'
  }
  incomplete: boolean
  incomplete_reason?: string
}

// ── SSRF Guard ─────────────────────────────────────────────────────────────────

function blockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
  }
  // Accept only global unicast IPv6; reject mapped/translation/local ranges.
  if (net.isIPv6(address)) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const first = parseInt(normalized.split(':')[0], 16)
    return !(first >= 0x2000 && first <= 0x3fff) ||
      normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0:') ||
      normalized.startsWith('2002:') || normalized.startsWith('3fff:')
  }
  return true
}

async function guardUrl(rawUrl: string): Promise<{ origin: string; href: string }> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw Object.assign(new Error('Invalid URL'), { code: 'INVALID_URL' }) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('Use an HTTP(S) URL without embedded credentials'), { code: 'INVALID_URL' })
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const reject = () => { throw Object.assign(new Error('Private or reserved destination blocked'), { code: 'SSRF_BLOCKED' }) }
  if (net.isIP(hostname)) {
    if (blockedAddress(hostname)) reject()
  } else {
    const records = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)])
    const addresses = records.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    if (!addresses.length) throw Object.assign(new Error('Unable to resolve hostname'), { code: 'UNREACHABLE' })
    if (addresses.some(blockedAddress)) reject()
  }
  return { origin: url.origin, href: url.href }
}

interface FetchResult { ok: boolean; status: number; headers: Record<string, string>; text: string; finalUrl: string; redirectCount: number }

async function fetchSafe(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<FetchResult> {
  const { timeoutMs = 12000, maxBytes = 512 * 1024 } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const deadline = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error(`Timeout after ${timeoutMs}ms`), { code: 'TIMEOUT' })), { once: true })
  })
  try {
    const operation = async (): Promise<FetchResult> => {
      let current = url
      for (let redirects = 0; ; redirects++) {
        await guardUrl(current)
        ctrl.signal.throwIfAborted()
        const res = await fetch(current, {
          redirect: 'manual', signal: ctrl.signal,
          headers: { 'User-Agent': 'GrowthChoiceAuditBot/1.0 (+https://growth-choice.com/ai-visibility-audit)', Accept: 'text/html,*/*' },
        })
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          await res.body?.cancel()
          const location = res.headers.get('location')
          if (!location || redirects >= 5) throw Object.assign(new Error('Invalid redirect or redirect limit exceeded'), { code: 'UNREACHABLE' })
          current = new URL(location, current).href
          continue
        }
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
        const reader = res.body?.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (total + value.length > maxBytes) {
              await reader.cancel()
              throw Object.assign(new Error('Response exceeds audit size limit'), { code: 'RESPONSE_TOO_LARGE' })
            }
            chunks.push(value); total += value.length
          }
        }
        const combined = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length }
        return { ok: res.ok, status: res.status, headers, text: new TextDecoder().decode(combined), finalUrl: current, redirectCount: redirects }
      }
    }
    return await Promise.race([operation(), deadline])
  } finally { clearTimeout(timer) }
}

async function probe(url: string, timeoutMs: number): Promise<{ found: boolean }> {
  try { const r = await fetchSafe(url, { timeoutMs, maxBytes: 32768 }); return { found: r.ok } } catch { return { found: false } }
}

// ── HTML parser ────────────────────────────────────────────────────────────────

interface HtmlMeta { title: string | null; metaDescription: string | null; metaRobots: string | null; canonical: string | null; h1: string | null; h1Count: number; jsonLdBlocks: unknown[]; textRatio: number; bodyText: string }

function parseHtml(html: string): HtmlMeta {
  const dec = (s: string) => s.replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&nbsp;/gi,' ')
  const attr = (tag: string, a: string) => { const m = new RegExp(`\\b${a}\\s*=\\s*(?:"([^"]*?)"|'([^']*?)'|([^\\s>]+))`, 'i').exec(tag); return m ? dec(m[1]??m[2]??m[3]??'') : null }
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const mdM = /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(html)
  const mrM = /<meta[^>]+name\s*=\s*["']robots["'][^>]*>/i.exec(html)
  const cM = /<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i.exec(html)
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
  const blocks: unknown[] = []
  const jre = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let jm: RegExpExecArray | null
  while ((jm = jre.exec(html)) !== null) { try { const p = JSON.parse(jm[1]); if (Array.isArray(p)) blocks.push(...p); else blocks.push(p) } catch { /* skip */ } }
  const stripped = html.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim()
  return {
    title: titleM ? dec(titleM[1].trim()) : null,
    metaDescription: mdM ? attr(mdM[0],'content') : null,
    metaRobots: mrM ? attr(mrM[0],'content') : null,
    canonical: cM ? attr(cM[0],'href') : null,
    h1: h1s[0] ? dec(h1s[0][1].replace(/<[^>]+>/g,'').trim()) : null,
    h1Count: h1s.length,
    jsonLdBlocks: blocks,
    textRatio: html.length > 0 ? stripped.length / html.length : 0,
    bodyText: stripped.slice(0, 4000),
  }
}

// ── Robots parser ──────────────────────────────────────────────────────────────

interface RobotsRule { userAgent: string; allows: string[]; disallows: string[] }
interface ParsedRobots { rules: RobotsRule[]; sitemaps: string[] }

function parseRobots(text: string): ParsedRobots {
  const rules: RobotsRule[] = []; const sitemaps: string[] = []; let cur: RobotsRule | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/,'').trim(); if (!line) { cur = null; continue }
    const ci = line.indexOf(':'); if (ci === -1) continue
    const f = line.slice(0,ci).trim().toLowerCase(), v = line.slice(ci+1).trim()
    if (f === 'user-agent') { if (!cur || cur.allows.length > 0 || cur.disallows.length > 0) { cur = { userAgent:v, allows:[], disallows:[] }; rules.push(cur) } else cur.userAgent = v }
    else if (f === 'allow' && cur) cur.allows.push(v)
    else if (f === 'disallow' && cur && v) cur.disallows.push(v)
    else if (f === 'sitemap') sitemaps.push(v)
  }
  return { rules, sitemaps }
}

function isAllowed(robots: ParsedRobots, ua: string, path: string): 'allowed' | 'disallowed' | 'unknown' {
  const rule = robots.rules.find(r => r.userAgent.toLowerCase() === ua.toLowerCase()) ?? robots.rules.find(r => r.userAgent === '*')
  if (!rule) return 'unknown'
  if (rule.disallows.includes('/') && !rule.allows.some(a => path.startsWith(a) && a !== '/')) return 'disallowed'
  for (const d of rule.disallows) { if (path.startsWith(d) && !rule.allows.some(a => a.length >= d.length && path.startsWith(a))) return 'disallowed' }
  return 'allowed'
}

const AI_CRAWLERS = [
  { ua: 'GPTBot', name: 'GPTBot' }, { ua: 'OAI-SearchBot', name: 'OAI-SearchBot' },
  { ua: 'ClaudeBot', name: 'ClaudeBot' }, { ua: 'PerplexityBot', name: 'PerplexityBot' },
  { ua: 'Googlebot', name: 'Googlebot' }, { ua: 'Bingbot', name: 'Bingbot' },
]

// ── Scoring helpers ────────────────────────────────────────────────────────────

function grade(score: number): Grade { return score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F' }
function catStatus(score: number, max: number): CategoryStatus { const p = score / max; return p >= 0.8 ? 'pass' : p >= 0.5 ? 'warn' : 'fail' }

// ── Main audit ─────────────────────────────────────────────────────────────────

export async function runAudit(rawUrl: string, _opts: { timeoutMs?: number } = {}): Promise<AuditResult> {
  const timeoutMs = _opts.timeoutMs ?? 12000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Object.assign(new Error('timeoutMs must be an integer from 1 to 300000'), { code: 'INVALID_ARGUMENT' })
  const t0 = Date.now()
  let urlStr = rawUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:/i.test(urlStr)) urlStr = `https://${urlStr}`

  let parsedUrl: URL
  try { parsedUrl = new URL(urlStr) } catch { throw Object.assign(new Error("Invalid URL"), { code: "INVALID_URL" }) }
  const { origin, href } = parsedUrl
  const targetPath = new URL(href).pathname || '/'

  const ft0 = Date.now()
  const homeRes = await fetchSafe(href, { timeoutMs })
  const ftd = Date.now() - ft0
  const html = parseHtml(homeRes.text)

  // Parallel: robots + discovery
  const [robotsRes, sitemapR, llmsR, feedR, ardR] = await Promise.all([
    fetchSafe(`${origin}/robots.txt`, { timeoutMs, maxBytes: 65536 }).catch(() => null),
    probe(`${origin}/sitemap.xml`, timeoutMs),
    probe(`${origin}/llms.txt`, timeoutMs),
    probe(`${origin}/feed.xml`, timeoutMs).then(r => r.found ? r : probe(`${origin}/rss.xml`, timeoutMs)),
    probe(`${origin}/.well-known/ard.json`, timeoutMs),
  ])

  const findings: Finding[] = []

  // ── Crawler access ──
  let crawlerScore = 0
  if (robotsRes?.ok) {
    crawlerScore += 4
    const parsed = parseRobots(robotsRes.text)
    const blanket = parsed.rules.find(r => r.userAgent === '*')?.disallows.includes('/')
    if (!blanket) crawlerScore += 8
    else findings.push({ id:'blanket-disallow', category:'crawler_access', severity:'critical', title:'Wildcard disallow blocks all crawlers', description:'robots.txt has "Disallow: /" for all agents.', url:`${origin}/robots.txt`, recommendation:'Remove blanket Disallow: / or add explicit Allow: /', verification:`curl ${origin}/robots.txt` })
    const oai = isAllowed(parsed, 'OAI-SearchBot', targetPath)
    const gpt = isAllowed(parsed, 'GPTBot', targetPath)
    if (oai !== 'disallowed' && gpt !== 'disallowed') crawlerScore += 5
    const blocked = AI_CRAWLERS.filter(c => isAllowed(parsed, c.ua, targetPath) === 'disallowed').map(c => c.name)
    if (blocked.length && !blanket) findings.push({ id:'ai-bots-blocked', category:'crawler_access', severity:'high', title:`AI crawlers blocked: ${blocked.join(', ')}`, description:`Your robots.txt disallows: ${blocked.join(', ')}`, url:`${origin}/robots.txt`, recommendation:'Allow OAI-SearchBot to enable ChatGPT Search discovery.', verification:`curl ${origin}/robots.txt` })
    if (parsed.sitemaps.length > 0) crawlerScore += 3
    else findings.push({ id:'robots-no-sitemap', category:'crawler_access', severity:'low', title:'No Sitemap directive in robots.txt', description:'Add a Sitemap: directive.', url:`${origin}/robots.txt`, recommendation:`Add Sitemap: ${origin}/sitemap.xml to robots.txt` })
  } else {
    findings.push({ id:'robots-not-found', category:'crawler_access', severity:'low', title:'robots.txt not found', description:'No robots.txt at /robots.txt.', url:`${origin}/robots.txt`, recommendation:'Create robots.txt with User-agent: *, Allow: /, and a Sitemap: directive.' })
  }

  // ── Technical SEO ──
  let techScore = 0
  const https = homeRes.finalUrl.startsWith('https://')
  if (https) techScore += 5
  else findings.push({ id:'no-https', category:'technical_seo', severity:'critical', title:'Not served over HTTPS', description:'Switch to HTTPS.', url:homeRes.finalUrl, recommendation:'Install TLS and redirect HTTP → HTTPS.' })
  if (homeRes.status < 400) techScore += 5
  else findings.push({ id:'http-error', category:'technical_seo', severity:'critical', title:`HTTP ${homeRes.status}`, description:'Page returns an error.', url:homeRes.finalUrl, recommendation:'Fix the server error.' })
  if (html.title && html.title.length >= 10) techScore += 5
  else findings.push({ id:'missing-title', category:'technical_seo', severity:'high', title:'Missing or short title tag', description:'Add a descriptive <title>.', url:homeRes.finalUrl, recommendation:'Add a 50–60 character title tag.' })
  if (html.metaDescription && html.metaDescription.length >= 50) techScore += 5
  else findings.push({ id:'missing-meta-desc', category:'technical_seo', severity:'medium', title:'Missing or short meta description', description:'Add a meta description.', url:homeRes.finalUrl, recommendation:'Add a 150–160 character meta description.' })
  if (html.h1Count === 1) techScore += 5
  else findings.push({ id: html.h1Count === 0 ? 'missing-h1' : 'multiple-h1', category:'technical_seo', severity:html.h1Count === 0 ? 'medium' : 'low', title: html.h1Count === 0 ? 'No H1 heading' : `Multiple H1 tags (${html.h1Count})`, description: html.h1Count === 0 ? 'Add a single H1.' : 'Use one H1 per page.', url:homeRes.finalUrl, recommendation:'Use exactly one H1 per page.' })
  if (html.canonical) techScore += 5
  else findings.push({ id:'missing-canonical', category:'technical_seo', severity:'medium', title:'No canonical URL', description:'Add a canonical link tag.', url:homeRes.finalUrl, recommendation:'Add <link rel="canonical" href="…"> in <head>.' })

  // ── Structured data ──
  let sdScore = 0
  const flatten = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (typeof value !== 'object' || value === null) return []
    const node = value as Record<string, unknown>
    return [node, ...(Array.isArray(node['@graph']) ? node['@graph'].flatMap(flatten) : [])]
  }
  const blocks = html.jsonLdBlocks.flatMap(flatten)
  if (blocks.length > 0) {
    sdScore += 5
    type N = { '@type'?: unknown; name?: unknown; url?: unknown; sameAs?: unknown }
    const getType = (b: unknown): string | null => { const t = (b as N)['@type']; return typeof t === 'string' ? t : Array.isArray(t) ? t.find(v => typeof v === 'string' && ['Organization','LocalBusiness','Corporation','ProfessionalService','FinancialService','LegalService','WebSite'].includes(v)) ?? null : null }
    const ORG = ['Organization','LocalBusiness','Corporation','ProfessionalService','FinancialService','LegalService']
    const org = blocks.find(b => ORG.includes(getType(b) ?? '')) as N | undefined
    if (org) {
      sdScore += 7
      if (org.name && org.url) sdScore += 4
      else findings.push({ id:'org-incomplete', category:'structured_data', severity:'medium', title:'Organization schema missing name or url', description:'Add name and url to Organization schema.', url:homeRes.finalUrl, recommendation:'Add "name" and "url" to your Organization JSON-LD block.' })
      if (org.sameAs) sdScore += 2
      else findings.push({ id:'org-no-sameas', category:'structured_data', severity:'low', title:'Organization schema missing sameAs', description:'Link social profiles with sameAs.', url:homeRes.finalUrl, recommendation:'Add sameAs with LinkedIn, Google Business, and other profile URLs.' })
    } else findings.push({ id:'no-org-schema', category:'structured_data', severity:'high', title:'No Organization/LocalBusiness schema', description:'Add Organization or LocalBusiness JSON-LD.', url:homeRes.finalUrl, recommendation:'Add Organization or LocalBusiness structured data with name, url, sameAs.', verification:'https://search.google.com/test/rich-results' })
    if (blocks.some(b => getType(b) === 'WebSite')) sdScore += 2
    else findings.push({ id:'no-website-schema', category:'structured_data', severity:'low', title:'No WebSite schema', description:'Add a WebSite schema block.', url:homeRes.finalUrl, recommendation:'Add WebSite schema with name, url, and optionally a SearchAction.' })
  } else {
    findings.push({ id:'no-json-ld', category:'structured_data', severity:'high', title:'No JSON-LD structured data', description:'Add Organization JSON-LD.', url:homeRes.finalUrl, recommendation:'Add Organization JSON-LD with name, url, description, telephone, sameAs.', verification:'https://search.google.com/test/rich-results' })
  }

  // ── AI discovery ──
  let discScore = 0
  if (sitemapR.found) discScore += 16; else findings.push({ id:'no-sitemap', category:'ai_discovery', severity:'high', title:'XML sitemap not found', description:'Create /sitemap.xml.', url:`${origin}/sitemap.xml`, recommendation:'Create and submit an XML sitemap.', verification:`curl -I ${origin}/sitemap.xml` })
  if (llmsR.found) discScore += 2; else findings.push({ id:'no-llms-txt', category:'ai_discovery', severity:'info', title:'llms.txt not found (optional)', description:'Consider adding llms.txt.', url:`${origin}/llms.txt`, recommendation:'Add llms.txt for AI agent navigation.', verification:`curl ${origin}/llms.txt` })
  if (feedR.found) discScore += 1
  if (ardR.found) discScore += 1

  // ── Content ──
  let contentScore = 0
  if (html.title && html.title.length >= 10) contentScore += 2
  if (html.metaDescription && html.metaDescription.length >= 50) contentScore += 2
  if (html.textRatio >= 0.05) contentScore += 3; else if (html.textRatio >= 0.02) contentScore += 1
  if (/service|product|solution|offer|provid|speciali[sz]/i.test(html.bodyText)) contentScore += 2
  if (html.h1Count >= 1) contentScore += 1

  if (html.textRatio < 0.05) findings.push({ id:'low-text-ratio', category:'content_accessibility', severity: html.textRatio < 0.02 ? 'high' : 'medium', title:`Low text-to-markup ratio (${(html.textRatio*100).toFixed(1)}%)`, description:'Ensure content is in server-rendered HTML.', url:homeRes.finalUrl, evidence:`Ratio: ${(html.textRatio*100).toFixed(1)}%`, recommendation:'Add server-rendered text content. Target ≥5% text/markup ratio.' })

  const sevOrd: Record<Severity, number> = { critical:0, high:1, medium:2, low:3, info:4 }
  findings.sort((a,b) => (sevOrd[a.severity]??5) - (sevOrd[b.severity]??5))

  const totalScore = crawlerScore + techScore + sdScore + discScore + contentScore
  const finalScore = Math.round((totalScore / 100) * 100)

  return {
    url: urlStr,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    score: finalScore,
    grade: grade(finalScore),
    categories: {
      crawler_access: { name:'Crawler Accessibility', key:'crawler_access', score:crawlerScore, max_score:20, status:catStatus(crawlerScore,20), summary:robotsRes?.ok ? 'robots.txt analyzed' : 'robots.txt not accessible' },
      technical_seo:  { name:'Technical SEO', key:'technical_seo', score:techScore, max_score:30, status:catStatus(techScore,30), summary:`HTTPS:${https?'✓':'✗'} Status:${homeRes.status} Title:${html.title?'✓':'✗'} H1:${html.h1Count>0?'✓':'✗'}` },
      structured_data: { name:'Structured Data', key:'structured_data', score:sdScore, max_score:20, status:catStatus(sdScore,20), summary:`${blocks.length} JSON-LD block(s)` },
      ai_discovery:   { name:'AI Discovery Resources', key:'ai_discovery', score:discScore, max_score:20, status:catStatus(discScore,20), summary:`sitemap:${sitemapR.found?'✓':'✗'} llms.txt:${llmsR.found?'✓':'✗'}` },
      content_accessibility: { name:'Content Accessibility', key:'content_accessibility', score:contentScore, max_score:10, status:catStatus(contentScore,10), summary:`${(html.textRatio*100).toFixed(1)}% text ratio` },
    },
    findings,
    metadata: { final_url:homeRes.finalUrl, status_code:homeRes.status, https, redirect_count:homeRes.redirectCount, fetch_duration_ms:ftd, content_type:homeRes.headers['content-type'], audit_scope:'homepage' },
    incomplete: false,
  }
}
