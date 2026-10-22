#!/usr/bin/env node
// @growth-choice/ai-audit CLI

import { writeFileSync } from 'node:fs'
import { runAudit } from './audit-engine.js'
import type { AuditResult, Severity } from './audit-engine.js'

const VERSION = '0.1.0'

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '\x1b[31m',   // red
  high:     '\x1b[33m',   // yellow
  medium:   '\x1b[93m',   // bright yellow
  low:      '\x1b[34m',   // blue
  info:     '\x1b[90m',   // grey
}
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const DIM = '\x1b[2m'

function usage() {
  console.log(`
${BOLD}@growth-choice/ai-audit${RESET} v${VERSION}
AI search readiness audit for any public website.

${BOLD}Usage:${RESET}
  npx @growth-choice/ai-audit <url> [options]
  growth-choice-ai audit <url> [options]

${BOLD}Options:${RESET}
  --json              Output raw JSON (machine-readable)
  --output <file>     Write JSON result to file
  --timeout <ms>      Per-request timeout in ms (default: 12000)
  --version           Print version
  --help              Show this help

${BOLD}Examples:${RESET}
  npx @growth-choice/ai-audit https://example.com
  npx @growth-choice/ai-audit https://example.com --json
  npx @growth-choice/ai-audit https://example.com --output report.json

${BOLD}Docs:${RESET}
  https://growth-choice.com/ai-visibility-audit/docs
`)
}

function printResult(result: AuditResult) {
  const gradeColors: Record<string, string> = { A: GREEN, B: '\x1b[32m', C: '\x1b[33m', D: '\x1b[33m', F: '\x1b[31m' }
  const gc = gradeColors[result.grade] ?? ''

  console.log()
  console.log(`${BOLD}AI Visibility Audit — ${result.metadata.final_url}${RESET}`)
  console.log(`${DIM}${result.timestamp} · ${result.duration_ms}ms${RESET}`)
  console.log()
  console.log(`${BOLD}Score: ${gc}${result.score}/100 (${result.grade})${RESET}`)
  console.log()

  console.log(`${BOLD}Categories:${RESET}`)
  for (const cat of Object.values(result.categories)) {
    const bar = buildBar(cat.score, cat.max_score, 20)
    const statusEmoji = cat.status === 'pass' ? '✓' : cat.status === 'warn' ? '⚠' : cat.status === 'fail' ? '✗' : '?'
    console.log(`  ${statusEmoji} ${cat.name.padEnd(26)} ${String(cat.score).padStart(2)}/${cat.max_score}  ${bar}`)
    if (cat.summary) console.log(`    ${DIM}${cat.summary}${RESET}`)
  }
  console.log()

  const actionable = result.findings.filter((f) => f.severity !== 'info')
  const info = result.findings.filter((f) => f.severity === 'info')

  if (actionable.length > 0) {
    console.log(`${BOLD}Findings (${actionable.length}):${RESET}`)
    for (const f of actionable) {
      const c = SEVERITY_COLORS[f.severity]
      console.log(`  ${c}[${f.severity.toUpperCase()}]${RESET} ${f.title}`)
      console.log(`    ${DIM}${f.recommendation}${RESET}`)
    }
    console.log()
  }

  if (info.length > 0) {
    console.log(`${BOLD}Optional improvements (${info.length}):${RESET}`)
    for (const f of info) {
      console.log(`  ${DIM}[INFO] ${f.title}${RESET}`)
    }
    console.log()
  }

  if (actionable.length === 0 && info.length === 0) {
    console.log(`${GREEN}✓ No issues found.${RESET}`)
    console.log()
  }

  console.log(`${DIM}Audit scope: homepage only · Docs: https://growth-choice.com/ai-visibility-audit/docs${RESET}`)
  console.log()
}

function buildBar(score: number, max: number, width: number): string {
  const filled = Math.round((score / max) * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage()
    process.exit(0)
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION)
    process.exit(0)
  }

  const remaining = [...args]
  if (remaining[0] === 'audit') remaining.shift()
  let urlArg: string | undefined
  let jsonFlag = false
  let outputFile: string | undefined
  let timeout = 12000
  const usageError = (message: string): never => { console.error(`Error: ${message}`); process.exit(2) }
  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i]
    if (arg === '--json') jsonFlag = true
    else if (arg === '--timeout' || arg === '--output') {
      const value = remaining[++i]
      if (!value || value.startsWith('--')) usageError(`${arg} requires a value`)
      if (arg === '--output') outputFile = value
      else {
        if (!/^\d+$/.test(value)) usageError('--timeout requires a positive integer')
        timeout = Number(value)
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) usageError('--timeout must be from 1 to 300000 ms')
      }
    } else if (arg.startsWith('-')) usageError(`Unknown option: ${arg}`)
    else if (urlArg) usageError('Only one URL can be audited at a time')
    else urlArg = arg
  }
  if (!urlArg) return usageError('URL argument required. Run --help for usage.')

  if (!jsonFlag) {
    process.stdout.write(`Running audit for ${urlArg}…\n`)
  }

  try {
    const result = await runAudit(urlArg, { timeoutMs: timeout })

    if (outputFile) {
      writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8')
      if (!jsonFlag) console.log(`✓ JSON written to ${outputFile}`)
    }

    if (jsonFlag) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      printResult(result)
    }

    // Exit code 0 = success (audit completed, even if score is low)
    process.exit(0)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'UNKNOWN'
    const msg = err instanceof Error ? err.message : 'Unknown error'

    if (jsonFlag) {
      process.stdout.write(JSON.stringify({ error: true, code, message: msg }) + '\n')
    } else {
      console.error(`\nAudit failed [${code}]: ${msg}`)
      if (code === 'INVALID_URL') console.error('  → Provide a full URL including scheme: https://example.com')
      if (code === 'SSRF_BLOCKED') console.error('  → That URL resolves to a private/reserved address and cannot be audited.')
      if (code === 'UNREACHABLE') console.error('  → The website is unreachable. Check the URL is public.')
      if (code === 'TIMEOUT') console.error(`  → Request timed out. Try increasing --timeout (current: ${timeout}ms)`)
    }

    process.exit(1)
  }
}

main()
