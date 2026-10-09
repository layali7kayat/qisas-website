import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'qisas-videos';
const DRY_RUN = process.env.DRY_RUN === '1';

for (const [k,v] of Object.entries({SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,R2_ACCOUNT_ID,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY})) {
  if (!v) throw new Error(`Missing ${k}`);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });

function ext(path, fallback) {
  const m = String(path || '').match(/\.(mp4|jpe?g|png|webp)$/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg','jpg')}` : fallback;
}
function publicStorageUrl(bucket, path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
}
async function migrateOne(row, field, bucket, prefix, fallbackExt, contentType) {
  const oldPath = row[field];
  if (!oldPath || String(oldPath).startsWith('r2:')) return false;
  const key = `${prefix}/${row.id}${ext(oldPath, fallbackExt)}`;
  console.log(`${row.id} ${field}: ${oldPath} -> r2:${key}`);
  if (DRY_RUN) return true;
  const res = await fetch(publicStorageUrl(bucket, oldPath));
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${bucket}/${oldPath}`);
  const body = Buffer.from(await res.arrayBuffer());
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: body, ContentType: res.headers.get('content-type') || contentType }));
  const patch = { [field]: `r2:${key}` };
  const { error } = await sb.from('videos').update(patch).eq('id', row.id);
  if (error) throw new Error(`DB update failed: ${error.message}`);
  return true;
}

const { data: rows, error } = await sb.from('videos').select('id,video_path,thumbnail_path').order('created_at', { ascending: true });
if (error) throw error;
let changed = 0;
for (const row of rows || []) {
  try {
    if (await migrateOne(row, 'video_path', 'videos', 'videos', '.mp4', 'video/mp4')) changed++;
    if (await migrateOne(row, 'thumbnail_path', 'thumbnails', 'thumbnails', '.jpg', 'image/jpeg')) changed++;
  } catch (e) {
    console.error(`FAILED ${row.id}:`, e.message);
  }
}
console.log(DRY_RUN ? `Dry run complete. ${changed} media objects would be migrated.` : `Migration complete. ${changed} media objects migrated.`);
