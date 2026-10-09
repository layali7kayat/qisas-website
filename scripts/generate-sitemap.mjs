import { writeFile } from 'node:fs/promises';

const SITE_URL = 'https://qisas-wa-hikayat.netlify.app';
const CATALOG_URL = 'https://qisas-r2-api.layali-7kayat-719.workers.dev?action=catalog';

const staticPages = [
  ['/', 'weekly', '1.0'],
  ['/videos', 'weekly', '0.9'],
  ['/shorts', 'weekly', '0.8'],
  ['/channel-about.html', 'monthly', '0.7'],
  ['/about.html', 'monthly', '0.6'],
  ['/contact.html', 'monthly', '0.6'],
  ['/privacy.html', 'yearly', '0.4'],
  ['/cookies.html', 'yearly', '0.4'],
  ['/terms.html', 'yearly', '0.4'],
  ['/disclaimer.html', 'yearly', '0.4'],
];

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getPublishedVideos() {
  const response = await fetch(CATALOG_URL, { headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`R2 catalog request failed: ${response.status}`);
  const catalog = await response.json();
  return Array.isArray(catalog?.videos) ? catalog.videos.filter(v => v.status === 'published') : [];
}

const urls = [...staticPages.map(([path, freq, priority]) => ({
  loc: `${SITE_URL}${path}`,
  freq,
  priority,
}))];

try {
  const videos = await getPublishedVideos();
  for (const video of videos) {
    const path = video.is_short
      ? `/shorts-viewer.html?id=${encodeURIComponent(video.id)}`
      : `/watch.html?id=${encodeURIComponent(video.id)}`;
    urls.push({
      loc: `${SITE_URL}${path}`,
      freq: 'weekly',
      priority: video.is_short ? '0.7' : '0.8',
      lastmod: video.created_at ? new Date(video.created_at).toISOString() : undefined,
    });
  }
  console.log(`Sitemap: added ${videos.length} published videos/shorts.`);
} catch (error) {
  console.warn(`Sitemap warning: ${error.message}`);
  console.warn('Static pages will still be written.');
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>\n${u.lastmod ? `    <lastmod>${esc(u.lastmod)}</lastmod>\n` : ''}    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
  `\n</urlset>\n`;

await writeFile('sitemap.xml', xml, 'utf8');
console.log(`Sitemap: wrote ${urls.length} URLs.`);
