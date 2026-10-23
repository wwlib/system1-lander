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

## Best practices

We tested two TypeSafe cookbooks on the Mac mini (batch27, tev1:4b, prose, seeds 1–6). Details are in [docs/results.md](docs/results.md#batch27-decomposed-thrust-and-the-confidence-gate-mac-mini-tev14b-prose-seeds-16-4s).

- **[Classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence): adopted.** Each answer has a `confidence` field. When it is below `CONFIDENCE_CUTOFF=0.5`, the code uses the probability-weighted blend (`GATE_MODE=blend`) of the options instead of the top choice alone. This landed **24/24**, against a baseline of **20/24** with the gate off. Hold landed 10/12 and rollup 10/12. Blend at 0.7 landed 8/12 and at 0.9 11/12. The gate adds no extra call, so latency did not go up.
- **[SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade) (breaking a question into smaller ones): tested and dropped.** We split thrust into several small questions. On single questions this scored better (166/180 vs 142/180), but it flew worse: v1 12/24, v2 9/18, v3 14/24. The default is still one `downward_thrust_magnitude` choice. Its "true = trouble" `noul` warnings exist only in `lander/modes/prose-decomp*.json` (`PROSE_FILE=`).

### A real call (final defaults, classic start seed 1)

Captured with `node lander/tools/capture.mjs` (full output: `results/capture-example.json`). Request to `/v1/systemone`:

```json
{
  "model": "tev1:4b",
  "state": "The pad is far off to your right, way in the distance. You are left of the pad.\nYou are drifting away from the pad, slowly.\nThe lander is at high altitude and is descending very slowly.\nThe ground between you and the pad is clear.",
  "questions": {
    "flight_direction": { "type": "choice", "instructions": "Determine whether to fly to the right or to the left to get over the pad", "criteria": { "right": "fly to the right, toward the pad that is off to your right", … } },
    "flight_velocity": { "type": "choice", "instructions": "Determine how fast to fly sideways based on how far off the pad is", "criteria": { "fast": "fly fast if the pad is far off or way in the distance", … } },
    "downward_thrust_magnitude": { "type": "choice", "instructions": "You are piloting a lunar lander. Determine the magnitude of the thrust needed …", "criteria": { "large": "…", "medium": "…", "small": "very little thrust is needed because the lander is at high altitude, or is descending slowly or very slowly", "none": "no thrust is needed because the lander is rising" } }
  },
  "keep_alive": "2h"
}
```

Response (probabilities rounded to 4 places):

```json
{
  "answers": {
    "flight_direction": { "choice": "right", "probabilities": { "right": 0.9958, "left": 0.0018, "none": 0.0024 }, "confidence": 0.9729 },
    "flight_velocity": { "choice": "fast", "probabilities": { "fast": 0.9637, "slow": 0.0330, "very_slow": 0.0025, "none": 0.0008 }, "confidence": 0.8782 },
    "downward_thrust_magnitude": { "choice": "small", "probabilities": { "large": 0.0004, "medium": 0.0044, "small": 0.9876, "none": 0.0077 }, "confidence": 0.9448 }
  },
  "usage": { "input_tokens": 804, "output_tokens": 0 }, …
}
```

How the code turns this into controls (`proseMap` in `lander/prose.mjs`):

- All three confidences are at or above 0.5, so the gate changes nothing (`gated: []`).
- Target sideways speed: direction right (+1) × speed fast (4 m/s) = **+4 m/s**. The ship is far from that speed, so it tilts **right**.
- Throttle is the probability-weighted sum over none 0 / small 0.3 / medium 0.55 / large 1: 0.0004·1 + 0.0044·0.55 + 0.9876·0.3 ≈ **30%**.
- Action: `burn_right`. This call took 1587 ms because it was a new scene with no prompt-cache hit.

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
