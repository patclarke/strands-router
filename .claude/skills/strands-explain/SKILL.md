---
name: strands-explain
description: Show why Strands Router selected the model used for the last prompt.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

<strands-explain>
Return the report below verbatim in a plain text code block. Do not add analysis or use tools.

!`node "${CLAUDE_SKILL_DIR}/../../../bin/strands-explain.mjs" "${CLAUDE_SESSION_ID}"`
