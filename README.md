# @growth-choice/ai-audit

Technical AI search readiness audit for any public website.

Checks AI crawler accessibility (robots.txt for GPTBot, OAI-SearchBot, ClaudeBot, Bingbot, Googlebot), technical SEO, JSON-LD structured data, AI discovery resources (llms.txt, sitemap, ARD), and content accessibility. Returns a 0–100 score with letter grade and per-finding recommendations.

**Web tool:** https://growth-choice.com/ai-visibility-audit  
**Docs:** https://growth-choice.com/ai-visibility-audit/docs

---

## Installation

```bash
# Run without installing
npx @growth-choice/ai-audit https://example.com

# Install globally
npm install -g @growth-choice/ai-audit
growth-choice-ai audit https://example.com
```

Requires Node.js 22 or later. ESM imports are supported; CommonJS require is not supported.

These installation commands become available after the first npm publication.

---

## Usage

```bash
# Basic audit (human-readable output)
npx @growth-choice/ai-audit https://example.com

# JSON output (machine-readable, for automation)
npx @growth-choice/ai-audit https://example.com --json

# Save JSON to file
npx @growth-choice/ai-audit https://example.com --output report.json

# Custom timeout (default: 12000ms)
npx @growth-choice/ai-audit https://example.com --timeout 20000
```

---

## Options

| Option | Description |
|---|---|
| `--json` | Output raw JSON |
| `--output <file>` | Write JSON to file |
| `--timeout <ms>` | Per-request timeout (default: 12000) |
| `--version` | Print version |
| `--help` | Show help |

---

## Exit codes

- `0` — Audit completed (even if score is low)
- `1` — Audit failed (invalid URL, unreachable, or blocked)
- `2` — Usage error

---

## Programmatic API

```typescript
import { runAudit } from '@growth-choice/ai-audit'

const result = await runAudit('https://example.com')
console.log(result.score, result.grade)
console.log(result.findings)
```

---

## What it checks

| Category | Max | Key signals |
|---|---|---|
| Crawler Accessibility | 20 | robots.txt, AI bot rules, sitemap directive |
| Technical SEO | 30 | HTTPS, HTTP 200, title, meta desc, H1, canonical |
| Structured Data | 20 | JSON-LD Organization, name+url, sameAs, WebSite |
| AI Discovery Resources | 20 | sitemap.xml, llms.txt, feeds, ARD endpoint |
| Content Accessibility | 10 | Text ratio ≥5%, service content, H1 presence |

Grade: A ≥85 · B ≥70 · C ≥55 · D ≥40 · F <40

---

## Privacy

The CLI resolves DNS and fetches the target URL directly from your machine. No audit data is transmitted to Growth Choice servers. The web version at growth-choice.com/ai-visibility-audit runs the audit server-side; submitted URLs are processed in memory and not stored.

---

## Agent Skill

An agent skill is available in `skills/growth-choice-ai-audit/SKILL.md`. It guides an AI assistant to run this CLI, parse the JSON output, and produce prioritized recommendations.

**What the skill does:** identifies the URL, explains the scope limitation, verifies Node.js ≥22, runs the pinned CLI with `--json`, handles failure cases (unreachable, timeout, SSRF blocked, oversized response, existing JSON report), parses the structured output, and presents scored findings with an action table.

**What it does not do:** it does not measure actual AI rankings, citations, traffic, or ChatGPT mentions. It does not deploy changes or modify production systems.

**Requirements:** Node.js 22 or later.

**Install the skill (Claude Code):**

```bash
npx skills add Alexdovzhenko/growth-choice-ai-audit --skill growth-choice-ai-audit -a claude-code
```

This command has not been tested against the published branch. It is the expected form based on current Skills CLI documentation; verify installation with `npx skills list` after running it.

**Example requests the skill responds to:**

- "Audit my website's technical readiness for AI search."
- "Check whether GPTBot can crawl my site."
- "Explain this Growth Choice audit JSON."
- "Run an AEO technical audit on https://example.com."
- "Why is my AI discovery score low?"

**The skill will decline:**

- Writing Instagram captions, general copywriting, or marketing strategy (not in scope).

**Skill source:** `skills/growth-choice-ai-audit/SKILL.md`

---

## Contributing

This package is not yet publicly released. Its repository is currently private at https://github.com/Alexdovzhenko/growth-choice-ai-audit. Public access and npm publication require owner approval.

---

## License

MIT — see LICENSE for details.

---

Built by [Growth Choice](https://growth-choice.com) — AI SEO and digital marketing.

## Limits and security

This heuristic audit checks the requested page and discovery resources at its original origin. It does not predict rankings, citations, or inclusion in AI answers. Optional discovery resources contribute 4 points; a sitemap contributes 16. robots.txt and HTML parsing are simplified and do not fully implement crawler matching or browser parsing. Discovery probes check HTTP success, not resource validity, and a failed probe may mean a network failure rather than absence.

Requests have a 12 second deadline by default, including DNS checks and body reading; `--timeout` applies to each request (1–300000 ms). Redirects are checked at each hop with a maximum of five. Page bodies are capped at 512 KiB; discovery probes at 32 KiB. Oversized pages fail; failed discovery probes score as absent.

Private/reserved IPv4 and non-global IPv6 destinations are rejected, including mixed public/private DNS answers. DNS checks and connections are separate, so DNS rebinding remains possible. Do not expose this package as a service for untrusted URLs without network egress isolation. The SDK has no authentication, API keys, telemetry, or runtime dependencies.

SDK example with timeout:

```js
import { runAudit } from '@growth-choice/ai-audit'
const result = await runAudit('https://example.com', { timeoutMs: 20000 })
```

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Use a currently supported Node.js release. Review SECURITY.md before hosting the SDK.
