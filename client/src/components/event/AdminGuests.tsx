import { useState } from "react";
import {
  Download,
  FileUp,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Ticket,
  Users,
  X,
} from "lucide-react";
import type { Guest, Invitation } from "@shared/eventflow";
import { eventGuests, isExcludedFromEvent } from "@shared/eventflow";
import { CLASS_TYPES, classLabel } from "@shared/registration";
import QRCode from "@/components/event/QRCode";
import { PageHeading } from "@/components/event/EventShell";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import {
  downloadText,
  hasRole,
  InlineError,
  invitationUrl,
  guestManagerRoles,
  RoleNotice,
  useWorkspaceMutation,
} from "./AdminShared";

type GuestDraft = {
  name: string;
  email: string;
  phone: string;
  group: string;
  note: string;
  classType: string;
  classNumber: string;
  chapter: string;
  invitedBy: string;
  memberKind: string;
  rosterKey: string;
  rosterClaimBlocked: boolean;
  excludedFromEvent?: boolean;
};
type GuestCreation = { guest: Guest; invitation: Invitation };
type GuestImport = {
  created: number;
  updated?: number;
  invitations: GuestCreation[];
};

const emptyDraft: GuestDraft = {
  name: "",
  email: "",
  phone: "",
  group: "",
  note: "",
  classType: "",
  classNumber: "",
  chapter: "",
  invitedBy: "",
  memberKind: "",
  rosterKey: "",
  rosterClaimBlocked: false,
  excludedFromEvent: false,
};

export default function AdminGuests() {
  const { state, eventId } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  const [query, setQuery] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const [draft, setDraft] = useState<GuestDraft>(emptyDraft);
  const [editing, setEditing] = useState<Guest | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [rows, setRows] = useState<GuestDraft[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<{
    guest: Guest;
    invitation: Invitation;
  } | null>(null);
  const [importedInvitations, setImportedInvitations] = useState<
    GuestCreation[]
  >([]);
  const [copyState, setCopyState] = useState<string | null>(null);

  if (!state) return null;
  const canManage = hasRole(state.role, guestManagerRoles);
  const attendanceOnly = state.event.mode === "attendance";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const guests = state.guests.filter(guest => {
    if (attendanceOnly && isExcludedFromEvent(state.event, guest) !== showExcluded) return false;
    if (!normalizedQuery) return true;
    return [
      guest.name,
      guest.email,
      guest.phone,
      guest.ticket,
      guest.group,
      guest.note,
      classLabel(guest),
      guest.classNumber || "",
      guest.chapter || "",
      guest.reportedChapter || "",
      guest.invitedBy || "",
    ].some(value => value.toLocaleLowerCase().includes(normalizedQuery));
  });

  const submitGuest = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    const body = {
      name,
      email: draft.email.trim() || undefined,
      phone: draft.phone.trim() || undefined,
      group: draft.group.trim(),
      note: draft.note.trim(),
      classType: draft.classType,
      classNumber: draft.classNumber.trim(),
      chapter: draft.chapter.trim(),
      invitedBy: draft.invitedBy.trim(),
      memberKind: draft.memberKind,
      rosterKey: draft.rosterKey.trim(),
      rosterClaimBlocked: draft.rosterClaimBlocked,
      ...(attendanceOnly ? { excludedFromEvent: Boolean(draft.excludedFromEvent) } : {}),
    };
    if (editing) {
      const result = await mutate<Guest>(
        "guest-edit",
        `/events/${eventId}/guests/${editing.id}`,
        "PATCH",
        body
      );
      if (result) closeGuestForm();
      return;
    }
    const result = await mutate<GuestCreation>(
      "guest-create",
      `/events/${eventId}/guests`,
      "POST",
      body
    );
    if (result) {
      closeGuestForm();
      setInvitation(result);
    }
  };

  const rotateInvitation = async (guest: Guest) => {
    const result = await mutate<Invitation>(
      `guest-rotate-${guest.id}`,
      `/events/${eventId}/guests/${guest.id}/invitation`,
      "POST",
      {}
    );
    if (result) setInvitation({ guest, invitation: result });
  };

  const importGuests = async () => {
    if (!rows.length) {
      setImportError("請先選擇含有姓名欄位的 CSV 檔案。");
      return;
    }
    if (rows.length > 500) {
      setImportError("一次最多可匯入 500 位嘉賓，請分批上載。");
      return;
    }
    setImportError(null);
    const result = await mutate<GuestImport>(
      "guest-import",
      `/events/${eventId}/guests/import`,
      "POST",
      { rows }
    );
    if (result) {
      setShowImport(false);
      setRows([]);
      setImportedInvitations(result.invitations);
      if (result.invitations[0]) setInvitation(result.invitations[0]);
    }
  };

  const closeGuestForm = () => {
    setShowForm(false);
    setEditing(null);
    setDraft(emptyDraft);
  };

  const setFromFile = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = parseGuestCsv(await file.text());
      if (!parsed.length) {
        setImportError(
          "找不到有效資料。第一列必須包含 name（可附 email、phone、group、note）。"
        );
      } else {
        setRows(parsed);
        setImportError(null);
      }
    } catch {
      setImportError("CSV 檔案無法讀取，請另存為 UTF-8 CSV 後再試。");
    }
  };

  const useInvite = invitation ? invitationUrl(invitation.invitation.path) : "";
  const downloadInvitation = () => {
    if (!invitation) return;
    downloadText(
      `${safeName(invitation.guest.name)}-invite.txt`,
      `${invitation.guest.name} 的活動邀請連結\n${useInvite}\n`
    );
  };
  const downloadImportedInvitations = () => {
    if (!importedInvitations.length) return;
    const csv = [
      "name,invite_url",
      ...importedInvitations.map(
        item =>
          `${csvCell(item.guest.name)},${csvCell(
            invitationUrl(item.invitation.path)
          )}`
      ),
    ].join("\n");
    downloadText("eventflow-import-invitations.csv", csv);
  };
  const copyInvitation = async () => {
    if (!useInvite || !navigator.clipboard) {
      setCopyState("此瀏覽器不支援直接複製，請使用下載連結。");
      return;
    }
    try {
      await navigator.clipboard.writeText(useInvite);
      setCopyState("已複製邀請連結。");
    } catch {
      setCopyState("未能複製連結，請使用下載連結。");
    }
  };
  const rosterUrl = `/api/eventflow/events/${encodeURIComponent(eventId)}/guest-roster.csv`;

  return (
    <>
      <PageHeading
        eyebrow="PEOPLE MAKE THE EVENT"
        title="嘉賓管理"
        description={
          attendanceOnly
            ? "管理嘉賓、分組及備註；座位與到場資料可隨時匯出。"
            : "新增、更新與邀請均會直接寫入目前活動；邀請憑證只在發出時顯示一次。"
        }
        action={
          canManage ? (
            <>
              <a className="button button-white" href={rosterUrl}>
                <Download size={15} />
                匯出嘉賓／座位
              </a>
              <button
                className="button button-white"
                onClick={() => setShowImport(true)}
              >
                <FileUp size={15} />
                CSV 匯入
              </button>
              <button
                className="button button-dark"
                onClick={() => {
                  setDraft(emptyDraft);
                  setEditing(null);
                  setShowForm(true);
                }}
              >
                <Plus size={16} />
                新增嘉賓
              </button>
            </>
          ) : undefined
        }
      />
      <RoleNotice allowed={guestManagerRoles}>
        你可查看權限允許的名單；新增、編輯、匯入、匯出及旋轉邀請由活動擁有者或管理員執行。
      </RoleNotice>

      <section className="mvp-panel">
        <div className="mvp-list-toolbar">
          <div>
            <strong>{eventGuests(state.event, state.guests).length}</strong>
            <span>位參會嘉賓</span>
          </div>
          {attendanceOnly && <label className="mvp-toggle-label">
            <input type="checkbox" checked={showExcluded} onChange={event => setShowExcluded(event.target.checked)} />
            只看保留／不參會紀錄（{state.guests.filter(guest => isExcludedFromEvent(state.event, guest)).length}）
          </label>}
          <label className="mvp-search">
            <Search size={15} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜尋姓名、分會、邀請人、班別、電話或票號"
            />
          </label>
        </div>
        <div className="mvp-data-table mvp-guests-table">
          <div className="mvp-table-head">
            <span>嘉賓／分組</span>
            <span>票號／座位</span>
            <span>簽到</span>
            <span>{attendanceOnly ? "備註" : "抽獎機會"}</span>
            <span>操作</span>
          </div>
          {guests.map(guest => {
            const table = state.tables.find(item => item.id === guest.tableId);
            return (
              <div className="mvp-table-row" key={guest.id}>
                <div className="mvp-person">
                  <span>{guest.name.slice(0, 1)}</span>
                  <div>
                    <strong>{guest.name}</strong>
                    <small>
                      {classLabel(guest) ||
                        guest.group ||
                        guest.email ||
                        guest.phone ||
                        "未分組／未提供聯絡資料"}
                    </small>
                    {(guest.chapter || guest.invitedBy) && (
                      <small>
                        {[
                          guest.chapter && `分會：${guest.chapter}`,
                          guest.invitedBy && `邀請人：${guest.invitedBy}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    )}
                    {guest.reportedChapter && (
                      <small>嘉賓自報分會：{guest.reportedChapter}</small>
                    )}
                    {guest.rosterClaimBlocked && <small>需人工核對</small>}
                    {isExcludedFromEvent(state.event, guest) && <small>保留紀錄／不參會（不計人數）</small>}
                  </div>
                </div>
                <div>
                  <strong>{guest.ticket}</strong>
                  <small>
                    {table && guest.seat
                      ? `${table.number} 號枱 · 座位 ${guest.seat}`
                      : "尚未安排座位"}
                  </small>
                </div>
                <span
                  className={`mvp-status ${guest.checkedInAt ? "success" : "quiet"}`}
                >
                  {isExcludedFromEvent(state.event, guest) ? "不參會（歷史保留）" : guest.checkedInAt ? "已到場" : "未簽到"}
                </span>
                {attendanceOnly ? (
                  <small className="mvp-cell-note">{guest.note || "—"}</small>
                ) : (
                  <span className="mvp-chance">
                    <Ticket size={13} />
                    {guest.chances} 次
                  </span>
                )}
                <div className="mvp-row-actions">
                  {canManage && (
                    <>
                      <button
                        className="mvp-text-button"
                        onClick={() => {
                          setEditing(guest);
                          setDraft({
                            name: guest.name,
                            email: guest.email,
                            phone: guest.phone,
                            group: guest.group,
                            note: guest.note,
                            classType: guest.classType || "",
                            classNumber: guest.classNumber || "",
                            chapter: guest.chapter || "",
                            invitedBy: guest.invitedBy || "",
                            memberKind: guest.memberKind || "",
                            rosterKey: guest.rosterKey || "",
                            rosterClaimBlocked: Boolean(
                              guest.rosterClaimBlocked
                            ),
                            excludedFromEvent: Boolean(guest.excludedFromEvent),
                          });
                          setShowForm(true);
                        }}
                      >
                        <Pencil size={14} />
                        編輯
                      </button>
                      <button
                        className="mvp-text-button"
                        disabled={isExcludedFromEvent(state.event, guest) || isPending(`guest-rotate-${guest.id}`)}
                        onClick={() => void rotateInvitation(guest)}
                      >
                        <RefreshCw size={14} />
                        旋轉邀請
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!guests.length && (
          <div className="mvp-empty compact">
            <Users size={24} />
            <p>
              {normalizedQuery
                ? "找不到符合搜尋的嘉賓。"
                : "尚未建立嘉賓；可手動新增或從 CSV 匯入。"}
            </p>
          </div>
        )}
      </section>
      <InlineError
        message={errorFor("guest-create") || errorFor("guest-edit")}
      />

      {showForm && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guest-form-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={closeGuestForm}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">GUEST PROFILE</span>
            <h2 id="guest-form-title">
              {editing ? "更新嘉賓資料" : "新增嘉賓"}
            </h2>
            <form className="mvp-form" onSubmit={submitGuest}>
              <label>
                姓名
                <input
                  required
                  value={draft.name}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="嘉賓姓名"
                />
              </label>
              {attendanceOnly && (
                <>
                  <label>
                    班種（選填）
                    <select
                      value={draft.classType}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          classType: event.target.value,
                          classNumber: event.target.value
                            ? current.classNumber
                            : "",
                        }))
                      }
                    >
                      <option value="">未提供班級</option>
                      {CLASS_TYPES.map(type => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    班號（自行輸入）
                    <input
                      value={draft.classNumber}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          classNumber: event.target.value,
                        }))
                      }
                      disabled={!draft.classType}
                      placeholder="例如62、BP62、格局10"
                    />
                  </label>
                  <label>
                    分會（選填）
                    <input
                      value={draft.chapter}
                      maxLength={200}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          chapter: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    邀請人（選填）
                    <input
                      value={draft.invitedBy}
                      maxLength={200}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          invitedBy: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    類別（不代表工作人員登入權限）
                    <select
                      value={draft.memberKind}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          memberKind: event.target.value,
                        }))
                      }
                    >
                      <option value="">未提供</option>
                      <option value="core">核心成員</option>
                      <option value="member">會員</option>
                      <option value="guest">嘉賓</option>
                    </select>
                  </label>
                  <label>
                    名單編號（來源識別，選填）
                    <input
                      value={draft.rosterKey}
                      maxLength={200}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          rosterKey: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="mvp-toggle-label">
                    <input
                      type="checkbox"
                      checked={draft.rosterClaimBlocked}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          rosterClaimBlocked: event.target.checked,
                        }))
                      }
                    />
                    需人工核對（禁止自助認領）
                  </label>
                  <label className="mvp-toggle-label">
                    <input type="checkbox" checked={Boolean(draft.excludedFromEvent)} onChange={event => setDraft(current => ({ ...current, excludedFromEvent: event.target.checked }))} />
                    保留紀錄／不參會（不計人數、不可簽到或排位；解除時須通過聯絡資料去重）
                  </label>
                </>
              )}
              <label>
                分組（選填）
                <input
                  value={draft.group}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      group: event.target.value,
                    }))
                  }
                  placeholder="例如：Noble 分會 · 會員"
                />
              </label>
              <label>
                電郵（選填）
                <input
                  type="email"
                  value={draft.email}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  placeholder="name@example.com"
                />
              </label>
              <label>
                電話（選填）
                <input
                  value={draft.phone}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      phone: event.target.value,
                    }))
                  }
                  placeholder="聯絡電話"
                />
              </label>
              <label>
                備註（選填，僅工作人員可見）
                <textarea
                  value={draft.note}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                  placeholder="例如：由某位會員邀請／需後補資料"
                />
              </label>
              <InlineError
                message={errorFor(editing ? "guest-edit" : "guest-create")}
              />
              <div className="mvp-dialog-actions">
                <button
                  type="button"
                  className="button button-white"
                  onClick={closeGuestForm}
                >
                  取消
                </button>
                <button
                  className="button button-dark"
                  disabled={isPending(editing ? "guest-edit" : "guest-create")}
                >
                  {isPending(editing ? "guest-edit" : "guest-create")
                    ? "儲存中…"
                    : "儲存嘉賓"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showImport && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => {
                setShowImport(false);
                setRows([]);
                setImportError(null);
              }}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">CSV IMPORT</span>
            <h2 id="import-title">匯入嘉賓名單</h2>
            <p className="mvp-dialog-copy">
              姓名必填；支援原有
              name、email、phone、group、note、class_type、class_number， 及
              chapter、invited_by、member_kind、roster_key、roster_claim_blocked
              、excluded_from_event（保留不參會，僅典禮）
              （或分會、邀請人、類別、名單編號、人工核對）。類別為
              core/member/guest/空，人工核對以 true/1/是表示。
              最多500列；相同名單編號更新原嘉賓，保留票號、座位、到場及原有聯絡，沒有編號則新增。
            </p>
            <div className="mvp-upload-row">
              <label className="button button-white">
                <FileUp size={15} />
                選擇 CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={event => void setFromFile(event.target.files?.[0])}
                  hidden
                />
              </label>
              <button
                className="mvp-text-button"
                onClick={() =>
                  downloadText(
                    "eventflow-guests-template.csv",
                    "name,email,phone,group,note,class_type,class_number,chapter,invited_by,member_kind,roster_key,roster_claim_blocked,excluded_from_event\n"
                  )
                }
              >
                下載範本
              </button>
            </div>
            {rows.length > 0 && (
              <div className="mvp-import-preview">
                <strong>已讀取 {rows.length} 列</strong>
                <span>
                  {rows
                    .slice(0, 3)
                    .map(row => row.name)
                    .join("、")}
                  {rows.length > 3 ? "…" : ""}
                </span>
              </div>
            )}
            <InlineError message={importError || errorFor("guest-import")} />
            <div className="mvp-dialog-actions">
              <button
                className="button button-white"
                onClick={() => setShowImport(false)}
              >
                取消
              </button>
              <button
                className="button button-dark"
                disabled={!rows.length || isPending("guest-import")}
                onClick={() => void importGuests()}
              >
                {isPending("guest-import")
                  ? "匯入中…"
                  : `匯入 ${rows.length || ""} 位嘉賓`}
              </button>
            </div>
          </section>
        </div>
      )}

      {invitation && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog mvp-invitation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => {
                setInvitation(null);
                setImportedInvitations([]);
                setCopyState(null);
              }}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">ONE-TIME INVITATION</span>
            <h2 id="invite-title">{invitation.guest.name} 的邀請 QR</h2>
            <p className="mvp-dialog-copy">
              請立即安全地交給嘉賓。旋轉邀請後，舊連結會失效。
            </p>
            <QRCode
              value={useInvite}
              title={`${invitation.guest.name} 的活動邀請`}
            />
            <a className="mvp-invite-url" href={useInvite}>
              {useInvite}
            </a>
            <div className="mvp-dialog-actions">
              <button
                className="button button-white"
                onClick={() => void copyInvitation()}
              >
                <Link2 size={15} />
                複製連結
              </button>
              <button
                className="button button-dark"
                onClick={downloadInvitation}
              >
                <Download size={15} />
                下載邀請連結
              </button>
            </div>
            {importedInvitations.length > 1 && (
              <button
                className="mvp-text-button"
                onClick={downloadImportedInvitations}
              >
                <Download size={14} />
                下載本次匯入的全部 {importedInvitations.length} 個邀請連結
              </button>
            )}
            {copyState && (
              <p className="mvp-inline-note" role="status">
                {copyState}
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}

export function parseGuestCsv(text: string): GuestDraft[] {
  const matrix = parseCsv(text).filter(row => row.some(cell => cell.trim()));
  if (matrix.length < 2) return [];
  const headers = matrix[0].map(value =>
    value
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
  );
  const indexOf = (...names: string[]) =>
    headers.findIndex(header => names.includes(header));
  const nameIndex = indexOf("name", "姓名", "嘉賓姓名");
  const emailIndex = indexOf("email", "電郵", "電郵地址");
  const phoneIndex = indexOf("phone", "電話", "聯絡電話");
  const groupIndex = indexOf("group", "分組", "嘉賓分組");
  const noteIndex = indexOf("note", "備註", "嘉賓備註");
  const classTypeIndex = indexOf(
    "class_type",
    "classType",
    "classtype",
    "班種"
  );
  const classNumberIndex = indexOf(
    "class_number",
    "classNumber",
    "classnumber",
    "班號"
  );
  const chapterIndex = indexOf("chapter", "分會");
  const invitedByIndex = indexOf("invited_by", "invitedby", "邀請人");
  const memberKindIndex = indexOf("member_kind", "memberkind", "類別");
  const rosterKeyIndex = indexOf("roster_key", "rosterkey", "名單編號");
  const blockedIndex = indexOf(
    "roster_claim_blocked",
    "rosterclaimblocked",
    "人工核對"
  );
  const excludedIndex = indexOf("excluded_from_event", "excludedfromevent", "保留不參會");
  if (nameIndex === -1) return [];
  return matrix
    .slice(1)
    .map(row => ({
      name: (row[nameIndex] ?? "").trim(),
      email: emailIndex === -1 ? "" : (row[emailIndex] ?? "").trim(),
      phone: phoneIndex === -1 ? "" : (row[phoneIndex] ?? "").trim(),
      group: groupIndex === -1 ? "" : (row[groupIndex] ?? "").trim(),
      note: noteIndex === -1 ? "" : (row[noteIndex] ?? "").trim(),
      classType:
        classTypeIndex === -1 ? "" : (row[classTypeIndex] ?? "").trim(),
      classNumber:
        classNumberIndex === -1 ? "" : (row[classNumberIndex] ?? "").trim(),
      chapter: chapterIndex === -1 ? "" : (row[chapterIndex] ?? "").trim(),
      invitedBy:
        invitedByIndex === -1 ? "" : (row[invitedByIndex] ?? "").trim(),
      memberKind:
        memberKindIndex === -1 ? "" : (row[memberKindIndex] ?? "").trim(),
      rosterKey:
        rosterKeyIndex === -1 ? "" : (row[rosterKeyIndex] ?? "").trim(),
      rosterClaimBlocked:
        blockedIndex !== -1 &&
        ["true", "1", "是"].includes(
          (row[blockedIndex] ?? "").trim().toLowerCase()
        ),
      excludedFromEvent: excludedIndex === -1 ? undefined : ["true", "1", "是"].includes((row[excludedIndex] ?? "").trim().toLowerCase()),
    }))
    .filter(row => row.name);
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, "-") || "guest";
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
