# CSC Mailer

A Node.js workflow for sending personalised cold emails to professors as part of a CSC PhD application campaign. It reads professor records from a Google Sheet or local CSV, optionally enriches them with web research, generates a tailored opening hook with an LLM, stores manual approval decisions, and sends emails through SMTP with pacing safeguards.

## What this project does

- Loads professor data from either:
  - a Google Sheet shared with public link access via `SHEET_CSV_URL`, or
  - a local CSV file via `CSV_PATH`
- Filters out invalid rows and already-applied professors
- Uses LangSearch (when enabled) and OpenRouter to generate a tailored hook paragraph
- Saves generated hooks in `hooks.json` for review and manual approval
- Builds a personalised email using prompt templates in `prompts/`
- Writes emails to `outbox/` in dry-run mode or sends them via SMTP in live mode
- Tracks progress in `state.json` so the run can safely pause and resume
- Enforces limits with a daily quota and randomized delays between sends

## Project structure

```text
csc-mailer/
├── .env.example
├── .env
├── README.md
├── hooks.json
├── sent_log.csv
├── state.json
├── prompts/
│   ├── email_body.txt
│   ├── email_signature.txt
│   ├── no_web.txt
│   ├── search_query.txt
│   ├── system.txt
│   └── user.txt
├── src/
│   └── index.js
├── package.json
├── package-lock.json
├── Muhammad_Hamza_CV.pdf
└── professors.csv   (optional local source file)
```

## Requirements

- Node.js 18+
- A CSV or spreadsheet containing at least these columns:
  - `Name`
  - `University`
  - `Email`
  - `Profile Link`
  - `Research Interests`
  - `Applied`
- An SMTP sender account (Gmail is the tested/default choice)
- An OpenRouter API key for hook generation
- A LangSearch API key if you want web-assisted professor research
- A CV file path for attachment

## Installation

```bash
npm install
cp .env.example .env
```

Then fill in the values in `.env`.

## Environment variables

Example configuration from `.env.example`:

```env
# Google Sheet or local CSV
SHEET_CSV_URL=
CSV_PATH=./professors.csv

CV_PATH=C:\Users\Hamza\Documents\Muhammad_Hamza_CV.pdf

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=yourname@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
FROM_NAME=Muhammad Hamza
SUBJECT=CSC 2027 PhD Application Enquiry - Muhammad Hamza

OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openrouter/free
USE_WEB_SEARCH=true

LANGSEARCH_API_KEY=*************
SEARCH_COUNT=5

DAILY_LIMIT=20
MIN_DELAY_MIN=4
MAX_DELAY_MIN=11
MIN_RATING=0
SEND_LOW_CONFIDENCE=false
DRY_RUN=true
```

### Notes

- `SHEET_CSV_URL` should be a Google Sheet URL with public access, and the script converts it to CSV export automatically.
- `CSV_PATH` is used when no sheet URL is provided.
- `DRY_RUN=true` keeps the script in safe mode and writes generated email drafts to `outbox/` instead of emailing anyone.
- `MIN_RATING` and `SEND_LOW_CONFIDENCE` are used to filter or hold low-fit or low-confidence hooks.

## Available commands

```bash
npm run preview -- 20
npm start
npm run status
```

### `npm run preview -- 20`

Generates hooks for the next 20 pending professors and writes them to `hooks.json`.

### `npm start`

Runs the email send cycle. In safe mode (`DRY_RUN=true`), it writes emails to `outbox/` and does not send anything. In live mode (`DRY_RUN=false`), it sends email and tracks progress in `state.json`.

### `npm run status`

Prints the current counts for pending, sent, failed, and hook-ready rows.

## Workflow

1. Prepare your professor list in a Google Sheet or CSV.
2. Set the required variables in `.env`.
3. Run preview to generate hook entries:

```bash
npm run preview -- 20
```

4. Review and edit `hooks.json`.
   - Set `"approved": true` to force a hook to be sent.
   - Set `"approved": false` to reject it permanently.
   - Adjust the generated text if needed before live send.
5. Validate safely:

```bash
DRY_RUN=true
npm start
```

This writes formatted emails into `outbox/` instead of contacting professors.

6. When satisfied, switch to live mode:

```env
DRY_RUN=false
```

Then run:

```bash
npm start
```

The app will:
- respect `DAILY_LIMIT`
- pause between sends using random delays from `MIN_DELAY_MIN` to `MAX_DELAY_MIN`
- stop until the next daily reset window (roughly 5:00 AM PKT) when the daily quota is reached
- keep progress in `state.json` so it can resume safely

## `hooks.json` behavior

Each hook is keyed by professor email and includes fields such as:

- `hook`: the main tailored paragraph
- `short`: a shorter version
- `rating`: compatibility score from 0 to 10
- `reasons`: brief explanation
- `recommend_short`: whether a shorter message is preferred
- `confidence`: `high`, `medium`, or `low`
- `evidence`: cited paper or source information
- `approved`: manual override flag

Example:

```json
{
  "professor@example.edu": {
    "hook": "I have reviewed your research work in **machine learning**...",
    "short": "I have reviewed your work in ...",
    "rating": 8,
    "reasons": "Strong fit with ML and drug discovery research.",
    "recommend_short": false,
    "confidence": "high",
    "evidence": "https://example.edu/paper",
    "approved": true
  }
}
```

Rows are skipped automatically when:
- `Email` is missing or invalid
- `Name` is missing
- `Applied` is `TRUE`
- the hook is flagged as low confidence and `SEND_LOW_CONFIDENCE` is disabled
- the rating is below `MIN_RATING`
- the hook is marked `approved: false`

## State and logs

The application stores its progress in:

- `state.json` — tracks sent emails, failed attempts, and daily counters
- `sent_log.csv` — a log of successfully sent professors
- `outbox/` — dry-run email drafts

This makes the tool safe to interrupt and resume.

## Safety and operational notes

- Always run a dry-run test before live sending.
- Review `hooks.json` before launch; generated content should be checked for accuracy.
- Keep `DRY_RUN=true` until you are comfortable with the outgoing messages.
- The script is intended for a personal, controlled outreach workflow, not bulk unsolicited mass-mailing.

## License

This project is intended for personal use. License terms, if any, should be added by the repository owner.
