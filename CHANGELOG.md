# Changelog

## 0.1.0 — 2026-10-22

Unreleased candidate — publication pending approval.

Release preparation fixes: validate IPv4/IPv6 and every redirect, bound body reads and DNS waits, honor timeout options, validate CLI arguments, handle null JSON-LD and graph nodes, and align discovery scoring (16/2/1/1). Node.js 22+; ESM SDK export; 23 regression tests.

- AI crawler accessibility check (robots.txt rules for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Googlebot, Bingbot)
- Technical SEO checks (HTTPS, HTTP status, title tag, meta description, canonical URL, H1 structure)
- Structured data checks (JSON-LD Organization/LocalBusiness/WebSite schemas)
- AI discovery resource checks (sitemap.xml, llms.txt, RSS/Atom feed, ARD endpoint)
- Content accessibility (text-to-markup ratio, service description detection)
- Human-readable CLI output with color-coded severity
- `--json` flag for machine-readable output
- `--output <file>` flag to save JSON report
- `--timeout <ms>` flag to control per-request timeout
- SSRF protection (blocks private/reserved IP ranges)
