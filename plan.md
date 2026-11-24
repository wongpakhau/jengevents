# 消費憑證、HK$500 消費抽獎券及角色測試入口

沿用 EventFlow 現有 React／TypeScript、Express API、活動聚合資料、工作人員 Google 登入及嘉賓邀請憑證，不重新設計網站或登入系統。

商家使用已有授權工作區掃描嘉賓「消費領抽獎券」QR，核對嘉賓姓名及票號後輸入實際港幣消費金額與交易參考。QR 必須是短效、限定用途的消費識別碼，不得包含嘉賓登入憑證、電話或電郵，也不得授予任何登入或角色權限。商家只可為自身授權商戶開單；伺服器驗證活動、商戶及消費碼後保存待確認憑證。嘉賓在自己的頁面核對商家、金額及交易參考，再明確確認或拒絕。確認前不增加抽獎權益，也不計入已確認營業額；重試、重複確認不得重複領券。

正向春茗及新建完整活動的已確認消費跨筆累積每滿 HK$500 得一次一般抽獎機會，餘額保留；HK$300 加 HK$200 合共一次、HK$1,000 兩次。已有憑證保留簽發時的規則快照，不重算既有中獎或修改歷史資料。保留原有商家出示憑證 QR 的領取方式，但改為嘉賓明確確認後才領取。既有 HK$1,000 利是在 2027 年 1 月 31 日香港時間下午 5 時的單次現場抽獎，仍按已簽到嘉賓每人一次等權參加，不受消費影響。

登入頁新增「測試管理員」、「商家測試」、「用家測試」三個入口，前往獨立、清楚標示的前端示範模式；不建立或模擬正式登入、不呼叫正式資料寫入 API、不設定登入 Cookie、不提供免驗證管理員權限。示範資料只存於瀏覽器隔離的測試命名空間，可重設；三個角色共用同一瀏覽器內的示範消費以體驗商家輸入、用家確認及管理員查看對帳的不同功能，不能作為跨裝置或正式端到端交易驗證。

## 專案結構

- `client/src/pages/GuestPortal.tsx`、消費 QR 與確認元件：嘉賓本人資料、待確認清單、領券及已確認消費。
- `client/src/pages/MerchantTerminal.tsx`：商家掃碼、核對、開單與待確認狀態。
- `client/src/pages/RoleDemo.tsx`、`client/src/lib/role-demo.ts`：隔離示範 UI 和純函式狀態；不與正式工作區或身份共用。
- `server/eventflow/routes.ts`、`server/eventflow/purchase-code.ts`：授權、消費碼、交易鎖、憑證確認和防重複。
- `shared/eventflow.ts`：憑證狀態與 API 型別；`server/eventflow/engine.ts`、`accounting.ts` 沿用一般權益及對帳引擎。
- `client/src/components/event/WorkspaceGate.tsx`、`client/src/App.tsx`、`client/public/manus-routes.json`：測試入口與新增頁面。

開發、測試和正式共用資料庫。自動檢查只用純函式或模擬連線，不以測試交易污染正式活動，不加入之前六筆嘉賓資料。保留現有品牌和行動端樣式，毋須新增裝飾圖片或外部資產。

# 三種角色介面與「登入即到位」易用性優化（2026-11-24）

沿用現有 Google 工作人員登入、臨時參與者帳戶、嘉賓邀請憑證與消費確認流程，不新增身份機制、不繞過真實登入、不改動資料模型或 API 寫入規則。目標是從登入頁開始，三種人各自只見到自己需要的入口和畫面：

- 登入頁（`/` 未登入）改為三個清晰角色入口：「大會管理員／工作人員」用 Google 登入回到工作台；「商家」用 Google 登入並直接回到 `/merchant` 掃碼開單；「用戶／嘉賓」按鈕按裝置是否已記住個人嘉賓邀請，前往 `/guest` 或 `/participant`（臨時帳戶→掃大會 QR）。三個獨立示範入口保留但降為次要「試用示範」。
- 伺服器 Google 登入 `returnTo` 白名單由固定集合擴至 `/merchant`、`/checkin`、`/draw`、`/guests`、`/settlements`，仍只接受固定的同源路徑，不接受任意 URL。
- 登入後按活動角色自動到位（`client/src/lib/role-home.ts` 純函式）：merchant → `/merchant`、checkin → `/checkin`、draw → `/draw`、guest_manager → `/guests`、owner／admin／project_manager → `/` 總覽。只在工作台根路徑轉向，刻意開啟的深層連結不受影響；「不在授權範圍」頁加入「前往你的工作台」按鈕。
- 商家終端精簡為三步並顯示步驟指示：1 掃用戶 QR（掃碼面板預設展開，相機仍需按下才開啟）→ 2 輸入金額（交易參考可留空自動產生）→ 3 等待用戶確認。只有一個授權商戶時不再顯示下拉選單。側欄為商家與管理員加入「商戶掃碼開單」導覽。
- 用戶介面把「我的消費 QR」放在歡迎卡之下、自動產生並顯示（短效、仍只供商家掃描），其後才是累積金額、抽獎機會、待確認交易、座位、憑證與結果；「記住邀請」等設定移到頁底。
- 管理員總覽加入快捷列（現場簽到、嘉賓管理、商戶對帳、掃碼開單、抽獎控制、帳戶授權）及待確認消費筆數，營業額／對帳／抽獎一眼可見。

## 本輪涉及檔案

- `client/src/lib/role-home.ts`（新增，含測試）：角色首頁、角色標籤與嘉賓入口路徑純函式。
- `client/src/components/event/WorkspaceGate.tsx`、`client/src/styles/role-entry.css`：三角色登入頁、登入後轉向。
- `client/src/pages/EventWorkspace.tsx`、`client/src/components/event/EventShell.tsx`、`client/src/components/event/AdminOverview.tsx`：授權範圍提示、導覽與管理員快捷列。
- `client/src/pages/MerchantTerminal.tsx`、`client/src/pages/GuestPortal.tsx`、`client/src/components/event/ConsumerTickets.tsx`、`client/src/styles/consumption.css`：商家三步與用戶 QR 優先。
- `server/_core/googleAuth.ts`、`server/google-auth.test.ts`、`server/consumption-ui-contract.test.ts`、`api-contract.md`：returnTo 白名單與回歸測試。
