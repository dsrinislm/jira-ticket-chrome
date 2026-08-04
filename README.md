# Tri Connect Hub — Issue Synchronizer

**Tri Connect Hub** is a Chrome extension that connects your QA/issue-tracking systems with Jira, so you can stop copy-pasting ticket details and start working.

It links **Micro Focus Octane** and **ServiceNow (Spark)** to **Atlassian Jira** with one-click workflows:

- Turn any QA ticket into a Jira issue, complete with attachments.
- Move entire listings or Excel reports into Jira in a single run.
- Keep comments in sync in both directions between Spark and Jira.
- Avoid duplicates — the extension checks Jira before creating anything new.

---

## What it lets you do

### 1. Create a Jira ticket from a single QA ticket
While viewing a ticket in Octane or Spark, the extension reads the ticket details and creates a matching Jira issue — description, links, and selected attachments included.

### 2. Bulk-import from a listing page
Tick several rows on an Octane or Spark listing, and the extension creates a Jira ticket for each one — with optional attachments — while keeping you informed of progress for every row.

### 3. Import from an Excel report
Upload a report (Octane: ID / Name / Description, or Spark: Number / Short description / Description). The extension previews every row, lets you choose what to import, and creates the tickets. When done, you can export a report of the results.

### 4. Detect existing tickets and stay duplicate-free
Before creating anything, the extension searches Jira for a matching issue. Existing tickets are skipped (and their missing attachments/comment updates are synced) instead of duplicated.

### 5. Keep comments in sync
- **Spark → Jira:** New Spark comments are added to the corresponding Jira issue.
- **Jira → Spark:** New Jira comments are written back into the Spark ticket — either directly or via a Spark-origin tab.

### 6. Upload attachments
Images, videos, and files attached to a QA ticket can be carried over to Jira, including inline images embedded in the ticket description. Progress is shown as files upload.

---

## Getting started

1. **Install the extension** in Chrome (via `chrome://extensions` → *Load unpacked*, selecting this folder).
2. **Open the extension** from the toolbar.
3. **Enter your Jira base URL** — for example `https://yourcompany.atlassian.net` (the extension can also detect it automatically when you open a Jira page).
4. **Enter your Jira project key** — the short project code, e.g. `QA`, `TES`, or `PROJ`.
5. Sign in to Jira in Chrome when prompted.

That's it — you're ready to create and sync tickets.

---

## How to use it

### Single ticket
1. Open the ticket's **details page** in Octane or Spark.
2. Open the extension — the **Current Ticket** tab shows the detected ticket.
3. (Optional) Turn on **attachments** and choose which files to include.
4. Click **Create or Sync ticket**.
5. If a matching Jira issue already exists, the extension reports it and syncs missing attachments and comments instead of creating a duplicate.

### Bulk import from a listing
1. On the listing page, **tick the rows** you want to import.
2. Open the extension and switch to the **Bulk Import** tab.
3. (Optional) Enable **attachments** and pick files per ticket.
4. Click **Sync selected listing** and follow the progress per row.

### Import from Excel
1. In the **Bulk Import** tab, upload your Excel report.
2. Review the preview table and select the tickets to import.
3. Click **Import** — each row becomes a Jira ticket.
4. Use **Export** to download a results report once the import finishes.

### Sync comments
- From a Spark ticket: create/sync the ticket and new Spark comments are posted to Jira.
- From a Jira issue: open the issue and use **Sync Updates** to bring new Jira comments into the linked Spark ticket.

---

## Good to know

- Attachments over ~25 MB are skipped during sync — add those from the Jira UI directly.
- The extension never changes your source tickets; it only reads from Octane/Spark and writes to Jira (and posts comments into Spark when you ask it to).
- If the import is taking too long, you can stop it at any time — completed rows are kept.

---

## Support

This is an internal productivity tool. For questions or issues, reach out to your team's extension owner or the Jira/QA administration contact.

---

## Author

Srinivasan Dhanapal <dsrinislm@gmail.com>
