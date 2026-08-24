const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

// "2026-08-24" no fuso de Brasilia (a Vercel roda em UTC)
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
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return json;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    // ?limit=N controla quantos reels listar (padrão 12)
    const limit = Math.min(parseInt(req.query && req.query.limit, 10) || 12, 50);

    const media = await fetchGraph('/' + IG_USER_ID + '/media', {
      fields: 'id,timestamp,media_type,media_product_type,permalink,caption',
      limit: '50'
    });

    const reels = (media.data || [])
      .filter(m => m.media_product_type === 'REELS' || m.media_type === 'VIDEO')
      .slice(0, limit);

    const rows = await Promise.all(reels.map(async r => {
      let value = null, metricUsed = null;
      for (const metric of ['views', 'plays', 'video_views']) {
        try {
          const ins = await fetchGraph('/' + r.id + '/insights', { metric });
          const row = (ins.data || []).find(d => d.name === metric);
          const v = row && row.values && row.values[0] && row.values[0].value;
          if (typeof v === 'number') { value = v; metricUsed = metric; break; }
        } catch (e) { /* tenta a próxima */ }
      }
      return {
        timestamp: r.timestamp,
        dataBRT: brtDateStr(new Date(r.timestamp)),
        horaBRT: new Intl.DateTimeFormat('pt-BR', {
          timeZone: TZ, hour: '2-digit', minute: '2-digit'
        }).format(new Date(r.timestamp)),
        permalink: r.permalink,
        caption: (r.caption || '').slice(0, 60),
        views: value,
        metric: metricUsed
      };
    }));

    const todayStr = brtDateStr(new Date());
    const today = rows.filter(r => r.dataBRT === todayStr);
    const sum = arr => arr.reduce((a, b) => a + (b.views || 0), 0);

    res.status(200).json({
      totalReelsListados: rows.length,
      somaViewsListados: sum(rows),
      reelsDeHoje: today.length,
      somaViewsDeHoje: sum(today),
      reels: rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
