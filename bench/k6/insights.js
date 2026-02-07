/**
 * k6 load test: /extractor-insights endpoint with ?limit for fair comparison.
 *
 * Usage:
 *   k6 run bench/k6/insights.js
 *   k6 run --env POOL_LIMIT=500 bench/k6/insights.js
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Trend, Rate, Counter } from 'k6/metrics'

const tsLatency = new Trend('ts_insights_latency', true)
const goLatency = new Trend('go_insights_latency', true)
const tsErrors = new Rate('ts_insights_errors')
const goErrors = new Rate('go_insights_errors')
const tsBytes = new Counter('ts_insights_bytes')
const goBytes = new Counter('go_insights_bytes')
const tsReqs = new Counter('ts_insights_reqs')
const goReqs = new Counter('go_insights_reqs')

const TS_URL = __ENV.TS_URL || 'http://localhost:8001'
const GO_URL = __ENV.GO_URL || 'http://localhost:8000'
const POOL_LIMIT = __ENV.POOL_LIMIT || '1000'

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
    ts_insights_latency: ['p(95)<2000'],
    go_insights_latency: ['p(95)<2000'],
    ts_insights_errors: ['rate<0.05'],
    go_insights_errors: ['rate<0.05'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

export default function () {
  const tsRes = http.get(`${TS_URL}/extractor-insights?limit=${POOL_LIMIT}`)
  tsLatency.add(tsRes.timings.duration)
  tsBytes.add(tsRes.body ? tsRes.body.length : 0)
  tsReqs.add(1)
  const tsOk = check(tsRes, {
    'TS status 200': (r) => r.status === 200,
    'TS has totalPools': (r) => {
      try { return JSON.parse(r.body).totalPools >= 0 } catch { return false }
    },
    'TS latency < 2s': (r) => r.timings.duration < 2000,
  })
  tsErrors.add(!tsOk)

  const goRes = http.get(`${GO_URL}/extractor-insights?limit=${POOL_LIMIT}`)
  goLatency.add(goRes.timings.duration)
  goBytes.add(goRes.body ? goRes.body.length : 0)
  goReqs.add(1)
  const goOk = check(goRes, {
    'Go status 200': (r) => r.status === 200,
    'Go has totalPools': (r) => {
      try { return JSON.parse(r.body).totalPools >= 0 } catch { return false }
    },
    'Go latency < 2s': (r) => r.timings.duration < 2000,
  })
  goErrors.add(!goOk)

  sleep(0.1)
}

export function handleSummary(data) {
  return {
    'bench/results/k6-insights.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  }
}

function textSummary(data) {
  const ts = data.metrics.ts_insights_latency
  const go = data.metrics.go_insights_latency
  let out = `\n=== k6 Insights Summary (limit=${POOL_LIMIT}) ===\n`
  if (ts && ts.values) {
    out += `  TS /insights:  avg=${ts.values.avg.toFixed(2)}ms  p95=${ts.values['p(95)'].toFixed(2)}ms  p99=${ts.values['p(99)'].toFixed(2)}ms\n`
  }
  if (go && go.values) {
    out += `  Go /insights:  avg=${go.values.avg.toFixed(2)}ms  p95=${go.values['p(95)'].toFixed(2)}ms  p99=${go.values['p(99)'].toFixed(2)}ms\n`
  }
  return out
}
