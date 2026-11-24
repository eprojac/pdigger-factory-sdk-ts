/**
 * The few runtime facilities the core may use when present, behind one object so that tests can take them away. The
 * core has no static Node imports: Node modules are loaded with dynamic imports that bundlers are told to leave alone.
 */

/** A Node gunzip stream, as far as the SDK uses it. */
export type GunzipStream = NodeJS.ReadWriteStream &
  AsyncIterable<Uint8Array> & { readonly destroyed: boolean; destroy(error?: unknown): void };

/** The Node `zlib` module, as far as the SDK uses it. */
export interface ZlibModule {
  createGunzip(): GunzipStream;
}

/** The Node `fs` module, as far as the SDK uses it. */
export interface FsModule {
  createReadStream(path: string | URL): NodeJS.ReadableStream & AsyncIterable<Uint8Array> & { destroy(): void };
  promises: { readFile(path: string | URL): Promise<Uint8Array>; readdir(path: string | URL): Promise<string[]> };
}

function load<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ specifier) as Promise<T>;
}

export const platform = {
  /** The web `DecompressionStream`, when the runtime has one (Node 18+, browsers, Deno, Bun). */
  decompressionStream: (): typeof DecompressionStream | undefined =>
    (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream,
  /** Node's `zlib` (the fallback for gzip when there is no `DecompressionStream`). */
  importZlib: (): Promise<ZlibModule> => load<ZlibModule>("node:zlib"),
  /** Node's `fs` (local recordings and fixtures). Rejects in browsers. */
  importFs: (): Promise<FsModule> => load<FsModule>("node:fs"),
};
