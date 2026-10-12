# strands-router

Automatic per-turn model routing for Claude Code and OpenAI Codex, decided **locally** by
[Strands Decider 2B](https://github.com/strands-labs/strands-decider) running on your Mac, with
a ledger of the **dollars it saves**.

This is a fork of [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router). Instead of
calling TypeSafe's hosted Jev model, it asks a Strands Decider server on `127.0.0.1`, so no API key
is needed and your prompts never leave your machine for the routing decision. It also prices every
response twice — as the model that served it, and as the model you'd have used without routing —
so you can see exactly what routing is worth.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `strands-claude` | Claude Code | Existing `claude login` | Status line, with session savings |
| `strands-codex` | OpenAI Codex | Existing `codex login` | Commentary line |
| `strands-savings` | Terminal report | — | Totals by model, CLI and day |

Both launchers run the real upstream CLI. The decider only chooses the model for a fresh user turn.

## Why this works as a drop-in for Jev

Strands Decider ships an HTTP server that exposes `POST /v1/systemone`, following the public Jev
request and response shape (`state` + named `noul` / `choice` / `score` questions in, typed
answers with confidence out). The Strands team states that JevBench's TypeSafe adapter runs
against it unchanged, but also that *compatibility with the Jev API itself is not verified*.
In practice one difference mattered for this router: Decider requires each `choice` option's
description to be a **string**, while jev-router sent objects. This fork flattens them; the
request it builds has been validated against Decider's own pydantic schema
(`strands_decider/schema.py`), and `test/router.test.mjs` pins that shape.

## Quick start (macOS, Apple silicon)

Requires Node.js 20.12+, Python 3.10+ (`brew install python@3.12`), and
[Claude Code](https://code.claude.com/docs/en/setup) and/or
[OpenAI Codex](https://developers.openai.com/codex/cli).

```bash
git clone https://github.com/patclarke/strands-router.git
cd strands-router
npm link                         # installs strands-claude, strands-codex, strands-savings

scripts/decider.sh install       # venv in ~/.strands-router/venv + pip install strands-decider
scripts/decider.sh serve         # first run downloads the model from Hugging Face (a few GB)
```

In a second terminal:

```bash
scripts/decider.sh check         # one test question against the running server
node scripts/live-routing.mjs    # labelled routing benchmark through the router's own code
strands-claude                   # or: strands-codex
```

To keep the decider running in the background and start it at login (launchd):

```bash
scripts/decider.sh autostart     # logs: ~/.strands-router/logs/decider.log
scripts/decider.sh stop          # remove the launchd job
```

The server auto-detects the device (`cuda` > `mps` > `cpu`). `decider.sh serve` runs Strands'
own server app through `scripts/serve_decider.py`, which keeps every model call on one thread
(the stock `strands-decider serve` segfaulted on an Apple-silicon Mac when requests landed on
different threads) and pays the one-off GPU warm-up (~35 s measured) before it starts listening.

**Routing adds about half a second to the first request of each turn on a Mac** (median 463 ms
measured with the default question). The model goes cold when idle: on an Apple-silicon Mac a
question took 1 s right after another but 11–14 s after a few idle minutes. So the server runs a
tiny keep-warm question whenever it has been idle for 20 s (`STRANDS_DECIDER_KEEPWARM`, `0` turns
it off), which keeps the GPU lightly busy while the server runs. If the decider isn't running or
doesn't answer within `STRANDS_DECIDER_DEADLINE_MS`, routing fails open (the current model is
kept); usage and savings are still recorded.

If serving misbehaves, `scripts/decider.sh diagnose` runs the router's request against the model
in isolated processes (MPS with and without Decider's prefix cache, and CPU), times each, and
recommends settings.

No Anthropic or OpenAI API key is required when the CLI is already logged in. Every CLI argument
is forwarded:

```bash
strands-claude --resume
strands-claude -p "fix the failing test"
strands-codex exec "fix the failing test"
```

## Dollars saved

Every billed response that passes through the proxy is read for its token usage (uncached input,
5-minute and 1-hour cache writes, cache reads, output) as it streams to the CLI, then:

1. **Actual cost** — priced on the model that served it (as reported by the API).
2. **Baseline cost** — the *same tokens* priced on the model the session would have used without
   routing.
3. **Saved** = baseline − actual. A turn the decider routes *up* counts against the total, so the
   figure is the net value of routing.

One JSON line per response is appended to `~/.strands-router/usage.jsonl` (mode 600). It holds
model ids, token counts and dollars only — never prompt or response text.

```text
$ strands-savings --since 7d
Strands Router savings

  Without routing (baseline)       $41.2210
  With routing (actual)            $17.0384
  Saved                            $24.1826  (58.7%)

  212 routed turns: 131 to a cheaper model, 4 to a pricier one, 77 unchanged
  ...
  Served by                      Responses      Actual    Baseline       Saved
  claude-opus-5-5                      390    $12.1100    $12.1100     $0.0000
  claude-haiku-4-5                     544     $3.9210    $23.6100    $19.6890
  claude-sonnet-5-5                    201     $1.0074     $5.5010     $4.4936
```

(Illustrative output.) Options: `--since 24h|7d|30d|4w|today|all`, `--session <id>`, `--json`.
The Claude status line shows the running total for the current session:

```text
claude-haiku-4-5 (p=0.91) · saved $0.36 (75%) · my-project · 12% context
```

### What the baseline is

In order of precedence:

1. `STRANDS_BASELINE_MODEL` — an exact model id (`claude-opus-5-5`) or a tier (`opus`, `sonnet`).
2. For Claude, the default model saved in `~/.claude/settings.json` before the session started.
3. The strong tier (Opus / `gpt-5.6-sol`).

A Claude session **starts on the baseline model** and the decider moves it from there, so every
dollar in the ledger comes from a routing decision rather than from where routing happened to
begin. If your saved default is Fable, the long tier is enabled automatically so routing can stay
on Fable for big tasks (set `STRANDS_ALLOW_FABLE=0` to cap at Opus instead).

Requests where you picked a model yourself, and Claude Code's own background calls (titles,
summaries), are recorded with zero savings: routing didn't touch them, but they're part of what
the session cost.

### Caveats — read before quoting the number

- **Estimates at API list prices.** On a Claude Pro/Max or ChatGPT subscription you aren't billed
  per token; the figure is the API-equivalent value (and a proxy for how much of your usage
  allowance routing preserved).
- **Same tokens, different model.** A different model would have produced a different number of
  output tokens, and tokenizers differ between model generations. The baseline assumes the same
  usage, which is the standard simplification but not exact.
- **Cache effects.** Switching models invalidates the prompt cache, so a downgrade can cause cache
  *writes* the baseline would have served as cheaper cache *reads*. The router already refuses
  downgrades once a conversation is large (`downgradeMaxContextTokens`), and the extra writes are
  included in the actual cost — but the baseline prices those same writes at the baseline model's
  rate rather than as reads, so savings on a turn that switched models are somewhat overstated.
- **Prices drift.** Rates live in `src/pricing.mjs` (Anthropic list prices as of October 2026;
  OpenAI rates as community-reported, with sources disagreeing on `gpt-5.6-sol`). Override or add
  any model in `~/.strands-router/pricing.json`:

  ```json
  {
    "gpt-5.6-sol": { "input": 5, "output": 30, "cacheRead": 0.5 },
    "gpt-6-astra": { "input": 10, "output": 60, "cacheRead": 1 }
  }
  ```

  Values are USD per million tokens. Cache writes are billed at 1.25x (5-minute) and 2x (1-hour)
  of `input`. Responses on a model with no known price are counted and reported as *unpriced*
  rather than treated as free.

## Claude Code interface

`strands-claude` launches Claude Code with **Strands Router** selected in `/model`. Selecting
another model pauses routing; selecting **Strands Router** resumes it. An existing custom
`statusLine` is preserved; set `STRANDS_NO_STATUSLINE=1` to disable the injected one.

Run `/strands-explain` in `strands-claude` (or `$strands-explain` in `strands-codex`) to see the
factors behind the last routing decision, rendered locally from the saved System One exchange:

```text
┌─────────────────────────────────┐
│ Strands Router                  │
│                                 │
│ Decider request                 │
│ Prompt: explain the router      │
│ Current tier: HAIKU             │
│ Context tokens: 6200            │
│                                 │
│ Decider response                │
│ Task complexity     0.82        │
│ Reasoning required  0.91        │
│ Tool complexity     0.64        │
│ Context size        0.31        │
│                                 │
│ Recommended tier: SONNET        │
│ Selected model: SONNET          │
│                                 │
│ Confidence: 94%                 │
│ Decision: Decider's pick        │
└─────────────────────────────────┘
```

Up to 20 recent exchanges per CLI session are kept in `$TMPDIR/strands-claude/<session>.json`
(mode 600; deleted after 7 days idle). They contain prompt text.

> Choosing a model with `Enter` can save it as Claude Code's default. `strands-claude` restores
> the previous default on exit so `strands-router` cannot break plain `claude`.

## OpenAI Codex interface

`strands-codex` launches Codex with a temporary **Strands Router** provider. Each fresh decision
appears as Codex commentary:

```text
[Decider] routed this turn to gpt-5.6-luna (decider, confidence 0.91).
```

## How it works

```text
you -> Claude Code -> strands-claude proxy -> Anthropic
                          |        |
                          |        +-> usage -> pricing -> ~/.strands-router/usage.jsonl
                          +-> Strands Decider @ 127.0.0.1:8000: choose a model

you -> OpenAI Codex -> strands-codex proxy -> OpenAI
                          (same)
```

Each launcher starts a loopback proxy, launches the real CLI, and forwards the CLI's existing
authorization headers without reading, storing, or modifying them. See
[docs/strands-claude-architecture.md](docs/strands-claude-architecture.md) for the full flow.

## Routing policy

One decider call per fresh user turn picks an exact model from the account's catalog, mapped to
a tier:

| Tier | Claude Code default | Codex default |
| --- | --- | --- |
| Fast | Haiku | `gpt-5.6-luna` |
| Balanced | Sonnet | `gpt-5.6-terra` |
| Strong | Opus | `gpt-5.6-sol` |
| Long | Fable (opt-in) | `gpt-6-astra` (opt-in) |

`src/policy.mjs` then applies these rules (unchanged from jev-router):

- explicit requests such as `use opus`, `use luna`, or `use strong` win;
- failure, timeout, or an unrecognised answer keeps the current model;
- low confidence never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `STRANDS_ALLOW_FABLE=1`.

Decider's confidence is calibrated (Strands reports answers at ≥ 0.9 are right ~95% of the time on
unseen short classification tasks), but it was not trained on this routing question specifically.
If it downgrades too eagerly for your taste, raise `THRESHOLDS.minConfidence` in `src/config.mjs`.

### Question style

Decider is a general classifier, so how the question is phrased matters a lot. Two styles are
available (`STRANDS_QUESTION_STYLE`):

- `compact` (default): the bare prompt as the state, and one question with short `fast` /
  `balanced` / `strong` options. The answer is mapped to the newest model of that tier.
- `detailed`: jev-router's original question over every exact model in the account's catalog,
  with session context in the state. On real Mac hardware it answered with ~0.17 confidence,
  below the 0.3 the policy needs before it will move to a cheaper model, so it rarely saved anything.

The three complexity scores shown by `/strands-explain` aren't used for routing and add latency,
so they're off unless `STRANDS_DECIDER_METRICS=1`. `node scripts/live-routing.mjs` compares all
four combinations on labelled prompts, so you can check which works best on your machine.

## Configuration

Set in the environment, a `.env` in the launch directory, or `~/.strands-router.env`.

| Variable | Interface | Effect |
| --- | --- | --- |
| `STRANDS_DECIDER_URL` | Both | Decider server; default `http://127.0.0.1:8000`. |
| `STRANDS_DECIDER_TIMEOUT_MS` | Both | Per-attempt timeout; default 6000. |
| `STRANDS_DECIDER_DEADLINE_MS` | Both | Hard deadline for one routing call; default 6500. |
| `STRANDS_QUESTION_STYLE` | Both | `compact` (default) or `detailed`; see Question style. |
| `STRANDS_DECIDER_METRICS` | Both | `1` also asks the complexity scores for `/strands-explain`. |
| `STRANDS_BASELINE_MODEL` | Both | Model (or tier) savings are measured against. |
| `STRANDS_HOME` | Both | Ledger, pricing overrides, venv, logs; default `~/.strands-router`. |
| `STRANDS_DISABLE` | Both | `1` launches the CLI with no proxy at all. |
| `STRANDS_ALLOW_FABLE` | Both | `1` enables the opt-in long tier; on by default when your saved Claude default is Fable. |
| `STRANDS_DEBUG` | Both | Logs decisions, rewrites and per-response costs to `~/.strands-router.log`. |
| `STRANDS_DUMP` | Both | Dumps request bodies for debugging wire-format changes. |
| `STRANDS_NO_STATUSLINE` | Claude | Disables the injected status line. |
| `STRANDS_CODEX_{FAST,BALANCED,STRONG,LONG}_MODEL` | Codex | Override the Codex tier models. |

`scripts/decider.sh` also reads `STRANDS_DECIDER_CHECKPOINT` (default
`StrandsAgents/strands-decider-2B-hobson-v19`, the current reference model), `STRANDS_DECIDER_PORT`
and `STRANDS_DECIDER_DEVICE`.

## Development

```bash
npm test                         # no dependencies to install
node scripts/live-routing.mjs       # needs a running decider
node bin/strands-claude.mjs -p "what is 2+2?"
```

## Limitations

- Only Apple silicon Macs are practical: current PyTorch has no Intel-Mac wheels.
- Decider adds latency to the first request of a turn only; tool-loop continuations add none.
- To read usage, the proxy asks the API for uncompressed responses on billed requests.
- Claude Code and Codex request formats are not public contracts. Use `STRANDS_DUMP` to diagnose
  upstream changes.
- Strands Decider is an experimental 0.1.0 release; its own docs say v19 is "the reference model
  today" and that compatibility with the Jev API is not verified.

## Credits and license

Routing proxy, policy and CLI integration by the [jev-router](https://github.com/gargpratyush/jev-router)
contributors (MIT). Strands Decider by AWS Strands Labs (Apache-2.0). This fork is MIT.
