# `strands-claude` architecture

```mermaid
flowchart TB
  user([User]) --> command["`strands-claude`\nCLI wrapper"]

  subgraph launcher["Launcher — bin/strands-claude.mjs"]
    direction TB
    command --> env["Load environment\nprecedence: process env → .env → ~/.strands-router.env"]
    env --> find["Find `claude` executable on PATH"]
    env --> saved["Read existing ~/.claude/settings.json model\nfor later restoration and as the savings baseline"]
    find --> disabled{"STRANDS_DISABLE=1?"}

    disabled -- Yes --> direct["Spawn real Claude Code\nwithout routing"]
    disabled -- No --> health["GET /health on the local Decider\nwarn if down; send one warm-up question"]
    health --> proxyStart["Start ephemeral loopback proxy\n127.0.0.1:random-port"]
    proxyStart --> launchEnv["Set ANTHROPIC_BASE_URL to proxy\nExpose `strands-router` as Strands Router in /model\nDefault to `strands-router` unless user set ANTHROPIC_MODEL\nTurn on gateway hint headers"]
    launchEnv --> statusCfg{"Status line allowed?"}
    statusCfg -- "No: STRANDS_NO_STATUSLINE or user statusLine" --> spawn
    statusCfg -- Yes --> statusCfgFile["Write temporary Claude status-line settings"] --> spawn
    direct --> spawn["Spawn real Claude Code\nwith original CLI arguments"]
  end

  spawn --> claude["Claude Code\n(native UI, login, tools, sessions, permissions)"]
  claude --> picker{"/model selection"}
  picker -- "Strands Router" --> auto["model: `strands-router`\n(routing sentinel)"]
  picker -- "Concrete model" --> manual["model: user-selected model"]
  auto --> loopback
  manual --> loopback

  subgraph proxy["Loopback proxy — src/proxy.mjs"]
    direction TB
    loopback["Receive HEAD or /v1/messages request"]
    loopback --> head{"HEAD probe?"}
    head -- Yes --> headOK["Return 200"]
    head -- No --> parse["Parse request body\nOptionally dump body with STRANDS_DUMP\nNormalize legacy MCP JSON schemas"]
    parse --> mode{"model is `strands-router`?"}

    mode -- No --> pass["Leave model unchanged\nFor agent requests, publish manual status"]
    mode -- Yes --> conversation["Build conversation key\nsession ID + first-message text\nKeep up to 50 independent states"]
    conversation --> fresh{"Fresh user turn?\nhint headers: not compaction/auxiliary,\nprompt id changed\nfallback: tool-bearing, last user text,\nnot a tool-result continuation"}
    fresh -- No --> pinned["Reuse tier pinned for this conversation\n(default: opus)"]
    fresh -- Yes --> prompt["Remove system-reminder blocks\nEstimate context tokens"]
    prompt --> decider
    decider --> policy
    policy --> saveTier["Pin chosen tier in conversation state"]
    saveTier --> pinned
    pinned --> rewrite["Rewrite `strands-router` to Claude tier model ID\nStrip unsupported thinking / effort fields"]
    rewrite --> publish["Write latest tier, confidence, and reason\nto per-session temp status file"]
    pass --> forward
    publish --> forward["Forward request to api.anthropic.com\nPreserve Claude Code authorization headers\nRequest an uncompressed stream so usage can be read"]
  end

  subgraph routing["Routing — src/router.mjs + src/policy.mjs"]
    direction TB
    decider["Local Strands Decider POST /v1/systemone\n(127.0.0.1:8000, no API key, nothing leaves the Mac)\nSends only the fresh user prompt plus:\ncurrent model, approximate context, available models"]
    policy["Policy resolves final tier\n• prompt override wins\n• failure / malformed answer: keep current\n• low confidence: no downgrade; upgrades capped at sonnet\n• large context: no downgrade that rebuilds cache\n• unavailable tier: choose nearest stronger available\n• fable requires STRANDS_ALLOW_FABLE=1"]
  end

  forward --> anthropic["Anthropic API"]
  anthropic --> tee

  subgraph accounting["Savings — src/usage.mjs + src/pricing.mjs + src/accounting.mjs"]
    direction TB
    tee["Stream response to Claude Code unchanged\nwhile reading token usage from SSE events"]
    tee --> price["Price usage on the served model\nand again on the baseline model"]
    price --> ledger["Append to ~/.strands-router/usage.jsonl\n(no prompt or response text)"]
    price --> sessionTotals["Update per-session running totals"]
  end
  tee --> claude

  subgraph visibility["Routing visibility — status.mjs + strands-statusline.mjs"]
    direction TB
    statusFile["Temp files: $TMPDIR/strands-claude/<session>.json\nand <session>-savings.json"]
    statusLine["Claude Code status-line command\nRenders model + confidence (or ⏸ manual)\nand 'saved $X (Y%)' for the session"]
    statusFile --> statusLine
  end
  publish --> statusFile
  pass --> statusFile
  sessionTotals --> statusFile
  statusLine --> claude
  ledger --> report["`strands-savings` report\ntotals, by model, by CLI, by day"]

  spawn --> exit["On process exit: close proxy\nand restore saved model only if it is still `strands-router`"]
```

The routing call happens only for the first request of a user turn. Tool-loop continuations reuse
the pinned tier, avoiding repeated routing latency and model changes mid-task. A concrete model
chosen in Claude Code bypasses routing until the user selects **Strands Router** again; those
requests are still recorded in the ledger, with zero savings, so totals reflect the whole session.
