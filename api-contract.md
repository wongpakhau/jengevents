# MVP API 契約

所有業務API前綴 `/api/eventflow`；成功直接回傳JSON（不包data），失敗HTTP4xx/5xx `{error:string,code?:string}`。金額整數分。時間ISO UTC。使用shared/eventflow.ts資料型別。所有staff端用現有sdk.authenticateRequest(req)，不虛構登入。驗證資料一律由後端；寫入JSON且credentials include，拒絕跨站Origin/不正確Content-Type。Idempotency-Key 用於所有關鍵寫入，同鍵異內容409。UUID作主鍵，票號六位數（舞台只捲後三位、前綴固定顯示）。

## 存取
GET /session -> Session (401 if logged out)
GET /api/auth/google/start?returnTo=<path> -> 302 Google；returnTo 只接受固定同源路徑白名單 `/`, `/join`, `/access`, `/merchant`, `/checkin`, `/draw`, `/guests`, `/settlements`（完全相等，不接受 query/hash/尾斜線/其他路徑），否則回 `/`。回呼後 302 至白名單路徑；前端 RoleLanding 只在路徑為 `/` 時依活動角色轉向（merchant→/merchant、checkin→/checkin、draw→/draw、guest_manager→/guests；attendance 模式 merchant/draw 留在 `/`），深連結不轉向。
POST /organizations {name} -> {id,name} (verified user creates own tenant)
POST /events {tenantId,name,date,venue} -> EventInfo (tenant owner only)
GET /events/:eventId/state -> WorkspaceState (role-clipped; owner/admin all, checkin only guests/tables/basic event, draw only public guest fields/prizes/draws, merchant only authorized merchant/its receipts/basic event; no token hashes/private engine fields)
PATCH /events/:eventId/settings Partial<EventInfo minus ids> -> EventInfo (owner/admin; rules versioned, existing transactions preserve rules)
POST /events/:eventId/copy {name} -> EventInfo (settings/tables layout/merchants/prize names copied with fresh IDs, no guests/receipts/payments/draws/members/ledger/audit copied)
POST /events/:eventId/members {role:'admin'|'checkin'|'draw'|'merchant',merchantId?:string,name:string} -> Invitation (owner/admin; scoped high-entropy invite, single-use 24h)
POST /invites/accept {token} -> {eventId,role} (OAuth authenticated, binds membership to current verified user; cannot overwrite owner)
PATCH /events/:eventId/members/:id {active:false} -> {ok:true}

## Guests/tables/checkin
POST /events/:eventId/guests {name,email?,phone?} -> {guest:Guest,invitation:Invitation} owner/admin. Invite token stored hashed, raw only issuance. No raw tokens in state.
POST /events/:eventId/guests/import {rows:{name,email?,phone?}[]} -> {created:number, invitations:{guest:Guest,invitation:Invitation}[]} max500 rows atomic, no overwrite existing.
PATCH /events/:eventId/guests/:id {name?,email?,phone?} -> Guest
POST /events/:eventId/guests/:id/invitation {} -> Invitation (rotate guest token, invalidates old link; no loss of receipts)
POST /events/:eventId/checkin {token:string} -> {guest:Guest,alreadyCheckedIn:boolean} owner/admin/checkin; same-event invitation token only, manual staff confirmation via guestId optional route body {guestId} supported.
POST /events/:eventId/tables {number,label?,capacity?:12,x?:number,y?:number} -> EventTable
PATCH /events/:eventId/tables/:id {label?,x?,y?} -> EventTable (canvas coordinates normalized0..100)
POST /events/:eventId/seating {guestId,tableId:string|null,seat:number|null} -> Guest; seat1..12 must be unoccupied, atomic movement; null unassign.

## Merchant/receipts/settlements
POST /events/:eventId/merchants {name} -> Merchant
PATCH /events/:eventId/merchants/:id {active:boolean} -> Merchant
POST /events/:eventId/purchase-code/resolve {code,merchantId} -> {guest:{id,name,ticket},expiresAt}; owner/admin/project_manager or own authorized active merchant, same-event short-lived consumption code only, no guest login token or PII in response.
POST /events/:eventId/receipts {merchantId,amountCents,reference:string,purchaseCode?:string} -> ReceiptIssued (owner/admin/project_manager or own authorized merchant; 10% round half-up per transaction; expires24h; rule snapshot; no fake chances in request). With purchaseCode: status pending, intended guest bound, no guest login or receipt-claim token returned. Pending/rejected receipts do not count as sales, fees or chances; new legacy no-code issuance also starts pending and returns its existing receipt QR, then becomes valid on explicit guest claim. Historical valid receipts remain unchanged.
POST /events/:eventId/receipts/:id/void {reason} -> Receipt (owner/admin; negate fee and ledger if safe, preserve audit; if included in previous draw snapshot mark drawException and don't silently alter draw)
GET /events/:eventId/settlements -> Settlement[] owner/admin/project_manager see all merchants; merchant sees only their own event-scoped merchant. Server does not accept a merchant selector from the request. Private, no-store.
POST /events/:eventId/payments {merchantId,amountCents,reference} -> Payment owner/admin/project_manager, no automatic charges
GET /events/:eventId/export -> CSV attachment, owner/admin/project_manager; formula-safe cells, include receipt/fee/paid/void status; no tokens. Private, no-store. CSV acceptable accounting export for MVP.

## Draw
POST /events/:eventId/prizes {name} -> Prize
POST /events/:eventId/draws {prizeId} -> Draw owner/admin/draw; immutable weighted snapshot of positive valid chances; randomInt or cryptographically secure picker, one result per prize; Idempotency-Key same draw, new key same prize rejected. Default exclude previous winners, no automatic chance consumption; preserve all ledger/snapshot sources. Winner data only authorized draw staff, not public guests until revealed.
POST /events/:eventId/draws/positive-spring-red-packet {} -> Draw; owner/admin/project_manager/draw for the fixed 正向春茗 event only, on or after 2027-01-31 17:00 Hong Kong time, one manual HK$1,000 draw from valid checked-in guests at one chance each. No consumption or prior-winner restriction; idempotency, event lock and dedicated prize prevent duplicate draws. No payment is made.
POST /events/:eventId/draws/:id/reveal {} -> Draw idempotent owner/admin/draw; never selects a new winner. Screen /screen uses authenticated workspace state, not publicly guessable access. Stage animates only already server-chosen ticket, after7s reveal; reconnect uses original draw and elapsed createdAt, replay only reruns visuals.

## Guest public capability (no OAuth required)
GET /public/events/:slug -> EventInfo safe public branding/settings
POST /public/events/:slug/register {name,email?,phone?,consent:true} -> {guest,invitation} only if registrationOpen. No PII exposed by GET. Maxreasonable registration with rate limiting.
POST /public/events/:slug/quick-names {sort?:'name'|'phone'} and POST /public/events/:slug/roster-names {consent:true,sort?:'name'|'phone'} -> {names:string[]} only. Default name sorting; phone sorting is performed server-side and does not return phone values or sorting keys, though it reveals the relative ordering of names by phone. Existing event, participant, consent and rate-limit restrictions remain in force.
GET /guest with header X-Guest-Token -> GuestView (own guest/own receipts/revealed draws only)
POST /guest/purchase-code {} with X-Guest-Token and Idempotency-Key -> {code,path,expiresAt}; purpose-scoped encrypted short-lived code, bound to event, guest and current invitation hash; no raw login capability, phone or email. Returned path /merchant#purchase=<code>.
POST /guest/receipts/:id/decision {confirmed:boolean} with X-Guest-Token and Idempotency-Key -> ClaimResult; only intended guest, explicit confirm pending -> valid and atomic ledger award, reject pending -> rejected with no sales/chances. Same decision replay never duplicates credit; wrong guest, conflicting decision, void or expiry fail closed.
POST /guest/claim-preview {token:receiptToken} with X-Guest-Token -> {receipt,merchantName}; read-only validation of legacy receipt before explicit customer confirmation, no mutation or credit.
POST /guest/claim {token:receiptToken} with X-Guest-Token -> ClaimResult (single claim, same guest replay idempotent, cross guest409, cross event403, expired410; transaction and guest locks/atomicity). Per-transaction floor(amount/threshold); cumulative difference of floors per rule version, no duplicate credit.

Guest URLs `/guest#invite=<token>`; receipt URLs `/guest#claim=<token>`; staff invitations `/join#invite=<token>`; registration `/register/:slug`. Hash avoids server/referrer token disclosure. Guest remembers its invite only in sessionStorage/localStorage by own choice; never treat receipt as guest identity. Display token hashes never. Frame QR code uses location.origin + returned relative path in browser only; server doesn't derive public URLs from req Host.

正向春茗及新建完整活動的新消費規則：已確認消費跨筆累積，每滿 HK$500（50,000 分）得一次一般抽獎機會，餘額保留；歷史憑證仍依簽發時的 ruleVersion/threshold/accumulation 計算。單次 HK$1,000 現場利是抽獎仍是已簽到嘉賓每人等權一次。

`/demo/admin`、`/demo/merchant`、`/demo/guest` 為隔離的前端角色示範，三個登入頁測試按鈕不會建立正式帳戶、正式 Cookie、授權或 API 登入。只使用瀏覽器示範命名空間，不寫入正式活動或抽獎資料；跨裝置測試須使用真正授權帳戶及正式流程。
