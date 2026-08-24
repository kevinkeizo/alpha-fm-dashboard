// Endpoint de diagnóstico: mostra a resposta crua da Meta pra entender
// o que cada métrica realmente devolve. Pode ser removido depois.
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

function brtDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function tzOffsetMs(d) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const u = Date.UTC(+p.year, +p.month - 1, +p.day,
    p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return d.getTime() - u;
}

function brtDayStartSec(d) {
  return Math.floor((Date.parse(brtDateStr(d) + 'T00:00:00Z') + tzOffsetMs(d)) / 1000);
}

async function raw(path, params) {
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { return { _parseError: text.slice(0, 300) }; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const now = new Date();
  const todayStart = brtDayStartSec(now);
  const nowSec = Math.floor(now.getTime() / 1000);
  const DAY = 86400;

  const out = { agoraUTC: now.toISOString(), hojeBRT: brtDateStr(now), testes: {} };

  // 1. views do dia, com a janela que a API usa hoje
  out.testes['A_views_hoje_com_since_until'] = await raw('/' + IG_USER_ID + '/insights', {
    metric: 'views', metric_type: 'total_value', period: 'day',
    since: String(todayStart), until: String(nowSec)
  });

  // 2. views sem since/until (deixa a Meta escolher a janela)
  out.testes['B_views_sem_janela'] = await raw('/' + IG_USER_ID + '/insights', {
    metric: 'views', metric_type: 'total_value', period: 'day'
  });

  // 3. views como série temporal (sem total_value) nos últimos 8 dias
  out.testes['C_views_serie_8dias'] = await raw('/' + IG_USER_ID + '/insights', {
    metric: 'views', period: 'day',
    since: String(todayStart - 8 * DAY), until: String(nowSec)
  });

  // 4. dia a dia, uma chamada por dia dos últimos 5 dias
  const porDia = [];
  for (let i = 1; i <= 5; i++) {
    const s = todayStart - i * DAY;
    const u = s + DAY;
    const r = await raw('/' + IG_USER_ID + '/insights', {
      metric: 'views', metric_type: 'total_value', period: 'day',
      since: String(s), until: String(u)
    });
    const row = (r.data || []).find(d => d.name === 'views');
    porDia.push({
      dia: brtDateStr(new Date(s * 1000)),
      views: row && row.total_value ? row.total_value.value : null,
      erro: r.error ? r.error.message : undefined
    });
  }
  out.testes['D_views_por_dia'] = porDia;

  // 5. reach na mesma janela, pra comparar a ordem de grandeza
  out.testes['E_reach_hoje'] = await raw('/' + IG_USER_ID + '/insights', {
    metric: 'reach', metric_type: 'total_value', period: 'day',
    since: String(todayStart), until: String(nowSec)
  });

  res.status(200).json(out);
};
