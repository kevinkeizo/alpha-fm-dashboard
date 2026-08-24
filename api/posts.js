const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';

const cache = { data: null, time: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min, igual ao /api/data

async function fetchGraph(path, params) {
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch (e) { throw new Error('Resposta inválida da Meta'); }
  if (json.error) throw new Error(json.error.message || 'Erro na API da Meta');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return json;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const now = Date.now();
    if (cache.data && now - cache.time < CACHE_TTL) {
      res.status(200).json(cache.data);
      return;
    }

    const media = await fetchGraph('/' + IG_USER_ID + '/media', {
      fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit: '12'
    });

    const posts = (media.data || []).map(m => ({
      id: m.id,
      permalink: m.permalink,
      // vídeo não tem thumb em media_url utilizável, usa thumbnail_url
      media_url: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : (m.media_url || null),
      media_type: m.media_type,
      isReel: m.media_product_type === 'REELS',
      caption: (m.caption || '').slice(0, 100),
      timestamp: m.timestamp,
      like_count: m.like_count ?? null,
      comments_count: m.comments_count ?? null
    }));

    const payload = { posts, timestamp: new Date().toISOString() };
    cache.data = payload;
    cache.time = now;
    res.status(200).json(payload);
  } catch (e) {
    console.error('Posts error:', e.message);
    res.status(500).json({ error: e.message, posts: [] });
  }
};
