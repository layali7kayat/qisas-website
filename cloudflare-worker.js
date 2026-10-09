const SITE_ORIGIN = 'https://qisas-wa-hikayat.netlify.app';
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function cors(origin) {
  const allowed = origin === SITE_ORIGIN ? origin : SITE_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pin',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function reply(request, status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(request.headers.get('Origin')), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
function validPin(request, body, env) {
  const supplied = request.headers.get('X-Admin-Pin') || body?.pin || '';
  return !!env.ADMIN_PIN && supplied === env.ADMIN_PIN;
}
function validKey(key) {
  return /^videos\/[0-9a-f-]{36}\.mp4$/i.test(key) || /^thumbnails\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/i.test(key);
}
function keyFromPath(path) {
  return String(path || '').replace(/^r2:/, '');
}
async function supabaseRequest(env, path, init = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase secrets are not configured.');
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(typeof data === 'object' && data?.message ? data.message : `Supabase request failed (${response.status}).`);
  return data;
}


function storagePathFromValue(value, bucket) {
  if (!value || String(value).startsWith('r2:')) return null;
  let raw = String(value).trim();
  const marker = '/storage/v1/object/';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex >= 0) raw = raw.slice(markerIndex + marker.length).split('?')[0];
  raw = raw.replace(/^\/+/, '').replace(/^(public|sign|authenticated)\//, '');
  if (raw.startsWith(`${bucket}/`)) raw = raw.slice(bucket.length + 1);
  try { raw = raw.split('/').map(part => decodeURIComponent(part)).join('/'); } catch {}
  if (!raw || raw.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return raw;
}
async function supabaseStorageRequest(env, path, init = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase secrets are not configured.');
  const response = await fetch(`${base}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Supabase Storage request failed (${response.status})${detail ? `: ${detail.slice(0, 220)}` : ''}`);
  }
  return response;
}
function validMigrationObject(bucket, name) {
  if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (bucket === 'videos') return /\.mp4$/i.test(name);
  return /\.(jpg|jpeg|png|webp)$/i.test(name);
}

async function refreshCatalog(env) {
  const videos = await supabaseRequest(env, 'videos?select=id,title,description,video_path,thumbnail_path,views,created_at,status,is_short,related_video_id&status=eq.published&order=created_at.desc&limit=5000');
  let featuredVideoId = null;
  try {
    const settings = await supabaseRequest(env, 'site_settings?select=featured_video_id&id=eq.1&limit=1');
    featuredVideoId = Array.isArray(settings) ? (settings[0]?.featured_video_id || null) : null;
  } catch {}
  const catalog = {
    updated_at: new Date().toISOString(),
    featured_video_id: featuredVideoId,
    videos: (Array.isArray(videos) ? videos : []).map(v => ({
      id: v.id, title: v.title || '', description: v.description || '',
      video_path: v.video_path || '', thumbnail_path: v.thumbnail_path || '',
      views: Number(v.views) || 0, created_at: v.created_at || null,
      status: v.status || 'published', is_short: !!v.is_short,
      related_video_id: v.related_video_id || null
    }))
  };
  await env.VIDEOS_BUCKET.put('site/catalog.json', JSON.stringify(catalog), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store, max-age=0' }
  });
  return { count: catalog.videos.length, updated_at: catalog.updated_at };
}

async function migrateStorageObject(env, bucket, offset) {
  const listResponse = await supabaseStorageRequest(env, `object/list/${bucket}`, {
    method: 'POST',
    body: JSON.stringify({ prefix: '', limit: 1, offset, sortBy: { column: 'name', order: 'asc' } }),
  });
  const list = await listResponse.json();
  const item = Array.isArray(list) ? list[0] : null;
  if (!item) return { done: true, nextOffset: offset, migrated: false };
  const name = String(item.name || '');
  if (!validMigrationObject(bucket, name)) return { done: false, skipped: true, name, nextOffset: offset + 1, migrated: false };

  const encodedPath = name.split('/').map(encodeURIComponent).join('/');
  const source = await supabaseStorageRequest(env, `object/${bucket}/${encodedPath}`, { method: 'GET' });
  const contentType = source.headers.get('content-type') || (bucket === 'videos' ? 'video/mp4' : name.toLowerCase().endsWith('.png') ? 'image/png' : name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg');
  const length = Number(source.headers.get('content-length') || 0);
  if (bucket === 'videos' && length > MAX_VIDEO_BYTES) throw new Error(`الملف ${name} أكبر من حد 50 MB.`);
  const body = await source.arrayBuffer();
  if (bucket === 'videos' && body.byteLength > MAX_VIDEO_BYTES) throw new Error(`الملف ${name} أكبر من حد 50 MB.`);
  const key = `${bucket}/${name}`;
  await env.VIDEOS_BUCKET.put(key, body, { httpMetadata: { contentType } });

  const rows = await supabaseRequest(env, 'videos?select=id,video_path,thumbnail_path&limit=1000');
  let updatedRows = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const field = bucket === 'videos' ? 'video_path' : 'thumbnail_path';
    const current = row[field];
    if (!current || String(current).startsWith('r2:')) continue;
    if (storagePathFromValue(current, bucket) !== name) continue;
    await supabaseRequest(env, `videos?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [field]: `r2:${key}` }),
    });
    updatedRows++;
  }
  return { done: false, migrated: true, name, key, updatedRows, nextOffset: offset + 1 };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (origin && origin !== SITE_ORIGIN) return reply(request, 403, { success: false, error: 'Origin not allowed.' });

    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.searchParams.get('action') !== 'catalog') return reply(request, 404, { success: false, error: 'Not found.' });
      try {
        const object = await env.VIDEOS_BUCKET.get('site/catalog.json');
        if (!object) return reply(request, 503, { success: false, error: 'Catalog not initialized. Open admin and run catalog sync.' }, { 'Cache-Control': 'no-store' });
        const data = await object.json();
        return reply(request, 200, data, { 'Cache-Control': 'no-store, max-age=0' });
      } catch (error) {
        return reply(request, 500, { success: false, error: error?.message || 'Could not read catalog.' });
      }
    }

    if (request.method === 'PUT') {
      if (!validPin(request, null, env)) return reply(request, 401, { success: false, error: 'رمز الإدارة غير صحيح.' });
      const url = new URL(request.url);
      const key = url.searchParams.get('key') || '';
      if (!validKey(key)) return reply(request, 400, { success: false, error: 'مسار الملف غير صالح.' });
      const type = request.headers.get('Content-Type') || 'application/octet-stream';
      const isVideo = key.startsWith('videos/');
      const allowedType = isVideo ? type === 'video/mp4' : ['image/jpeg', 'image/png', 'image/webp'].includes(type);
      if (!allowedType) return reply(request, 415, { success: false, error: 'نوع الملف غير مسموح.' });
      const length = Number(request.headers.get('Content-Length') || 0);
      if (isVideo && length > MAX_VIDEO_BYTES) return reply(request, 413, { success: false, error: 'حجم الفيديو أكبر من 50 MB.' });
      try {
        await env.VIDEOS_BUCKET.put(key, request.body, { httpMetadata: { contentType: type } });
        return reply(request, 200, { success: true, key });
      } catch (error) {
        return reply(request, 500, { success: false, error: error?.message || 'تعذر رفع الملف إلى R2.' });
      }
    }

    if (request.method !== 'POST') return reply(request, 405, { success: false, error: 'Method not allowed.' }, { Allow: 'POST, PUT, OPTIONS' });
    let body;
    try { body = await request.json(); } catch { return reply(request, 400, { success: false, error: 'Invalid JSON.' }); }
    if (!validPin(request, body, env)) return reply(request, 401, { success: false, error: 'رمز الإدارة غير صحيح.' });

    try {
      const action = body.action;
      if (action === 'verify') return reply(request, 200, { success: true });
      if (action === 'syncCatalog') {
        const result = await refreshCatalog(env);
        return reply(request, 200, { success: true, ...result });
      }
      if (action === 'migrateStorageObject') {
        const bucket = String(body.bucket || '');
        const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
        if (!['videos', 'thumbnails'].includes(bucket)) return reply(request, 400, { success: false, error: 'مخزن غير صالح.' });
        const result = await migrateStorageObject(env, bucket, offset);
        return reply(request, 200, { success: true, bucket, offset, ...result });
      }

      if (action === 'create') {
        const id = String(body.id || '');
        const videoKey = String(body.videoKey || '');
        const thumbnailKey = String(body.thumbnailKey || '');
        if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(request, 400, { success: false, error: 'معرّف القصة غير صالح.' });
        if (!validKey(videoKey) || !videoKey.startsWith(`videos/${id}.`)) return reply(request, 400, { success: false, error: 'الفيديو مطلوب أو مساره غير صالح.' });
        const row = {
          id,
          title: String(body.title || '').trim(),
          description: String(body.description || '').trim(),
          video_path: `r2:${videoKey}`,
          thumbnail_path: thumbnailKey && validKey(thumbnailKey) && thumbnailKey.startsWith(`thumbnails/${id}.`) ? `r2:${thumbnailKey}` : null,
          is_short: !!body.is_short,
          related_video_id: body.related_video_id || null,
          status: 'published',
        };
        if (!row.title) return reply(request, 400, { success: false, error: 'عنوان القصة مطلوب.' });
        await supabaseRequest(env, 'videos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
        await refreshCatalog(env);
        return reply(request, 200, { success: true, id, video_path: row.video_path, thumbnail_path: row.thumbnail_path });
      }

      if (action === 'update') {
        const id = String(body.id || '');
        if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(request, 400, { success: false, error: 'معرّف القصة غير صالح.' });
        const oldRows = await supabaseRequest(env, `videos?select=id,video_path,thumbnail_path&id=eq.${encodeURIComponent(id)}&limit=1`);
        const old = Array.isArray(oldRows) ? oldRows[0] : null;
        if (!old) return reply(request, 404, { success: false, error: 'القصة غير موجودة.' });
        const patch = {};
        if (body.title !== undefined) patch.title = String(body.title).trim();
        if (body.description !== undefined) patch.description = String(body.description).trim();
        if (body.is_short !== undefined) patch.is_short = !!body.is_short;
        if (body.related_video_id !== undefined) patch.related_video_id = body.related_video_id || null;
        if (body.videoKey) {
          if (!validKey(body.videoKey) || !body.videoKey.startsWith(`videos/${id}.`)) return reply(request, 400, { success: false, error: 'مسار الفيديو غير صالح.' });
          patch.video_path = `r2:${body.videoKey}`;
        }
        if (body.thumbnailKey) {
          if (!validKey(body.thumbnailKey) || !body.thumbnailKey.startsWith(`thumbnails/${id}.`)) return reply(request, 400, { success: false, error: 'مسار الصورة غير صالح.' });
          patch.thumbnail_path = `r2:${body.thumbnailKey}`;
        }
        await supabaseRequest(env, `videos?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        for (const [newKey, oldPath] of [[patch.video_path, old.video_path], [patch.thumbnail_path, old.thumbnail_path]]) {
          if (newKey && oldPath && String(oldPath).startsWith('r2:') && oldPath !== newKey) await env.VIDEOS_BUCKET.delete(keyFromPath(oldPath));
        }
        await refreshCatalog(env);
        return reply(request, 200, { success: true, id });
      }

      if (action === 'delete') {
        const id = String(body.id || '');
        if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(request, 400, { success: false, error: 'معرّف القصة غير صالح.' });
        const rows = await supabaseRequest(env, `videos?select=id,video_path,thumbnail_path&id=eq.${encodeURIComponent(id)}&limit=1`);
        const old = Array.isArray(rows) ? rows[0] : null;
        if (!old) return reply(request, 404, { success: false, error: 'القصة غير موجودة.' });
        for (const path of [old.video_path, old.thumbnail_path].filter(Boolean)) {
          if (String(path).startsWith('r2:')) await env.VIDEOS_BUCKET.delete(keyFromPath(path));
        }
        await supabaseRequest(env, `videos?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        await refreshCatalog(env);
        return reply(request, 200, { success: true });
      }
      return reply(request, 400, { success: false, error: 'عملية غير معروفة.' });
    } catch (error) {
      return reply(request, 500, { success: false, error: error?.message || 'Server error.' });
    }
  },
};
