# v0.3 API contract

Node.js 24+, Express, node:sqlite, React/Vite. Single-team/repository/instance. See [design](docs/DESIGN.md), [operations](docs/OPERATIONS.md) and [implementation details](docs/IMPLEMENTATION-V2.md). Database membership is authoritative; environment whitelists are legacy migration inputs only.

## Security

- JSON errors: `{error, requestId?}`; 400 invalid input, 401 session invalid, 403 unauthorized, 409 version/business conflict, 429 backoff/rate limit.
- Member business APIs require an active member/session. Anonymous read-only APIs: GET `/api/health`, `/api/session`, `/api/public/overview`, `/api/public/items`. GitHub OAuth links or creates the member account on first login. Signed webhooks remain independent.
- GitHub writes are limited to creating issue/PR comments with the member's encrypted OAuth token; the platform never merges, closes, labels, assigns or edits code. Tokens are never returned or logged, and are deleted on disable or local revocation.
- Every browser mutation requires exact configured Origin and `X-CSRF-Token` from session. Signed webhooks use raw-body HMAC instead of browser CSRF.
- Member ID / GitHub fixed ID determine authorization and routing; login strings are display snapshots only.
- Never return complete Feishu open_id, integration secrets, OAuth access tokens or raw webhook payloads to the client.
- Demo is isolated and guest-first, never uses real integrations. Explicit POST `/auth/demo/member` requires exact Origin + `X-Demo-Intent:1`; live mode returns404. No automatic member/admin cookies for anonymous visitors; demo roles/status still come from the database.

## Guest and member boundary

Root `/` is public even for signed members; `/workspace` mounts member UI only for mode member. `/join` is the GitHub login screen, not a personal center or application form.

`GET /api/session` returns `{mode:'guest'|'member',user,csrfToken,features:{publicOverviewEnabled}}`. `user` exists only for valid active members; csrfToken is the member CSRF, otherwise null. Logout clears the member session.

`PublicItem` ONLY `{number,kind,title,state,author,labels,createdAt,updatedAt,url,merged?:true}`. URL is constructed for the configured GitHub repo; no body, fixed user IDs, local fields, assignees, reviewers, CI, member data, audit or notification data. Reconstruct DTOs by allowlist; no spreading member Items.

| Route | Scope and payload |
| --- | --- |
| GET /api/public/overview | Anonymous `{available,reason,demo,repo,repoUrl,dataUpdatedAt,visibilityCheckedAt,stats}`; stats={openPRs,closedPRs,openIssues,closedIssues} or null |
| GET /api/public/items | Anonymous `{available,reason,items,total,page,pageSize,dataUpdatedAt}`; strict query kind=pr|issue,state=open|closed|all,q,page,pageSize≤100, no internal filters |
| GET /api/admin/access-policy | Admin `{policy,publicStatus:{available,reason,checkedAt}}` |
| PUT /api/admin/access-policy | Admin+CSRF `{version,publicOverviewEnabled}` → `{policy}` |

Access policy defaults: public data false. Policy version protects races. Enabling public verifies fresh repo metadata before saving and rechecks current admin/session after await; disabling revokes generation/data. Publicly enabling does not itself perform full GitHub sync; admin sync or polling must produce the new projection.

Public reason: disabled / unverified / private / expired / no_snapshot / ready. All public responses no-store. Guest GET never triggers external fetch. Visibility TTL60s; worker refreshes in background and failure closes public access. Only public, repository-ID-matched, complete fresh snapshots are projected. Before and AFTER full fetch verify visibility; forced post-fetch check waits any older flight then starts a fresh check. Revocation epochs prevent late publication after policy changes; private webhooks revoke immediately. Historical private rows in member tables are never a public fallback.

## Identity shapes

`SessionUser`: `{id,memberId,githubId,login,name,avatarUrl,isAdmin,role,status,module,feishuBound,feishuVerified,notificationsEnabled,quietStart,quietEnd,githubWriteReady,githubWriteScopes}`.

`Member`: `{id,githubId,login,name,displayName,avatarUrl,module,notes?,role,status,version,firstLoginAt,lastLoginAt,createdAt,updatedAt,feishuBound,feishuVerified,notificationsEnabled,reachable}`. `notes` is administrator-only. `status` is pending_activation / active / disabled.

`Item`: original GitHub fields `{id,number,kind,title,body,url,state,author,authorId,assignees,assigneeIds,reviewers,reviewerIds,labels,updatedAt,createdAt,ciStatus,draft?,merged?}` plus local fields `{workflow,ownerMemberId,owner,ownerName,ownerStatus,ownerReachable,ownerIssue,module,priority,dueAt,overdue,version,needsReview}`. Legacy `owner` is display-only. `ownerIssue` may be disabled / pending_activation / unbound / needs_confirmation / notifications_disabled / legacy_unresolved.

## Session / login / personal

| Method and route | Request / response |
| --- | --- |
| GET /api/session | `{mode:'guest'|'member',user:SessionUser|null,csrfToken,demo,githubConfigured,feishuConfigured,repo,features}` |
| GET /auth/github | OAuth redirect; first login auto-creates an active member, later logins reuse the fixed GitHub identity |
| GET /auth/github/callback | One-time browser-bound OAuth state; creates/links the member and establishes a member session |
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

## Conversation

| Method and route | Request / response |
| --- | --- |
| GET /api/items/:id/conversation | `{item,messages,events:{ci,operation},unread,sync,syncError?}`; query `before`, `limit≤100`, `refresh=0|1`; messages newest-first, long bodies are collapsed by the client |
| POST /api/items/:id/conversation/sync | Member; force incremental GitHub sync of comments/reviews/timeline/CI |
| POST /api/items/:id/messages | `{body,clientId?}` →201 `{message}`; comments are posted to GitHub as the member; 409 `GITHUB_WRITE_AUTH_REQUIRED` + `authUrl` when authorization is missing |
| POST /api/items/:id/messages/:messageId/retry | Retry a failed local message, dedupe by clientId |
| POST /api/items/:id/ci/:eventId/rerun | Member; re-run every job of the GitHub Actions workflow run behind this check as the member's own GitHub identity, falling back to `GITHUB_ACTIONS_TOKEN` only when the organization blocks OAuth Apps; response `{ok,runId,via:'member'\|'server'}`; 409 `CI_NOT_RERUNABLE` / `CI_RUN_ID_MISSING` / `GITHUB_WRITE_AUTH_REQUIRED`; commit statuses and non-Actions checks are rejected |
| POST /api/items/:id/read | `{messageIds:[≤50]}` → `{marked}`; own messages are not recorded |
| GET /api/items/:id/messages/:messageId/reads | `{members:[{memberId,displayName,login,avatarUrl,readAt}]}`; active members only |
| GET /api/items/unread | `{items:{itemId:{unread,mentions,lastMessageAt}},total,mentions}` |
| GET /api/items/search | `{items:[{id,number,kind,title,state}]}`; query `q≤100`, at most 8 lightweight rows for the `#` reference picker; no bodies |
| POST /api/github/authorization/revoke | Delete the member's local GitHub write token; no GitHub-side revocation |

`Message` DTO: `{id,source,kind,author:{memberId?,login,name,avatarUrl},body,createdAt,updatedAt,url,path,line,startLine?,side?,diffHunk?,reviewCommentId?,state,deliveryStatus,deliveryError,remoteDeleted,mentions:[{login,memberId?,isSelf}],readCount,readByMe}`. Inline `review_comment` messages also carry `path`, `line`, `startLine`, `side` (`LEFT`/`RIGHT`), `diffHunk`, `reviewCommentId` (GitHub review comment id) and `url`. The platform builds the jump target as `<itemUrl>/changes#r<reviewCommentId>`, because GitHub resolves `#discussion_r<id>` on the PR root to the Conversation tab instead of Files changed. `Event` DTO: `{id,category,type,actor,summary,detail,occurredAt}`.

`GET /api/items` and `/api/dashboard` add `unreadCount`, `mentionCount`, `lastMessageAt` per item and `stats.unreadMessages` / `stats.mentions`. Conversation writes require active member + Origin + CSRF and are rate limited; read receipts are platform-member-only and never infer GitHub-side readers.

## Administrator membership

| Method and route | Request / response |
| --- | --- |
| GET /api/admin/members | `{members,total,page,pageSize}`; filters q,status,role,module,bound; page starts1, pageSize≤100 |
| PATCH /api/admin/members/:id | `{version,displayName?,module?,notes?,role?}` → `{member}`; fixed GitHub identity immutable |
| POST /api/admin/members/:id/disable | `{version}` → `{member}`; revoke sessions/OAuth/messages/binding verification, preserve history |
| POST /api/admin/members/:id/enable | `{version}` → `{member}`; active if previously activated, otherwise pending; binding still needs confirmation |
| GET /api/members | Compatibility administrator member list `{members}` |

Members are created by their first GitHub login; there is no administrator create endpoint. An existing `pending_activation` record can only come from a legacy migration and activates on first login. Last active activated admin cannot be demoted/disabled. Stale versions and duplicate identities return409. No physical delete endpoint.

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
