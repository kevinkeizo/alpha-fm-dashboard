const { exigirLogin } = require('../lib/auth');
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

if (!TOKEN || !IG_USER_ID) {
  console.error('Faltam IG_TOKEN e/ou IG_USER_ID nas env vars');
}

const cache = { data: null, time: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// A Vercel roda em UTC. Sem isso o "dia" comecaria as 21h BRT do dia anterior.
function tzOffsetMs(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  const asIfUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    parts.hour === '24' ? 0 : +parts.hour, +parts.minute, +parts.second
  );
  return d.getTime() - asIfUTC;
}

// "2026-08-24" no fuso de Brasilia
function brtDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// Epoch (segundos) da meia-noite de Brasilia do dia de `d`
function brtDayStartSec(d) {
  const midnightUTC = Date.parse(brtDateStr(d) + 'T00:00:00Z');
  return Math.floor((midnightUTC + tzOffsetMs(d)) / 1000);
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

async function fetchAllData() {
  const now = Date.now();
  if (cache.data && now - cache.time < CACHE_TTL) {
    return cache.data;
  }

  const profile = await fetchGraph('/' + IG_USER_ID, {
    fields: 'followers_count,media_count,username,profile_picture_url'
  });

  let reach = null;
  try {
    const insights = await fetchGraph('/' + IG_USER_ID + '/insights', {
      metric: 'reach', period: 'day'
    });
    const vals = insights.data && insights.data[0] && insights.data[0].values;
    if (vals && vals.length) reach = vals[vals.length - 1].value;
  } catch (e) { console.error('Alcance falhou:', e.message); }

  let totalInteractions = null;
  try {
    const now = new Date();
    const since = brtDayStartSec(now);
    const until = Math.floor(now.getTime() / 1000);
    const insights2 = await fetchGraph('/' + IG_USER_ID + '/insights', {
      metric: 'total_interactions',
      metric_type: 'total_value',
      period: 'day',
      since: String(since),
      until: String(until)
    });
    (insights2.data || []).forEach(m => {
      if (m.name === 'total_interactions' && m.total_value) {
        totalInteractions = m.total_value.value;
      }
    });
  } catch (e) { console.error('Engajamento falhou:', e.message); }

  // Visualizações da conta (views) - métrica nova da v22, é o que o app mostra
  let views = null;
  try {
    const now = new Date();
    const since = brtDayStartSec(now);
    const until = Math.floor(now.getTime() / 1000);
    const insightsViews = await fetchGraph('/' + IG_USER_ID + '/insights', {
      metric: 'views',
      metric_type: 'total_value',
      period: 'day',
      since: String(since),
      until: String(until)
    });
    (insightsViews.data || []).forEach(m => {
      if (m.name === 'views' && m.total_value) {
        views = m.total_value.value;
      }
    });
  } catch (e) { console.error('Visualizações (conta) falhou:', e.message); }

  let engagementRate = null;
  if (totalInteractions !== null && reach) {
    engagementRate = (totalInteractions / reach) * 100;
  }

  let postsToday = 0;
  let reelsToday = 0;
  let reelViews = null;
  try {
    const media = await fetchGraph('/' + IG_USER_ID + '/media', {
      // A conta publica ~40x por dia; 50 nao cobre um dia inteiro
      fields: 'id,timestamp,media_type,media_product_type', limit: '100'
    });
    const todayStr = brtDateStr(new Date());
    const todayMedia = (media.data || []).filter(m => brtDateStr(new Date(m.timestamp)) === todayStr);
    postsToday = todayMedia.length;

    // Soma visualizações dos reels/vídeos publicados hoje
    const videos = todayMedia.filter(m =>
      m.media_product_type === 'REELS' || m.media_type === 'VIDEO'
    );
    reelsToday = videos.length;

    if (videos.length) {
      const results = await Promise.all(videos.map(async v => {
        for (const metric of ['views', 'plays', 'video_views']) {
          try {
            const ins = await fetchGraph('/' + v.id + '/insights', { metric });
            const row = (ins.data || []).find(d => d.name === metric);
            const val = row && row.values && row.values[0] && row.values[0].value;
            if (typeof val === 'number') return val;
          } catch (e) { /* tenta a próxima métrica */ }
        }
        return null;
      }));
      const valid = results.filter(v => typeof v === 'number');
      if (valid.length) reelViews = valid.reduce((a, b) => a + b, 0);
    }
  } catch (e) { console.error('Publicações falhou:', e.message); }

  // Se a métrica de conta não veio, usa a soma dos reels
  if (views === null && reelViews !== null) views = reelViews;

  const data = {
    profile: {
      followers_count: profile.followers_count,
      media_count: profile.media_count,
      username: profile.username
    },
    reach,
    views,
    reelViews,
    reelsToday,
    postsToday,
    totalInteractions,
    engagementRate,
    timestamp: new Date().toISOString()
  };

  cache.data = data;
  cache.time = now;
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!exigirLogin(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const data = await fetchAllData();

    // Calcula dias até expiração (token dura ~60 dias)
    // Renovado em 2026-08-18, expira em 2026-10-17
    const expiryDate = new Date('2026-10-17');
    const today = new Date();
    const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

    data.tokenStatus = {
      expiryDate: expiryDate.toISOString().split('T')[0],
      daysUntilExpiry: daysUntilExpiry,
      isExpired: daysUntilExpiry <= 0,
      isWarning: daysUntilExpiry > 0 && daysUntilExpiry <= 10
    };

    res.status(200).json(data);
  } catch (e) {
    console.error('API error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
