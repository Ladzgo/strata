// Strata's offline service worker for the hosted web app (scripts/build-web.mjs fills in the two
// constants below and writes it to dist-web/sw.js). It is never registered in the desktop app.
//
// - The app shell (app/index.html, its entry chunks, styles, startup fonts, SQLite wasm, icons) is
//   cached on install, so the installed app opens with no network.
// - Every other file under assets/ and ocr/ has a content hash or never changes, so it's served from
//   the cache once fetched (cache-first): lazy features keep working offline after their first use.
// - Opening the app asks the network first (for a fresh index.html after a deploy) and falls back to
//   the cached shell after a short wait.
// - A new version waits until the page says "update" (the "Update ready" toast), then takes over.

const VERSION = "0d819801bb";
const PRECACHE = [
  "/strata/app/index.html",
  "/strata/manifest.webmanifest",
  "/strata/icons/icon-192.png",
  "/strata/icons/apple-touch-icon.png",
  "/strata/assets/app-CYWOvGod.js",
  "/strata/assets/rolldown-runtime-BCiCTKAo.js",
  "/strata/assets/fraunces-Bw4xECud.js",
  "/strata/assets/react-BWPDF9mI.js",
  "/strata/assets/preload-helper-BLi_Ytyw.js",
  "/strata/assets/service-B_N5Tkv1.js",
  "/strata/assets/store-tzuP2Jo5.js",
  "/strata/assets/fraunces-CSucOKDI.css",
  "/strata/assets/app-BrpLarZr.css",
  "/strata/assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2",
  "/strata/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
  "/strata/assets/fraunces-latin-ext-wght-normal-Ca2vKHc0.woff2",
  "/strata/assets/fraunces-latin-wght-normal-ukD16Tqj.woff2",
  "/strata/assets/jetbrains-mono-latin-ext-wght-normal-DBQx-q_a.woff2",
  "/strata/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2",
  "/strata/assets/caveat-latin-ext-wght-normal-Byk3UhVp.woff2",
  "/strata/assets/caveat-latin-wght-normal-C1hSzPvX.woff2",
  "/strata/assets/sql-wasm-C1D_RJuy.wasm"
];
const SHELL = `strata-shell-${VERSION}`;
const FILES = `strata-files-${VERSION}`;
const scope = new URL(self.registration.scope);
const base = scope.pathname.replace(/app\/$/, ""); // "/strata/"
const appIndex = `${base}app/index.html`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, FILES]);
      // Carry over files that are still current (same hashed name), so an update doesn't
      // throw away the OCR engine or chunks already fetched.
      for (const key of await caches.keys()) {
        if (keep.has(key) || !key.startsWith("strata-files-")) continue;
        const old = await caches.open(key);
        const next = await caches.open(FILES);
        for (const req of await old.keys()) {
          const res = await old.match(req);
          if (res) await next.put(req, res);
        }
      }
      for (const key of await caches.keys()) if (key.startsWith("strata-") && !keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "update") self.skipWaiting();
  // The page loaded some chunks before this worker took over: it sends their URLs to keep.
  if (event.data?.type === "keep") event.waitUntil(keep(event.data.urls));
});

async function keep(urls) {
  const cache = await caches.open(FILES);
  for (const href of urls) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !/\/(assets|ocr)\//.test(url.pathname) || (await caches.match(url.href))) continue;
    try {
      const res = await fetch(url.href);
      if (res.ok) await cache.put(url.href, res);
    } catch {
      // Offline already: it'll be cached the next time it's fetched.
    }
  }
}

async function fromNetworkThenShell(request) {
  const shell = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(request), new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 3500))]);
    if (res.ok) return res;
    return (await shell.match(appIndex)) ?? res;
  } catch {
    return (await shell.match(appIndex)) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const hit = (await caches.match(request, { ignoreSearch: true }));
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type !== "opaque") (await caches.open(FILES)).put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // models, links being captured: never cached here
  if (request.mode === "navigate" && url.pathname.startsWith(`${base}app`)) {
    event.respondWith(fromNetworkThenShell(request));
    return;
  }
  if (url.pathname.startsWith(`${base}assets/`) || url.pathname.startsWith(`${base}ocr/`) || url.pathname.startsWith(`${base}icons/`)) {
    event.respondWith(cacheFirst(request));
  }
});
