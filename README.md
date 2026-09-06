# ID Card Cutter + Resume Maker

A small browser-first web app with two tools:

- **ID Card Cutter** opens password-protected PDFs and images, lets you drag a
  box around the card, and downloads the cut region as a **PNG image** and/or a
  **PDF**.
- **Resume Maker** collects resume details manually or parses pasted profile
  text into one simple editable template, then uses the browser print dialog
  to save it as a PDF.

The ID Card Cutter remains fully offline. Resume drafts are saved only in the
browser. When AI parsing is used, only the pasted text is sent to the selected
server-side provider; provider credentials never reach the browser.

## Requirements

- Windows with **Node.js 18+** installed (default path `C:\Program Files\nodejs\node.exe`).
  - If Node is installed elsewhere, edit `start.cmd` and change the `NODE` variable.
- A modern browser (Chrome, Edge, or Firefox).

## How to use

1. Double-click **`start.cmd`**.
   - This starts a tiny local server and opens `http://127.0.0.1:8080` in your browser.
   - Opening `index.html` directly may not work because browsers block PDF.js's
     module worker over the `file://` protocol.
2. Select the document type, then drop a PDF or image onto the page (or browse
   from your device). Supported image formats are JPG, PNG, and WebP.
3. Unlocked PDFs open immediately. For locked documents, the form matches the
   selected type:
   - **Aadhaar:** first four letters of the name (uppercase) + birth year.
   - **PAN:** date of birth in `DDMMYYYY` format.
   - **Voter ID:** tries the Aadhaar-style password and DOB when both are supplied.
   - **Driving License, Passport, Generic:** enter the password manually.
   - You can always use the manual password field.
4. Drag a box around the card on the preview. Use **Auto-detect** for a first
   guess, then fine-tune with the corner handles or drag inside the box to move it.
5. Choose **PNG** and/or **PDF**, then click **Download**.

## The Aadhaar password

Official e-Aadhaar PDFs are locked with:

```text
<FIRST 4 LETTERS OF NAME IN UPPERCASE><4-DIGIT BIRTH YEAR>
```

Example: name **Rajesh Kumar**, born **1990** → password `RAJE1990`.

- Spaces are ignored when computing the name part.
- If your name has fewer than four letters, use the full uppercase name + birth year.
- If that does not work, use the manual password option.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App UI |
| `style.css` | Styling |
| `app.js` | PDF load/unlock, rendering, crop, and export logic |
| `server.js` | Tiny local static server (Node core, no dependencies) |
| `start.cmd` | One-click launcher |
| `vendor/` | Vendored pdf.js (4.10.38) and jsPDF (2.5.1) — the app works offline |

## Notes & limitations

- **Axis-aligned crops only.** Rotated or skewed scans need to be straightened
  first; the box cannot rotate.
- **Auto-detect is best-effort.** It finds the largest card-shaped region on a
  plain background; adjust the box manually when needed.
- Very large pages are rendered at a reduced scale to stay fast and avoid
  running out of memory.
- No data leaves your machine — PDF rendering and export happen entirely in the browser.

### Windows 7 browser compatibility

The website includes a compatibility shim for older browsers that do not
provide `Promise.withResolvers`, which PDF.js requires. After an update, users
should hard-refresh the website once so the new application script is loaded.

## Troubleshooting

- **"Node.js not found"** — edit `start.cmd` and point `NODE` to your `node.exe`.
- **Wrong password** — double-check the name/birth-year, or use the manual password field.
- **Blank page in browser** — open the browser's DevTools console (F12) and check for errors.

## Deploy to Vercel

This app is fully static — no build step, no server runtime. Deploy it as-is:

1. Push this folder to a Git repository (e.g. GitHub).
2. Import the repo at [vercel.com/new](https://vercel.com/new) — Vercel auto-detects
   the static project (it reads `vercel.json`).
3. Or deploy straight from the CLI:

   ```
   npm i -g vercel
   vercel        # preview deploy
   vercel --prod # production deploy
   ```

That's it. The `vercel.json` config sets sensible cache headers
(immutable for `vendor/` assets, no-cache for the entry page).

> The local Node server (`server.js` / `start.cmd`) is only for offline use on
> your own PC. It also serves the local resume parsing API when AI environment
> variables are configured.

## Resume Maker AI setup

The AI endpoint is `POST /api/parse-resume`. By default it tries xKiro
(`openai/gpt-5.6-luna`) first, then falls back to the keyless OpenCode Zen
free tier:

```text
RESUME_AI_PROVIDERS=xkiro,opencode
```

The only required setting is the xKiro key — the base URL, model, and
provider order already default to the values below. Set the key in the
deployment environment; do not commit it to this repository or put it in
browser JavaScript:

```text
XKIRO_API_KEY=replace-with-your-server-secret
```

Optional overrides (defaults shown):

```text
XKIRO_BASE_URL=https://api.xkiro.com/v1
XKIRO_MODEL=openai/gpt-5.6-luna
RESUME_AI_PROVIDERS=xkiro,opencode
OPENCODE_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_MODEL=hy3-free
```

An OpenAI adapter is also available when desired:

```text
RESUME_AI_PROVIDERS=openai
OPENAI_MODEL=replace-with-a-model-id
OPENAI_API_KEY=replace-with-your-server-secret
```

For local use, set the variables in the shell before running `start.cmd`.
For Vercel, add them under the project environment variables and redeploy.
The manual resume form works even when no AI provider is configured.
