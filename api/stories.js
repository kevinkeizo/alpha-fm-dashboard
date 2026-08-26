// Stories no ar agora. A Meta só expõe os ativos (24h), então isto é um
// retrato do momento — não dá pra recuperar story de ontem por aqui. Por isso
// o snapshot noturno também grava o agregado do dia no histórico.
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

const cache = { data: null, time: 0 };
const CACHE_TTL = 5 * 60 * 1000;

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

// Uma chamada com o combo; se a Meta recusar, tenta uma a uma
async function metricasDoStory(id) {
  const base = ['views', 'reach', 'replies', 'navigation', 'total_interactions', 'shares'];
  const vals = {};
  const absorve = j => (j.data || []).forEach(d => {
    const v = d.values && d.values[0] ? d.values[0].value : null;
    if (typeof v === 'number') vals[d.name] = v;
  });
  try {
    absorve(await fetchGraph('/' + id + '/insights', { metric: base.join(',') }));
  } catch (e) {
    for (const m of base) {
      try { absorve(await fetchGraph('/' + id + '/insights', { metric: m })); } catch (e2) {}
    }
  }
  return vals;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = null; }
    }
  }));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const agora = Date.now();
    if (cache.data && agora - cache.time < CACHE_TTL) {
      res.status(200).json(cache.data);
      return;
    }

    const lista = await fetchGraph('/' + IG_USER_ID + '/stories', {
      fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp'
    });

    const brutos = lista.data || [];
    const comMetricas = (await mapLimit(brutos, 6, async m => {
      const v = await metricasDoStory(m.id);
      return {
        id: m.id,
        permalink: m.permalink,
        media_url: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : (m.media_url || null),
        media_type: m.media_type,
        timestamp: m.timestamp,
        hora: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
          .format(new Date(m.timestamp)),
        views: v.views ?? null,
        reach: v.reach ?? null,
        replies: v.replies ?? null,
        navigation: v.navigation ?? null,
        interactions: v.total_interactions ?? null,
        shares: v.shares ?? null
      };
    })).filter(Boolean);

    comMetricas.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const soma = campo => comMetricas.reduce((a, s) => a + (s[campo] || 0), 0);
    const alcances = comMetricas.map(s => s.reach).filter(v => typeof v === 'number');

    const payload = {
      ativos: comMetricas.length,
      stories: comMetricas,
      resumo: {
        views: soma('views'),
        // Alcance de stories não soma: a mesma pessoa vê vários. O máximo de
        // um story isolado é a melhor aproximação de "quantos vimos hoje".
        alcanceMaximo: alcances.length ? Math.max(...alcances) : null,
        alcanceMedio: alcances.length ? Math.round(alcances.reduce((a, b) => a + b, 0) / alcances.length) : null,
        replies: soma('replies'),
        interactions: soma('interactions')
      },
      timestamp: new Date().toISOString()
    };

    cache.data = payload;
    cache.time = agora;
    res.status(200).json(payload);
  } catch (e) {
    console.error('Stories error:', e.message);
    res.status(500).json({ error: e.message, stories: [], ativos: 0 });
  }
};
