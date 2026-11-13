// Marrow server: static files + AI proxy (keeps the OpenRouter key off the client) + arXiv fetch.
// Run: node --env-file=.env server.js
const http = require('http'), fs = require('fs'), path = require('path');

const KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 5173;
// Free models only, tried in order until one answers. Override with MODELS=a,b,c in .env.
const MODELS = (process.env.MODELS ||
  'nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free,baidu/ernie-5.5-flash-preview:free,google/gemma-4-26b-a4b-it:free,openrouter/free'
).split(',');
// Used when a message carries an image (figure/equation snips).
const VISION = (process.env.VISION_MODELS ||
  'nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,openrouter/free'
).split(',');
const MAX_BODY = 6e6; // paper text plus one cropped image

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function ai(messages) {
  let lastErr = 'no model answered';
  for (const model of messages.some(m => Array.isArray(m.content)) ? VISION : MODELS) {
    if (!model.endsWith(':free') && model !== 'openrouter/free') continue; // never spend money
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Marrow' },
        body: JSON.stringify({ model, messages, temperature: 0.3 }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content;
      if (text) return { text, model };
      lastErr = `${model}: ${j.error?.message || r.status}`;
    } catch (e) { lastErr = `${model}: ${e.message}`; }
    console.warn('model failed ->', lastErr);
  }
  throw new Error(lastErr);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/ai') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > MAX_BODY) return send(res, 413, { error: 'too large' }); }
      const { messages } = JSON.parse(body);
      if (!Array.isArray(messages)) return send(res, 400, { error: 'messages required' });
      return send(res, 200, await ai(messages));
    }
    if (url.pathname === '/api/arxiv') {
      // Only arXiv ids are accepted, so this can't be used to fetch arbitrary URLs.
      const id = (url.searchParams.get('id') || '').match(/(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)/)?.[0];
      if (!id) return send(res, 400, { error: 'not an arXiv id or link' });
      const r = await fetch(`https://arxiv.org/pdf/${id}`);
      if (!r.ok) return send(res, 502, { error: `arXiv returned ${r.status}` });
      return send(res, 200, Buffer.from(await r.arrayBuffer()), 'application/pdf');
    }
    if (url.pathname === '/' || url.pathname === '/index.html')
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Marrow -> http://localhost:${PORT}` + (KEY ? '' : '  (OPENROUTER_API_KEY missing!)')));
