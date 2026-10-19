// Local preview server (no downloads needed). Run: node .claude/serve-web.js [folder] [port]
// Default: the web folder on port 5173. The reference copy of the floor plan uses: reference/floor-plan 5174
// (reference/ is git-ignored — it is only served on this computer, never committed).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", process.argv[2] || "web");
const port = Number(process.env.PORT) || Number(process.argv[3]) || 5173; // the preview tool may pick another free port
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (urlPath.endsWith("/")) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "http://localhost:5174" });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`Serving ${root} at http://localhost:${port}`));
