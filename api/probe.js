// Temporário: descobre quais métricas de insight cada tipo de mídia aceita.
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';

async function raw(path, params) {
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  try { return JSON.parse(await res.text()); }
  catch (e) { return { _erro: 'resposta ilegível' }; }
}

const CANDIDATAS = [
  'follows', 'profile_visits', 'profile_activity', 'reach', 'saved',
  'shares', 'total_interactions', 'views', 'likes', 'comments',
  'navigation', 'replies', 'thread_replies'
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const media = await raw('/' + IG_USER_ID + '/media', {
    fields: 'id,media_type,media_product_type,timestamp,permalink', limit: '25'
  });

  // Um exemplar de cada tipo, pra não gastar chamada à toa
  const porTipo = {};
  (media.data || []).forEach(m => {
    const k = m.media_product_type === 'REELS' ? 'REELS' : m.media_type;
    if (!porTipo[k]) porTipo[k] = m;
  });

  const out = {};
  for (const [tipo, m] of Object.entries(porTipo)) {
    out[tipo] = { permalink: m.permalink, funciona: {}, falha: {} };
    for (const metric of CANDIDATAS) {
      const r = await raw('/' + m.id + '/insights', { metric });
      if (r.error) {
        out[tipo].falha[metric] = (r.error.message || '').slice(0, 90);
      } else {
        const row = (r.data || []).find(d => d.name === metric);
        const v = row && row.values && row.values[0] ? row.values[0].value : null;
        out[tipo].funciona[metric] = v;
      }
    }
  }

  res.status(200).json(out);
};
