# Session Sharing Onboarding Prompt

This is the prompt that a team member pastes into Claude Code to set up session sharing.
The admin generates the invite code with `gated-knowledge team create`.

## For the team member

Copy-paste this into Claude Code, replacing `<INVITE_CODE>` with the code from your admin:

---

Настрой мне шаринг сессий с командой. Вот invite-код: <INVITE_CODE>

---

That's it. Claude will:
1. Ask your name
2. Open browser for Google Drive authorization (one click)
3. Configure everything automatically

## What Claude does under the hood

When Claude sees a `gk_` invite code, it runs:

```bash
gated-knowledge init sessions --team <INVITE_CODE> --name "<Name>" --id <slug>
```

This:
1. Decodes the invite code (team name, OAuth client, Drive folder ID)
2. Opens browser → Google OAuth consent → user clicks "Allow"
3. Stores permanent Drive refresh token in OS keychain
4. Configures session sharing (which projects to share, auto-share settings)
5. Scans local sessions

## Optional: specify which projects to share

```
Настрой мне шаринг сессий: <INVITE_CODE>
Шарь только проекты: skillset-backend, skillset-frontend
```

Claude will add `--projects skillset-backend,skillset-frontend` flag.

## For the admin

### Prerequisites
1. Google Cloud project with OAuth consent screen configured
2. OAuth client ID (Desktop app type) — same one used for Gmail auth
3. A shared folder on Google Drive

### Generate invite code

```bash
gated-knowledge team create
```

Interactive prompts:
- Team name
- Shared Drive folder ID
- OAuth client credentials (auto-detected from existing Gmail auth, or provide client_secret.json)

Output: `gk_eyJ0ZWFt...` invite code to share with team.

### Alternative: without Google Cloud

If the team doesn't have Google Cloud:

1. Each member installs gated-knowledge + session-snapshot
2. Each runs `gated-knowledge init sessions` (local only, no sharing)
3. Sessions are searchable locally via `session_list` and `session_search`

Sharing can be added later by running `gated-knowledge init sessions --team <code>`.
