# Aadhaar Card PDF Cutter

A small, fully **offline** web app that unlocks your password-protected
[e-Aadhaar](https://uidai.gov.in) PDF, lets you drag a box around the card,
and downloads the cut region as a **PNG image** and/or a **PDF**.

Everything runs in your browser. Your PDF is never uploaded anywhere.

## Requirements

- Windows with **Node.js** installed (default path `C:\Program Files\nodejs\node.exe`).
  - If Node is installed elsewhere, edit `start.cmd` and change the `NODE` variable.
- A modern browser (Chrome, Edge, or Firefox).

## How to use

1. Double-click **`start.cmd`**.
   - This starts a tiny local server and opens `http://127.0.0.1:8080` in your browser.
   - (Opening `index.html` directly may not work because browsers block PDF.js's
     module worker over the `file://` protocol — that's why we use the server.)
2. Drop your e-Aadhaar PDF onto the page (or click to browse).
3. If the PDF is password-protected, enter the **name on the card** and the
   **birth year**. The app tries the standard password automatically. You can
   also expand **"Enter password manually"** to type it yourself.
4. Drag a box around the card on the preview. Use **Auto-detect** for a first
   guess, then fine-tune with the corner handles (drag inside the box to move it).
5. Choose **PNG** and/or **PDF** and click **Download**.

## The e-Aadhaar password

Official e-Aadhaar PDFs are locked with:

\`\`\`
<FIRST 4 LETTERS OF NAME IN UPPERCASE><4-DIGIT BIRTH YEAR>
\`\`\`

Example: name **Rajesh Kumar**, born **1990** → password `RAJE1990`.

- Spaces are ignored when computing the name part.
- If your name has fewer than 4 letters, use the full uppercase name + birth year.
- If that doesn't work, use the **manual password** option.

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
> your own PC. On Vercel, static hosting serves the exact same files.
