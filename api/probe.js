// Temporário: testa 'follows' e 'profile_visits' em mídia já madura,
// pra saber se dá pra ranquear publicações por conversão em seguidores.
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

async function raw(path, params) {
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  try { return JSON.parse(await res.text()); }
  catch (e) { return { _erro: 'resposta ilegível' }; }
}

async function metrica(id, metric) {
  const r = await raw('/' + id + '/insights', { metric });
  if (r.error) return { erro: (r.error.message || '').slice(0, 70) };
  const row = (r.data || []).find(d => d.name === metric);
  const v = row && row.values && row.values[0] ? row.values[0].value : null;
  return { valor: v };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Volta ~4 dias pra pegar publicações que já tiveram tempo de converter
  const alvo = Date.now() / 1000 - 4 * 86400;
  let todas = [];
  let params = { fields: 'id,media_type,media_product_type,timestamp,permalink,caption', limit: '100' };
  for (let p = 0; p < 6; p++) {
    const r = await raw('/' + IG_USER_ID + '/media', params);
    const data = r.data || [];
    todas.push(...data);
    const ultimo = data[data.length - 1];
    if (!ultimo) break;
    if (new Date(ultimo.timestamp).getTime() / 1000 < alvo) break;
    const after = r.paging && r.paging.cursors && r.paging.cursors.after;
    if (!after) break;
    params = { ...params, after };
  }

  // Amostra: as mais antigas do lote (mais maduras), variando o tipo
  const maduras = todas.filter(m => new Date(m.timestamp).getTime() / 1000 < Date.now() / 1000 - 2 * 86400);
  const amostra = [];
  const contagem = {};
  for (const m of maduras.reverse()) {
    const k = m.media_product_type === 'REELS' ? 'REELS' : m.media_type;
    contagem[k] = (contagem[k] || 0) + 1;
    if (contagem[k] <= 4) amostra.push(m);
    if (amostra.length >= 12) break;
  }

  const linhas = [];
  for (const m of amostra) {
    const tipo = m.media_product_type === 'REELS' ? 'REELS' : m.media_type;
    const [f, pv, r_, v] = [
      await metrica(m.id, 'follows'),
      await metrica(m.id, 'profile_visits'),
      await metrica(m.id, 'reach'),
      await metrica(m.id, 'views')
    ];
    linhas.push({
      tipo,
      quando: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(m.timestamp)),
      follows: f.erro ? 'ERRO: ' + f.erro : f.valor,
      profile_visits: pv.erro ? 'ERRO' : pv.valor,
      reach: r_.erro ? 'ERRO' : r_.valor,
      views: v.erro ? 'ERRO' : v.valor,
      permalink: m.permalink
    });
  }

  res.status(200).json({
    totalLido: todas.length,
    tiposNoLote: contagem,
    amostra: linhas
  });
};
