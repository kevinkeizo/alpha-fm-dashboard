// Autenticação do dashboard.
//
// O repositório é público, então nada de credencial no código: usuário e senha
// vivem em variáveis de ambiente na Vercel, ao lado do IG_TOKEN. O navegador
// nunca recebe a senha — só um token assinado com prazo.
const crypto = require('crypto');

const VALIDADE_DIAS = 30; // o telão da rádio não pode deslogar no meio do dia

// Sem AUTH_SECRET configurado, deriva do IG_TOKEN — que já é secreto e já está
// lá. Assim não é preciso cadastrar mais uma variável só pra isso.
function segredo() {
  const s = process.env.AUTH_SECRET || process.env.IG_TOKEN;
  if (!s) throw new Error('Sem AUTH_SECRET nem IG_TOKEN configurados');
  return s;
}

function assinar(dados) {
  return crypto.createHmac('sha256', segredo()).update(dados).digest('hex');
}

// Comparação em tempo constante: comparar string com === vaza informação pelo
// tempo de resposta e permite adivinhar caractere a caractere.
function igual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function criarToken() {
  const expira = Date.now() + VALIDADE_DIAS * 86400000;
  const corpo = Buffer.from(JSON.stringify({ exp: expira })).toString('base64url');
  return corpo + '.' + assinar(corpo);
}

function tokenValido(token) {
  if (!token || typeof token !== 'string') return false;
  const partes = token.split('.');
  if (partes.length !== 2) return false;
  const [corpo, sig] = partes;
  if (!igual(sig, assinar(corpo))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    return typeof exp === 'number' && Date.now() < exp;
  } catch (e) {
    return false;
  }
}

// Usuário não diferencia maiúscula de minúscula; senha sim.
function credenciaisConferem(usuario, senha) {
  const u = process.env.DASH_USER;
  const p = process.env.DASH_PASS;
  if (!u || !p) return { ok: false, motivo: 'nao-configurado' };
  const okU = igual(String(usuario || '').trim().toLowerCase(), u.trim().toLowerCase());
  const okP = igual(String(senha || ''), p);
  return { ok: okU && okP, motivo: okU && okP ? null : 'credenciais' };
}

// Aceita o token na query (?t=) ou no cabeçalho Authorization.
// A query evita preflight de CORS, que complicaria a chamada entre domínios.
function extrairToken(req) {
  if (req.query && req.query.t) return req.query.t;
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '');
  return null;
}

// Devolve true se a requisição pode seguir. Se não, já responde 401.
function exigirLogin(req, res) {
  // Sem credenciais configuradas o dashboard ficaria inacessível para sempre;
  // melhor servir aberto e avisar no /api/login do que travar tudo em silêncio.
  if (!process.env.DASH_USER || !process.env.DASH_PASS) return true;

  if (tokenValido(extrairToken(req))) return true;

  res.status(401).json({ error: 'nao-autorizado' });
  return false;
}

module.exports = { criarToken, tokenValido, credenciaisConferem, exigirLogin };
