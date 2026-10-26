// Offline helper (service worker). Keeps a copy of the app's screens on the device so the app
// still opens on bad Wi-Fi or none. Logins and other server calls are never cached â€” they always
// go to the server, and the app shows "Can't reach the server" when there's no connection.
//
// Strategy:
//   - The app's own files: try the network first (so updates show up right away), fall back to the copy.
//   - Firebase library from Google: the version is in the address and never changes, so use the copy if we have one.

const CACHE = "cdg-ops-v94";
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
  "/checklists.js",
  "/activity.js",
  "/requests.js",
  "/push.js",
  "/shopmap.js",
  "/mapadmin.js",
  "/trainingadmin.js",
  "/dashboard.js",
  "/announcements.js",
  "/signoff.js",
  "/outbox.js",
  "/departments.js",
  "/crew.js",
  "/forms.js",
  "/handoff.js",
  "/shoptasks.js",
  "/stations.js",
  "/linecheck.js",
  "/refdocs.js",
  "/documents.js",
  "/machines.js",
  "/testdata.js",
  "/trucks.js",
  "/silos.js",
  "/reels.js",
  "/downtime.js",
  "/whotocall.js",
  "/incidents.js",
  "/writeups.js",
  "/retention.js",
  "/nav.js",
  "/messagehours.js",
  "/messages.js",
  "/tasks.js",
  "/sigpad.js",
  "/shift.js",
  "/training.html",
  "/training-screens.html",
  "/training/app.js",
  "/training/runtime.js",
  "/training/sync.js",
  "/training/file.js",
  "/vendor/react-18.3.1.production.min.js",
  "/vendor/react-dom-18.3.1.production.min.js",
  "/vendor/msal-browser-2.38.3.min.js",
  "/vendor/jszip-3.10.1.min.js",
  "/vendor/training-fonts.css",
  "/vendor/fonts/Figtree-57fd1acf.woff2",
  "/vendor/fonts/JetBrainsMono-4f27206c.woff2",
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

// Push notifications (requests sent to you, status of your requests). The server sends data only
// ({ title, body, url }); this shows it, even when the app is closed.
self.addEventListener("push", (event) => {
  let d = {};
  try {
    const msg = event.data ? event.data.json() : {};
    d = msg.data || msg.notification || msg;
  } catch {}
  event.waitUntil(
    self.registration.showNotification(d.title || "CDG Ops", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/favicon-32.png",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
    })
  );
});

// Tapping a notification opens the app on that request (or brings an open app to it).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) return open.navigate(url).then((c) => (c || open).focus());
      return self.clients.openWindow(url);
    })
  );
});
