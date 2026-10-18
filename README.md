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

- **Prose + choice criteria landings.** On a GPU, prose with option descriptions landed **6/6** (tev1:4b and nimble:9b; avg scores ~7–8). On the Mac mini with the current prose and the **new default assists** (steering assists off), classic pad is about **11/12** and choose-pad about **11/12** (batch26-thrust-nosteer: 22/24 landed). Earlier "raw controls" scene variants got 0/6 — the model has to judge the situation, not fly the stick.
- **Mac ~1.2 s per new scene vs ~10 ms cache hits.** A changed prose body takes about **1.2 s** (median of 8 scenes: 1191 ms); an identical body returns in ~5–11 ms with a full prompt-cache hit. MLX shows the cache benefit; Q8_0 on the same Mac did not.
- **4/s default + same-scene skip.** Decision rate defaults to 4/s (sim time). When the prose body is unchanged (< 1 sim-second old), the server reuses the last answer instead of calling the model.
- **Landing is a special case, still described, not instructed.** Within 18 m above and 15 m of the target pad, the prose switches to a final-approach scene: where the legs are relative to the pad edges and its middle, fine height bands, sink and slide as impressions, and lean, with its own `final_approach` questions. Saying where the pad's middle is mattered: "near its left edge" alone made the model fly toward the edge.
- **Code assists are optional and named.** Burn lease and touchdown leveling **steer** toward a soft landing and are **off by default**. Smoothing, latency prediction, stale-reply discard, and climb guard stay **on** — they ease actuators, time the call, drop late answers, or cap a runaway climb; they do not pick the pad or the burn for the model. See [Is the code cheating?](#is-the-code-cheating).
- **Flat approach zones** (`APPROACH` in `sim.mjs`) because the model cannot see terrain: ground is pad height within 20 m of every pad edge; bumps grow back over the next 25 m.
- **Choose-pad is opt-in (`?pads=1` / `LAYOUT=pads`).** Three pads (narrow ×2, wide ×1, ridge ×3); `pad_choice` in `prose.json` is its own call, re-asked every 5 sim s. With the new defaults: about 11/12 (batch26-thrust-nosteer pads).

Full tables and tuning history: [docs/results.md](docs/results.md).

## Is the code cheating?

The model answers choice questions. Everything between that answer and the engine is plain code in `lander/pilot-loop.mjs`. Each piece has its own switch (`?lease=1`, `LEASE=1`, …). The HUD lists which assists are on.

| assist | default | what it does | kind |
|---|---|---|---|
| **smoothing** | on | eases throttle and tilt toward the model's targets instead of jumping | actuator |
| **predict** | on | sends the ship state predicted for when the reply will land | timing |
| **stale discard** | on | drops a reply older than `maxAge` while a recent target exists | safety |
| **climb guard** | on | caps throttle below hover while rising faster than `climbLimit` | safety |
| **burn lease** | **off** | after a throttle target ages out, eases toward hover (or idle while rising) | steering |
| **touchdown level** | **off** | within 4 m of the ground, tilts to center without waiting for a reply | steering |

**Why the steering assists are off.** They choose a gentler descent or a level attitude for the model. Ablations after the final-approach prose work (commits `d36e207`, `2a9c495`, `090915b`):

| setup | landed | notes |
|---|---|---|
| all assists on (batch25 run-2, uncontended) | classic **6/6**, pads **6/6** | single-assist-off classic also all 6/6 |
| **steering off = new default** (lease + touchdown level off; batch26-thrust-nosteer) | **22/24** | classic 11/12, pads 11/12 |
| all assists off (batch26-final-off) | **11/24** | **no fuel-outs**; fuel left ~39–50% |

The remaining gap from 22/24 down to 11/24 with everything off is mostly smoothing and prediction (and the other non-steering assists), not the steering pair. Batch25 run-1 logs ran during another agent's heavy audio job — treat them as contended. Details: [docs/results.md](docs/results.md).

## Config

Useful toggles (query string or env):

| toggle | env / query | default |
|---|---|---|
| Decision rate | `DECISION_RATE` / `?rate=` | 4/s |
| Smoothing | `SMOOTHING` / `?smooth=` | on |
| Predict / stale discard | `PREDICT` `STALE_DISCARD` / `?predict=` `?stale=` (or group `LATENCY_COMP` / `?comp=`) | on |
| Climb guard | `CLIMB_GUARD` / `?climb=` | on |
| Burn lease | `LEASE` / `?lease=` | **off** |
| Touchdown level | `TOUCHDOWN_LEVEL` / `?level=` | **off** |
| All assists / impulse group | `ASSISTS` / `?assists=` · `IMPULSE_LIMITS` / `?impulse=` | unset (use the singles) |
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
lander/pilot-loop.mjs    decision rate + code assists (steering assists off by default)
lander/prose.mjs         perception bands → prose sentences, control map
lander/modes/            prose.json, policies/*.txt
```

## License

MIT © 2026 Andrew Rapo — see LICENSE
