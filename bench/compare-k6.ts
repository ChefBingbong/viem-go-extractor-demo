#!/usr/bin/env bun
/**
 * k6 Benchmark Comparison Script
 *
 * Parses k6 JSON summary files and generates:
 *   - bench/comparison-results/k6-comparison.md
 *   - bench/comparison-results/charts/k6-*.svg
 *   - bench/comparison-results/k6-comparison.json
 *
 * Usage:  bun run bench/compare-k6.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// ─── Paths ───────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(new URL(import.meta.url).pathname))
const RESULTS_DIR = resolve(ROOT, 'results')
const OUT_DIR = resolve(ROOT, 'comparison-results')
const CHARTS_DIR = resolve(OUT_DIR, 'charts')

const K6_FILES = {
  healthTs: resolve(RESULTS_DIR, 'k6-health-ts.json'),
  healthGo: resolve(RESULTS_DIR, 'k6-health-go.json'),
  insightsTs: resolve(RESULTS_DIR, 'k6-insights-ts.json'),
  insightsGo: resolve(RESULTS_DIR, 'k6-insights-go.json'),
  stressTs: resolve(RESULTS_DIR, 'k6-stress-ts.json'),
  stressGo: resolve(RESULTS_DIR, 'k6-stress-go.json'),
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface LatencyStats {
  avg: number
  min: number
  med: number
  max: number
  'p(90)': number
  'p(95)': number
  'p(99)': number
}

interface SuiteResult {
  name: string
  goLatency: LatencyStats | null
  tsLatency: LatencyStats | null
  goErrorRate: number | null
  tsErrorRate: number | null
  goReqs: number | null
  tsReqs: number | null
  goBytes: number | null
  tsBytes: number | null
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function extractMetric(data: any, metricName: string): LatencyStats | null {
  const m = data?.metrics?.[metricName]
  if (!m?.values) return null
  return m.values as LatencyStats
}

function extractRate(data: any, metricName: string): number | null {
  const m = data?.metrics?.[metricName]
  if (!m?.values) return null
  return m.values.rate ?? null
}

function extractCount(data: any, metricName: string): number | null {
  const m = data?.metrics?.[metricName]
  if (!m?.values) return null
  return m.values.count ?? m.values.value ?? null
}

function loadJson(path: string): any | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

// Each k6 script now runs against a single service, so metric names
// are unprefixed: health_latency, insights_latency, stress_latency, etc.

function parseSuite(
  name: string,
  tsFile: string,
  goFile: string,
  latencyMetric: string,
  errorsMetric: string,
  reqsMetric: string,
  bytesMetric: string | null,
): SuiteResult | null {
  const tsData = loadJson(tsFile)
  const goData = loadJson(goFile)
  if (!tsData && !goData) return null
  return {
    name,
    goLatency: goData ? extractMetric(goData, latencyMetric) : null,
    tsLatency: tsData ? extractMetric(tsData, latencyMetric) : null,
    goErrorRate: goData ? extractRate(goData, errorsMetric) : null,
    tsErrorRate: tsData ? extractRate(tsData, errorsMetric) : null,
    goReqs: goData ? extractCount(goData, reqsMetric) : null,
    tsReqs: tsData ? extractCount(tsData, reqsMetric) : null,
    goBytes: goData && bytesMetric ? extractCount(goData, bytesMetric) : null,
    tsBytes: tsData && bytesMetric ? extractCount(tsData, bytesMetric) : null,
  }
}

function parseHealth(): SuiteResult | null {
  return parseSuite(
    '/health',
    K6_FILES.healthTs,
    K6_FILES.healthGo,
    'health_latency',
    'health_errors',
    'health_reqs',
    null,
  )
}

function parseInsights(): SuiteResult | null {
  return parseSuite(
    '/extractor-insights',
    K6_FILES.insightsTs,
    K6_FILES.insightsGo,
    'insights_latency',
    'insights_errors',
    'insights_reqs',
    'insights_bytes',
  )
}

function parseStress(): SuiteResult | null {
  return parseSuite(
    'Stress',
    K6_FILES.stressTs,
    K6_FILES.stressGo,
    'stress_latency',
    'stress_errors',
    'stress_total_requests',
    'stress_total_bytes',
  )
}

// ─── SVG Charts ──────────────────────────────────────────────────────────────

const COLORS = {
  go: '#00ADD8',
  ts: '#3178C6',
  grid: '#e5e7eb',
  text: '#374151',
  lightText: '#6b7280',
  bg: '#ffffff',
  border: '#d1d5db',
  error: '#ef4444',
}

function generatePercentileChart(opts: {
  title: string
  labels: string[]
  goValues: (number | null)[]
  tsValues: (number | null)[]
  unit: string
}): string {
  const { title, labels, goValues, tsValues, unit } = opts
  const W = 800
  const H = Math.max(350, labels.length * 60 + 120)
  const marginLeft = 100
  const marginRight = 130
  const marginTop = 60
  const marginBottom = 50
  const chartW = W - marginLeft - marginRight
  const chartH = H - marginTop - marginBottom

  const allVals = [...goValues, ...tsValues].filter(
    (v): v is number => v !== null && v > 0,
  )
  const maxVal = Math.max(...allVals, 1)
  const barGroupH = chartH / labels.length
  const barH = barGroupH * 0.3

  function scaleX(v: number | null): number {
    if (v === null || v <= 0) return 0
    return (v / maxVal) * chartW
  }

  function fmt(v: number | null): string {
    if (v === null) return 'N/A'
    if (v >= 1000) return `${(v / 1000).toFixed(1)}s`
    return `${v.toFixed(1)}${unit}`
  }

  const gridCount = 5
  let gridLines = ''
  for (let i = 0; i <= gridCount; i++) {
    const x = marginLeft + (i / gridCount) * chartW
    const val = (i / gridCount) * maxVal
    gridLines += `<line x1="${x}" y1="${marginTop}" x2="${x}" y2="${marginTop + chartH}" stroke="${COLORS.grid}" stroke-width="1"/>\n`
    gridLines += `<text x="${x}" y="${H - marginBottom + 20}" text-anchor="middle" fill="${COLORS.lightText}" font-size="11">${fmt(val)}</text>\n`
  }

  let bars = ''
  for (let i = 0; i < labels.length; i++) {
    const y = marginTop + i * barGroupH
    const gap = barGroupH * 0.1
    const goW = scaleX(goValues[i])
    const tsW = scaleX(tsValues[i])

    bars += `<text x="${marginLeft - 8}" y="${y + barGroupH / 2 + 4}" text-anchor="end" fill="${COLORS.text}" font-size="12">${labels[i]}</text>\n`

    if (goValues[i] !== null) {
      bars += `<rect x="${marginLeft}" y="${y + gap}" width="${Math.max(goW, 2)}" height="${barH}" rx="3" fill="${COLORS.go}" opacity="0.85"/>\n`
      bars += `<text x="${marginLeft + goW + 6}" y="${y + gap + barH / 2 + 4}" fill="${COLORS.go}" font-size="11" font-weight="600">${fmt(goValues[i])}</text>\n`
    }
    if (tsValues[i] !== null) {
      bars += `<rect x="${marginLeft}" y="${y + gap + barH + 2}" width="${Math.max(tsW, 2)}" height="${barH}" rx="3" fill="${COLORS.ts}" opacity="0.85"/>\n`
      bars += `<text x="${marginLeft + tsW + 6}" y="${y + gap + barH + 2 + barH / 2 + 4}" fill="${COLORS.ts}" font-size="11" font-weight="600">${fmt(tsValues[i])}</text>\n`
    }
  }

  const legendX = W - marginRight + 10
  const legend = `
    <rect x="${legendX}" y="${marginTop}" width="12" height="12" rx="2" fill="${COLORS.go}"/>
    <text x="${legendX + 18}" y="${marginTop + 11}" fill="${COLORS.text}" font-size="12">Go</text>
    <rect x="${legendX}" y="${marginTop + 22}" width="12" height="12" rx="2" fill="${COLORS.ts}"/>
    <text x="${legendX + 18}" y="${marginTop + 33}" fill="${COLORS.text}" font-size="12">TS</text>
  `

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <style>text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }</style>
  <rect width="${W}" height="${H}" fill="${COLORS.bg}" rx="8"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${COLORS.border}" rx="8"/>
  <text x="${W / 2}" y="35" text-anchor="middle" fill="${COLORS.text}" font-size="16" font-weight="700">${title}</text>
  ${gridLines}
  ${bars}
  ${legend}
</svg>`
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  mkdirSync(CHARTS_DIR, { recursive: true })

  const health = parseHealth()
  const insights = parseInsights()
  const stress = parseStress()

  const found: string[] = []
  const missing: string[] = []
  for (const [key, path] of Object.entries(K6_FILES)) {
    if (existsSync(path)) found.push(key)
    else missing.push(key)
  }

  if (found.length === 0) {
    console.error('No k6 result files found in bench/results/.')
    console.error('Run the k6 suites first: make k6-all')
    process.exit(1)
  }

  console.log(`Found k6 results: ${found.join(', ')}`)
  if (missing.length > 0)
    console.log(`Missing (skipped): ${missing.join(', ')}`)

  // ─── Generate charts ────────────────────────────────────────────

  const percentiles = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'] as const

  if (health) {
    writeFileSync(
      resolve(CHARTS_DIR, 'k6-health-latency.svg'),
      generatePercentileChart({
        title: '/health Latency Percentiles (ms) — lower is better',
        labels: [...percentiles],
        goValues: percentiles.map((p) => health.goLatency?.[p] ?? null),
        tsValues: percentiles.map((p) => health.tsLatency?.[p] ?? null),
        unit: 'ms',
      }),
    )
  }

  if (insights) {
    writeFileSync(
      resolve(CHARTS_DIR, 'k6-insights-latency.svg'),
      generatePercentileChart({
        title: '/extractor-insights Latency Percentiles (ms) — lower is better',
        labels: [...percentiles],
        goValues: percentiles.map((p) => insights.goLatency?.[p] ?? null),
        tsValues: percentiles.map((p) => insights.tsLatency?.[p] ?? null),
        unit: 'ms',
      }),
    )
  }

  if (stress) {
    writeFileSync(
      resolve(CHARTS_DIR, 'k6-stress-latency.svg'),
      generatePercentileChart({
        title: 'Stress Test Latency Percentiles (ms) — lower is better',
        labels: [...percentiles],
        goValues: percentiles.map((p) => stress.goLatency?.[p] ?? null),
        tsValues: percentiles.map((p) => stress.tsLatency?.[p] ?? null),
        unit: 'ms',
      }),
    )
  }

  // ─── Generate markdown ──────────────────────────────────────────

  function fmtMs(v: number | null): string {
    if (v === null) return 'N/A'
    if (v >= 1000) return `${(v / 1000).toFixed(2)}s`
    return `${v.toFixed(2)}ms`
  }

  function fmtRate(v: number | null): string {
    if (v === null) return 'N/A'
    return `${(v * 100).toFixed(2)}%`
  }

  function fmtCount(v: number | null): string {
    if (v === null) return 'N/A'
    return v.toLocaleString()
  }

  function fmtBytes(v: number | null): string {
    if (v === null) return 'N/A'
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)} GB`
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} MB`
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)} KB`
    return `${v} B`
  }

  function winner(goVal: number | null, tsVal: number | null): string {
    if (goVal === null || tsVal === null) return '-'
    if (Math.abs(goVal - tsVal) / Math.max(goVal, tsVal) < 0.05) return 'Tie'
    return goVal < tsVal ? '🟦 Go' : '🟪 TS'
  }

  function speedup(goVal: number | null, tsVal: number | null): string {
    if (goVal === null || tsVal === null) return '-'
    const ratio = Math.max(goVal, tsVal) / Math.min(goVal, tsVal)
    if (ratio < 1.05) return '~1.0x'
    const w = goVal < tsVal ? 'Go' : 'TS'
    return `${w} ${ratio.toFixed(1)}x`
  }

  let md = `# k6 API Load Test Comparison: Go vs TypeScript

> Generated: ${new Date().toISOString()}
> Pool limit: ?limit=1000 (equal data volume for both services)

---

`

  // Health section
  if (health) {
    md += `## /health — Lightweight Endpoint

![Health Latency](./charts/k6-health-latency.svg)

| Percentile | Go | TS | Winner | Speedup |
|------------|----|----|--------|---------|
`
    for (const p of percentiles) {
      const g = health.goLatency?.[p] ?? null
      const t = health.tsLatency?.[p] ?? null
      md += `| ${p} | ${fmtMs(g)} | ${fmtMs(t)} | ${winner(g, t)} | ${speedup(g, t)} |\n`
    }
    md += `
| Metric | Go | TS |
|--------|----|----|
| Total requests | ${fmtCount(health.goReqs)} | ${fmtCount(health.tsReqs)} |
| Error rate | ${fmtRate(health.goErrorRate)} | ${fmtRate(health.tsErrorRate)} |

`
  }

  // Insights section
  if (insights) {
    md += `## /extractor-insights — Heavy Endpoint (serializes pools)

![Insights Latency](./charts/k6-insights-latency.svg)

| Percentile | Go | TS | Winner | Speedup |
|------------|----|----|--------|---------|
`
    for (const p of percentiles) {
      const g = insights.goLatency?.[p] ?? null
      const t = insights.tsLatency?.[p] ?? null
      md += `| ${p} | ${fmtMs(g)} | ${fmtMs(t)} | ${winner(g, t)} | ${speedup(g, t)} |\n`
    }
    md += `
| Metric | Go | TS |
|--------|----|----|
| Total requests | ${fmtCount(insights.goReqs)} | ${fmtCount(insights.tsReqs)} |
| Total bytes transferred | ${fmtBytes(insights.goBytes)} | ${fmtBytes(insights.tsBytes)} |
| Error rate | ${fmtRate(insights.goErrorRate)} | ${fmtRate(insights.tsErrorRate)} |

`
  }

  // Stress section
  if (stress) {
    md += `## Stress Test — High Concurrency (50 steady → 200 spike VUs)

![Stress Latency](./charts/k6-stress-latency.svg)

| Percentile | Go | TS | Winner | Speedup |
|------------|----|----|--------|---------|
`
    for (const p of percentiles) {
      const g = stress.goLatency?.[p] ?? null
      const t = stress.tsLatency?.[p] ?? null
      md += `| ${p} | ${fmtMs(g)} | ${fmtMs(t)} | ${winner(g, t)} | ${speedup(g, t)} |\n`
    }
    md += `
| Metric | Go | TS |
|--------|----|----|
| Total requests | ${fmtCount(stress.goReqs)} | ${fmtCount(stress.tsReqs)} |
| Total bytes | ${fmtBytes(stress.goBytes)} | ${fmtBytes(stress.tsBytes)} |
| Error rate | ${fmtRate(stress.goErrorRate)} | ${fmtRate(stress.tsErrorRate)} |

`
  }

  // ─── Overall Summary ────────────────────────────────────────────

  md += `---

## Overall Summary

`

  const allComparisons: {
    suite: string
    p95Go: number | null
    p95Ts: number | null
  }[] = []
  if (health)
    allComparisons.push({
      suite: '/health',
      p95Go: health.goLatency?.['p(95)'] ?? null,
      p95Ts: health.tsLatency?.['p(95)'] ?? null,
    })
  if (insights)
    allComparisons.push({
      suite: '/insights',
      p95Go: insights.goLatency?.['p(95)'] ?? null,
      p95Ts: insights.tsLatency?.['p(95)'] ?? null,
    })
  if (stress)
    allComparisons.push({
      suite: 'Stress',
      p95Go: stress.goLatency?.['p(95)'] ?? null,
      p95Ts: stress.tsLatency?.['p(95)'] ?? null,
    })

  md += `| Suite | Go p95 | TS p95 | Winner | Speedup |
|-------|--------|--------|--------|---------|
`
  let goWins = 0
  let tsWins = 0
  for (const c of allComparisons) {
    const w = winner(c.p95Go, c.p95Ts)
    if (w.includes('Go')) goWins++
    else if (w.includes('TS')) tsWins++
    md += `| ${c.suite} | ${fmtMs(c.p95Go)} | ${fmtMs(c.p95Ts)} | ${w} | ${speedup(c.p95Go, c.p95Ts)} |\n`
  }

  const overall =
    goWins > tsWins ? 'Go' : goWins < tsWins ? 'TypeScript' : 'Tied'
  md += `\n**Overall API winner (by p95)**: **${overall}** (Go: ${goWins}, TS: ${tsWins})\n`

  md += `
---

*Generated by \`bench/compare-k6.ts\` — run \`make k6-compare\` to regenerate.*
`

  // ─── Write outputs ──────────────────────────────────────────────

  writeFileSync(resolve(OUT_DIR, 'k6-comparison.md'), md)
  writeFileSync(
    resolve(OUT_DIR, 'k6-comparison.json'),
    JSON.stringify(
      { health, insights, stress, summary: { goWins, tsWins, overall } },
      null,
      2,
    ),
  )

  // ─── Console summary ───────────────────────────────────────────

  console.log('\n' + '='.repeat(60))
  console.log('  k6 API LOAD TEST COMPARISON')
  console.log('='.repeat(60))
  for (const c of allComparisons) {
    const w = winner(c.p95Go, c.p95Ts)
    console.log(
      `  ${c.suite.padEnd(20)} Go p95=${fmtMs(c.p95Go).padEnd(10)} TS p95=${fmtMs(c.p95Ts).padEnd(10)} ${w}`,
    )
  }
  console.log(`\n  Overall: ${overall}`)
  console.log(`\n  Output:`)
  console.log(`    ${resolve(OUT_DIR, 'k6-comparison.md')}`)
  console.log(`    ${CHARTS_DIR}/k6-*.svg`)
  console.log('')
}

main()
