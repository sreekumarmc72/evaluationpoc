# Profiles, faculty sessions and logout

## Interface

Faculty and student headers show a circular local avatar icon, name and role. The profile menu supports keyboard navigation, Escape and outside dismissal. Faculty uses the authenticated username or optional `FACULTY_DISPLAY_NAME`; existing `FACULTY_USER` and `FACULTY_PASSWORD` values remain authoritative. Student views show **Student** until a readable scanned or saved manual submission name is available. No external avatar service or student login is introduced. The faculty exam-list refresh action now displays **Refresh**, using its existing handler.

## Faculty authentication

- `/faculty/login` serves the application sign-in page. Unauthenticated faculty page requests redirect there; protected APIs return 401 (or a fail-closed configuration error when the hosted password is missing).
- `GET /api/faculty/session` reports authentication state and, only when authenticated, the faculty username/display name.
- `POST /api/faculty/login` accepts only username and password, validates the existing environment credentials and rotates the browser's session. Failed attempts receive a generic error; ten failures from the same network address within a minute temporarily limit further attempts. Maps are bounded to prevent unbounded memory growth. Behind a proxy this limit may apply to a shared address.
- A cryptographically random `faculty_session` cookie is HttpOnly, SameSite=Strict and Secure when serving HTTPS or configured with an HTTPS public origin. Only its hash and expiry are kept in server memory. Sessions expire after eight hours and do not survive server restart. No database, persistent authentication file or new secret is needed.
- `POST /api/faculty/logout` revokes that session and expires only the faculty cookie. Replaying the previous cookie or a cached Basic Authorization header cannot restore access. Login/logout pass through the existing same-origin write guard.
- Other tabs using the same browser session are notified to hide faculty content and also recheck on focus, restored-page navigation and periodically. Failed background network checks preserve an in-progress form; backend authorization remains enforced. A failed logout is shown as an error rather than claiming success.

This remains a single shared faculty account. Independently signed-in browsers have separate sessions; logout affects the current session, not every browser. Server-side sessions require a single app instance, as currently deployed. Multiple replicas would require a shared session store and are outside this POC change.

Local mode without configured faculty credentials remains unprotected, as before, and the login page identifies that mode rather than offering invented credentials. To test real sign-in locally, configure `FACULTY_PASSWORD` (and optionally `FACULTY_USER`) or use the isolated session test harness. Hosted `NODE_ENV=production` remains fail-closed without a password.

## Student exit

Student **Log out** leaves the exam view for `/student?left=1`. It does not revoke faculty authentication, delete a submission cookie, remove the exam-scoped saved run pointer, or call a cancellation/delete endpoint. Reopening the exam link can recover the same submission using the original browser access. Evaluation already running on the server continues and its checkpoints remain archived. This is navigation out of a public view, not a new student-authentication system.

## Deployment and verification

No exam, answer PDF, rubric, result, manual name, model setting or scoring rule is migrated or changed. Existing student access cookies retain their scope. Existing faculty Basic-auth browser caches are intentionally ignored, so after deployment faculty signs in through the new form using the same credentials. A restart/deployment requires faculty sign-in again; it does not remove saved exams/results. No Render environment change is required. An optional `FACULTY_DISPLAY_NAME` changes only header presentation.

Regression coverage includes login validation, cookie rotation/revocation/replay/expiry, restart behavior, HTTPS cookie flags, same-origin enforcement, missing hosted credentials, failed-attempt limits, faculty-only mutations, student PDF ownership, evaluation during logout, cross-tab UI updates, profile keyboard handling, connection failures, form preservation and the text refresh button. Tests and the HTTP smoke harness use temporary local data and no real model calls. Do not deploy until the local checks have completed and the user requests a push.
