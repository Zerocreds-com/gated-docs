# Google Setup Guide

Complete guide to connecting Google services to gated-knowledge. One service account — access to everything.

## Step 0: Get a Google Cloud Project

Everything in Google Cloud lives inside a "project". You need one. It's free.

**Already have a project?** Skip to [Step 1](#step-1-create-service-account). Your project ID is in the URL when you open [Google Cloud Console](https://console.cloud.google.com/) — it's in the top bar next to "Google Cloud", or in the URL: `console.cloud.google.com/home/dashboard?project=YOUR_PROJECT_ID`.

**Don't have a project? Create one:**

1. Open [Create a Project](https://console.cloud.google.com/projectcreate)
   - If you've never used Google Cloud, you'll see a "Get started for free" page — click it, agree to terms. No credit card needed for free tier.
2. **Project name**: anything you want (e.g., `my-tools`, `personal-mcp`, `work-automation`)
3. **Organization**: leave "No organization" if using a personal Gmail. If you're on Google Workspace (company email), it may auto-select your organization — that's fine.
4. Click **Create**
5. Wait 10 seconds — your project is ready

**Your Project ID** is shown on the creation page and in the dashboard. It looks like `my-tools-438209` (name + random number). You'll use it in commands below.

```
Where to find your Project ID:
  - Console top bar: click the project name dropdown → see ID column
  - URL: console.cloud.google.com/home/dashboard?project=THIS_IS_YOUR_ID
  - CLI: gcloud projects list
```

**Free tier:** Google Cloud has a generous free tier. Drive API, Sheets API, Docs API — free. BigQuery — first 1 TB/month of queries free. No billing account needed for basic API usage, but Google may ask you to enable billing for some APIs (like BigQuery). You won't be charged unless you exceed free tier limits.

---

## Step 1: Create Service Account

A service account is a "robot user" — it has an email address and can be given access to files, APIs, and data. Unlike your personal account, it never expires and doesn't need to log in.

**Option A: Via Console (no tools needed)**

1. Open [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Make sure your project is selected in the top dropdown
3. Click **"+ Create Service Account"**
   - Name: `gated-knowledge` (or anything)
   - Service account ID auto-fills (this becomes the email)
   - Click **Create and Continue**
   - **Grant this service account access to project** — skip for now (we'll add roles later per service)
   - Click **Done**
4. You'll see your new service account in the list with an email like:
   `gated-knowledge@your-project-id.iam.gserviceaccount.com`
5. Click on it → go to **"Keys"** tab → **"Add Key"** → **"Create new key"** → select **JSON** → **Create**
6. A `.json` file downloads — **this is your key**. Keep it safe.

**Option B: Via gcloud CLI (if installed)**

```bash
gcloud iam service-accounts create gated-knowledge --display-name="gated-knowledge MCP"
```

Download the key (replace `YOUR_PROJECT_ID`):
```bash
gcloud iam service-accounts keys create ~/Downloads/gated-knowledge-key.json --iam-account=gated-knowledge@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

**Don't have gcloud?** That's fine — Option A (Console) does everything. If you want gcloud: [Install guide](https://cloud.google.com/sdk/docs/install).

## Step 2: Enable APIs

Enable only the APIs you need. Each API is a toggle — turn on what you want.

**Option A: Via CLI**
```bash
# Core (most people need these)
gcloud services enable drive.googleapis.comgcloud services enable sheets.googleapis.comgcloud services enable docs.googleapis.com
# BigQuery
gcloud services enable bigquery.googleapis.com
# Gmail (requires OAuth — see Gmail section below)
gcloud services enable gmail.googleapis.com
# Calendar
gcloud services enable calendar-json.googleapis.com```

**Option B: Via Console**
1. Open [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for each API → click → **Enable**

## Step 3: Grant Access

#### Google Drive / Sheets / Docs
Share folders or files with the SA email:
1. In Google Drive, right-click folder → **Share**
2. Paste: `gated-knowledge@YOUR_PROJECT.iam.gserviceaccount.com`
3. Set to **Viewer** (read-only)

**Pro tip:** Share ONE top-level folder → everything inside becomes accessible.

#### BigQuery
Grant the SA access to query data:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:gated-knowledge@YOUR_PROJECT_ID.iam.gserviceaccount.com" --role="roles/bigquery.user"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:gated-knowledge@YOUR_PROJECT_ID.iam.gserviceaccount.com" --role="roles/bigquery.dataViewer"
```

Or via Console: [IAM](https://console.cloud.google.com/iam-admin/iam) → find the SA → Edit → Add roles.

#### Gmail
**SA cannot access Gmail directly.** Gmail requires user consent (OAuth2). See [Gmail section](#gmail) below.

#### Google Calendar
Share calendars with the SA email:
1. Google Calendar → Settings → calendar → **Share with specific people**
2. Add SA email → **See all event details**

## Step 4: Connect to gated-knowledge

```bash
node --experimental-strip-types bin/gated-knowledge.ts auth google --service-account ~/Downloads/gated-knowledge-key.json
node --experimental-strip-types bin/gated-knowledge.ts scan
```

Done. Delete the key file — it's now in Keychain.

---

## Available Google Services

### Google Drive (files, folders)
| What | How |
|------|-----|
| **Search files** | Full-text search via Drive API (same as Drive search bar) |
| **Read documents** | Export Google Docs as plain text |
| **Read spreadsheets** | All sheets, tab-separated, header + 50 rows |
| **List files** | By folder, by type, by modification date |
| **Access** | Share folder/file with SA email |
| **API** | `drive.googleapis.com` |
| **Auth** | Service Account |

Claude can ask: `search({query: "marketing report Q1", source: "google"})`

### Google Sheets (spreadsheet data)
| What | How |
|------|-----|
| **Read sheet data** | Cell values, all tabs |
| **Search** | Full-text search finds content inside cells |
| **Formulas** | Returns computed values, not formulas |
| **Access** | Share spreadsheet/folder with SA email |
| **API** | `sheets.googleapis.com` |
| **Auth** | Service Account |

Claude can ask: `read_document({id: "1abc...", source: "google"})` → gets all sheets as text

### Google Docs (documents)
| What | How |
|------|-----|
| **Read document** | Full text export |
| **Search** | Full-text search via Drive API |
| **Formatting** | Plain text only (no styling) |
| **Access** | Share doc/folder with SA email |
| **API** | `docs.googleapis.com` |
| **Auth** | Service Account |

### BigQuery (SQL analytics)
| What | How |
|------|-----|
| **Run queries** | Execute SQL, get results |
| **List datasets** | See what data is available |
| **List tables** | Schema, row count, size |
| **View running jobs** | What's running now, who started it |
| **Query history** | Recent queries and their results |
| **Cost** | First 1TB/month free, then $6.25/TB |
| **Access** | IAM role: `bigquery.user` + `bigquery.dataViewer`, or DWD |
| **API** | `bigquery.googleapis.com` |
| **Auth** | Service Account (direct IAM or DWD impersonation) |

**Cross-project queries:** If the SA is in a different project than the data, set `bigquery_project` in config or use [DWD](#domain-wide-delegation-dwd) to impersonate a user who has access.

Claude can ask:
- `bigquery_query({sql: "SELECT * FROM dataset.table LIMIT 10"})`
- `bigquery_list_datasets({})`
- `bigquery_list_jobs({state: "RUNNING"})`

### Gmail
| What | How |
|------|-----|
| **Search emails** | Gmail search syntax (`from:`, `subject:`, `newer_than:`, `is:unread`) |
| **Read email** | Full body text (HTML stripped to plain text) |
| **List recent** | Latest emails with subject, sender, date, snippet |
| **Use case** | Verification codes, notifications, quick inbox check |
| **API** | `gmail.googleapis.com` |
| **Auth** | **OAuth2 refresh token** (recommended) or DWD or ADC fallback |

#### Option A: OAuth2 refresh token (recommended, permanent, no admin needed)

Like n8n — one-time browser consent, then permanent access via refresh token. Works with personal Gmail and Workspace.

1. Enable Gmail API: [Enable Gmail API](https://console.cloud.google.com/apis/api/gmail.googleapis.com)
2. Create OAuth Client ID:
   - [Credentials page](https://console.cloud.google.com/apis/credentials) → **Create Credentials** → **OAuth client ID**
   - If prompted for consent screen: **External** → fill app name (e.g. "gated-knowledge") → add your email as test user → save
   - Application type: **Desktop app** → Create
   - Download the JSON file (or copy Client ID + Client Secret)
3. Run:
```bash
node --experimental-strip-types bin/gated-knowledge.ts auth gmail --client-secret-file ~/Downloads/client_secret_*.json
```
4. Browser opens → sign in → grant read-only access → done. Refresh token stored in Keychain permanently.

To disconnect: `node --experimental-strip-types bin/gated-knowledge.ts deauth gmail`

#### Option B: Domain-Wide Delegation (permanent, requires Workspace admin)

SA impersonates a Workspace user — no token refresh ever. Requires Google Workspace admin.

1. Enable Gmail API: [Enable Gmail API](https://console.cloud.google.com/apis/api/gmail.googleapis.com)
2. Set up DWD — see [Domain-Wide Delegation](#domain-wide-delegation-dwd) section below
3. Set the impersonation email:
```bash
node --experimental-strip-types bin/gated-knowledge.ts impersonate user@yourdomain.com
```
4. Done. `check_email` now uses SA + DWD permanently.

#### Option C: ADC fallback (no admin needed, tokens expire)

Uses your personal OAuth token. Simpler but requires periodic refresh.

1. Enable Gmail API: [Enable Gmail API](https://console.cloud.google.com/apis/api/gmail.googleapis.com)
2. Run ADC login with `gmail.readonly` scope:
```bash
gcloud auth application-default login \
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/gmail.readonly"
```
3. Done. Token lasts ~1 hour, then needs refresh.

**MCP tool:** `check_email`
```
check_email(query="subject:verification newer_than:1h")     # find recent verification codes
check_email(query="from:github.com is:unread")              # unread GitHub notifications
check_email()                                                # latest 5 emails
check_email(message_id="abc123")                             # read full email body
```

#### Sending emails

Requires a separate OAuth2 token with `gmail.send` scope:

```bash
node --experimental-strip-types bin/gated-knowledge.ts auth gmail --send
```

**MCP tool:** `send_email`
```
send_email(to="john@example.com", subject="Hello", body="Message text")
send_email(to="a@b.com", subject="Тема", body="Текст", cc="c@d.com")
```

Subject and body are RFC 2047/base64 encoded — non-ASCII characters (Cyrillic, emoji, etc.) are fully supported.

### Google Calendar
| What | How |
|------|-----|
| **List events** | Today, this week, date range |
| **Search events** | By title, attendee, location |
| **Read event details** | Description, attendees, meet link |
| **Access** | Share calendar with SA email |
| **API** | `calendar-json.googleapis.com` |
| **Auth** | Service Account |

---

## IAM Roles Reference

Minimal roles for each service:

| Service | Role | What it allows |
|---------|------|---------------|
| Drive | *(shared via email)* | Read files shared with SA |
| Sheets | *(shared via email)* | Read spreadsheet data |
| Docs | *(shared via email)* | Read document text |
| BigQuery | `roles/bigquery.user` | Run queries, list jobs |
| BigQuery | `roles/bigquery.dataViewer` | Read table data and schemas |
| BigQuery | `roles/bigquery.jobUser` | Create and manage own query jobs |

Grant roles:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:gated-knowledge@YOUR_PROJECT_ID.iam.gserviceaccount.com" --role="roles/bigquery.user"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:gated-knowledge@YOUR_PROJECT_ID.iam.gserviceaccount.com" --role="roles/bigquery.dataViewer"
```

---

## Checklist

Pick what you need:

- [ ] **Google Drive** — enable API, share folder with SA
- [ ] **Google Sheets** — enable API (Drive share covers access)
- [ ] **Google Docs** — enable API (Drive share covers access)
- [ ] **BigQuery** — enable API, grant `bigquery.user` + `bigquery.dataViewer` roles
- [ ] **Gmail** — enable API, set up DWD (recommended) or use ADC fallback
- [ ] **Google Calendar** — enable API, share calendar with SA

After enabling, run:
```bash
node --experimental-strip-types bin/gated-knowledge.ts scan
```

---

## Domain-Wide Delegation (DWD)

Domain-Wide Delegation lets the service account act on behalf of a Google Workspace user. This gives permanent access to Gmail and BigQuery without token refreshes.

**When you need DWD:**
- Reading Gmail (SA can't access mailboxes without DWD)
- Querying BigQuery datasets that the SA doesn't have direct IAM access to, but a Workspace user does

**Requirements:**
- Google Workspace (not personal Gmail)
- Workspace admin access (or an admin who can make the change)

### Setup (two parts)

#### Part 1: Enable DWD on the Service Account (GCP Console — you do this)

1. Open [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click on your service account (`gated-knowledge@...`)
3. Go to **Details** tab → expand **Show domain-wide delegation**
4. Check **Enable Google Workspace Domain-wide Delegation**
5. Save — note the **Client ID** (numeric, e.g. `112704238198897838115`)

Or find your Client ID:
```bash
node --experimental-strip-types bin/gated-knowledge.ts impersonate user@yourdomain.com
# prints the Client ID
```

#### Part 2: Authorize in Admin Console (Workspace admin does this)

> **Copy-paste these instructions to your admin:**

---

**Task:** Authorize a service account for Domain-Wide Delegation

1. Open **[admin.google.com](https://admin.google.com)** → sign in as admin
2. Go to: **Security** → **Access and data control** → **API controls**
3. Scroll down to **Domain-wide delegation** → click **Manage Domain-wide Delegation**
4. Click **Add new**
5. Fill in:
   - **Client ID:** `YOUR_CLIENT_ID`
   - **OAuth scopes** (one line, comma-separated):
     ```
     https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/bigquery.readonly
     ```
6. Click **Authorize**

That's it. Changes take effect within a few minutes.

---

> **Note:** There is no gcloud CLI command for this step — Google only provides the Admin Console UI. This is a one-time setup.

#### Part 3: Configure gated-knowledge

```bash
# Set the email to impersonate (the Workspace user whose data you want to access)
node --experimental-strip-types bin/gated-knowledge.ts impersonate user@yourdomain.com
```

#### Verify it works

```bash
# Test Gmail
node --experimental-strip-types bin/gated-knowledge.ts check-email "newer_than:1d"

# Test BigQuery
node --experimental-strip-types bin/gated-knowledge.ts search "test"
```

### DWD Scopes Reference

Add only what you need:

| Scope | What it allows |
|-------|---------------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read emails |
| `https://www.googleapis.com/auth/bigquery.readonly` | Query BigQuery |
| `https://www.googleapis.com/auth/drive.readonly` | Read Drive files |
| `https://www.googleapis.com/auth/spreadsheets.readonly` | Read Sheets |
| `https://www.googleapis.com/auth/calendar.readonly` | Read Calendar events |

To add more scopes later, the admin edits the existing DWD entry — doesn't need to create a new one.

---

## Troubleshooting

**"403 Forbidden"** → API not enabled, or SA doesn't have access. Check:
1. Is the API enabled? → [APIs & Services](https://console.cloud.google.com/apis/enabled)
2. Is the file/folder shared with SA email?
3. For BigQuery: does SA have IAM roles?

**"401 Unauthorized"** → Credential issue. Re-run:
```bash
node --experimental-strip-types bin/gated-knowledge.ts auth google --service-account key.json
```

**"unauthorized_client: Client is unauthorized to retrieve access tokens using this method"** → DWD not configured or not yet active. Check:
1. Is DWD enabled on the SA in GCP Console? (Part 1 above)
2. Is the Client ID + scopes authorized in Admin Console? (Part 2 above)
3. Wait a few minutes — changes can take up to 5 minutes to propagate

**"Token expired" for Gmail (ADC mode)** → ADC token expired. Re-run:
```bash
gcloud auth application-default login \
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/gmail.readonly"
```

**"Delegation denied for user@domain.com"** → The impersonate email doesn't match the Workspace domain, or the user doesn't exist.

**"Key creation is not allowed"** → Organization policy blocks SA key creation. If you manage the org:
```bash
gcloud resource-manager org-policies delete iam.disableServiceAccountKeyCreation --project=YOUR_PROJECT_ID
```
Or via Console: [Org Policies](https://console.cloud.google.com/iam-admin/orgpolicies) → find `iam.disableServiceAccountKeyCreation` → Edit → Not enforced. You can re-enable it after downloading the key.

**BigQuery "Access Denied"** → SA needs roles at project level:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:gated-knowledge@YOUR_PROJECT_ID.iam.gserviceaccount.com" --role="roles/bigquery.user"
```
