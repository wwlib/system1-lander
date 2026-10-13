// Mock /v1/systemone for offline UI tests (~300ms). Answers every question generically: noul random, choice random option, score random level.
import http from 'node:http';
http.createServer(async (q, r) => { let b = ''; for await (const c of q) b += c; const j = JSON.parse(b), answers = {};
  for (const [name, v] of Object.entries(j.questions)) {
    if (v.type === 'noul') answers[name] = { type: 'noul', noul: Math.random() };
    else if (v.type === 'score') { const n = v.criteria.length, sc = Math.random() * (n - 1); answers[name] = { type: 'score', score: sc, legend: Object.fromEntries(v.criteria.map((c, i) => [i, c])), probabilities: Object.fromEntries(v.criteria.map((c, i) => [i, i === Math.round(sc) ? 0.8 : 0.2 / (n - 1)])), confidence: 0.7 }; }
    else { const ks = Object.keys(v.criteria), ch = ks[(Math.random() * ks.length) | 0];
      answers[name] = { type: 'choice', choice: ch, probabilities: Object.fromEntries(ks.map(k => [k, k === ch ? 0.8 : 0.2 / (ks.length - 1)])), confidence: 0.7 }; } }
  setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ model: j.model, answers, usage: { input_tokens: b.length >> 2, output_tokens: 1 } })); }, 300);
}).listen(+process.env.PORT || 11999);
