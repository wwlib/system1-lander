# System 1 Lander

A lunar lander flown in real time by a small **System 1 decision model** through Ollama's `POST /v1/systemone`. The request is a `state` plus `questions` (`noul` yes/no, `choice`, `score`). The reply is the answers with their probabilities, from a single forward pass, with no text generation. Node ≥ 20, no dependencies.

![Lander in prose mode after a random-start landing scored 7.9, with the System 1 panel showing the prose sentences, choice probabilities, code mapping and request](docs/screenshot-landed.png)

## Run it

```bash
cp .env.example .env        # set OLLAMA_URL (and optionally OLLAMA_URL2 as a fallback host)
ollama pull tev1:4b         # also tried: nimble:9b, tev1:0.8b
npm start                   # game at http://localhost:8787, playground at /playground
npm run headless            # fly 4 starts without a browser (EXTRA=2 → 6 starts; VARIANT=data|policy:careful|…)
npm run hello               # minimal /v1/systemone example
npm run check               # syntax-check everything
```

`.env` sets the server (`PORT`, `MODEL`, `VARIANT`) and the hosts. Real environment variables override `.env`.

## The three modes

| mode | id | what the model gets → what it decides |
|---|---|---|
| **Prose input (choice questions)** (default) | `prose` | Two prose sentences ("The pad is far to the right. The lander is near the ground (low altitude) and is descending fast.") and 3 `choice` questions with option descriptions (fly direction, fly speed, thrust magnitude). One call per decision. Questions are in `lander/modes/prose.json`. |
| **Data input (yes/no fact checks)** | `data` | A chain of tiny yes/no fact questions about rounded numbers ("Is fall_speed_mps greater than 5?"). One call per fact, up to ~8 per decision. |
| **Policy (plain-English rules)** | `policy:careful` / `fuel-miser` / `aggressive` | A policy text (`lander/modes/policies/*.txt`) plus ship JSON, and 4 judgment questions ("Is the ship falling faster than the policy allows?"). Probabilities are used as graded values. |

In every mode, **code** maps the answers to controls with a small fixed table, shown in the game's System 1 panel. The prose sentences are written by code from the physics, using fixed bands. **They stand in for a vision model**; no vision model is used. To change behavior, edit `prose.json` or a policy file; no code change is needed.

## Results

Headless, 1× time scale (decisions apply after their real latency), 6 starts per row. One NVIDIA RTX 4070 SUPER (12 GB) running Ollama.

| mode | model | landed | avg score | fuel left | ms / decision |
|---|---|---|---|---|---|
| prose | tev1:4b | **6/6** | 7.68 | 47% | 251 |
| prose | nimble:9b | **6/6** | 6.98 | 45% | 310 |
| data | tev1:4b | **6/6** | 7.87 | 28% | 747 |
| policy (careful / fuel-miser / aggressive) | tev1:4b | 1–2/6 | 1.1–1.5 | 44–71% | ~390 |
| prose, **random starts** (seeds 1–6) | tev1:4b | **6/6** | 8.18 | 45% | 327 |

Random starts: x 15–185 m, altitude 50–140 m above the pad, vx ±3 m/s, vy −4…+1 m/s, tilt ±0.15 rad, full fuel (`randomStart(seed)` in `sim.mjs`). In the game, tick **Random start** or use `?random=1` / `?seed=N`. Headless: `RANDOM_START=1 SEED=1 COUNT=6`.

Logs: `results/batch18-criteria.log` (prose), `results/batch20-random-start.log` (random starts), `results/batch17-policy.log` (policy), `results/batch19-verify.log` (prose re-run after the cleanup: 6/6, 7.55, 243 ms). Older `results/` logs are from earlier experiments that have since been removed (see git history).

## What this shows, and what it doesn't

- **Shown:** a small decision model can fly the lander by making **judgments from prose** ("the pad is far to the right" → fly right, fast). Code only maps the named choices to controls.
- **Not shown:** that the model does the control. Code still turns the choices into a target speed, tilt and throttle. The prose comes from code, not from a camera.
- **Small sample:** 6 starts per configuration, one GPU, one physics setup. Treat the differences between the 6/6 rows (score, fuel) as indicative only.

## Key findings

- **Prose + choice questions with option descriptions worked.** 6/6 with both models, one call per decision, the lowest latency of the three modes.
- **Prose where the model picks the raw controls failed.** Earlier "scene" variants (engine on/off, joystick, throttle levels; since removed) got 0/6 across many wordings. The model has to judge the situation, not fly the stick.
- **Policies change behavior, but loosely.** Editing only the policy text changed descent speed and fuel use. Numbers in the policy ("no faster than 3 m/s above 30 m") were followed far better than adjectives ("gentle").
- **The larger model was not better.** nimble:9b matched or trailed tev1:4b and was slower.
- **Latency is mostly prompt prefill.** It scales with input tokens and the number of calls, not with the answer. The data mode's many short calls cost more than one prose call.
- **Switching models costs a reload.** On a 12 GB GPU, switching between nimble:9b and tev1:4b reloads the model (~6–15 s for the first call). Use a long `keep_alive`.

## Playground

`/playground` sends any `/v1/systemone` request through the server (no CORS issue; input is validated).
- **Request:** pick the host and model (listed from the host's `/api/tags`). Edit the state as JSON or prose, the questions as JSON, and `keep_alive`.
- **Results:** probability bars, score, latency and tokens, and the raw request and response. Run N times to see variance, or compare two models side by side.
- **Examples:** the three game modes, the original prose examples, hello.mjs, ticket triage and a tool-call safety check.
- **From the game:** "open latest call in playground" loads the current call.
- **URL params:** `?example=<id>&model=<name>&compare=<name>&run=1` loads and sends an example; `?redact=1` (game or playground) masks host IPs, for screenshots.

![Playground: an original prose example on tev1:4b, choice probabilities as bars](docs/screenshot-playground.png)

## Using other providers

`lander/providers/index.mjs` has adapters for TypeSafe Jev and Microsoft Decision-1 (Azure Foundry and OpenRouter). They are written from public docs and are **untested** (no keys). Only Ollama is tested. Configure them in `.env`; they show up in the host dropdowns.

## Layout

For where the model calls happen, see the [code walkthrough](docs/code-walkthrough.md).

```
lander/server.mjs        HTTP server, the 3 modes, playground proxy (/api/systemone, /api/models, /api/examples)
lander/sim.mjs           physics + data-mode questions (shared with the browser)
lander/prose.mjs         perception bands → prose sentences, prose-mode control map
lander/policy.mjs        policy-mode questions and map
lander/modes/            prose.json, policies/*.txt (edit these to change behavior)
lander/index.html        game page: game.js (logic), game.css
lander/playground.html   playground page: playground.js, playground.css
lander/tools/            headless.mjs (fly), proseprobe.mjs (offline question probe)
```

## License

MIT © 2026 Andrew Rapo — see LICENSE
