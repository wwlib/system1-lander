# Results and tuning history

Detailed landing tables, prompt-cache measurements, and prose-tuning history for [System 1 Lander](../README.md). Numbers are from the runs logged under `results/`; nothing here is invented.

## Headless mode comparison (GPU)

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

## Early findings (GPU prose / data / policy)

- **Prose + choice questions with option descriptions worked.** 6/6 with both models, one call per decision, the lowest latency of the three modes.
- **Prose where the model picks the raw controls failed.** Earlier "scene" variants (engine on/off, joystick, throttle levels; since removed) got 0/6 across many wordings. The model has to judge the situation, not fly the stick.
- **Policies change behavior, but loosely.** Editing only the policy text changed descent speed and fuel use. Numbers in the policy ("no faster than 3 m/s above 30 m") were followed far better than adjectives ("gentle").
- **The larger model was not better.** nimble:9b matched or trailed tev1:4b and was slower.
- **Latency is mostly prompt prefill.** It scales with input tokens and the number of calls, not with the answer. The data mode's many short calls cost more than one prose call.
- **Switching models costs a reload.** On a 12 GB GPU, switching between nimble:9b and tev1:4b reloads the model (~6–15 s for the first call). Use a long `keep_alive`.

## Pilot-loop results (Mac mini)

`lander/pilot-loop.mjs` sits between the model's answers and the engine. Everything in it is **plain code with fixed limits, not model behavior**.

Pilot-loop results (Mac mini Ollama, tev1:4b on the MLX runner (mxfp8); the Mac moved from Ollama 0.40.3 to 0.40.5 during this work, and these rows predate the 4/s default and the same-scene skip; tev1:4b, prose mode, random seeds 1–6). Latency is per call; with `DELAY_MS`, the delay is included.

| setting | landed | avg score | fuel left | actual rate | avg latency | flew away |
|---|---|---|---|---|---|---|
| rate 2, defaults | 5/6 | 5.95 | 56% | 1.7/s | 137 ms | 0 |
| **rate 5, defaults** | **5/6** | **5.50** | 60% | 3.8/s | 81 ms | 0 |
| rate 10, defaults | 4/6 | 4.62 | 61% | 7.5/s | 39 ms | 0 |
| rate max, defaults | 4/6 | 4.72 | 59% | 44.9/s | 11 ms | 0 |
| rate max, smoothing off | 5/6 | 5.57 | 59% | 45.1/s | 11 ms | 0 |
| rate max, everything off (old behavior) | 6/6 | 6.95 | 51% | 45.4/s | 11 ms | 0 |
| delay 600 ms, compensation on | 5/6 | 5.90 | 59% | 1.2/s | 758 ms | 0 |
| delay 600 ms, compensation off | 4/6 | 5.20 | 62% | 1.2/s | 752 ms | 0 |
| **delay 1200 ms, defaults** | **5/6** | **5.97** | 65% | 0.6/s | 1483 ms | 0 |
| delay 1200 ms, compensation off | 2/6 | 2.43 | 70% | 0.6/s | 1503 ms | 0 |
| delay 1200 ms, impulse limits off | 0/6 | 0.00 | 0% | 0.7/s | 1467 ms | 0 |
| delay 1200 ms, everything off (old behavior) | 0/6 | 0.00 | 0% | 0.6/s | 1695 ms | 1 |

The two bold rows use the current defaults. The other smoothing-on rows ran with an earlier 1.5 rad/s tilt limit; at rate 5 that limit landed 4/6 (score 4.72) against 5/6 with 2 rad/s, which is why the default is now 2. With a fast host, the old "as fast as possible, no smoothing" loop lands best; these six seeds can't tell the 5/6 settings apart. With a slow host, latency compensation and the impulse limits decide the outcome. Without the limits, a held burn emptied the tank on every flight (and one ship flew out of the world). Seed 1 is the usual crash in every setting: it drifts in sideways at just over 2 m/s.

## Prompt cache hits (Mac ~10 ms)

The very fast Mac latencies are mostly cache hits, not fast inference. Measured on the Mac mini (Ollama 0.40.5, tev1:4b, MLX mxfp8):

- An identical prose body comes back in about 5–11 ms. Ollama reports `prompt_eval_cached_count` 621 of 621 input tokens, so nothing is evaluated.
- A changed scene shares only about 200 cached tokens of the template. It takes about **1.2 s** (median of 8 distinct scenes: 1191 ms), and so does a body with only a random suffix added.
- Alternating between two scenes still hits for both, so several entries are cached.
- The answers follow the scene sensibly: pad left gives `left`, about to touch down falling very fast gives `large` thrust, rising gives `small`. A hit is always for the identical body, so its answer is never stale. The hello.mjs JSON states (about 160 tokens) take about 340 ms per new state.
- A cold call after unloading took 4.5 s.
- Flights: at 4/s, prose flights see about 9 unique scenes each, and 150 of 286 calls in six flights were skipped as the same scene. At `max`, a flight made about 1,660 calls for about 12 unique scenes, so over 99% of calls were cache hits.

### MLX vs llama.cpp Q8_0

MLX vs llama.cpp Q8_0 on the Mac (`tev1:4b` vs `tev1:4b-q8_0`, same answers on 90/90 probes):

- MLX: changed-scene median 16 ms (p90 2235 ms), repeat median 5 ms.
- Q8_0: changed median 1589 ms (p90 2209 ms), and a repeat still costs 1522 ms; this setup showed no cache benefit.

So on the Mac, a real new decision costs about 1.2 s, and the ~10 ms figure is the cache. The 4/s default and the same-scene skip avoid paying for repeats, and latency compensation covers the real ~1.2 s misses.

Flights at the 4/s default (Mac, seeds 1–6): landed 4/6, avg score 4.48, 72% fuel left, actual 1.7/s. The Mac was also serving gemma4:12b-mlx for another task at the time, and some calls stalled for 2–22 s.

## Prompt tuning and flat approach zones (Mac, tev1:4b, prose, random seeds 1–6, 4/s)

The Mac had only tev1:4b and a small embedding model loaded for most runs; gemma4:12b-mlx was loaded briefly during variant B. `tools/proseprobe.mjs` now also asks full in-flight scenes (pad sentence + altitude sentence, all three questions in one call, both sides).

| prose.json | probe dir / vel / thrust (isolated) | full scenes dir / vel / thrust (of 36) | landed | avg score |
|---|---|---|---|---|
| before | 9/9, 6/9, 12/20 | 33, 24, 18 | 4/6 | 4.85 |
| B: thrust criteria rewritten to match the probe | 9/9, 9/9, 17/20 | 33, 30, 34 | 1/6 | 1.40 |
| C: velocity wording only | 9/9, 9/9 (thrust as before) | 33, 30 (thrust as before) | 5/6, 5/6 | 5.70, 5.85 |
| D: C + "more thrust if the pad is far and the ship is low" in the instructions | – | – | 1/6 | 1.23 |
| **F: C + pad-aware `medium` criterion** | 9/9, 9/9, 13/20 | 33, 30, 21 | 5/6 | 5.60 |
| **F + flat approach zones** | | | **6/6** | **6.85** |

- **Direction was healthy all along.** Both sides got it right, in isolation and in full scenes. The only misses were `none` when about to touch down, where code levels the ship anyway. Rewording the direction criteria with "because the pad is to the right" broke it (4/9, with mirrored flips), so that wording was reverted.
- **Velocity:** "very near, just a little to one side" in the `very_slow` criterion fixed "very near → slow (2 m/s)", one cause of touching down sideways at more than 2 m/s.
- **Thrust: probe accuracy is not landing success.** Criteria that "fixed" the probe (medium when descending slowly near the ground, thrust while rising) made the ship hover until the tank was empty: medium (0.55) is above hover (0.41). The kept change only adds "or the pad is still far away and the lander is getting low" to `medium`, so the model weighs both sentences. That got seed 1, the usual crash, to land.
- **Flat approach zones** (`APPROACH` in `sim.mjs`): the model cannot see terrain. The ground is now pad height within 20 m of every pad edge (`PADS`), and the bumps grow back smoothly over the next 25 m. This applies to every start, random or fixed.

Logs: `results/batch21-*.log`.

## Horizontal prose, terrain clearance and touchdown leveling

Mac, tev1:4b, random seeds 1–6, 4/s.

- **Where the pad is.** The side is stated twice, as an impression rather than an instruction: "The pad is far off to your right. You are left of the pad." The bands are *directly above / close / a fair way / far / way in the distance*.
- **Drift relative to the pad** (`approach`): "You are drifting toward the pad, fast." / "…away from the pad, slowly." The old left/right drift sentence made direction worse, because fast drift flipped answers.
- **Terrain clearance** (`terrain`): code checks the highest ground between the ship and the target pad. The prose says "There is a ridge ahead, higher than you." / "…just below your height." / "The ground between you and the pad is clear." `medium` thrust also covers "a ridge ahead is higher than the lander".
- **Direction criteria name the side of the pad:** "fly to the right, toward the pad that is off to your right"; `none` is "…because you are directly above the pad".
- **Touchdown leveling** (pilot loop, **off by default**): within 4 m of the ground below, the tilt goes to center without waiting for a reply. Two earlier crashes were tilt ≥ 0.3 at touchdown, because a new-scene reply takes about 1.2 s. Kept as an optional assist after ablations showed the model can land without it once final-approach prose is in place.

`tools/dirprobe.mjs` is a mirrored direction probe: 160 flight scenes (5 distances × 5 drifts × 4 altitudes × both sides), with all questions in one call, as in flight.

| prose | pad right | pad left | directly above | mirrored pairs |
|---|---|---|---|---|
| before (committed b806f8f) | 75/80 | 70/80 | 40/40 | 95/100 |
| before + old drift sentence | 74/80 | 66/80 | 40/40 | 92/100 |
| new prose, old direction criteria | 78/80 | 76/80 | 40/40 | 92/100 |
| **new prose + new criteria (current)** | **80/80** | **80/80** | 40/40 | **100/100** |

Most "before" misses were `none` near touchdown when the pad was a fair way or more off to one side, more often on the left.

Flights with the current prose: **classic 6/6, avg score 6.60**, 60% fuel left. That is the same landing count as before (6/6, 6.85), and these six seeds can't separate the scores. More sentences mean more distinct scenes, so more calls miss the prompt cache: avg latency 414 ms, actual rate 1.7/s.

## Choose landing pad (`?pads=1` / `LAYOUT=pads`)

There are three pads, each with a sign: **NARROW ×2** (x 22–32), **WIDE ×1** (x 80–110) and **RIDGE ×3** (x 172–182, on a plateau 30 m up). Every pad, including the ridge, has a flat 20 m shoulder on both sides.

The model picks the target with its own `pad_choice` call (in `prose.json`). That call gets one sentence per pad, giving distance, side, height relative to the ship and whether a ridge is in the way, plus fuel and the current target. The criteria weigh reward against distance, fuel and difficulty. The pick is re-asked every 5 sim s, until the ship is near the target and low. Flight prose then describes the target pad, and the score is multiplied by the reward of the pad landed on. The HUD shows the target pad and its confidence, and the target pad is drawn bright with "▼".

| prose | landed | avg score (×reward) | pads landed on |
|---|---|---|---|
| first prose | 4/6 | 11.98 | wide, ridge ×3 |
| + touchdown leveling | 5/6 | 13.78 | narrow, wide, ridge ×3 |
| current prose | 5/6 | 11.13 | narrow, wide ×2, ridge ×2 |

- **The picks were sensible.** Ships starting near a pad chose it: x 42 → narrow, x 83 → wide, x 175 and 183 → ridge. With low fuel the model moves toward the nearest pad.
- **Picks were stable.** No flight switched pads; later re-asks confirmed the target at 0.9+.
- **One questionable pick in a probe:** directly above the ridge pad with 20% fuel, it chose the far wide pad (0.51 vs 0.41).
- **Crashes were touchdowns just off a pad edge.** Narrow pads are 10 m wide; one ship came down 2 m short of the wide pad.
- **Not the default.** The layout lands 5/6 against 6/6 for the classic pad, so it stays opt-in.

Logs: `results/batch22-*.log`.

## One line per sentence, and "low" starts higher

Mac, tev1:4b, random seeds 1–6, 4/s, all runs on the same evening.

- **State format.** The prose state now has one sentence group per line (`join('\n')`), for flight prose and the pad choice:

  ```
  The pad is far off to your left. You are right of the pad.
  You are drifting away from the pad, fast.
  The lander is near the ground (low altitude) and is descending slowly.
  There is a ridge ahead, just below your height.
  ```

  The game's System 1 panel and the playground already show the state with `white-space: pre-wrap`.
- **"Low" starts at 33 m** above the pad, not 25 m (`BANDS.alt`), so "near the ground (low altitude)" comes sooner and the thrust criteria ("…has low altitude…") apply earlier. The criteria wording did not need to change. `padChoiceDue` still treats 25 m as committed.

| run (classic) | landed | avg score | avg latency |
|---|---|---|---|
| baseline, same evening | 6/6 | 7.38 | 324 ms |
| newlines only (low 25 m) | 5/6 | 6.00 | 408 ms |
| low 33 m only (spaces) | 5/6 | 6.15 | 324 ms |
| both, run 1 (slow host, one flight averaged 2.6 s per call) | 3/6 | 3.40 | 655 ms |
| **both, run 2** | **6/6** | **6.93** | 339 ms |

| run (pads) | landed | avg score | pads landed on |
|---|---|---|---|
| baseline, same evening | 6/6 | 12.87 | narrow, wide ×3, ridge ×2 |
| **both** | **6/6** | **12.03** | narrow, wide ×3, ridge ×2 |

The single-change crashes were all seed 1: horizontal speed at touchdown (vx 2.3–3.4 m/s). On these six seeds the new format is about neutral. It lands as well as the baseline, but scores run slightly lower and vertical touchdown speed did not improve. Run-to-run spread is as large as the difference.

Logs: `results/batch23-*.log`.

## Final approach: its own scene and questions

Mac, tev1:4b, random seeds 1–6, 4/s, each config run twice (host noise).

When the ship is **below 18 m above the target pad and within 15 m of its edges** (`inFinalApproach()`), `perceive()` switches to a final-approach scene. It is still only a description of what the pilot would see:

```
Your legs are over the pad, near its left edge; the middle of the pad is just off to your right.
You are a few meters above the pad.
You are dropping fast.
You are sliding sideways quickly to the left, toward the pad's left edge.
You are upright.
```

- **Legs vs pad edges:** over the middle / near an edge (the middle is off to one side) / past an edge over rough ground / short of the pad (the pad is a short way off to one side).
- **Height:** some way above, coming in to land (≥ 13 m) / a little way / a few meters / a couple of meters / almost touching (< 1.5 m).
- **Sink:** rising / settling gently (< 1.2 m/s) / sinking steadily / dropping fast / dropping hard (≥ 3.5 m/s).
- **Slide:** nearly still / sliding slowly / sliding / sliding sideways quickly (≥ 1.8 m/s), toward the middle of the pad, toward an edge, or away from the pad.
- **Lean:** upright / leaning left / leaning right.

In the zone, the questions come from `final_approach` in `prose.json`, with the same three keys, so `proseMap()` and the code safety limits stay unchanged. Their criteria are phrased in terms of these impressions. The state has no instructions.

Iterations (12 flights per layout each):

| version | classic landed | pads landed | mean \|vx\| / max | mean \|vy\| / max | off-pad |
|---|---|---|---|---|---|
| baseline (no final scene) | 11/12 (6.87, 5.95) | 12/12 (12.83, 12.92) | 0.73 / 3.76 classic | 2.68 / 3.56 classic, 2.76 pads | 0 |
| v1: zone 14 m, ±6 m | 10/12 | 12/12 | 0.67 / 2.43 | 1.76 | 0 |
| v2: zone 18 m, ±15 m, "short of the pad" | 12/12 | 11/12 | 0.33 / 1.35 | 1.70 / 1.55 | 1 |
| v3: + "the middle of the pad is off to your right" | 12/12 | 10/12 | 0.50 / 1.31 | 1.60 / 1.67 | 2 |
| **v4: + slide criteria (hold still while sliding), middle band 60%** | **12/12 (7.97, 8.48)** | **12/12 (14.08, 14.95)** | 0.32 / 0.45 classic, 0.18 / 0.65 pads | 1.76 / 2.46 classic, 1.81 / 2.40 pads | 0 |

- **Vertical touchdown speed fell from about 2.7 to 1.8 m/s,** because "dropping fast / dropping hard" in the last meters draws large thrust. Scores went up: classic averaged 6.4 before and 8.2 after; pads averaged 12.9 before and 14.5 after.
- **Sideways crashes went away.** In the baseline, seed 1 crashed with vx 3.8. In v1 the zone was too small: the ship came in at 3.7 m/s and had no time to slow down, so v2 widened it.
- **Off-pad misses on the narrow pads came from v2 and v3.** "Near its left edge" alone made the model pick "left". Saying which side the middle is on, and holding still while sliding, fixed it in v4.

The game's call history also lists the pad-choice call as its own **pad choice** entry, with the full request body and response, and it counts in the call count.

Logs: `results/batch24-*.log` (base = before, v4 = kept).

## Code-assist ablations (Mac mini, tev1:4b, prose, 4/s)

Each assist has its own switch in `lander/pilot-loop.mjs`. Summaries from `node lander/tools/batchtable.mjs` over the logs under `results/`. **Batch25 run-1** ran while another agent held a heavy audio job — treat those flights as contended. **Batch25 run-2** is the uncontended single-assist-off set. **Batch26** is after the final-approach prose / thrust-criteria work (`d36e207`, `2a9c495`, `090915b`).

### Batch25 run-2 (uncontended): one assist off at a time

| config | layout | landed | avg score | fuel left | failures |
|---|---|---|---|---|---|
| all (everything on) | classic | **6/6** | 8.22 | 54% | – |
| all | pads | **6/6** | 14.08 | 64% | – |
| climb0 | classic | **6/6** | 8.23 | 54% | – |
| climb0 | pads | **6/6** | 15.13 | 63% | – |
| lease0 | classic | **6/6** | 8.13 | 34% | – |
| lease0 | pads | 5/6 | 12.55 | 37% | 1 vy (fuel out) |
| level0 | classic | **6/6** | 8.43 | 55% | – |
| level0 | pads | 4/6 | 9.70 | 62% | 2 tilt |
| predict0 | classic | **6/6** | 6.98 | 56% | – |
| predict0 | pads | 5/6 | 11.18 | 63% | 1 off-pad |
| smooth0 | classic | **6/6** | 8.32 | 52% | – |
| smooth0 | pads | 4/6 | 8.18 | 64% | 1 vx, 1 off-pad |
| stale0 | classic | **6/6** | 8.07 | 55% | – |
| stale0 | pads | **6/6** | 14.43 | 62% | – |
| off (all assists off) | classic | 2/6 | 2.50 | 7% | 4 fuel-outs |
| off | pads | 4/6 | 10.80 | 41% | 2 fuel-outs |

Classic with any single assist off: **all 6/6**. All-off still burned out of fuel on several flights (pre–thrust-criteria prose).

### Batch26: steering assists off vs all off (after prose / criteria)

Lease and touchdown leveling are the **steering** assists (they push toward a gentle descent / level touchdown). The new **defaults turn them off**. Smoothing, predict, stale discard, and climb guard stay on.

| config | layout | runs | landed | avg score | fuel left | failures |
|---|---|---|---|---|---|---|
| **thrust-nosteer** (lease + level off) | classic | 2 | **11/12** | 6.96 | 38% | 1 tilt |
| **thrust-nosteer** | pads | 2 | **11/12** | 13.27 | 39% | 1 tilt+off-pad |
| final-nosteer (same assists; later thrust wording) | classic | 2 | **11/12** | 6.79 | 46% | 1 off-pad |
| final-nosteer | pads | 1 | **5/6** | 10.27 | 52% | 1 off-pad |
| **final-off** (all assists off) | classic | 2 | 6/12 | 3.22 | 39% | 5 tilt, 1 off-pad |
| **final-off** | pads | 2 | 5/12 | 5.53 | 50% | tilt / off-pad / flew-away (no fuel-outs) |

**Headline:** steering assists off (new default) **22/24** on thrust-nosteer; all assists off **11/24** with **no fuel-outs**. The gap left with all-off is mostly smoothing / prediction / the other non-steering assists, not burn lease or touchdown leveling.

Logs: `results/batch25-ablation-*.log`, `results/batch26-thrust-nosteer-*.log`, `results/batch26-final-nosteer-*.log`, `results/batch26-final-off-*.log`. Table helper: `lander/tools/batchtable.mjs`.

## Batch27: decomposed thrust and the confidence gate (Mac mini, tev1:4b, prose, seeds 1–6, 4/s)

Each answer carries a `confidence` field. The gate marks an answer unsure when its confidence is below `CONFIDENCE_CUTOFF`. `GATE_MODE` then picks what happens: `hold` keeps the previous command, `rollup` moves one level up the choice's hierarchy (no second call), and `blend` uses the probability-weighted mix of the options. Throttle is always the probability-weighted mix, so in practice `blend` only changes the sideways target.

| config | layout | runs | landed | avg score | touch \|vx\| | avg latency |
|---|---|---|---|---|---|---|
| base (single thrust choice, gate off) | classic | 2 | 11/12 | 6.38 | 0.66 | 480 / 538 ms |
| base | pads | 2 | 9/12 | 9.17 | 0.24 | 1004 / 935 ms |
| **gate-blend-0.5** | classic | 2 | **12/12** | 7.20 | 0.23 | 545 / 493 ms |
| **gate-blend-0.5** | pads | 2 | **12/12** | 13.38 | 0.17 | 588 / 766 ms |
| gate-blend-0.7 | classic | 1 | 4/6 | 4.82 | 0.40 | 396 ms |
| gate-blend-0.7 | pads | 1 | 4/6 | 10.05 | 0.49 | 766 ms |
| gate-blend-0.9 | classic | 1 | 6/6 | 7.58 | 0.09 | 412 ms |
| gate-blend-0.9 | pads | 1 | 5/6 | 10.80 | 0.30 | 828 ms |
| gate-hold-0.5 | classic | 1 | 5/6 | 6.08 | 0.85 | 537 ms |
| gate-hold-0.5 | pads | 1 | 5/6 | 10.27 | 0.53 | 697 ms |
| gate-rollup-0.5 | classic | 1 | 5/6 | 6.08 | 0.63 | 497 ms |
| gate-rollup-0.5 | pads | 1 | 5/6 | 11.62 | 0.36 | 683 ms |
| decomp (v1) | classic | 2 | 8/12 | 4.71 | 0.46 | |
| decomp (v1) | pads | 2 | 4/12 | 6.16 | 0.06 | |
| decomp2 | classic | 2 | 8/12 | 4.13 | 0.84 | |
| decomp2 | pads | 1 | 1/6 | 3.40 | 0.00 | |
| decomp3 (thrust table) | classic | 2 | 6/12 | 3.63 | 0.30 | |
| decomp3 | pads | 2 | 8/12 | 7.72 | 0.52 | |

**Totals:** base 20/24. Gate blend 0.5 24/24, blend 0.7 8/12, blend 0.9 11/12, hold 0.5 10/12, rollup 0.5 10/12. Decomposed thrust: v1 12/24, v2 9/18, v3 14/24. Decomposition did better on single questions (decompprobe 166/180 vs 142/180), but it flew worse every time.

**Cutoff sweep** (`lander/tools/gatesweep.mjs`, offline over the TRACE logs). In gate-off and blend logs, a cutoff of 0.5 marks about 35–45% of thrust answers unsure. At 0.7 the figure is 57–79%, and at 0.9 it is 80–90%. Above 0.5 the gate fires on most calls. We flew only 0.7 and 0.9, and only for blend, because blend was the best mode at 0.5. Neither beat 0.5, and since 0.9 landed more than 0.7, the difference between them is probably noise.

**Kept:** `GATE_MODE=blend`, `CONFIDENCE_CUTOFF=0.5` (new defaults). **Dropped:** decomposed thrust (defaults keep the single `downward_thrust_magnitude` choice), hold, and rollup. **Latency:** the gate makes no extra call. Mean latency was 739 ms for base and 598 ms for blend 0.5, and the gap is run-to-run noise. **Contention:** while these ran, other jobs were active on the Mac (simworld-drive, comfyui-studio scene-storyboard, a progression_batch). Only `tev1:4b` was loaded in Ollama. They may have added latency noise, but they used no other Ollama model.

Logs: `results/batch27-*.log`, `results/batch27-decompprobe.txt`. Example call: `results/capture-example.json` (`lander/tools/capture.mjs`).
