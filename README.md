# System 1 Lander

A lunar lander flown in real time by a small **System 1 decision model** through Ollama's `POST /v1/systemone`. The request is a `state` plus `questions` (`noul` yes/no, `choice`, `score`). The reply is the answers with their probabilities, from a single forward pass, with no text generation. Node ≥ 20, no dependencies.

Public repo: [wwlib/system1-lander](https://github.com/wwlib/system1-lander). MIT © Andrew Rapo.

![Lander in prose mode after a random-start landing scored 7.9, with the System 1 panel showing the prose sentences, choice probabilities, code mapping and request](docs/screenshot-landed.png)

## Quick start

```bash
cp .env.example .env        # set OLLAMA_URL (and optionally OLLAMA_URL2 as a fallback host)
ollama pull tev1:4b         # also tried: nimble:9b, tev1:0.8b; also in the menu: d1:3b, nimble-v3:9b (needs Ollama 0.40.4+)
npm start                   # game at http://localhost:8787, playground at /playground
npm run headless            # fly 4 starts without a browser (EXTRA=2 → 6 starts; VARIANT=data|policy:careful|…)
npm run hello               # minimal /v1/systemone example
npm run check               # syntax-check everything
```

`.env` sets the server (`PORT`, `MODEL`, `VARIANT`) and the hosts. Real environment variables override `.env`.

## Modes

| mode | id | what the model gets → what it decides |
|---|---|---|
| **Prose input (choice questions)** (default) | `prose` | Prose sentences ("The pad is far to the right. The lander is near the ground…") and 3 `choice` questions with option descriptions (fly direction, fly speed, thrust). One call per decision. Questions in `lander/modes/prose.json`. |
| **Data input (yes/no fact checks)** | `data` | A chain of tiny yes/no fact questions about rounded numbers ("Is fall_speed_mps greater than 5?"). One call per fact, up to ~8 per decision. |
| **Policy (plain-English rules)** | `policy:careful` / `fuel-miser` / `aggressive` | A policy text (`lander/modes/policies/*.txt`) plus ship JSON, and 4 judgment questions. Probabilities are used as graded values. |

In every mode, **code** maps the answers to controls with a small fixed table (shown in the game's System 1 panel). The prose sentences are written by code from the physics, using fixed bands; they stand in for a vision model — no vision model is used. Edit `prose.json` or a policy file to change behavior; no code change is needed.

## Key findings

- **Prose + choice criteria landings.** On a GPU, prose with option descriptions landed **6/6** (tev1:4b and nimble:9b; avg scores ~7–8). On the Mac mini with the current prose, classic pad **6/6** in both runs (avg score 7.97 / 8.48 with the final-approach scene; 6.87 / 5.95 without). Earlier "raw controls" scene variants got 0/6 — the model has to judge the situation, not fly the stick.
- **Mac ~1.2 s per new scene vs ~10 ms cache hits.** A changed prose body takes about **1.2 s** (median of 8 scenes: 1191 ms); an identical body returns in ~5–11 ms with a full prompt-cache hit. MLX shows the cache benefit; Q8_0 on the same Mac did not.
- **4/s default + same-scene skip.** Decision rate defaults to 4/s (sim time). When the prose body is unchanged (< 1 sim-second old), the server reuses the last answer instead of calling the model.
- **Impulse limits and touchdown leveling are code safety.** Burn lease, climb guard, and leveling tilt within 4 m of the ground (`touchdownTilt` in `pilot-loop.mjs`) are fixed limits in code, not model behavior. Without them, a slow host empties the tank (and can fly out of the world).
- **Flat approach zones** (`APPROACH` in `sim.mjs`) because the model cannot see terrain: ground is pad height within 20 m of every pad edge; bumps grow back over the next 25 m.
- **Choose-pad is opt-in (`?pads=1` / `LAYOUT=pads`) and lands 6/6 (latest runs, avg 14.08 / 14.95 with the final-approach scene; 5/6 earlier).** Three pads (narrow ×2, wide ×1, ridge ×3); `pad_choice` in `prose.json` is its own call, re-asked every 5 sim s. Stays opt-in vs classic 6/6.

Full tables and tuning history: [docs/results.md](docs/results.md).

## Config

Useful toggles (query string or env):

| toggle | env / query | default |
|---|---|---|
| Decision rate | `DECISION_RATE` / `?rate=` | 4/s |
| Smoothing | `SMOOTHING` / `?smooth=` | on |
| Latency compensation | `LATENCY_COMP` / `?comp=` | on |
| Impulse limits | `IMPULSE_LIMITS` / `?impulse=` | on |
| Same-scene skip | `SAME_SCENE_SKIP` | on |
| Choose pad | `LAYOUT=pads` / `?pads=1` | off |
| Random start | `RANDOM_START` / `?random=1` | off |
| Artificial delay | `DELAY_MS` / `?delay=` | 0 |

> **Note:** setting `OLLAMA` in the environment forces every call to that URL and disables the host menu. Prefer `.env` `OLLAMA_URL` / `OLLAMA_URL2` instead.

Other providers (TypeSafe Jev, Microsoft Decision-1 / OpenRouter) are wired in `lander/providers/index.mjs` from public docs but **untested**; only Ollama is tested.

`/playground` proxies any `/v1/systemone` request (examples, side-by-side compare, load latest call from the game).

## Docs

- [docs/results.md](docs/results.md) — landing tables, prompt-cache measurements, prose tuning, choose-pad
- [docs/code-walkthrough.md](docs/code-walkthrough.md) — where the model calls happen

```
lander/server.mjs        HTTP server, modes, playground proxy
lander/sim.mjs           physics + data-mode questions
lander/pilot-loop.mjs    decision rate, smoothing, latency compensation, impulse limits
lander/prose.mjs         perception bands → prose sentences, control map
lander/modes/            prose.json, policies/*.txt
```

## License

MIT © 2026 Andrew Rapo — see LICENSE
