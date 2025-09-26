// /app/sitemap.ts
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://www.blockbattle.org";
  const now = new Date();

  return [
    { url: `${base}/`,       lastModified: now, changeFrequency: "hourly", priority: 1.0 },
    { url: `${base}/about`,  lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/rules`,  lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    // Add more static public pages here when they exist
  ];
}
