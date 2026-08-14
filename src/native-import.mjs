// Kept as a plain .mjs module on purpose. pi loads extension TypeScript
// through jiti, which rewrites source-level dynamic import() in transformed
// modules into jitiImport() and resolves the specifier back to a bare file
// path — a cache-busting query string never reaches Node's ESM loader, so
// edited scriptPath workflows keep executing stale exports. jiti imports
// plain .mjs modules natively, so this import() keeps real ESM semantics:
// the full URL, query included, is the module cache key.
export const nativeImport = (specifier) => import(specifier);
