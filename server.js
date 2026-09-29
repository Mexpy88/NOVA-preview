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

async function issueDeepgramToken(req, res) {
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

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return json(res, 503, { error: 'Deepgram is not configured' }, cors);

  try {
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: 120 }),
    });

    let data = {};
    try { data = await response.json(); } catch {}

    if (!response.ok || !data.access_token) {
      return json(res, 502, {
        error: 'Deepgram token request failed',
        status: response.status,
        detail: data?.err_msg || data?.error || 'Unknown Deepgram error',
      }, cors);
    }

    return json(res, 200, {
      token: String(data.access_token),
      expiresIn: Number(data.expires_in || 120),
      issuedAt: Date.now(),
    }, cors);
  } catch (error) {
    return json(res, 502, {
      error: 'Deepgram token request failed',
      detail: String(error?.message || error),
    }, cors);
  }
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
      deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
      azureConfigured: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    });
  }

  if (url.pathname === '/api/deepgram-token') {
    return issueDeepgramToken(req, res);
  }

  if (url.pathname === '/api/azure-speech-token') {
    return issueSpeechToken(req, res);
  }

  return json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SOMA Speech Backend listening on 0.0.0.0:${PORT}`);
});
