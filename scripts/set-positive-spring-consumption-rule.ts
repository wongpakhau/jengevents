#!/usr/bin/env -S pnpm exec tsx
import { pathToFileURL } from "node:url";
import mysql, { type Connection, type ConnectionOptions } from "mysql2/promise";
import {
  ConsumptionRuleError,
  safeConsumptionRuleError,
  setPositiveSpringConsumptionRule,
  type ConsumptionRuleMode,
  type ConsumptionRuleReport,
} from "../server/eventflow/positive-spring-consumption-rule";

export function parseConsumptionRuleMode(
  args: readonly string[]
): ConsumptionRuleMode {
  if (!args.length || (args.length === 1 && args[0] === "--dry-run")) {
    return "dry-run";
  }
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new ConsumptionRuleError(
    "用法：pnpm exec tsx scripts/set-positive-spring-consumption-rule.ts [--dry-run | --apply]（預設只讀預覽）。"
  );
}

/** Same connection restrictions as the authorized positive-spring initializer. */
export function consumptionRuleConnectionOptions(
  raw: string | undefined
): ConnectionOptions {
  if (!raw) throw new ConsumptionRuleError("必須明確設定 DATABASE_URL。");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConsumptionRuleError("DATABASE_URL 格式不正確。");
  }
  if (
    url.protocol !== "mysql:" ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new ConsumptionRuleError(
      "DATABASE_URL 必須是指定資料庫的 MySQL URL。"
    );
  }
  // URI parameters can override mysql2 host/database/credentials/options.
  // Only the initializer's SSL parameter is permitted; never silently redirect.
  for (const key of url.searchParams.keys()) {
    if (key !== "ssl") {
      throw new ConsumptionRuleError(
        "DATABASE_URL 查詢參數只允許 ssl；請檢查連線設定。"
      );
    }
  }
  return {
    uri: raw,
    charset: "UTF8MB4_UNICODE_CI",
    timezone: "Z",
    multipleStatements: false,
  };
}

export type ConsumptionRuleConnector = (
  options: ConnectionOptions
) => Promise<Connection>;

/** Injectable connector allows CLI tests without any network/database access. */
export async function runPositiveSpringConsumptionRuleCli(
  args: readonly string[] = process.argv.slice(2),
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  connect: ConsumptionRuleConnector = options => mysql.createConnection(options)
): Promise<ConsumptionRuleReport> {
  const mode = parseConsumptionRuleMode(args);
  const options = consumptionRuleConnectionOptions(databaseUrl);
  try {
    const connection = await connect(options);
    try {
      return await setPositiveSpringConsumptionRule(connection, { mode });
    } finally {
      await connection.end();
    }
  } catch (error) {
    throw safeConsumptionRuleError(error);
  }
}

// Importing this module in isolated tests never connects or runs the CLI.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPositiveSpringConsumptionRuleCli()
    .then(report => {
      // Only allowlisted operational fields, encoded to escape control characters.
      console.log(JSON.stringify(report));
    })
    .catch((error: unknown) => {
      console.error(safeConsumptionRuleError(error).message);
      process.exitCode = 1;
    });
}
