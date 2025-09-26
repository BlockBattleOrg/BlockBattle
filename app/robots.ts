// /app/robots.ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/admin", "/api/ingest", "/api/health"], // keep private endpoints out
    },
    sitemap: "https://www.blockbattle.org/sitemap.xml",
    host: "https://www.blockbattle.org",
  };
}

