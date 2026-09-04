import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { rtlTextAlias } from './rtlTextAlias.js';

export default defineConfig({
  plugins: [react()],
  test: {
    alias: [rtlTextAlias],
    root: '.',
    globals: true,
    environment: './tests/environment/jsdom-native-abort.ts',
    include: [
      'tests/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
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
      include: ['src/**/*.{ts,tsx}'],
      // All .d.ts, not just vite-env: declaration files carry no executable
      // code, and their lcov entries can't resolve on the Sonar side (its
      // **/*.d.ts exclusion removes them from analysis), which surfaced as
      // "Could not resolve 2 file paths" warnings in every scan.
      exclude: ['src/main.tsx', 'src/**/*.d.ts'],
      // Without these the Client Tests job produced a report, uploaded it and
      // passed no matter what the number was — which is how coverage drifted
      // down to ~48% unnoticed. 85 across the board is the floor we do not want
      // to fall through, not a target: the suite currently sits well above it.
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
    css: false,
  },
});
