const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

if (!TOKEN || !IG_USER_ID) {
  console.error('Faltam IG_TOKEN e/ou IG_USER_ID nas env vars');
}

const cache = { data: null, time: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min

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
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const since = Math.floor(dayStart.getTime() / 1000);
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

  let impressions = null;
  try {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const since = Math.floor(dayStart.getTime() / 1000);
    const until = Math.floor(now.getTime() / 1000);
    const insightsImpressions = await fetchGraph('/' + IG_USER_ID + '/insights', {
      metric: 'impressions',
      metric_type: 'total_value',
      period: 'day',
      since: String(since),
      until: String(until)
    });
    (insightsImpressions.data || []).forEach(m => {
      if (m.name === 'impressions' && m.total_value) {
        impressions = m.total_value.value;
      }
    });
  } catch (e) { console.error('Impressões falhou:', e.message); }

  let engagementRate = null;
  if (totalInteractions !== null && reach) {
    engagementRate = (totalInteractions / reach) * 100;
  }

  let postsToday = 0;
  try {
    const media = await fetchGraph('/' + IG_USER_ID + '/media', {
      fields: 'id,timestamp', limit: '50'
    });
    const todayStr = new Date().toDateString();
    postsToday = (media.data || []).filter(m => new Date(m.timestamp).toDateString() === todayStr).length;
  } catch (e) { console.error('Publicações falhou:', e.message); }

  const data = {
    profile: {
      followers_count: profile.followers_count,
      media_count: profile.media_count,
      username: profile.username
    },
    reach,
    impressions,
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
