const { exigirLogin } = require('../lib/auth');
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

const cache = { data: null, time: 0 };
const CACHE_TTL = 5 * 60 * 1000;

function brtDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

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
  return json;
}

// Roda `fn` sobre os itens com no máximo `limit` chamadas simultâneas.
// A conta publica ~40x por dia e a função tem 10s de teto: sequencial estoura.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = null; }
    }
  }));
  return out;
}

// Uma chamada com todas as métricas de uma vez; se a Meta recusar o combo,
// cai pra uma por uma. 'follows' vai à parte: os reels não aceitam.
async function metricasDaMidia(m) {
  const isVideo = m.media_product_type === 'REELS' || m.media_type === 'VIDEO';
  const base = ['reach', 'views', 'total_interactions', 'likes', 'comments', 'saved', 'shares'];
  const vals = {};

  const absorve = json => {
    (json.data || []).forEach(d => {
      const v = d.values && d.values[0] ? d.values[0].value : null;
      if (typeof v === 'number') vals[d.name] = v;
    });
  };

  try {
    absorve(await fetchGraph('/' + m.id + '/insights', { metric: base.join(',') }));
  } catch (e) {
    for (const metric of base) {
      try { absorve(await fetchGraph('/' + m.id + '/insights', { metric })); }
      catch (e2) { /* métrica indisponível pra este tipo */ }
    }
  }

  // A Media Insights API não suporta 'follows' em reels — só imagem e carrossel
  let follows = null;
  if (!isVideo) {
    try {
      const r = await fetchGraph('/' + m.id + '/insights', { metric: 'follows' });
      const row = (r.data || []).find(d => d.name === 'follows');
      const v = row && row.values && row.values[0] ? row.values[0].value : null;
      if (typeof v === 'number') follows = v;
    } catch (e) { /* segue sem */ }
  }

  return {
    id: m.id,
    permalink: m.permalink,
    media_url: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : (m.media_url || null),
    media_type: m.media_type,
    isReel: m.media_product_type === 'REELS',
    isVideo,
    caption: (m.caption || '').replace(/\s+/g, ' ').slice(0, 90),
    timestamp: m.timestamp,
    date: brtDateStr(new Date(m.timestamp)),
    hora: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
      .format(new Date(m.timestamp)),
    reach: vals.reach ?? null,
    views: vals.views ?? null,
    interactions: vals.total_interactions ?? null,
    likes: vals.likes ?? null,
    comments: vals.comments ?? null,
    saved: vals.saved ?? null,
    shares: vals.shares ?? null,
    follows
  };
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

    const hoje = brtDateStr(new Date());
    const media = await fetchGraph('/' + IG_USER_ID + '/media', {
      fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',
      limit: '100'
    });

    const doDia = (media.data || []).filter(m => brtDateStr(new Date(m.timestamp)) === hoje);
    const comMetricas = (await mapLimit(doDia, 8, metricasDaMidia)).filter(Boolean);

    comMetricas.sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1));

    const payload = {
      periodo: 'hoje',
      data: hoje,
      total: comMetricas.length,
      posts: comMetricas.slice(0, 12),
      timestamp: new Date().toISOString()
    };
    cache.data = payload;
    cache.time = now;
    res.status(200).json(payload);
  } catch (e) {
    console.error('Top error:', e.message);
    res.status(500).json({ error: e.message, posts: [] });
  }
};
