// Mock /v1/systemone for offline UI tests (~300ms). Answers every question generically: noul 0.6, choice = first/random option.
import http from 'node:http';
http.createServer(async (q, r) => { let b = ''; for await (const c of q) b += c; const j = JSON.parse(b), answers = {};
  for (const [name, v] of Object.entries(j.questions)) {
    if (v.type === 'noul') answers[name] = { type: 'noul', noul: Math.random() };
    else { const ks = Object.keys(v.criteria), ch = ks[(Math.random() * ks.length) | 0];
      answers[name] = { type: 'choice', choice: ch, probabilities: Object.fromEntries(ks.map(k => [k, k === ch ? 0.8 : 0.2 / (ks.length - 1)])), confidence: 0.7 }; } }
  setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ model: j.model, answers, usage: { input_tokens: b.length >> 2, output_tokens: 1 } })); }, 300);
}).listen(+process.env.PORT || 11999);
