# Google Setup Guide

Complete guide to connecting Google services to gated-info. One service account — access to everything.

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
   - Name: `gated-info` (or anything)
   - Service account ID auto-fills (this becomes the email)
   - Click **Create and Continue**
   - **Grant this service account access to project** — skip for now (we'll add roles later per service)
   - Click **Done**
4. You'll see your new service account in the list with an email like:
   `gated-info@your-project-id.iam.gserviceaccount.com`
5. Click on it → go to **"Keys"** tab → **"Add Key"** → **"Create new key"** → select **JSON** → **Create**
6. A `.json` file downloads — **this is your key**. Keep it safe.

**Option B: Via gcloud CLI (if installed)**

```bash
# Create service account
gcloud iam service-accounts create gated-info \
  --display-name="gated-info MCP" \
  --project=YOUR_PROJECT_ID

# Download key
gcloud iam service-accounts keys create ~/Downloads/gated-info-key.json \
  --iam-account=gated-info@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

**Don't have gcloud?** That's fine — Option A (Console) does everything. If you want gcloud: [Install guide](https://cloud.google.com/sdk/docs/install).

## Step 2: Enable APIs

Enable only the APIs you need. Each API is a toggle — turn on what you want.

**Option A: Via CLI**
```bash
# Core (most people need these)
gcloud services enable drive.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable sheets.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable docs.googleapis.com --project=YOUR_PROJECT_ID

# BigQuery
gcloud services enable bigquery.googleapis.com --project=YOUR_PROJECT_ID

# Gmail (requires OAuth — see Gmail section below)
gcloud services enable gmail.googleapis.com --project=YOUR_PROJECT_ID

# Calendar
gcloud services enable calendar-json.googleapis.com --project=YOUR_PROJECT_ID
```

**Option B: Via Console**
1. Open [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for each API → click → **Enable**

## Step 3: Grant Access

#### Google Drive / Sheets / Docs
Share folders or files with the SA email:
1. In Google Drive, right-click folder → **Share**
2. Paste: `gated-info@YOUR_PROJECT.iam.gserviceaccount.com`
3. Set to **Viewer** (read-only)

**Pro tip:** Share ONE top-level folder → everything inside becomes accessible.

#### BigQuery
Grant the SA access to query data:
```bash
# Viewer — can run queries and see results
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gated-info@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/bigquery.user"

# Data viewer — can see dataset contents
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gated-info@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
```

Or via Console: [IAM](https://console.cloud.google.com/iam-admin/iam) → find the SA → Edit → Add roles.

#### Gmail
**SA cannot access Gmail directly.** Gmail requires user consent (OAuth2). See [Gmail section](#gmail) below.

#### Google Calendar
Share calendars with the SA email:
1. Google Calendar → Settings → calendar → **Share with specific people**
2. Add SA email → **See all event details**

## Step 4: Connect to gated-info

```bash
node --experimental-strip-types bin/gated-info.ts auth google --service-account ~/Downloads/gated-info-key.json
node --experimental-strip-types bin/gated-info.ts scan
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
| **Access** | IAM role: `bigquery.user` + `bigquery.dataViewer` |
| **API** | `bigquery.googleapis.com` |
| **Auth** | Service Account |

Claude can ask:
- `bigquery_query({sql: "SELECT * FROM dataset.table LIMIT 10"})`
- `bigquery_list_datasets({})`
- `bigquery_list_jobs({state: "RUNNING"})`

### Gmail
| What | How |
|------|-----|
| **Search emails** | Gmail search syntax (`from:`, `subject:`, `after:`) |
| **Read email** | Full body, attachments list |
| **List threads** | Recent conversations |
| **Access** | **OAuth2 only** (SA can't access personal Gmail) |
| **API** | `gmail.googleapis.com` |
| **Auth** | OAuth2 (one-time browser login) |

**Why not SA?** Gmail is personal — Google doesn't allow service accounts to read someone's email without domain-wide delegation (Workspace admin only).

**OAuth2 setup:**
1. Go to [Credentials](https://console.cloud.google.com/apis/credentials)
2. **"+ Create Credentials"** → **OAuth Client ID** → **Desktop app**
3. Download `client_secret_xxx.json`
4. Set [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) to **Production** (avoids 7-day token expiry)

```bash
node --experimental-strip-types bin/gated-info.ts auth gmail --client-secret ~/Downloads/client_secret.json
# → Opens browser → log in → authorize → refresh token → Keychain
```

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
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gated-info@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/bigquery.user"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gated-info@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
```

---

## Checklist

Pick what you need:

- [ ] **Google Drive** — enable API, share folder with SA
- [ ] **Google Sheets** — enable API (Drive share covers access)
- [ ] **Google Docs** — enable API (Drive share covers access)
- [ ] **BigQuery** — enable API, grant `bigquery.user` + `bigquery.dataViewer` roles
- [ ] **Gmail** — enable API, create OAuth Client ID, run `auth gmail`
- [ ] **Google Calendar** — enable API, share calendar with SA

After enabling, run:
```bash
node --experimental-strip-types bin/gated-info.ts scan
```

---

## Troubleshooting

**"403 Forbidden"** → API not enabled, or SA doesn't have access. Check:
1. Is the API enabled? → [APIs & Services](https://console.cloud.google.com/apis/enabled)
2. Is the file/folder shared with SA email?
3. For BigQuery: does SA have IAM roles?

**"401 Unauthorized"** → Credential issue. Re-run:
```bash
node --experimental-strip-types bin/gated-info.ts auth google --service-account key.json
```

**"Token expired" for Gmail** → OAuth consent screen is in "Testing" mode. Switch to Production:
[OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) → **Publish App**

**BigQuery "Access Denied"** → SA needs roles at project level:
```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:SA_EMAIL" \
  --role="roles/bigquery.user"
```
