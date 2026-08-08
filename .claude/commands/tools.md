---
description: List the Whatbox MCP tools, grouped by category and risk, with current mutation state
---

Call the `whatbox_list_tools` MCP tool (or read the `whatbox://guide/tools`
resource) and present the result to the user as a grouped list:

1. State clearly at the top whether remote mutations are currently **enabled**
   or **disabled** (`mutationsEnabled`). If disabled, note that only read-only
   and planning tools will actually run, and that enabling requires setting
   `WHATBOX_MUTATIONS_ENABLED=true` in the private local configuration.
2. Group the tools by `category` in this order: meta, observe, files, backup,
   delete, services, website, torrents.
3. For each tool show its name, one-line summary, and risk:
   - `read_only` — safe, no changes.
   - `reversible` — changes state but is undoable; auto-runs when mutations are enabled.
   - `destructive` — **always** prompts for explicit human approval, even in
     auto-mode. Deletion quarantines first; permanent purge is a separate second approval.
4. Do not invent tools that are not in the returned catalog.

If `$ARGUMENTS` names a category (e.g. `torrents`) or the word `destructive`,
filter the list to just those entries.
