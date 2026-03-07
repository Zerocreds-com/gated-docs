# Google Setup Guide

Complete guide to connecting Google services to gated-info. One service account — access to everything.

## Quick Start (5 minutes)

### 1. Create Service Account

**Option A: Via CLI (if gcloud installed)**
```bash
# Set your project
PROJECT_ID="skillset-analytics-487510"  # or any GCP project

# Create service account
gcloud iam service-accounts create gated-info \
  --display-name="gated-info MCP" \
  --project=$PROJECT_ID

# Download key
gcloud iam service-accounts keys create ~/Downloads/gated-info-key.json \
  --iam-account=gated-info@${PROJECT_ID}.iam.gserviceaccount.com
```

**Option B: Via Console (no gcloud needed)**
1. Open [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Select your project (top dropdown)
3. **"+ Create Service Account"**
   - Name: `gated-info`
   - Click **Create and Continue**
   - Skip roles for now → **Done**
4. Click on the created account → **Keys** tab → **Add Key** → **JSON**
5. Key file downloads automatically

### 2. Enable APIs

Enable only the APIs you need. Each API is a toggle — turn on what you want.

**Option A: Via CLI**
```bash
PROJECT_ID="skillset-analytics-487510"

# Core (most people need these)
gcloud services enable drive.googleapis.com --project=$PROJECT_ID
gcloud services enable sheets.googleapis.com --project=$PROJECT_ID
gcloud services enable docs.googleapis.com --project=$PROJECT_ID

# BigQuery
gcloud services enable bigquery.googleapis.com --project=$PROJECT_ID

# Gmail (requires OAuth — see Gmail section below)
gcloud services enable gmail.googleapis.com --project=$PROJECT_ID

# Calendar
gcloud services enable calendar-json.googleapis.com --project=$PROJECT_ID
```

**Option B: Via Console**
1. Open [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for each API → click → **Enable**

### 3. Grant Access

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
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gated-info@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/bigquery.user"

# Data viewer — can see dataset contents
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gated-info@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
```

Or via Console: [IAM](https://console.cloud.google.com/iam-admin/iam) → find the SA → Edit → Add roles.

#### Gmail
**SA cannot access Gmail directly.** Gmail requires user consent (OAuth2). See [Gmail section](#gmail) below.

#### Google Calendar
Share calendars with the SA email:
1. Google Calendar → Settings → calendar → **Share with specific people**
2. Add SA email → **See all event details**

### 4. Connect to gated-info

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
SA_EMAIL="gated-info@${PROJECT_ID}.iam.gserviceaccount.com"

# BigQuery
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.user"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
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
