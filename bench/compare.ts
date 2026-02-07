#!/usr/bin/env bun
/**
 * Benchmark Comparison Script
 *
 * Parses Go benchmark output (bench/results/go-bench.txt) and
 * TypeScript results (bench/results/ts-results.json), then generates:
 *   - bench/comparison-results/comparison.md    (full markdown report)
 *   - bench/comparison-results/charts/*.svg     (SVG bar charts)
 *   - bench/comparison-results/comparison.json  (raw comparison data)
 *
 * Usage:  bun run bench/compare.ts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// ─── Paths ───────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(new URL(import.meta.url).pathname))
const GO_BENCH_PATH = resolve(ROOT, 'results/go-bench.txt')
const TS_RESULTS_PATH = resolve(ROOT, 'results/ts-results.json')
const OUT_DIR = resolve(ROOT, 'comparison-results')
const CHARTS_DIR = resolve(OUT_DIR, 'charts')

// ─── Types ───────────────────────────────────────────────────────────────────

interface GoBenchEntry {
  name: string
  iterations: number
  nsPerOp: number
  bytesPerOp: number
  allocsPerOp: number
  msPerOp: number
}

interface TsBenchEntry {
  name: string
  runs: number
  iterations: number
  avgNsPerOp: number
  avgMsPerOp: number
  minNsPerOp: number
  maxNsPerOp: number
  opsPerSec: number
  heapMB: number
}

interface ComparisonRow {
  category: string
  benchmark: string
  goAvgMs: number
  tsAvgMs: number
  winner: 'Go' | 'TypeScript' | 'Tie'
  speedup: string
  goAllocsPerOp: number
  goBytesPerOp: number
  tsHeapMB: number
}

interface GoMemoryEntry {
  poolCount: number
  memoryMB: number
  kbPerPool: number
}

// ─── Parse Go Benchmark Output ──────────────────────────────────────────────

function parseGoBench(raw: string): { benches: GoBenchEntry[]; memory: GoMemoryEntry[]; cpu: string } {
  const benches: GoBenchEntry[] = []
  const memory: GoMemoryEntry[] = []
  let cpu = 'unknown'

  const cpuMatch = raw.match(/cpu:\s+(.+)/)
  if (cpuMatch) cpu = cpuMatch[1].trim()

  // Parse benchmark lines: BenchmarkName-N  <iters>  <ns/op>  <B/op>  <allocs/op>
  const benchRe = /^(Benchmark\S+)-\d+\s+(\d+)\s+([\d.]+)\s+ns\/op\s+([\d.]+)\s+B\/op\s+(\d+)\s+allocs\/op$/gm
  let m: RegExpExecArray | null
  while ((m = benchRe.exec(raw)) !== null) {
    benches.push({
      name: m[1],
      iterations: Number.parseInt(m[2]),
      nsPerOp: Number.parseFloat(m[3]),
      bytesPerOp: Number.parseFloat(m[4]),
      allocsPerOp: Number.parseInt(m[5]),
      msPerOp: Number.parseFloat(m[3]) / 1_000_000,
    })
  }

  // Parse memory test output
  const memRe = /Memory for ([\d,]+) pools: ([\d.]+) MB/g
  while ((m = memRe.exec(raw)) !== null) {
    const count = Number.parseInt(m[1].replace(/,/g, ''))
    const mb = Number.parseFloat(m[2])
    memory.push({ poolCount: count, memoryMB: mb, kbPerPool: (mb * 1024) / count })
  }

  return { benches, memory, cpu }
}

// Average multiple runs of the same benchmark
function averageGoRuns(entries: GoBenchEntry[]): Map<string, GoBenchEntry> {
  const groups = new Map<string, GoBenchEntry[]>()
  for (const e of entries) {
    const arr = groups.get(e.name) ?? []
    arr.push(e)
    groups.set(e.name, arr)
  }

  const result = new Map<string, GoBenchEntry>()
  for (const [name, runs] of groups) {
    const avg: GoBenchEntry = {
      name,
      iterations: Math.round(runs.reduce((s, r) => s + r.iterations, 0) / runs.length),
      nsPerOp: runs.reduce((s, r) => s + r.nsPerOp, 0) / runs.length,
      bytesPerOp: runs.reduce((s, r) => s + r.bytesPerOp, 0) / runs.length,
      allocsPerOp: Math.round(runs.reduce((s, r) => s + r.allocsPerOp, 0) / runs.length),
      msPerOp: runs.reduce((s, r) => s + r.msPerOp, 0) / runs.length,
    }
    result.set(name, avg)
  }
  return result
}

// ─── Match Go benchmarks to TS benchmarks ───────────────────────────────────

interface MatchedPair {
  category: string
  label: string
  goName: string
  tsName: string
}

const MATCHES: MatchedPair[] = [
  { category: 'Multicall', label: 'Single getReserves', goName: 'BenchmarkMulticallSingle', tsName: 'multicall: single getReserves' },
  { category: 'Multicall', label: 'Batch 10', goName: 'BenchmarkMulticallBatch/batch_10', tsName: 'multicall: batch 10 getReserves' },
  { category: 'Multicall', label: 'Batch 50', goName: 'BenchmarkMulticallBatch/batch_50', tsName: 'multicall: batch 50 getReserves' },
  { category: 'Multicall', label: 'Batch 100', goName: 'BenchmarkMulticallBatch/batch_100', tsName: 'multicall: batch 100 getReserves' },
  { category: 'Multicall', label: 'Batch 200', goName: 'BenchmarkMulticallBatch/batch_200', tsName: 'multicall: batch 200 getReserves' },
  { category: 'Event Decoding', label: 'Single Sync decode', goName: 'BenchmarkDecodeSyncEvent', tsName: 'decodeEventLog: single Sync event' },
  { category: 'Event Decoding', label: 'Batch 1000 Sync decode', goName: 'BenchmarkDecodeSyncEventBatch', tsName: 'decodeEventLog: batch 1000 Sync events' },
  { category: 'Factory Sync', label: 'Chunk 50', goName: 'BenchmarkFactorySyncChunks/chunk_50', tsName: 'factory sync: chunk 50 (addrs+info)' },
  { category: 'Factory Sync', label: 'Chunk 100', goName: 'BenchmarkFactorySyncChunks/chunk_100', tsName: 'factory sync: chunk 100 (addrs+info)' },
  { category: 'Factory Sync', label: 'Chunk 500', goName: 'BenchmarkFactorySyncChunks/chunk_500', tsName: 'factory sync: chunk 500 (addrs+info)' },
  { category: 'JSON Serialization', label: '100 pools', goName: 'BenchmarkPoolSerializationJSON/pools_100', tsName: 'JSON.stringify: 100 pools' },
  { category: 'JSON Serialization', label: '1,000 pools', goName: 'BenchmarkPoolSerializationJSON/pools_1000', tsName: 'JSON.stringify: 1000 pools' },
  { category: 'JSON Serialization', label: '5,000 pools', goName: 'BenchmarkPoolSerializationJSON/pools_5000', tsName: 'JSON.stringify: 5000 pools' },
  { category: 'JSON Serialization', label: '10,000 pools', goName: 'BenchmarkPoolSerializationJSON/pools_10000', tsName: 'JSON.stringify: 10000 pools' },
]

// ─── SVG Chart Generation ───────────────────────────────────────────────────

const COLORS = {
  go: '#00ADD8',      // Go blue
  ts: '#3178C6',      // TypeScript blue
  goBg: '#00ADD820',
  tsBg: '#3178C620',
  grid: '#e5e7eb',
  text: '#374151',
  lightText: '#6b7280',
  bg: '#ffffff',
  border: '#d1d5db',
}

function generateBarChart(opts: {
  title: string
  labels: string[]
  goValues: number[]
  tsValues: number[]
  unit: string
  width?: number
  height?: number
  logScale?: boolean
}): string {
  const { title, labels, goValues, tsValues, unit, logScale } = opts
  const W = opts.width ?? 800
  const H = opts.height ?? Math.max(400, labels.length * 60 + 120)

  const marginLeft = 140
  const marginRight = 120
  const marginTop = 60
  const marginBottom = 50
  const chartW = W - marginLeft - marginRight
  const chartH = H - marginTop - marginBottom

  const allVals = [...goValues, ...tsValues].filter((v) => v > 0)
  const rawMax = Math.max(...allVals, 1)
  const maxVal = logScale ? Math.log10(rawMax + 1) : rawMax
  const barGroupH = chartH / labels.length
  const barH = barGroupH * 0.3
  const gap = barGroupH * 0.1

  function scaleX(v: number): number {
    const val = logScale ? Math.log10(v + 1) : v
    return (val / maxVal) * chartW
  }

  function fmt(v: number): string {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
    if (v >= 1) return v.toFixed(1)
    if (v >= 0.001) return v.toFixed(3)
    return v.toFixed(6)
  }

  // Grid lines
  const gridCount = 5
  let gridLines = ''
  for (let i = 0; i <= gridCount; i++) {
    const x = marginLeft + (i / gridCount) * chartW
    const rawVal = logScale
      ? Math.pow(10, (i / gridCount) * maxVal) - 1
      : (i / gridCount) * rawMax
    gridLines += `<line x1="${x}" y1="${marginTop}" x2="${x}" y2="${marginTop + chartH}" stroke="${COLORS.grid}" stroke-width="1"/>\n`
    gridLines += `<text x="${x}" y="${H - marginBottom + 20}" text-anchor="middle" fill="${COLORS.lightText}" font-size="11">${fmt(rawVal)}</text>\n`
  }

  // Bars
  let bars = ''
  for (let i = 0; i < labels.length; i++) {
    const y = marginTop + i * barGroupH
    const goW = scaleX(goValues[i])
    const tsW = scaleX(tsValues[i])

    // Label
    bars += `<text x="${marginLeft - 8}" y="${y + barGroupH / 2 + 4}" text-anchor="end" fill="${COLORS.text}" font-size="12">${labels[i]}</text>\n`

    // Go bar
    bars += `<rect x="${marginLeft}" y="${y + gap}" width="${Math.max(goW, 2)}" height="${barH}" rx="3" fill="${COLORS.go}" opacity="0.85"/>\n`
    bars += `<text x="${marginLeft + goW + 6}" y="${y + gap + barH / 2 + 4}" fill="${COLORS.go}" font-size="11" font-weight="600">${fmt(goValues[i])} ${unit}</text>\n`

    // TS bar
    bars += `<rect x="${marginLeft}" y="${y + gap + barH + 2}" width="${Math.max(tsW, 2)}" height="${barH}" rx="3" fill="${COLORS.ts}" opacity="0.85"/>\n`
    bars += `<text x="${marginLeft + tsW + 6}" y="${y + gap + barH + 2 + barH / 2 + 4}" fill="${COLORS.ts}" font-size="11" font-weight="600">${fmt(tsValues[i])} ${unit}</text>\n`
  }

  // Legend
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
  ${logScale ? `<text x="${W / 2}" y="52" text-anchor="middle" fill="${COLORS.lightText}" font-size="11">(log scale)</text>` : ''}
  ${gridLines}
  ${bars}
  ${legend}
</svg>`
}

function generateWinnerChart(rows: ComparisonRow[]): string {
  const goWins = rows.filter((r) => r.winner === 'Go').length
  const tsWins = rows.filter((r) => r.winner === 'TypeScript').length
  const ties = rows.filter((r) => r.winner === 'Tie').length
  const total = rows.length

  const W = 500
  const H = 300
  const cx = W / 2
  const cy = H / 2 + 10
  const r = 100

  function arc(startAngle: number, endAngle: number, color: string, label: string, count: number): string {
    if (count === 0) return ''
    const start = { x: cx + r * Math.cos(startAngle), y: cy + r * Math.sin(startAngle) }
    const end = { x: cx + r * Math.cos(endAngle), y: cy + r * Math.sin(endAngle) }
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
    const midAngle = (startAngle + endAngle) / 2
    const labelR = r + 30
    const lx = cx + labelR * Math.cos(midAngle)
    const ly = cy + labelR * Math.sin(midAngle)

    return `
      <path d="M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z" fill="${color}" opacity="0.85"/>
      <text x="${lx}" y="${ly + 4}" text-anchor="middle" fill="${color}" font-size="13" font-weight="700">${label} (${count})</text>
    `
  }

  const goAngle = (goWins / total) * 2 * Math.PI
  const tsAngle = (tsWins / total) * 2 * Math.PI
  const startGo = -Math.PI / 2
  const startTs = startGo + goAngle
  const startTie = startTs + tsAngle

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <style>text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }</style>
  <rect width="${W}" height="${H}" fill="${COLORS.bg}" rx="8"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${COLORS.border}" rx="8"/>
  <text x="${cx}" y="30" text-anchor="middle" fill="${COLORS.text}" font-size="16" font-weight="700">Overall Winner Breakdown</text>
  ${arc(startGo, startTs, COLORS.go, 'Go', goWins)}
  ${arc(startTs, startTie, COLORS.ts, 'TypeScript', tsWins)}
  ${ties > 0 ? arc(startTie, startGo + 2 * Math.PI, '#9ca3af', 'Tie', ties) : ''}
  <text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="${COLORS.text}" font-size="20" font-weight="800">${total}</text>
  <text x="${cx}" y="${cy + 22}" text-anchor="middle" fill="${COLORS.lightText}" font-size="11">benchmarks</text>
</svg>`
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  // Check inputs exist
  if (!existsSync(GO_BENCH_PATH)) {
    console.error(`Go bench results not found: ${GO_BENCH_PATH}`)
    console.error('Run "make bench-go" first.')
    process.exit(1)
  }
  if (!existsSync(TS_RESULTS_PATH)) {
    console.error(`TS bench results not found: ${TS_RESULTS_PATH}`)
    console.error('Run "make bench-ts" first.')
    process.exit(1)
  }

  // Parse
  const goRaw = readFileSync(GO_BENCH_PATH, 'utf-8')
  const tsResults: TsBenchEntry[] = JSON.parse(readFileSync(TS_RESULTS_PATH, 'utf-8'))
  const { benches: goBenches, memory: goMemory, cpu } = parseGoBench(goRaw)
  const goAvg = averageGoRuns(goBenches)
  const tsMap = new Map<string, TsBenchEntry>()
  for (const e of tsResults) tsMap.set(e.name, e)

  // Build comparison rows
  const rows: ComparisonRow[] = []
  for (const match of MATCHES) {
    const go = goAvg.get(match.goName)
    const ts = tsMap.get(match.tsName)
    if (!go || !ts) continue

    const goMs = go.msPerOp
    const tsMs = ts.avgMsPerOp
    const ratio = goMs > 0 && tsMs > 0 ? Math.max(goMs, tsMs) / Math.min(goMs, tsMs) : 1
    const winner: 'Go' | 'TypeScript' | 'Tie' = Math.abs(goMs - tsMs) / Math.max(goMs, tsMs) < 0.05
      ? 'Tie'
      : goMs < tsMs ? 'Go' : 'TypeScript'
    const speedup = winner === 'Tie' ? '~1.0x' : `${ratio.toFixed(1)}x`

    rows.push({
      category: match.category,
      benchmark: match.label,
      goAvgMs: goMs,
      tsAvgMs: tsMs,
      winner,
      speedup: `${winner === 'Tie' ? '' : winner + ' '}${speedup}`,
      goAllocsPerOp: go.allocsPerOp,
      goBytesPerOp: go.bytesPerOp,
      tsHeapMB: ts.heapMB,
    })
  }

  // Create output dirs
  mkdirSync(CHARTS_DIR, { recursive: true })

  // ─── Generate Charts ────────────────────────────────────────────────

  // 1. Multicall latency chart
  const multicallRows = rows.filter((r) => r.category === 'Multicall')
  writeFileSync(
    resolve(CHARTS_DIR, 'multicall-latency.svg'),
    generateBarChart({
      title: 'Multicall Latency (ms) — lower is better',
      labels: multicallRows.map((r) => r.benchmark),
      goValues: multicallRows.map((r) => r.goAvgMs),
      tsValues: multicallRows.map((r) => r.tsAvgMs),
      unit: 'ms',
    }),
  )

  // 2. Event decoding chart
  const decodeRows = rows.filter((r) => r.category === 'Event Decoding')
  writeFileSync(
    resolve(CHARTS_DIR, 'event-decoding.svg'),
    generateBarChart({
      title: 'Event Decoding Latency (ms) — lower is better',
      labels: decodeRows.map((r) => r.benchmark),
      goValues: decodeRows.map((r) => r.goAvgMs),
      tsValues: decodeRows.map((r) => r.tsAvgMs),
      unit: 'ms',
      logScale: true,
    }),
  )

  // 3. Factory sync chart
  const syncRows = rows.filter((r) => r.category === 'Factory Sync')
  writeFileSync(
    resolve(CHARTS_DIR, 'factory-sync.svg'),
    generateBarChart({
      title: 'Factory Sync Latency (ms) — lower is better',
      labels: syncRows.map((r) => r.benchmark),
      goValues: syncRows.map((r) => r.goAvgMs),
      tsValues: syncRows.map((r) => r.tsAvgMs),
      unit: 'ms',
    }),
  )

  // 4. JSON serialization chart
  const jsonRows = rows.filter((r) => r.category === 'JSON Serialization')
  writeFileSync(
    resolve(CHARTS_DIR, 'json-serialization.svg'),
    generateBarChart({
      title: 'JSON Serialization Latency (ms) — lower is better',
      labels: jsonRows.map((r) => r.benchmark),
      goValues: jsonRows.map((r) => r.goAvgMs),
      tsValues: jsonRows.map((r) => r.tsAvgMs),
      unit: 'ms',
      logScale: true,
    }),
  )

  // 5. Winner pie chart
  writeFileSync(resolve(CHARTS_DIR, 'winner-breakdown.svg'), generateWinnerChart(rows))

  // ─── Generate Markdown Report ───────────────────────────────────────

  const goWins = rows.filter((r) => r.winner === 'Go').length
  const tsWins = rows.filter((r) => r.winner === 'TypeScript').length
  const ties = rows.filter((r) => r.winner === 'Tie').length
  const overallWinner = goWins > tsWins ? 'Go (viem-go)' : goWins < tsWins ? 'TypeScript (viem)' : 'Tied'

  function fmtMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
    if (ms >= 1) return `${ms.toFixed(2)}ms`
    if (ms >= 0.001) return `${(ms * 1000).toFixed(1)}us`
    return `${(ms * 1_000_000).toFixed(0)}ns`
  }

  function winnerEmoji(w: string): string {
    if (w === 'Go') return '🟦'
    if (w === 'TypeScript') return '🟪'
    return '⬜'
  }

  let md = `# Benchmark Comparison: Go (viem-go) vs TypeScript (viem)

> Generated: ${new Date().toISOString()}
> CPU: ${cpu}
> Go benchmarks: 3 runs averaged | TS benchmarks: variable iterations

---

## Overall Summary

| Metric | Value |
|--------|-------|
| **Overall Winner** | **${overallWinner}** |
| Go wins | ${goWins} / ${rows.length} |
| TypeScript wins | ${tsWins} / ${rows.length} |
| Ties (<5% diff) | ${ties} / ${rows.length} |

![Winner Breakdown](./charts/winner-breakdown.svg)

---

## Detailed Results

`

  // Category -> chart filename mapping (must match the filenames written above)
  const chartFileMap: Record<string, string> = {
    'Multicall': 'multicall-latency',
    'Event Decoding': 'event-decoding',
    'Factory Sync': 'factory-sync',
    'JSON Serialization': 'json-serialization',
  }

  // Group by category
  const categories = [...new Set(rows.map((r) => r.category))]
  for (const cat of categories) {
    const catRows = rows.filter((r) => r.category === cat)
    const chartFile = chartFileMap[cat] ?? cat.toLowerCase().replace(/\s+/g, '-')

    md += `### ${cat}

![${cat}](./charts/${chartFile}.svg)

| Benchmark | Go (avg) | TS (avg) | Winner | Speedup | Go allocs/op | Go B/op |
|-----------|----------|----------|--------|---------|-------------|---------|
`
    for (const r of catRows) {
      md += `| ${r.benchmark} | ${fmtMs(r.goAvgMs)} | ${fmtMs(r.tsAvgMs)} | ${winnerEmoji(r.winner)} ${r.winner} | ${r.speedup} | ${r.goAllocsPerOp.toLocaleString()} | ${Math.round(r.goBytesPerOp).toLocaleString()} B |\n`
    }
    md += '\n'
  }

  // ─── Analysis Section ─────────────────────────────────────────────

  md += `---

## In-Depth Analysis

### 1. RPC / Multicall Performance

`

  const singleGo = rows.find((r) => r.benchmark === 'Single getReserves')
  const singleTs = rows.find((r) => r.benchmark === 'Single getReserves')
  const batch200Go = rows.find((r) => r.benchmark === 'Batch 200')

  if (singleGo && batch200Go) {
    const goScaling = batch200Go.goAvgMs / singleGo.goAvgMs
    const tsScaling = batch200Go.tsAvgMs / (singleTs?.tsAvgMs ?? 1)
    md += `Both implementations use multicall to batch on-chain reads into single RPC calls.

- **Single call latency**: Go ${fmtMs(singleGo.goAvgMs)} vs TS ${fmtMs(singleGo.tsAvgMs)}
- **Batch 200 latency**: Go ${fmtMs(batch200Go.goAvgMs)} vs TS ${fmtMs(batch200Go.tsAvgMs)}
- **Scaling factor (1 -> 200)**: Go ${goScaling.toFixed(1)}x vs TS ${tsScaling.toFixed(1)}x increase

`
    if (singleGo.goAvgMs > singleGo.tsAvgMs) {
      md += `TypeScript's viem client has lower single-call latency, likely due to Bun's optimized HTTP stack and viem's efficient request batching. `
    } else {
      md += `Go's viem-go client has lower single-call latency, benefiting from Go's lightweight goroutine scheduling and efficient net/http stack. `
    }
    md += `As batch sizes increase, both scale sub-linearly thanks to multicall aggregation.\n\n`
  }

  md += `### 2. Event Decoding Throughput

`

  const decodeSingle = rows.find((r) => r.benchmark === 'Single Sync decode')
  const decodeBatch = rows.find((r) => r.benchmark === 'Batch 1000 Sync decode')

  if (decodeSingle && decodeBatch) {
    const goOpsPerSec = Math.round(1000 / decodeSingle.goAvgMs)
    const tsOpsPerSec = Math.round(1000 / decodeSingle.tsAvgMs)
    md += `Event decoding is a pure CPU-bound operation (no RPC) — this is where language runtime differences show most clearly.

- **Go**: ${fmtMs(decodeSingle.goAvgMs)}/event (${goOpsPerSec.toLocaleString()} ops/sec) — ${decodeSingle.goAllocsPerOp} allocs/op, ${decodeSingle.goBytesPerOp.toLocaleString()} B/op
- **TS**: ${fmtMs(decodeSingle.tsAvgMs)}/event (${tsOpsPerSec.toLocaleString()} ops/sec)

`
    if (decodeSingle.goAvgMs < decodeSingle.tsAvgMs) {
      const factor = decodeSingle.tsAvgMs / decodeSingle.goAvgMs
      md += `Go's decode is **${factor.toFixed(1)}x faster** per event. Go's \`DecodeSyncEvent\` does raw byte slicing on the hex data, while viem's \`decodeEventLog\` performs full ABI resolution.\n\n`
    } else {
      const factor = decodeSingle.goAvgMs / decodeSingle.tsAvgMs
      md += `TypeScript's decode is **${factor.toFixed(1)}x faster** per event. Bun's JIT-optimized V8 engine handles viem's \`decodeEventLog\` very efficiently.\n\n`
    }
  }

  md += `### 3. Factory Sync (On-Chain Data at Scale)

`

  const sync500 = rows.find((r) => r.benchmark === 'Chunk 500')
  const sync50 = rows.find((r) => r.benchmark === 'Chunk 50')

  if (sync500 && sync50) {
    md += `Factory sync simulates the real-world workload: fetching pair addresses, then batching token0/token1/getReserves calls for all of them. This tests the full pipeline including RPC I/O, response parsing, and multicall encoding.

- **50 pools**: Go ${fmtMs(sync50.goAvgMs)} vs TS ${fmtMs(sync50.tsAvgMs)}
- **500 pools**: Go ${fmtMs(sync500.goAvgMs)} vs TS ${fmtMs(sync500.tsAvgMs)}

`
    if (sync500.goAvgMs < sync500.tsAvgMs) {
      md += `At 500 pools, Go is **${(sync500.tsAvgMs / sync500.goAvgMs).toFixed(1)}x faster**. `
    } else {
      md += `At 500 pools, TypeScript is **${(sync500.goAvgMs / sync500.tsAvgMs).toFixed(1)}x faster**. `
    }
    md += `This is the most representative benchmark for comparing how each version handles extreme on-chain data lookups, as it mirrors the actual \`syncFactoryStreaming\` hot path.\n\n`
  }

  md += `### 4. JSON Serialization (API Response Performance)

`

  const json10k = rows.find((r) => r.benchmark === '10,000 pools')
  const json100 = rows.find((r) => r.benchmark === '100 pools')

  if (json10k && json100) {
    md += `The \`/extractor-insights\` endpoint serializes the entire pool map to JSON. This directly impacts API response time under load.

- **100 pools**: Go ${fmtMs(json100.goAvgMs)} vs TS ${fmtMs(json100.tsAvgMs)}
- **10,000 pools**: Go ${fmtMs(json10k.goAvgMs)} vs TS ${fmtMs(json10k.tsAvgMs)}

`
    if (json10k.goAvgMs < json10k.tsAvgMs) {
      md += `Go's \`encoding/json\` is **${(json10k.tsAvgMs / json10k.goAvgMs).toFixed(1)}x faster** at 10k pools. `
    } else {
      md += `Bun's \`JSON.stringify\` is **${(json10k.goAvgMs / json10k.tsAvgMs).toFixed(1)}x faster** at 10k pools. `
    }
    md += `At this scale the serialization cost becomes a significant portion of API latency — consider streaming JSON or pagination if pool counts grow much further.\n\n`
  }

  // ─── Memory Section ─────────────────────────────────────────────

  md += `### 5. Memory Usage

`

  if (goMemory.length > 0) {
    const goMem = goMemory[0]
    md += `**Go**: ${goMem.memoryMB.toFixed(2)} MB for ${goMem.poolCount.toLocaleString()} pools (~${goMem.kbPerPool.toFixed(2)} KB/pool)\n`
  }

  // Check TS memory from the last result entry
  const tsMemEntry = tsResults[tsResults.length - 1]
  if (tsMemEntry) {
    md += `**TypeScript**: ${tsMemEntry.heapMB.toFixed(2)} MB heap at end of benchmark run\n`
  }

  md += `
> **Note**: Memory comparisons are approximate. Go reports heap allocations via \`runtime.MemStats\`, while TS reports \`process.memoryUsage().heapUsed\`. The TS number includes all benchmark overhead in the same process.

`

  // ─── Conclusion ─────────────────────────────────────────────────

  md += `---

## Conclusion

| Category | Winner | Margin |
|----------|--------|--------|
`
  for (const cat of categories) {
    const catRows = rows.filter((r) => r.category === cat)
    const catGoWins = catRows.filter((r) => r.winner === 'Go').length
    const catTsWins = catRows.filter((r) => r.winner === 'TypeScript').length
    const catWinner = catGoWins > catTsWins ? 'Go' : catGoWins < catTsWins ? 'TypeScript' : 'Mixed'
    const margin = catGoWins === catTsWins ? '-' : `${Math.max(catGoWins, catTsWins)}/${catRows.length} benchmarks`
    md += `| ${cat} | ${winnerEmoji(catWinner)} ${catWinner} | ${margin} |\n`
  }

  md += `
### Key Takeaways

`

  if (goWins > tsWins) {
    md += `1. **Go (viem-go) wins ${goWins}/${rows.length} benchmarks overall.** Go's advantages come from its compiled nature, lower GC overhead, and efficient memory allocation patterns.
2. **TypeScript (viem) wins ${tsWins}/${rows.length} benchmarks.** Bun's JIT compilation and viem's mature, well-optimized API make it competitive, especially for I/O-bound multicall operations.
3. **For production use**: If your bottleneck is on-chain data throughput (syncing thousands of pools), Go has a meaningful edge. If your bottleneck is API latency at moderate pool counts, both are equally capable.
`
  } else if (tsWins > goWins) {
    md += `1. **TypeScript (viem) wins ${tsWins}/${rows.length} benchmarks overall.** Bun's V8 JIT, viem's mature HTTP batching, and efficient JSON handling give it a strong showing.
2. **Go (viem-go) wins ${goWins}/${rows.length} benchmarks.** Go's advantages are most apparent in CPU-bound operations (event decoding) and memory-efficient data structures.
3. **For production use**: TypeScript's viem library is the more mature option with excellent performance. Go's viem-go is competitive and offers advantages in memory-constrained or high-concurrency scenarios.
`
  } else {
    md += `1. **Both implementations are remarkably close in overall performance** — each winning ${goWins}/${rows.length} benchmarks.
2. **Go excels** at CPU-bound work (event decoding, serialization) with lower allocations and predictable GC behavior.
3. **TypeScript excels** at I/O-bound work (RPC calls) where Bun's async I/O and viem's batching shine.
`
  }

  md += `
---

*Generated by \`bench/compare.ts\` — run \`make bench-compare\` to regenerate.*
`

  // ─── Write outputs ──────────────────────────────────────────────

  writeFileSync(resolve(OUT_DIR, 'comparison.md'), md)
  writeFileSync(resolve(OUT_DIR, 'comparison.json'), JSON.stringify({ cpu, rows, goMemory, summary: { goWins, tsWins, ties, overallWinner } }, null, 2))

  // ─── Console summary ───────────────────────────────────────────

  console.log('\n' + '='.repeat(70))
  console.log('  BENCHMARK COMPARISON: Go (viem-go) vs TypeScript (viem)')
  console.log('='.repeat(70))
  console.log(`\n  CPU: ${cpu}`)
  console.log(`  Benchmarks compared: ${rows.length}`)
  console.log(`  Go wins: ${goWins}  |  TS wins: ${tsWins}  |  Ties: ${ties}`)
  console.log(`  Overall: ${overallWinner}\n`)

  console.log('  ' + '-'.repeat(66))
  console.log(`  ${'Benchmark'.padEnd(30)} ${'Go'.padEnd(12)} ${'TS'.padEnd(12)} Winner`)
  console.log('  ' + '-'.repeat(66))
  for (const r of rows) {
    const w = r.winner === 'Go' ? '\x1b[36mGo\x1b[0m' : r.winner === 'TypeScript' ? '\x1b[35mTS\x1b[0m' : 'Tie'
    console.log(`  ${r.benchmark.padEnd(30)} ${fmtMs(r.goAvgMs).padEnd(12)} ${fmtMs(r.tsAvgMs).padEnd(12)} ${w}`)
  }
  console.log('  ' + '-'.repeat(66))

  console.log(`\n  Output:`)
  console.log(`    ${resolve(OUT_DIR, 'comparison.md')}`)
  console.log(`    ${resolve(OUT_DIR, 'comparison.json')}`)
  console.log(`    ${CHARTS_DIR}/ (5 SVG charts)`)
  console.log('')
}

main()
