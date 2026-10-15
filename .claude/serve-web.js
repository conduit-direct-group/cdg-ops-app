// Local preview server for the web folder (no downloads needed). Run: node .claude/serve-web.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (urlPath.endsWith("/")) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  })
  .listen(5173, () => console.log("Serving web/ at http://localhost:5173"));
