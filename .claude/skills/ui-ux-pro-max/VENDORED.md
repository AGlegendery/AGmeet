# Vendored skill

Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT)
Version: 2.13.0
Commit: 4aad0584d92131626b16d4ff4d77f0455385013c
Vendored: 2026-09-08

Copied verbatim from the upstream `.claude/skills/ui-ux-pro-max/` tree, with one change:
the script invocations in `SKILL.md` used `${CLAUDE_PLUGIN_ROOT}/...`, which is only
defined for a Claude Code *plugin* install. This is a project skill, so the paths were
rewritten to be project-root relative (`.claude/skills/ui-ux-pro-max/scripts/search.py`).

To update: re-copy the upstream skill directory and re-apply that path rewrite.
