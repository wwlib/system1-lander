# Code walkthrough

A short map for finding the model calls. Every call ends up in one place on the server; the browser never talks to the model directly.

Each file starts with a comment saying what it is for, and has `// @ts-check` with JSDoc types. `jsconfig.json` turns on type checking in editors. There is no build step and there are no dependencies: the pages load plain ES modules.

## One decision, end to end

1. **Browser (`lander/game.js`, loaded by `lander/index.html`).** `ask()` sends the current ship state to the game's server as `POST /decide`. When the reply arrives, `applyDecision()` puts the chosen controls on the ship, and `renderHow()` fills the right-hand "how the model sees it" panel. `frame()` runs the physics and drawing on every animation frame. Between the reply and the engine sits the pilot loop (`lander/pilot-loop.mjs`, `createPilotLoop()`): `shouldSend()` enforces the decision rate in sim time, `send()` picks the state to send (predicted ahead with `predictShip()` when latency compensation is on), `receive()` sets the targets or discards a reply that is too old, and `stepShip()` eases the controls toward the targets and applies the burn lease and climb guard before calling `step()`.
2. **Server routes (`lander/server.mjs`).** `route()` sends `/decide` to `handleDecide()`, which calls `decide()`. `decide()` picks the mode: `decideProse()`, `decideData()` or `decidePolicy()`.
3. **The model call.** In prose mode, `decideProse()` first reuses the last answer when the body is identical and under 1 sim-second old (the same-scene skip). Otherwise each mode builds its request and calls `call()` in `server.mjs`. That calls `post()`, which tries the primary host and falls back to the secondary (`fallbackHostFor()`). The single `fetch` to `/v1/systemone` is `send()` in `lander/providers/index.mjs`, which also defines how each provider (Ollama, Jev, Microsoft Decision-1, OpenRouter) wants its request shaped.

```mermaid
flowchart LR
  A["game.js ask()"] -->|POST /decide| B["server.mjs decide()"]
  B --> C["decideProse / decideData / decidePolicy"]
  C --> D["call() then post()"]
  D --> E["providers send()"]
  E -->|POST /v1/systemone| F[(Ollama or other provider)]
  F --> D --> A
```

## Prose mode (the default)

- `lander/prose.mjs`. `perceive()` turns the physics into plain sentences (`padSentence()`, `altSentence()`, `driftSentence()`, using the `BANDS` table); this is the part standing in for a vision model. `proseMap()` turns the model's choices into a target sideways speed, a tilt and a throttle.
- `lander/modes/prose.json` holds the three choice questions and their option descriptions, sent as-is.

## Everything else

- **Physics and scoring:** `lander/sim.mjs`. `step()` moves the ship, `landingScore()` scores a landing, `randomStart(seed)` makes a random start (seeded by `createSeededRandom()`), and `dataMap()` / `dataThrust()` are the data mode's lookup tables. The data mode's yes/no questions are `DATA_QUESTIONS`, asked in order.
- **Policy mode:** `lander/policy.mjs` builds the ship JSON (`shipJSON()`), defines the four questions (`POLICY_QUESTIONS`) and maps answers to controls (`policyMap()`). Policy texts are in `lander/modes/policies/`.
- **Playground:** `lander/playground.js` (loaded by `lander/playground.html`) calls the server's `/api/systemone` route. On the server, `playground()` checks the body with `validateBody()` and forwards it with `send()`. The examples come from `lander/examples.mjs`.
- **Styles:** `lander/game.css` and `lander/playground.css`.
- **Providers and config:** `lander/providers/index.mjs` (`hostTable()`, `send()`) and `lander/env.mjs` (reads `.env`).
- **Without a browser:** `lander/tools/headless.mjs` flies the game from the command line by calling `decide()` directly (`flyOne()` per start), through the same pilot loop in sim time (env `DECISION_RATE`, `SMOOTHING`, `LATENCY_COMP`, `IMPULSE_LIMITS`, `DELAY_MS`). `lander/tools/proseprobe.mjs` tests the prose questions on single sentences. `hello.mjs` is the bare `/v1/systemone` call with nothing around it.
