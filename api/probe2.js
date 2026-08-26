// Temporário: verifica se o token alcança stories e demografia.
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

function resumo(r) {
  if (r.error) return { erro: (r.error.message || '').slice(0, 120) };
  return r;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const out = {};

  // ── Stories ativos ──
  out.stories = resumo(await raw('/' + IG_USER_ID + '/stories', {
    fields: 'id,media_type,timestamp,permalink'
  }));

  // Métricas de um story, se houver algum no ar
  if (out.stories.data && out.stories.data.length) {
    const primeiro = out.stories.data[0];
    out.storyMetricas = {};
    for (const m of ['views', 'reach', 'replies', 'navigation', 'total_interactions', 'shares', 'impressions']) {
      const r = await raw('/' + primeiro.id + '/insights', { metric: m });
      if (r.error) {
        out.storyMetricas[m] = 'ERRO: ' + (r.error.message || '').slice(0, 70);
      } else {
        const linha = (r.data || [])[0];
        const v = linha && linha.values && linha.values[0] ? linha.values[0].value : null;
        out.storyMetricas[m] = v;
      }
    }
  }

  // ── Demografia (lifetime) ──
  for (const bd of ['age', 'gender', 'city', 'country']) {
    const r = await raw('/' + IG_USER_ID + '/insights', {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: bd,
      timeframe: 'this_month'
    });
    out['demo_' + bd] = r.error
      ? { erro: (r.error.message || '').slice(0, 120) }
      : (((r.data || [])[0] || {}).total_value || {});
  }

  // ── Alcance por tipo de conteúdo ──
  out.reachPorTipo = resumo(await raw('/' + IG_USER_ID + '/insights', {
    metric: 'reach', period: 'day', metric_type: 'total_value', breakdown: 'media_product_type'
  }));

  res.status(200).json(out);
};
