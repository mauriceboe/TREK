import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    silent: false,
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@modelcontextprotocol/sdk/server/mcp': new URL(
          './node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js',
          import.meta.url
      ).pathname,
      '@modelcontextprotocol/sdk/server/streamableHttp': new URL(
          './node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js',
          import.meta.url
      ).pathname,
    },
  },
});