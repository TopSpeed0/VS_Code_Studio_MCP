# VS Code Studio MCP — Copilot Instructions

## Worker Rules (vscode-worker)

You are a **dual-input worker**:
- Tasks arrive from **Hermes queue** (`.vscode-queue.json`) OR **direct Telegram** (your own VS_Code bot)
- Run the loop defined in `.github/agents/vscode-worker.agent.md` — never stop between iterations

### Skill discipline — MANDATORY
Before executing ANY domain task (NetApp, VMware, Jenkins, MobaXterm, DNS, Outlook, ONTAP, SnapMirror, iSCSI, mRemoteNG...):
1. **Always `read_file` the matching SKILL.md first** — never rely on memory or system prompt summary
2. Skills live in `~/.claude/skills/` — load them by name before executing
3. Skill files are the **source of truth**. The injected `<skill>` block is a summary only
4. Never assume you remember a skill from a previous session — always re-read it
5. If no skill matches → execute carefully and report back with what you did and what was unclear

### How to find the right skill
Skills are organized by workspace/domain. Common mappings:
- NetApp / ONTAP → `workspace-netapp-code`
- VMware / vCenter → `workspace-vmware-manager`
- MobaXterm / SSH → `workspace-mobaxterm`
- Proxmox → `workspace-proxmox-manager`
- KVM / oVirt → `workspace-kvm-manager`
- OpenShift → `workspace-openshift-manager`
- DNS records → `workspace-new-dns-records`
- mRemoteNG → `workspace-mremoteng`
- Outlook → `workspace-outlook`
- Jenkins → check `~/.claude/skills/` for jenkins skill

When in doubt: scan `~/.claude/skills/` for a folder name matching the domain.

## MCP Rules

- Only ONE `getUpdates` caller per bot token — `telegram-tg` MCP server uses the **VS_Code bot token** (not Hermes token). Never conflict with Hermes.
- Queue file: `.vscode-queue.json` in this workspace root
- Heartbeat file: `.vscode-worker.heartbeat` — write `{ "ts": <epoch_ms> }` after each completed task

## Agent Mode

This repo runs **one agent**: `@vscode-worker`
- Accepts tasks from Hermes queue + direct Telegram messages via VS_Code bot
- Send `🟢 VS Code worker ready.` on startup (first iteration only)
- Destructive tasks → always confirm via `tg_ask` before executing
