/* Chiku Live — hand-written service worker.
 *
 * NOT vite-plugin-pwa: this app's dependency list is fixed, and what is needed
 * here is small enough to read in one sitting, which matters more than usual
 * for a file that can serve stale code to a child's device for months.
 *
 * WHAT IT IS FOR, in order:
 *
 *   1. THE MODELS. /vision/ holds ~23MB of WASM runtime and model bundles.
 *      They are immutable, they are the difference between "Chiku can see you"
 *      and a minute of waiting, and on a metered Indian connection making a
 *      family pay for them twice is not acceptable. They live in their own
 *      cache, keyed separately from the app shell, so shipping a new build
 *      never evicts them.
 *
 *   2. OFFLINE. Without a worker, no network means a white page. The shell is
 *      precached and navigations fall back to it.
 *
 *   3. NOT SERVING STALE CODE. Navigations are network-FIRST. A cache-first
 *      navigation on a PWA is how an app gets stuck on an old build on a
 *      device nobody will ever debug.
 *
 * INVARIANTS (§9): only same-origin GETs are ever touched. Nothing is posted
 * anywhere, there is no push handler, no sync handler, and no analytics. The
 * page CSP already makes a cross-origin request impossible; this file must not
 * be the exception that reintroduces one.
 */

/* Bump SHELL_CACHE when the shell strategy changes. MODEL_CACHE is bumped only
   if the vendored model files themselves change — that is the whole point of
   keeping the two names apart. */
const SHELL_CACHE = "chiku-live-shell-v1";
const MODEL_CACHE = "chiku-live-vision-v1";
const KEEP = [SHELL_CACHE, MODEL_CACHE];

/* Hashed build assets cannot be listed here, so the shell precache is only the
   things with stable names. Everything else is filled in on first visit. */
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, not addAll: addAll is atomic, so one missing icon would
      // throw away the whole precache and leave the app with no offline at all.
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            /* This one asset is simply not precached. */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => (KEEP.includes(n) ? undefined : caches.delete(n))));
      await self.clients.claim();
    })(),
  );
});

/** Immutable, enormous, and never revalidated: the vendored vision bundle. */
async function modelFirst(request) {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only complete, successful responses. A 206 or an error page cached here
  // would poison the model load until someone clears site data by hand.
  if (res.ok && res.status === 200) await cache.put(request, res.clone());
  return res;
}

/** Hashed build assets: serve instantly, refresh quietly behind the child. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok && res.status === 200) void cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (hit) return hit;
  const res = await network;
  if (res) return res;
  throw new Error("offline and not cached");
}

/** Navigations: the network decides, the cache catches. */
async function networkFirstDocument(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) void cache.put("/", res.clone());
    return res;
  } catch {
    const hit = (await cache.match(request)) ?? (await cache.match("/"));
    if (hit) return hit;
    throw new Error("offline and no shell cached");
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Same origin only. Nothing else may pass through this worker at all.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstDocument(request));
    return;
  }
  if (url.pathname.startsWith("/vision/")) {
    event.respondWith(modelFirst(request));
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/fonts/")) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
