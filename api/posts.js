const { exigirLogin } = require('../lib/auth');
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

function brtDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

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

  if (!exigirLogin(req, res)) return;

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

    const hoje = brtDateStr(new Date());

    const posts = await Promise.all((media.data || []).map(async m => {
      const isVideo = m.media_product_type === 'REELS' || m.media_type === 'VIDEO';

      let views = null;
      if (isVideo) {
        for (const metric of ['views', 'plays', 'video_views']) {
          try {
            const ins = await fetchGraph('/' + m.id + '/insights', { metric });
            const row = (ins.data || []).find(d => d.name === metric);
            const v = row && row.values && row.values[0] && row.values[0].value;
            if (typeof v === 'number') { views = v; break; }
          } catch (e) { /* tenta a próxima métrica */ }
        }
      }

      return {
        id: m.id,
        permalink: m.permalink,
        // vídeo não tem thumb em media_url utilizável, usa thumbnail_url
        media_url: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : (m.media_url || null),
        media_type: m.media_type,
        isReel: m.media_product_type === 'REELS',
        isVideo,
        views,
        caption: (m.caption || '').slice(0, 100),
        timestamp: m.timestamp,
        hora: new Intl.DateTimeFormat('pt-BR', {
          timeZone: TZ, hour: '2-digit', minute: '2-digit'
        }).format(new Date(m.timestamp)),
        isHoje: brtDateStr(new Date(m.timestamp)) === hoje,
        like_count: m.like_count ?? null,
        comments_count: m.comments_count ?? null
      };
    }));

    const doDia = posts.filter(p => p.isHoje);
    const payload = {
      posts,
      resumo: {
        postsHoje: doDia.length,
        reelsHoje: doDia.filter(p => p.isVideo).length,
        viewsHoje: doDia.reduce((a, p) => a + (p.views || 0), 0)
      },
      timestamp: new Date().toISOString()
    };
    cache.data = payload;
    cache.time = now;
    res.status(200).json(payload);
  } catch (e) {
    console.error('Posts error:', e.message);
    res.status(500).json({ error: e.message, posts: [] });
  }
};
