# 正向春茗活動初始化說明

本專案的新資料庫已建立「正向春茗」草稿，日期為 2027-01-31，時間和場地待定。草稿使用完整活動模式，登記尚未開放，沒有虛構使用者或名單。組織「正向春茗（籌備中）」只是暫定分組名稱，並非已確認的組織名稱。

組織及活動擁有人仍未指派。使用者已指定五個系統擁有人 Google 帳戶：pakhauwong@gmail.com、mikilee1028@gmail.com、yeeayeeahk@gmail.com、garyyang020730@gmail.com、cj93128@gmail.com。名單記錄於後端權限設定，必須驗證直接 Google 登入後才生效。完成 Google 登入設定後，其中一位擁有人須登入工作台，明確選擇將待指派活動指派給目前登入的帳戶。資料庫的組織及活動各保留一位認領者；認領後五位經驗證的系統擁有人均依系統擁有人權限管理活動。未指派的活動不會供一般訪客、成員或系統管理員讀取或操作。不要開放登記，直至大會核對資料與設定。

## 一次性初始化

`pnpm exec tsx scripts/init-positive-spring-banquet.ts --confirm-new-empty-database` 僅供本專案全新、已遷移且所有應用程式資料表皆空的資料庫使用。執行前必須核對目標資料庫，並停止所有其他寫入者及 DDL。腳本使用 named lock、REPEATABLE READ 交易、固定識別碼及永久標記；受管理的 TiDB 不支援 SERIALIZABLE，不應假設空表範圍鎖能阻止非合作寫入者。再次執行僅核對現有標記與識別，不覆寫使用者後續資料；不一致時會停止，不得刪除標記或強行重建。

`pnpm db:migrate` 管理資料庫遷移，執行前先確認資料庫目標及備份。MySQL 類型的 DDL 可能隱式提交，中斷後須檢查實際結構與遷移紀錄，不可盲目重試。`DATABASE_URL` 與 Google OAuth 憑證只應透過安全設定注入，不能提交到版本庫。

登入需在 `server/_core/googleOrigins.ts` 設定已確認的精確 HTTPS 網域，並在 Google OAuth 用戶端註冊相同網域的 `/api/auth/google/callback`。還需安全設定 `GOOGLE_CLIENT_ID` 與 `GOOGLE_CLIENT_SECRET`，並以真人帳戶驗證登入、權限、認領和主要操作。發布或健康檢查成功不等於 Google 登入或活動營運已完成驗收。

## bp.jengevents.com 登入入口

2026-11-23 使用者確認目前使用 `https://bp.jengevents.com`；唯讀正式版本查詢確認此網域指向本網站。工作區已加入此精確可信來源，保留原有 `https://eventflow-ctmsgwbx.manus.space`；沒有加入尚未接通的 `www.jengevents.com` 或任何萬用字元。

Google Cloud 專案 API 3D 的網頁 OAuth 用戶端已核對：JavaScript 來源為 `https://bp.jengevents.com`，已授權重新導向 URI 包含 `https://bp.jengevents.com/api/auth/google/callback`；以上原已存在，沒有重複修改。已儲存 `openid`、`userinfo.email` 及 `userinfo.profile` 三項非機密基本登入範圍，沒有加入機密或受限制範圍。新 Client ID 與配對密鑰已透過安全設定保存；工作區狀態顯示 `configured:true`，但這不是正式網站或真人登入驗證。

Google 品牌設定目前的應用程式名稱為「Manus」，授權網域包括 `manus.space` 及 `jengevents.com`；首頁、私隱政策和服務條款連結目前空白。受眾仍為 External／Testing，沒有擅自發布 Google 應用程式或申請驗證。只有經使用者授權發布網站修正及以五個指定帳戶直接 Google 登入後，才能真人驗證系統擁有人權限。Manus 帳戶的 Google 綁定與登入不等同本應用的直接 Google 身份；不得只改 `loginMethod`、電郵或資料庫角色來略過驗證。

工作區修正包含新增 cj93128@gmail.com 為第五位系統擁有人，通過 Google 登入、擁有人、待認領隔離及登出共 214 項回歸測試，並通過 TypeScript 型別檢查。測試移除 `DATABASE_URL` 與 `DRIZZLE_DATABASE_URL` 環境變數，以 mock 的 Google 身份與資料庫操作驗證，沒有使用真人帳戶或修改正式資料。

截至 2026-11-23 16:44，修正仍只保留在工作區，正式 bp 入口回報 Google 直接登入未設定。使用者其後明確授權立即發布登入修正及第五位擁有人；Auto Publish 已開啟，發布結果及真人登入、認領仍需驗證，不能因版本提交就宣稱完成。
