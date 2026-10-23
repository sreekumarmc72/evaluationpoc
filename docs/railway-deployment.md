# Railway deployment — Paperwise POC

## Signup and access

1. Open https://railway.com/ and choose Login, then sign in with GitHub.
2. Connect the GitHub account owning `sreekumarmc72/evaluationpoc`.
3. Authorize Railway's GitHub application for this repository only.
4. Check whether the account has Full Trial or Limited Trial status. Limited trials restrict outbound networking and may prevent OpenAI connectivity. GitHub verification is automated; see https://docs.railway.com/pricing/free-trial.
5. Never put passwords, OpenAI keys or Railway tokens in Git or chat.

## Deploy one service

1. New Project → Deploy from GitHub repo → select `evaluationpoc`, branch `main`.
2. Keep the service root at the repository root. The repository's Dockerfile builds all workspaces and serves React plus Express in one Node process. `railway.json` selects Docker and `/api/health` as the deployment health check.
3. Add a persistent volume to this service with mount path `/data`. The free/trial storage allowance is 0.5 GB. Do not mount over `/app`, which contains the application.
4. Set service variables:

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | Enter your key privately in Railway |
| `OPENAI_MODEL` | `gpt-6.1-sol`, or the configured model you have access to |
| `DATA_DIR` | `/data` |
| `MODEL_TIMEOUT_MS` | `180000` |
| `MAX_FILE_MB` | `30` |
| `MAX_PDF_PAGES` | `50` |
| `RETENTION_MS` | `3600000` |

The image already sets `NODE_ENV=production` and `HOST=0.0.0.0`. Railway supplies `PORT`. Leave replicas at one and disable automatic sleep/serverless mode for reliable in-process evaluations; continuous uptime consumes credit.

5. Settings → Networking → Generate Domain. The server uses `RAILWAY_PUBLIC_DOMAIN` to allow same-origin uploads. Redeploy after generating the domain so that variable is available to the process. Alternatively set `APP_ORIGIN=https://<generated-domain>` explicitly, with no path.
6. Wait for a successful deployment and check `https://<generated-domain>/api/health`. `ok: true` means the server is running; `configured: true` means credentials/model are set, not that a live OpenAI request has succeeded.

## Three public pages

- Original POC: `https://<generated-domain>/`
- Faculty: `https://<generated-domain>/faculty`
- Student: `https://<generated-domain>/student`

The same service handles all `/api` requests. No separate frontend hosting, database, Redis or CORS proxy is required.

## Storage and launch checks

Prepared faculty exams are stored under `/data/exams`; the original POC's retained PDFs and extracted-exam cache are under `/data/retained-exam`. Only the frontend's built static directory is served publicly. Temporary answer-sheet files and in-memory results expire according to the existing one-hour retention policy. Restarting/redeploying loses active evaluations and temporary results, but prepared exams survive when the volume remains attached.

Local saved exams are not uploaded by pushing code. Create an exam on the hosted faculty page using your PDFs. Back up the volume outside Railway; do not treat free/trial storage as a guaranteed permanent archive.

Before sharing:

1. Open and refresh all three URLs on a second device.
2. Create one faculty exam and inspect its extracted questions/rubric.
3. Submit a sample answer sheet, checking progress, elapsed time, PDF preview and complete results. This test consumes OpenAI credit.
4. Restart the service after the evaluation finishes, and confirm the prepared exam still appears. Submit another sheet to verify reuse.
5. Check deployment logs and Railway usage. Do not enable logging of uploaded document contents or API keys.

## Demo access and costs

The current POC has no authentication. Anyone with public access can create exams, run evaluations using your API credits, inspect the shared exam catalog and use exposed review endpoints. An origin allowlist prevents cross-origin browser writes; it is not authentication and does not prevent scripts or direct API requests. Use this deployment for controlled demos and synthetic/anonymised sheets. Add an access gate and usage limits before unrestricted public sharing.

Railway currently advertises $5 trial credit for 30 days, then $1 monthly free credit, plus 0.5 GB volume storage. Its trial documentation states trial volumes are deleted 30 days after credit expiration. Confirm your account's current retention terms before relying on stored exams after the trial. Hosting credits do not cover OpenAI API charges.

Official references:
- https://docs.railway.com/quick-start
- https://docs.railway.com/pricing/free-trial
- https://docs.railway.com/volumes/reference
- https://docs.railway.com/deployments/healthchecks
- https://railway.com/pricing

## Local production check

Run `npm run build` first. In PowerShell, set `NODE_ENV=production`, `HOST=127.0.0.1`, a free `PORT` such as `3002`, `APP_ORIGIN=http://127.0.0.1:3002`, and `DATA_DIR` to an isolated local folder, then run `npm start`. Visit port 3002 directly; Vite is not needed. Clear those process environment variables before returning to the normal local `npm run dev` workflow.
