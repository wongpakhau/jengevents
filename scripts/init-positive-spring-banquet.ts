#!/usr/bin/env -S pnpm exec tsx
import mysql from "mysql2/promise";
import {
  InitializationError,
  initializePositiveSpring,
} from "../server/eventflow/positive-spring-initializer";

async function main(): Promise<void> {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== "--confirm-new-empty-database"
  ) {
    throw new InitializationError(
      "用法：pnpm exec tsx scripts/init-positive-spring-banquet.ts --confirm-new-empty-database"
    );
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new InitializationError("必須明確設定 DATABASE_URL。");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InitializationError("DATABASE_URL 格式不正確。");
  }
  if (
    url.protocol !== "mysql:" ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new InitializationError(
      "DATABASE_URL 必須是指定資料庫的 MySQL URL。"
    );
  }
  // mysql2 lets URI query parameters override the host, database, socket,
  // credentials and even falsy connection options. Only SSL is permitted;
  // reject everything else rather than silently connect to an unintended DB.
  for (const key of url.searchParams.keys()) {
    if (key !== "ssl") {
      throw new InitializationError(
        "DATABASE_URL 查詢參數只允許 ssl；請檢查連線設定。"
      );
    }
  }

  const connection = await mysql.createConnection({
    uri: raw,
    charset: "UTF8MB4_UNICODE_CI",
    timezone: "Z",
    multipleStatements: false,
  });
  try {
    const result = await initializePositiveSpring(connection);
    console.log(
      result === "created"
        ? "已建立正向春茗草稿；組織與活動擁有人均待指派。"
        : "已確認先前初始化；沒有覆寫任何資料。"
    );
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  // Do not print raw driver errors: they may contain credentials, hosts or SQL.
  console.error(
    error instanceof InitializationError
      ? error.message
      : "初始化未完成；請在安全的操作環境檢查資料庫設定及衝突。"
  );
  process.exitCode = 1;
});
