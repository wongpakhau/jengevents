# EventFlow 程式碼移轉說明

本 ZIP 由已接受的 Manus checkpoint `9b81f448ce3248e8155ca5c3254ea0bb3822631f` 建立，僅供在另一個 Manus 帳戶重新建立網站程式專案。

## 本包包含／不包含

- 包含前端、後端、共享型別、資料庫 schema/migrations、Dockerfile、依賴鎖定檔、通用操作指南及不含個人名單的程式測試。
- 不含 `.git` 歷史、任何 CSV、`.env`／密鑰、正式 MySQL 資料、活動交付文件、嘉賓資料，亦不含原活動宴會廳平面圖。
- 內建舊示範資料已替換為空白／匿名示例；含活動日期、賓客姓名／別名的個別回歸測試已省略或匿名化。
- CSV 匯入／匯出功能仍在程式碼中；本 ZIP 不提供名單檔或 CSV 範本。
- 舊活動專用姓名別名與座位圖位置已從快照移除；新帳戶需按新的活動設定名單、場地圖及座位。
- `server/eventflow/access-policy.ts` 保留系統擁有人電郵白名單；請在新帳戶部署前檢視是否仍適用。

## 在新 Manus 帳戶使用

1. 在新帳戶建立 Webdev 網站專案，將本 ZIP 的原始碼匯入／解壓到專案工作區；這不會自動接管舊帳戶的網站或資料。
2. 使用 Node.js 22 與 pnpm 10.18.0；安裝依賴：`pnpm install --frozen-lockfile`。可先執行 `pnpm check`、`pnpm test`、`pnpm build`。
3. 在新帳戶啟用伺服器與 MySQL，使用新帳戶提供的資料庫連線。此 ZIP 不含舊帳戶正式資料，也不可把舊資料庫 URL 當作一般設定複製。
4. 對新資料庫執行 `pnpm db:migrate`。若將來匯入任何正式資料，先在來源端備份，再另行確認資料範圍與授權。
5. 在新帳戶的秘密管理設定 OAuth／資料庫連線；勿將值寫入 Git。Google OAuth 的正式 redirect URI 必須更新為 `https://<新正式網域>/api/auth/google/callback`，並在 Google Cloud Console 加入相同 URI。
6. 正式容器使用根目錄 `Dockerfile`；預設埠為 `3000`，健康檢查路徑為 `/api/health`。正式啟動命令為 `pnpm start`（容器內使用 `node dist/index.js`）。
7. 新帳戶需自行重新設定網域、秘密、資料庫、Google OAuth 用戶端、管理權限及發布設定。舊網站在新帳戶驗收前仍然保持原狀。

本 ZIP 是程式碼快照，不是正式網站資料備份，也不包含可直接還原的活動／嘉賓／簽到紀錄。
