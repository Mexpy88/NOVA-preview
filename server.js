import http from 'node:http';

const PORT = Number(process.env.PORT || 10000);
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const rateStore = new Map();

function json(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(payload);
}

function allowedOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return '';
  const extra = String(process.env.SOMA_ALLOWED_ORIGINS || 'https://mexpy88.github.io')
    .split(',')
    .map((x) => x.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

function isRateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const now = Date.now();
  const hit = rateStore.get(ip);
  if (!hit || now - hit.start >= WINDOW_MS) {
    rateStore.set(ip, { start: now, count: 1 });
    return false;
  }
  hit.count += 1;
  return hit.count > MAX_PER_WINDOW;
}

async function issueSpeechToken(req, res) {
  const origin = allowedOrigin(req);
  if (origin === null) return json(res, 403, { error: 'Origin not allowed' });

  const cors = origin
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store, max-age=0',
    });
    return res.end();
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, cors);
  if (isRateLimited(req)) return json(res, 429, { error: 'Too many token requests' }, cors);

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return json(res, 503, { error: 'Azure Speech is not configured' }, cors);

  const endpoint = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return json(res, 502, {
        error: 'Azure token request failed',
        status: response.status,
        detail,
      }, cors);
    }

    const token = await response.text();
    return json(res, 200, {
      token,
      region,
      expiresIn: 540,
      issuedAt: Date.now(),
    }, cors);
  } catch (error) {
    return json(res, 502, {
      error: 'Azure token request failed',
      detail: String(error?.message || error),
    }, cors);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'SOMA Speech Backend',
      azureConfigured: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    });
  }

  if (url.pathname === '/api/azure-speech-token') {
    return issueSpeechToken(req, res);
  }

  return json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SOMA Speech Backend listening on 0.0.0.0:${PORT}`);
});
