/**
 * k6 load test: /health endpoint on a SINGLE service.
 * Run separately for each service to avoid interleaving bias.
 *
 * Usage:
 *   k6 run --env TARGET_URL=http://localhost:8000 --env LABEL=ts bench/k6/health.js
 *   k6 run --env TARGET_URL=http://localhost:8001 --env LABEL=go bench/k6/health.js
 */

import { check, sleep } from 'k6'
import http from 'k6/http'
import { Counter, Rate, Trend } from 'k6/metrics'

const latency = new Trend('health_latency', true)
const errors = new Rate('health_errors')
const reqs = new Counter('health_reqs')

const TARGET_URL = __ENV.TARGET_URL
if (!TARGET_URL) {
  throw new Error(
    'TARGET_URL env var is required (e.g. --env TARGET_URL=http://localhost:8000)',
  )
}
const LABEL = __ENV.LABEL || 'unknown'

export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: 10 },
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    health_latency: ['p(95)<200'],
    health_errors: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

export default function () {
  const res = http.get(`${TARGET_URL}/health`)
  latency.add(res.timings.duration)
  reqs.add(1)
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
  })
  errors.add(!ok)
  sleep(0.05)
}

export function handleSummary(data) {
  const outFile = `bench/results/k6-health-${LABEL}.json`
  return {
    [outFile]: JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  }
}

function textSummary(data) {
  const s = data.metrics.health_latency
  let out = `\n=== k6 Health Summary (${LABEL}) ===\n`
  if (s && s.values) {
    out += `  avg=${s.values.avg.toFixed(2)}ms  p95=${s.values['p(95)'].toFixed(2)}ms  p99=${s.values['p(99)'].toFixed(2)}ms  max=${s.values.max.toFixed(2)}ms\n`
  }
  return out
}
