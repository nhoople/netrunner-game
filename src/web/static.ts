import { normalize } from "node:path";

/** File under `public/` for an HTTP path. `/` is the verification table. */
export function publicFile(pathname: string): string {
  const raw = pathname === "/" ? "table.html" : pathname.replace(/^\/+/, "");
  const rel = normalize(raw);
  if (rel === "play" || rel === "play/") return "play/index.html";
  return rel;
}

export function contentType(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
