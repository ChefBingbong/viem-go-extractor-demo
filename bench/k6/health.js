/**
 * k6 load test: /health endpoint for both TS and Go services.
 *
 * Usage:
 *   k6 run --out json=bench/results/k6-health.json bench/k6/health.js
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Trend, Rate, Counter } from 'k6/metrics'

const tsLatency = new Trend('ts_health_latency', true)
const goLatency = new Trend('go_health_latency', true)
const tsErrors = new Rate('ts_health_errors')
const goErrors = new Rate('go_health_errors')
const tsReqs = new Counter('ts_health_reqs')
const goReqs = new Counter('go_health_reqs')

const TS_URL = __ENV.TS_URL || 'http://localhost:8001'
const GO_URL = __ENV.GO_URL || 'http://localhost:8000'

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
    ts_health_latency: ['p(95)<200'],
    go_health_latency: ['p(95)<200'],
    ts_health_errors: ['rate<0.01'],
    go_health_errors: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

export default function () {
  const tsRes = http.get(`${TS_URL}/health`)
  tsLatency.add(tsRes.timings.duration)
  tsReqs.add(1)
  const tsOk = check(tsRes, {
    'TS /health 200': (r) => r.status === 200,
  })
  tsErrors.add(!tsOk)

  const goRes = http.get(`${GO_URL}/health`)
  goLatency.add(goRes.timings.duration)
  goReqs.add(1)
  const goOk = check(goRes, {
    'Go /health 200': (r) => r.status === 200,
  })
  goErrors.add(!goOk)

  sleep(0.05)
}

export function handleSummary(data) {
  return {
    'bench/results/k6-health.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  }
}

function textSummary(data) {
  const ts = data.metrics.ts_health_latency
  const go = data.metrics.go_health_latency
  let out = '\n=== k6 Health Summary ===\n'
  if (ts && ts.values) {
    out += `  TS /health:  avg=${ts.values.avg.toFixed(2)}ms  p95=${ts.values['p(95)'].toFixed(2)}ms  p99=${ts.values['p(99)'].toFixed(2)}ms\n`
  }
  if (go && go.values) {
    out += `  Go /health:  avg=${go.values.avg.toFixed(2)}ms  p95=${go.values['p(95)'].toFixed(2)}ms  p99=${go.values['p(99)'].toFixed(2)}ms\n`
  }
  return out
}
