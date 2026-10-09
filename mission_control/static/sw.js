/* Hermes Mission Control — service worker.
 *
 * - static assets: network first, cached copy only when the server is
 *   unreachable (a new deploy is picked up on the next load)
 * - Three.js from the CDN: cache first (versioned, immutable URL), so BMO
 *   still renders when the CDN is blocked after the first visit
 * - /api/* and /healthz: never touched — a monitoring dashboard must not
 *   show cached data as if it were live
 * - page navigation while the backend is down: /offline.html
 *
 * Only registered in a secure context (http://127.0.0.1 / localhost); over
 * plain http on the VPN address browsers do not allow service workers.
 */
var CACHE = "hmc-static-v1";
var THREE_URL = "https://unpkg.com/three@0.160.0/build/three.module.js";
var STATIC = ["/", "/style.css", "/app.js", "/bmo.js", "/favicon.svg", "/icon-192.png", "/icon-512.png",
  "/manifest.webmanifest", "/offline.html"];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(STATIC); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(request, key) {
  return fetch(request).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(key || request, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(key || request).then(function (hit) { return hit || Response.error(); });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  if (url.href === THREE_URL) {
    event.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") === 0 || url.pathname === "/healthz") return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(function () { return caches.match("/offline.html"); }));
    return;
  }
  if (STATIC.indexOf(url.pathname) >= 0) event.respondWith(networkFirst(req, url.pathname));
});
