# v0.3 API contract

Node.js 24+, Express, node:sqlite, React/Vite. Single-team/repository/instance. See [design](docs/DESIGN.md), [operations](docs/OPERATIONS.md) and [implementation details](docs/IMPLEMENTATION-V2.md). Database membership is authoritative; environment whitelists are legacy migration inputs only.

## Security

- JSON errors: `{error, requestId?}`; 400 invalid input, 401 session invalid, 403 unauthorized, 409 version/business conflict, 429 backoff/rate limit.
- Member business APIs require an active member/session. Anonymous read-only APIs: GET `/api/health`, `/api/session`, `/api/public/overview`, `/api/public/items`. OAuth verifies identity, not membership. Registration APIs accept a separate limited registration session only. Signed webhooks remain independent.
- Every browser mutation requires exact configured Origin and `X-CSRF-Token` from session. Signed webhooks use raw-body HMAC instead of browser CSRF.
- Member ID / GitHub fixed ID determine authorization and routing; login strings are display snapshots only.
- Never return complete Feishu open_id, integration secrets, OAuth access tokens or raw webhook payloads to the client.
- Demo is isolated and guest-first, never uses real integrations. Explicit POST `/auth/demo/member` and `/auth/demo/applicant` require exact Origin + `X-Demo-Intent:1`; live mode returns404. No automatic member/admin cookies for anonymous visitors; demo roles/status still come from the database.

## Guest and applicant boundary

Root `/` is public even for signed members; `/workspace` mounts member UI only for mode member. `/join` and `/join/status` are restricted application screens, not personal centers. See [registration/guest design](docs/REGISTRATION-GUEST-DESIGN.md).

`GET /api/session` adds `{mode:'guest'|'applicant'|'member',applicant:RegistrationStatus|null,features:{registrationEnabled,publicOverviewEnabled}}`. `user` exists only for valid active members; csrfToken is member or registration CSRF, otherwise null. Limited cookie `triage_registration` has a 30-minute absolute expiry and never grants member scope. Member login rotates and clears limited sessions. Logout clears both.

`RegistrationStatus={identity:{githubId,login,name,avatarUrl},application,memberStatus,canApply,canLogin,reapplyAt,blocked}`. Public application fields: `{id,status,displayName,module,reason,submittedAt,reviewedAt,publicFeedback,version,round}`; never internalNote or other identities. Approved status does not upgrade a restricted session.

`PublicItem` ONLY `{number,kind,title,state,author,labels,createdAt,updatedAt,url,merged?:true}`. URL is constructed for the configured GitHub repo; no body, fixed user IDs, local fields, assignees, reviewers, CI, member data, audit or notification data. Reconstruct DTOs by allowlist; no spreading member Items.

| Route | Scope and payload |
| --- | --- |
| GET /api/public/overview | Anonymous `{available,reason,demo,repo,repoUrl,dataUpdatedAt,visibilityCheckedAt,stats}`; stats={openPRs,closedPRs,openIssues,closedIssues} or null |
| GET /api/public/items | Anonymous `{available,reason,items,total,page,pageSize,dataUpdatedAt}`; strict query kind=pr|issue,state=open|closed|all,q,page,pageSize≤100, no internal filters |
| POST /api/registration/applications | Limited session+CSRF: `{displayName?,module?,reason,consent:true}` →201 `{application}`; reason10..2000, no self-reported identity/role |
| GET /api/registration/status | Limited session, zero query keys; only current verified identity/application |
| GET /api/admin/join-requests | Admin `{requests,total,page,pageSize,pendingCount}`; query status,q,page,pageSize |
| POST /api/admin/join-requests/:id/approve | Admin+CSRF `{version,publicFeedback?,internalNote?}` → `{request}`; grant only normal pending_activation member, or preserve legitimate existing role/status; disabled409 |
| POST /api/admin/join-requests/:id/reject | Same, publicFeedback required; feedback and internal notes separate |
| GET /api/admin/access-policy | Admin `{policy,publicStatus:{available,reason,checkedAt}}` |
| PUT /api/admin/access-policy | Admin+CSRF full `{version,registrationEnabled,publicOverviewEnabled,reapplyCooldownHours,maxPendingRequests}` → `{policy}` |

Access policy defaults: registration true, public data false, rejection cooldown24h, pending cap1000. Policy version protects races. Enabling public verifies fresh repo metadata before saving and rechecks current admin/session after await; disabling revokes generation/data. Publicly enabling does not itself perform full GitHub sync; admin sync or polling must produce the new projection.

Public reason: disabled / unverified / private / expired / no_snapshot / ready. All public responses no-store. Guest GET never triggers external fetch. Visibility TTL60s; worker refreshes in background and failure closes public access. Only public, repository-ID-matched, complete fresh snapshots are projected. Before and AFTER full fetch verify visibility; forced post-fetch check waits any older flight then starts a fresh check. Revocation epochs prevent late publication after policy changes; private webhooks revoke immediately. Historical private rows in member tables are never a public fallback.

## Identity shapes

`SessionUser`: `{id,memberId,githubId,login,name,avatarUrl,isAdmin,role,status,module,feishuBound,feishuVerified,notificationsEnabled,quietStart,quietEnd}`.

`Member`: `{id,githubId,login,name,displayName,avatarUrl,module,notes?,role,status,version,firstLoginAt,lastLoginAt,createdAt,updatedAt,feishuBound,feishuVerified,notificationsEnabled,reachable}`. `notes` is administrator-only. `status` is pending_activation / active / disabled.

`Item`: original GitHub fields `{id,number,kind,title,body,url,state,author,authorId,assignees,assigneeIds,reviewers,reviewerIds,labels,updatedAt,createdAt,ciStatus,draft?,merged?}` plus local fields `{workflow,ownerMemberId,owner,ownerName,ownerStatus,ownerReachable,ownerIssue,module,priority,dueAt,overdue,version,needsReview}`. Legacy `owner` is display-only. `ownerIssue` may be disabled / pending_activation / unbound / needs_confirmation / notifications_disabled / legacy_unresolved.

## Session / login / personal

| Method and route | Request / response |
| --- | --- |
| GET /api/session | `{user:SessionUser|null,csrfToken,demo,githubConfigured,feishuConfigured,repo}` |
| GET /auth/github | OAuth redirect; verified approved identities activate/login, unknown identities get limited registration session only |
| GET /auth/github/callback | One-time browser-bound OAuth state; verified GitHub identity lookup |
| POST /auth/logout | `{}` → `{ok:true}` |
| GET /auth/feishu/bind | Authenticated OAuth redirect with session-bound persistent binding generation |
| GET /auth/feishu/callback | Link current identity as needs_confirmation; callback may not undo a later unbind |
| POST /api/feishu/test | `{}` → `{sent,demo,user?}`; only current binding successful self-test marks verified |
| DELETE /api/feishu/binding | `{}` → `{ok:true}`; revoke OAuth intent and queued/in-flight envelopes; preserve monotonic generation |
| PATCH /api/preferences | `{notificationsEnabled,quietStart,quietEnd}` → `{user}`; quiet fields both present or both empty, Asia/Shanghai |

## Transactions

| Method and route | Request / response |
| --- | --- |
| GET /api/dashboard | `{stats:{openIssues,openPRs,overdue,myTasks,unassigned,ownerIssues,needsReview},items,activity,lastSync,syncError}` |
| GET /api/items | `{items}`; filters kind,state=open|closed|all,mine,q,ownerMemberId,unassigned,ownerIssue,needsReview,module |
| PATCH /api/items/:id | `{version,workflow?,ownerMemberId?,priority?,dueAt?}` → `{item}`; related members edit local fields; owner changes require admin |
| POST /api/items/:id/claim | `{version}` → `{item}`; active member, open/unassigned item, atomic no-steal |
| POST /api/items/bulk-assign | Admin: `{items:[{id,version}],ownerMemberId}` → `{items}`; 1–100 unique items, all-or-nothing |
| GET /api/assignable-members | `{members:[{id,githubId,login,name,module,status,reachable}]}`; excludes disabled, includes pending, no notes |

Every item PATCH and claim needs current version. Local workflow never closes/merges/modifies GitHub. Explicit workflow changes acknowledge needsReview; priority-only changes do not.

## Administrator membership

| Method and route | Request / response |
| --- | --- |
| GET /api/admin/github-users/resolve?login=... | `{profile:{githubId,login,name,avatarUrl,url,type?}}`; server GET lookup, real User only |
| GET /api/admin/members | `{members,total,page,pageSize}`; filters q,status,role,module,bound; page starts1, pageSize≤100 |
| POST /api/admin/members | `{githubLogin,expectedGithubId,displayName?,module?,notes?,role?,approvePendingRequest?}` → 201 `{member}`; re-resolve server-side before inserting pending member |
| PATCH /api/admin/members/:id | `{version,displayName?,module?,notes?,role?}` → `{member}`; fixed GitHub identity immutable |
| POST /api/admin/members/:id/disable | `{version}` → `{member}`; revoke sessions/OAuth/messages/binding verification, preserve history |
| POST /api/admin/members/:id/enable | `{version}` → `{member}`; active if previously activated, otherwise pending; binding still needs confirmation |
| GET /api/members | Compatibility administrator member list `{members}` |

Last active activated admin cannot be demoted/disabled. Stale versions and duplicate identities return409. No physical delete endpoint.

Demo resolver fixtures: demo-maintainer=1001, reviewer-chen=1002, pending-lin=1003, disabled-wang=1004, new-contributor=1005. They are not actual verified GitHub accounts.

## Notifications / operations

| Method and route | Request / response |
| --- | --- |
| POST /api/sync | Admin `{}` → `{count,lastSync}`; demo only local refresh |
| GET /api/rules | `{rules:{enabled,staleHours,reminderCooldownHours},isAdmin}` |
| PUT /api/rules | Admin same rules object → `{rules}` |
| POST /api/reminders/run | Admin `{}` → `{queued,delivered,failed,skipped}` |
| GET /api/notifications | `{notifications:[{id,title,recipient,recipientMemberId,status,reason,createdAt,error,errorCode,attempts,nextAt}]}`; admin all, member own |
| GET /api/admin/audit-logs | `{logs,total,page,pageSize}`; optional exact action; each log has actor/action/targetType/targetId/before/after/requestId/createdAt |
| GET /api/admin/integration-status | `{demo,repo,lastSync,syncError,nextSyncAllowedAt,githubConfigured,feishuConfigured,syncIntervalMinutes,webhookIntervalSeconds,webhook,notifications,membership,schemaVersion}` |
| POST /api/admin/webhooks/:id/retry | Admin `{}` → `{ok:true}`; only existing unfinished accepted delivery, completed409 |
| POST /api/webhooks/github | HMAC-valid target-repository event persisted / deduped before202; ping200; no business data in response |

Notification status is pending / sending / sent / failed / skipped / cancelled. Cancellation is not resurrected by a failed in-flight send. If upstream accepted while revocation raced, keep cancellation plus DELIVERED_AFTER_REVOCATION and audit actual external acceptance; no retry. UUID-based upstream dedup is bounded, not exactly-once.

Default polling10 minutes, event/message worker15 seconds; neither is a guaranteed delivery SLA. Global notifications default disabled; invalid/unreachable recipients are visible, not silently treated as delivered. CI instant-failure messages, GitHub writes, multi-repo and Feishu interactive cards are explicitly deferred.
