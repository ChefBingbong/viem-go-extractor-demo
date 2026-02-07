import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    benchmark: {
      include: ['bench/ts/**/*.bench.ts'],
      outputJson: 'bench/results/ts-results.json',
    },
  },
})
