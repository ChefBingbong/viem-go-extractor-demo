/**
 * k6 stress test: hammers a single service's /extractor-insights?limit=N
 * with high concurrency to find the breaking point.
 *
 * Usage:
 *   k6 run --env TARGET_URL=http://localhost:8001 --env LABEL=ts bench/k6/stress.js
 *   k6 run --env TARGET_URL=http://localhost:8000 --env LABEL=go bench/k6/stress.js
 */
import http from 'k6/http'
import { check } from 'k6'
import { Trend, Rate, Counter } from 'k6/metrics'

const latency = new Trend('stress_latency', true)
const errors = new Rate('stress_errors')
const totalRequests = new Counter('stress_total_requests')
const totalBytes = new Counter('stress_total_bytes')

const TARGET_URL = __ENV.TARGET_URL
if (!TARGET_URL) {
  throw new Error('TARGET_URL env var is required (e.g. --env TARGET_URL=http://localhost:8000)')
}
const POOL_LIMIT = __ENV.POOL_LIMIT || '1000'
const LABEL = __ENV.LABEL || 'unknown'

export const options = {
  scenarios: {
    // Phase 1: steady load
    steady: {
      executor: 'constant-vus',
      vus: 50,
      duration: '1m',
      startTime: '0s',
    },
    // Phase 2: spike
    spike: {
      executor: 'ramping-vus',
      startVUs: 50,
      stages: [
        { duration: '15s', target: 200 },
        { duration: '30s', target: 200 },
        { duration: '15s', target: 0 },
      ],
      startTime: '1m',
    },
  },
  thresholds: {
    stress_latency: ['p(99)<5000'],
    stress_errors: ['rate<0.10'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

export default function () {
  const res = http.get(`${TARGET_URL}/extractor-insights?limit=${POOL_LIMIT}`)
  latency.add(res.timings.duration)
  totalRequests.add(1)
  totalBytes.add(res.body ? res.body.length : 0)

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'latency < 5s': (r) => r.timings.duration < 5000,
    'body has pools': (r) => {
      try { return JSON.parse(r.body).totalPools >= 0 } catch { return false }
    },
  })
  errors.add(!ok)
}

export function handleSummary(data) {
  const outFile = `bench/results/k6-stress-${LABEL}.json`
  return {
    [outFile]: JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  }
}

function textSummary(data) {
  const s = data.metrics.stress_latency
  let out = `\n=== k6 Stress Summary (${LABEL}, limit=${POOL_LIMIT}) ===\n`
  if (s && s.values) {
    out += `  avg=${s.values.avg.toFixed(2)}ms  p95=${s.values['p(95)'].toFixed(2)}ms  p99=${s.values['p(99)'].toFixed(2)}ms  max=${s.values.max.toFixed(2)}ms\n`
  }
  const reqs = data.metrics.stress_total_requests
  if (reqs && reqs.values) {
    out += `  total requests: ${reqs.values.count}\n`
  }
  return out
}
