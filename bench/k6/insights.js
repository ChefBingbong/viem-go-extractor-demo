/**
 * k6 load test: /extractor-insights endpoint on a SINGLE service.
 * Run separately for each service to avoid interleaving bias.
 *
 * Usage:
 *   k6 run --env TARGET_URL=http://localhost:8000 --env LABEL=ts bench/k6/insights.js
 *   k6 run --env TARGET_URL=http://localhost:8001 --env LABEL=go bench/k6/insights.js
 */

import { check, sleep } from 'k6'
import http from 'k6/http'
import { Counter, Rate, Trend } from 'k6/metrics'

const latency = new Trend('insights_latency', true)
const errors = new Rate('insights_errors')
const bytes = new Counter('insights_bytes')
const reqs = new Counter('insights_reqs')

const TARGET_URL = __ENV.TARGET_URL
if (!TARGET_URL) {
  throw new Error(
    'TARGET_URL env var is required (e.g. --env TARGET_URL=http://localhost:8000)',
  )
}
const POOL_LIMIT = __ENV.POOL_LIMIT || '1000'
const LABEL = __ENV.LABEL || 'unknown'

export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: 5 },
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    insights_latency: ['p(95)<2000'],
    insights_errors: ['rate<0.05'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

export default function () {
  const res = http.get(`${TARGET_URL}/extractor-insights?limit=${POOL_LIMIT}`)
  latency.add(res.timings.duration)
  bytes.add(res.body ? res.body.length : 0)
  reqs.add(1)
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has totalPools': (r) => {
      try {
        return JSON.parse(r.body).totalPools >= 0
      } catch {
        return false
      }
    },
    'latency < 2s': (r) => r.timings.duration < 2000,
  })
  errors.add(!ok)
  sleep(0.1)
}

export function handleSummary(data) {
  const outFile = `bench/results/k6-insights-${LABEL}.json`
  return {
    [outFile]: JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  }
}

function textSummary(data) {
  const s = data.metrics.insights_latency
  let out = `\n=== k6 Insights Summary (${LABEL}, limit=${POOL_LIMIT}) ===\n`
  if (s && s.values) {
    out += `  avg=${s.values.avg.toFixed(2)}ms  p95=${s.values['p(95)'].toFixed(2)}ms  p99=${s.values['p(99)'].toFixed(2)}ms  max=${s.values.max.toFixed(2)}ms\n`
  }
  return out
}
