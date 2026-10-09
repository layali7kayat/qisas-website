const R2_PUBLIC_BASE = "https://pub-025c138d90ed4d4bb9d231b4589a28bb.r2.dev";

function esc(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] || c));
}
function jsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
function storagePublicUrl(bucket: string, path: string | null | undefined) {
  if (!path) return "";
  const value = String(path);
  if (value.startsWith("r2:")) {
    const encoded = value.slice(3).split("/").map(encodeURIComponent).join("/");
    return `${R2_PUBLIC_BASE}/${encoded}`;
  }
  return "";
}

export default async function (request: Request, context: any) {
  const response = await context.next();
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const titleParam = url.searchParams.get("title");
    if (!id && !titleParam) return response;

    const catalogResponse = await fetch("https://qisas-r2-api.layali-7kayat-719.workers.dev?action=catalog", { headers: { "cache-control": "no-cache" } });
    if (!catalogResponse.ok) return response;
    const catalog = await catalogResponse.json();
    const video = (Array.isArray(catalog?.videos) ? catalog.videos : []).find((item: any) =>
      item.status === "published" && !item.is_short &&
      (id ? String(item.id) === String(id) : String(item.title || "") === String(titleParam || ""))
    );
    if (!video) return response;

    const title = String(video.title || "مشاهدة القصة").trim();
    const description = String(video.description || "شاهد القصة كاملة على موقع قصص وحكايات الليل.").trim();
    const image = storagePublicUrl("thumbnails", video.thumbnail_path);
    const contentUrl = storagePublicUrl("videos", video.video_path);
    const canonical = url.href;
    const pageTitle = `${title} | قصص وحكايات الليل`;
    const safeDescription = description.length > 160 ? `${description.slice(0,157).trim()}...` : description;

    const schema = {
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: title,
      description,
      thumbnailUrl: image ? [image] : [],
      uploadDate: video.created_at || undefined,
      contentUrl: contentUrl || undefined,
      embedUrl: canonical,
      interactionStatistic: {
        "@type": "InteractionCounter",
        interactionType: { "@type": "WatchAction" },
        userInteractionCount: Math.max(0, Number(video.views) || 0)
      },
      publisher: {
        "@type": "Organization",
        name: "قصص وحكايات الليل",
        url: "https://qisas-wa-hikayat.netlify.app/"
      }
    };

    const meta = `
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="description" content="${esc(safeDescription)}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="قصص وحكايات الليل">
${image ? `<meta property="og:image" content="${esc(image)}"><meta property="og:image:secure_url" content="${esc(image)}"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ""}
<link rel="canonical" href="${esc(canonical)}">
<script type="application/ld+json">${jsonLd(schema)}</script>`;

    const seoContent = `<div id="seoStoryContent" class="seo-story"><h2>${esc(title)}</h2><p>${esc(description)}</p></div>`;
    const body = await response.text();
    const updated = body
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(pageTitle)}</title>`)
      .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${esc(safeDescription)}">`)
      .replace(/<div id="seoStoryContent" class="seo-story"[^>]*>[\s\S]*?<\/div>/i, seoContent)
      .replace(/<\/head>/i, `${meta}\n</head>`);

    const headers = new Headers(response.headers);
    headers.set("content-type", "text/html; charset=UTF-8");
    headers.delete("content-length");
    return new Response(updated, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}
