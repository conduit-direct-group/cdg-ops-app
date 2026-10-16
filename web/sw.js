// Offline helper (service worker). Keeps a copy of the app's screens on the device so the app
// still opens on bad Wi-Fi or none. Logins and other server calls are never cached — they always
// go to the server, and the app shows "Can't reach the server" when there's no connection.
//
// Strategy:
//   - The app's own files: try the network first (so updates show up right away), fall back to the copy.
//   - Firebase library from Google: the version is in the address and never changes, so use the copy if we have one.

const CACHE = "cdg-ops-v8";
const FIREBASE_LIB = "https://www.gstatic.com/firebasejs/";

const APP_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/admin.js",
  "/ui.js",
  "/firebase.js",
  "/data.js",
  "/setup.js",
  "/fixlib.js",
  "/issues.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/logo-banner.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

// Clears copies saved by older versions of this file.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  if (request.url.startsWith(FIREBASE_LIB)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || (request.mode === "navigate" ? caches.match("/index.html") : undefined))
      )
  );
});
