import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * setRTLTextPlugin() takes the URL of a classic script that the GL worker pulls in
 * with importScripts. mapbox-gl-rtl-text ships exactly that as
 * dist/mapbox-gl-rtl-text.js, but its "exports" field publishes only the ESM/WASM
 * entry, so the resolver refuses the subpath. Resolving the entry it does publish
 * and stepping across to dist keeps this working wherever npm hoists the package.
 *
 * Shared by vite.config.js and vitest.config.ts: the build needs it to emit the
 * asset, and the test run needs it because a lazily imported engine module reaches
 * the same specifier.
 *
 * The pattern is a regex, not a string key: the import carries a `?url` suffix,
 * which a string alias will not match. It is left unanchored on purpose so the
 * query survives the rewrite and Vite still emits an asset URL.
 */
export const rtlTextAlias = {
  find: /^@mapbox\/mapbox-gl-rtl-text\/dist\/mapbox-gl-rtl-text\.js/,
  replacement: path.join(
    path.dirname(createRequire(import.meta.url).resolve('@mapbox/mapbox-gl-rtl-text')),
    '../dist/mapbox-gl-rtl-text.js',
  ),
};
