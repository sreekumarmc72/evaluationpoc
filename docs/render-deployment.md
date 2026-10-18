# Render deployment: free validation, then paid persistence

## What this deployment provides

One Docker web service serves React and the Node API. Its three pages are `/`, `/faculty` and `/student`. The existing Dockerfile builds all workspaces. The origin allowlist automatically uses Render's `RENDER_EXTERNAL_URL`; do not copy a Railway `APP_ORIGIN` into Render. For a custom domain, explicitly set `APP_ORIGIN` to its full HTTPS origin.

## Signup and free deployment

1. Create a Render account with a permanent email address or sign in with your GitHub account. Authorize access only to `sreekumarmc72/evaluationpoc`.
2. In the Render dashboard, select **New → Blueprint**, connect that repository, and select branch `main`. Render reads the root `render.yaml`.
3. Review the proposed resources: exactly one Docker web service on the **Free** compute plan, Singapore region, **no disk**, no database. Supply `OPENAI_API_KEY` and a strong `FACULTY_PASSWORD` privately when prompted; never add it to Git or send it in chat.
4. Apply/create the Blueprint. The other variables come from `render.yaml`; Docker sets `NODE_ENV=production` and `HOST=0.0.0.0`, and Render supplies `PORT` and `RENDER_EXTERNAL_URL`. No build/start command override is needed.
5. Wait until the deployment is Live. Open its generated `https://<service-name>.onrender.com` URL. Share the URL for read-only checks; it is not a credential.

Alternative manual flow: **New → Web Service**, connect the repository, branch `main`, keep the root directory blank, select **Docker**, Dockerfile `./Dockerfile`, Free compute, and health check `/api/health`. Add the variables listed in `render.yaml` manually. Do not create both a manual service and a Blueprint service.

## Verify on Free

1. Check `/api/health` returns `ok: true` and `configured: true`. This checks server/configuration, not live model connectivity.
2. Open `/`, `/faculty`, and `/student` directly and refresh each page.
3. Create a faculty exam from the question paper and answer key. Review the questions and rubric.
4. Upload one answer sheet on the student page. Check progress/elapsed time, transcript, evidence, marks and PDF preview. This uses paid OpenAI API credit.
5. Submit another sheet for the same exam during the same running session. Verify prepared exam reuse. Test the original POC as well.
6. Review Render logs and memory metrics, especially when uploading larger PDFs. Faculty login uses `FACULTY_USER=faculty` and the private password. New submissions are archived as described in [submission-history.md](submission-history.md). The service permits one active preparation/evaluation at a time; 512 MB is an initial demo configuration, not a demonstrated capacity guarantee.

Free services sleep after 15 minutes without inbound traffic. Waking takes about a minute; first open the app and let it finish waking before starting an upload. Free services can restart at other times too. All files written to `/data` remain **ephemeral until a disk is attached**; saved exams, rubrics and retained PDFs disappear on restart/redeploy/sleep. Without the paid disk, archived files can also disappear; a disk is required before retaining client submissions. Keep original PDFs locally, expect to recreate exams, and do not use Free to verify durable storage. No automatic upgrade or paid resource is configured in `render.yaml`.

## Upgrade after client approval

1. Finish active evaluations and keep local copies of your source PDFs.
2. Update `render.yaml` in Git: change `plan: free` to the paid plan identifier shown in Render's current Blueprint reference (currently `0.5c-512mb` for the $7/month option), and add this at the service level:

   ```yaml
   disk:
     name: exam-data
     mountPath: /data
     sizeGB: 1
   ```

3. Review the paid service/disk changes in Render before applying them. Updating the Blueprint keeps Git aligned with the actual service and avoids a later sync reverting a dashboard-only upgrade. If deploying manually, change the instance type in the dashboard and add a 1 GB disk mounted at `/data` instead.
4. Keep `DATA_DIR=/data`. Existing files from the Free filesystem are not a migration source; recreate faculty exams from the original PDFs after the disk is attached.
5. Confirm `/data/exams` and `/data/retained-exam` now reside on the disk. Create one exam, restart the service after completion, and verify it remains available with its saved rubric.
6. Test another student submission. Back up persistent exam data separately.

Paid compute removes the idle sleep behavior. It does **not** guarantee zero downtime: disk-backed services can be interrupted during redeploys/maintenance. A restart interrupts in-progress evaluations, preserving their saved checkpoint and PDF. Completed archived student reports survive on the disk; original POC runs remain temporary.

Starting hosting estimate: $7/month service + $0.25/month for 1 GB disk, before taxes or extra metered usage. OpenAI charges remain separate. Confirm pricing in Render before applying an upgrade.

## Sharing the demo

Hosted faculty pages, exam catalog and saved history require the shared faculty credentials. Student links remain public and can invoke evaluations using your API credits. Origin validation is not a rate limit. Share with a small controlled test group using anonymised documents; add an access gate/usage controls before unrestricted use. Production files are served only from the React build directory, not `/data`.

## Official references

- https://render.com/docs/blueprint-spec
- https://render.com/docs/web-services
- https://render.com/docs/environment-variables
- https://render.com/docs/free
- https://render.com/docs/disks
- https://render.com/pricing
