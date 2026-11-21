import { useEffect, useState } from "react";
import {
  Copy,
  Link2,
  Palette,
  Plus,
  ShieldCheck,
  UserRoundMinus,
  UsersRound,
  X,
} from "lucide-react";
import type { EventInfo, Invitation, Member, Role } from "@shared/eventflow";
import QRCode from "@/components/event/QRCode";
import { PageHeading } from "@/components/event/EventShell";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import {
  eventDateFields,
  eventDateUpdateFromFields,
  isLegacyEventDateTime,
} from "@/lib/event-date";
import {
  hasRole,
  InlineError,
  invitationUrl,
  managerRoles,
  RoleNotice,
  roleName,
  useWorkspaceMutation,
  parseCents,
} from "./AdminShared";
import { validLogoAddress } from "@shared/brand";

type SettingsForm = {
  name: string;
  date: string;
  time: string;
  venue: string;
  status: EventInfo["status"];
  brandName: string;
  logoUrl: string;
  color: string;
  privacyText: string;
  registrationOpen: boolean;
  registrationCheckIn: boolean;
  rosterClaimEnabled: boolean;
  threshold: string;
  accumulation: EventInfo["accumulation"];
  excludeWinners: boolean;
  program: EventInfo["program"];
};
type InviteForm = {
  name: string;
  role: Exclude<Role, "owner">;
  merchantId: string;
};
const blankInvite: InviteForm = { name: "", role: "checkin", merchantId: "" };

export default function AdminSettings() {
  const { state, eventId, setEventId, refreshSession } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [confirmLegacyTime, setConfirmLegacyTime] = useState(false);
  const [copyName, setCopyName] = useState("");
  const [showCopy, setShowCopy] = useState(false);
  const [copyValidation, setCopyValidation] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState<InviteForm>(blankInvite);
  const [inviteValidation, setInviteValidation] = useState<string | null>(null);
  const [issuedInvitation, setIssuedInvitation] = useState<Invitation | null>(
    null
  );
  const [revoking, setRevoking] = useState<Member | null>(null);
  const canManage = state ? hasRole(state.role, managerRoles) : false;
  const canManageMembers = state?.role === "owner" || state?.role === "admin";
  const attendanceOnly = state?.event.mode === "attendance";

  useEffect(() => {
    setForm(state ? makeForm(state.event) : null);
    setConfirmLegacyTime(false);
  }, [state?.event]);
  if (!state || !form) return null;

  const submitSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    const dateUpdate = eventDateUpdateFromFields(
      { date: form.date, time: form.time },
      state.event.date,
      confirmLegacyTime
    );
    const thresholdCents = attendanceOnly
      ? state.event.thresholdCents
      : parseCents(form.threshold);
    const logo = form.logoUrl.trim();
    if (
      !form.name.trim() ||
      !form.brandName.trim() ||
      !dateUpdate ||
      (!attendanceOnly && (thresholdCents === null || thresholdCents <= 0))
    ) {
      setValidation(
        attendanceOnly
          ? "請填寫活動、品牌及有效日期和時間（時間可留空待定）。"
          : "請填寫活動、品牌、有效日期和時間（時間可留空待定）及正數抽獎門檻。"
      );
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(form.color)) {
      setValidation("主色必須是六位 HEX 色碼，例如 #C89538。");
      return;
    }
    if (!validLogoAddress(logo)) {
      setValidation(
        "Logo 只接受持久HTTPS網址或 /manus-storage/ 管理資產路徑。"
      );
      return;
    }
    setValidation(null);
    const result = await mutate<EventInfo>(
      "settings-save",
      `/events/${eventId}/settings`,
      "PATCH",
      {
        name: form.name.trim(),
        ...dateUpdate,
        venue: form.venue.trim(),
        status: form.status,
        brand: {
          name: form.brandName.trim(),
          logoUrl: logo,
          color: form.color,
          privacyText: form.privacyText.trim(),
        },
        registrationOpen: form.registrationOpen,
        registrationCheckIn: form.registrationCheckIn,
        program: form.program,
        ...(attendanceOnly
          ? { rosterClaimEnabled: form.rosterClaimEnabled }
          : {
              thresholdCents,
              accumulation: form.accumulation,
              excludeWinners: form.excludeWinners,
            }),
      }
    );
    if (result) setForm(makeForm(result));
  };
  const copyEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!copyName.trim()) {
      setCopyValidation("請為複製出的活動命名。");
      return;
    }
    setCopyValidation(null);
    const result = await mutate<EventInfo>(
      "event-copy",
      `/events/${eventId}/copy`,
      "POST",
      { name: copyName.trim() }
    );
    if (result) {
      setShowCopy(false);
      setCopyName("");
      setEventId(result.id);
      await refreshSession();
    }
  };
  const sendInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !invite.name.trim() ||
      (invite.role === "merchant" && !invite.merchantId) ||
      (attendanceOnly && (invite.role === "merchant" || invite.role === "draw"))
    ) {
      setInviteValidation(
        attendanceOnly
          ? "簽到典禮只可邀請管理員或簽到人員。"
          : "請填寫名稱；商戶角色須選擇其授權商戶。"
      );
      return;
    }
    setInviteValidation(null);
    const result = await mutate<Invitation>(
      "member-invite",
      `/events/${eventId}/members`,
      "POST",
      {
        role: invite.role,
        name: invite.name.trim(),
        ...(invite.role === "merchant"
          ? { merchantId: invite.merchantId }
          : {}),
      }
    );
    if (result) {
      setShowInvite(false);
      setInvite(blankInvite);
      setIssuedInvitation(result);
    }
  };
  const revokeMember = async () => {
    if (!revoking) return;
    const result = await mutate<{ ok: true }>(
      `member-revoke-${revoking.id}`,
      `/events/${eventId}/members/${revoking.id}`,
      "PATCH",
      { active: false }
    );
    if (result) setRevoking(null);
  };

  return (
    <>
      <PageHeading
        eyebrow="YOUR BRAND, YOUR EVENT"
        title="白牌設定"
        description="活動設定、規則版本、成員權限與複製功能均以目前活動作資料邊界。"
        action={
          canManageMembers ? (
            <>
              <button
                className="button button-white"
                onClick={() => setShowCopy(true)}
              >
                <Copy size={15} />
                複製活動
              </button>
              <button
                className="button button-dark"
                form="event-settings-form"
                type="submit"
              >
                儲存設定
              </button>
            </>
          ) : undefined
        }
      />
      <RoleNotice allowed={managerRoles}>
        白牌、活動規則、成員與活動複製只可由擁有者或管理員管理。
      </RoleNotice>
      <form
        id="event-settings-form"
        className="mvp-settings-grid"
        onSubmit={submitSettings}
      >
        <section className="mvp-panel mvp-settings-card">
          <div className="mvp-panel-heading">
            <div>
              <span className="mvp-kicker">EVENT META</span>
              <h2>活動資料</h2>
            </div>
          </div>
          <div className="mvp-form two-col">
            <label>
              活動名稱
              <input
                disabled={!canManage}
                required
                value={form.name}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, name: event.target.value }
                  )
                }
              />
            </label>
            <label>
              活動狀態
              <select
                disabled={!canManage}
                value={form.status}
                onChange={event =>
                  setForm(
                    current =>
                      current && {
                        ...current,
                        status: event.target.value as EventInfo["status"],
                      }
                  )
                }
              >
                <option value="draft">籌備中</option>
                <option value="live">進行中</option>
                <option value="closed">已結束</option>
              </select>
            </label>
            <label>
              日期
              <input
                disabled={!canManage}
                required
                type="date"
                value={form.date}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, date: event.target.value }
                  )
                }
              />
            </label>
            <label>
              {isLegacyEventDateTime(state.event.date)
                ? "開始時間（舊資料時區未指定；留空表示待定）"
                : "開始時間（瀏覽器時區；留空表示待定）"}
              <input
                disabled={!canManage}
                type="time"
                step="0.001"
                value={form.time}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, time: event.target.value }
                  )
                }
              />
              {isLegacyEventDateTime(state.event.date) && (
                <small>未更改日期或時間時會保留舊資料；更改後會按瀏覽器時區儲存。</small>
              )}
            </label>
            {isLegacyEventDateTime(state.event.date) && form.time && (
              <label className="mvp-toggle-label">
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={confirmLegacyTime}
                  onChange={event => setConfirmLegacyTime(event.target.checked)}
                />
                確認以上時間為瀏覽器當地時間，並儲存為具時區的時間
              </label>
            )}
            <label>
              場地（選填，留空表示待定）
              <input
                disabled={!canManage}
                maxLength={300}
                value={form.venue}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, venue: event.target.value }
                  )
                }
              />
            </label>
            <label className="mvp-toggle-label">
              <input
                disabled={!canManage}
                type="checkbox"
                checked={form.registrationOpen}
                onChange={event =>
                  setForm(
                    current =>
                      current && {
                        ...current,
                        registrationOpen: event.target.checked,
                      }
                  )
                }
              />
              開放公開嘉賓登記
            </label>
            <p className="mvp-inline-note">
              所有活動共用簡易姓名登記：輸入名字、選本人、填電話確認。開放時會提供本活動的姓名清單，不公開電話；關閉後停止姓名查找與新登記。
            </p>
            <label className="mvp-toggle-label">
              <input
                disabled={!canManage}
                type="checkbox"
                checked={form.registrationCheckIn}
                onChange={event =>
                  setForm(
                    current =>
                      current && {
                        ...current,
                        registrationCheckIn: event.target.checked,
                      }
                  )
                }
              />
              自助登記提交後，記錄為已到場（只限現場使用）
            </label>
            <p className="mvp-inline-note">
              這是嘉賓自行申報到場，不能核實實際位置；提前發送連結時請關閉此選項。
            </p>
            {attendanceOnly && (
              <label className="mvp-toggle-label">
                <input
                  disabled={!canManage}
                  type="checkbox"
                  checked={form.rosterClaimEnabled}
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          rosterClaimEnabled: event.target.checked,
                        }
                    )
                  }
                />
                保留舊版嚴格名單認領接口（相容已開啟的舊頁面；不影響新版簡易入口）
              </label>
            )}
          </div>
        </section>
        {attendanceOnly && (
          <section className="mvp-panel mvp-settings-card">
            <div className="mvp-panel-heading">
              <div>
                <span className="mvp-kicker">CEREMONY DETAILS</span>
                <h2>典禮資訊</h2>
              </div>
            </div>
            <div className="mvp-form two-col">
              <label>
                英文活動名稱
                <input
                  disabled={!canManage}
                  value={form.program.titleEn}
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          program: {
                            ...current.program,
                            titleEn: event.target.value,
                          },
                        }
                    )
                  }
                />
              </label>
              <label>
                英文組織名稱
                <input
                  disabled={!canManage}
                  value={form.program.organizationEn}
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          program: {
                            ...current.program,
                            organizationEn: event.target.value,
                          },
                        }
                    )
                  }
                />
              </label>
              <label className="mvp-span-all">
                場地地址
                <input
                  disabled={!canManage}
                  value={form.program.venueAddress}
                  placeholder="示例地址（炮台山站A出口）"
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          program: {
                            ...current.program,
                            venueAddress: event.target.value,
                          },
                        }
                    )
                  }
                />
              </label>
              <label>
                恭候時間
                <input
                  disabled={!canManage}
                  value={form.program.receptionTime}
                  placeholder="18:30 恭候"
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          program: {
                            ...current.program,
                            receptionTime: event.target.value,
                          },
                        }
                    )
                  }
                />
              </label>
              <label>
                入席時間
                <input
                  disabled={!canManage}
                  value={form.program.seatingTime}
                  placeholder="19:30 入席"
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          program: {
                            ...current.program,
                            seatingTime: event.target.value,
                          },
                        }
                    )
                  }
                />
              </label>
            </div>
          </section>
        )}
        <section className="mvp-panel mvp-settings-card">
          <div className="mvp-panel-heading">
            <div>
              <span className="mvp-kicker">WHITE-LABEL BRAND</span>
              <h2>品牌外觀</h2>
            </div>
            <Palette size={18} />
          </div>
          <div className="mvp-form">
            <label>
              品牌名稱
              <input
                disabled={!canManage}
                required
                value={form.brandName}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, brandName: event.target.value }
                  )
                }
              />
            </label>
            <label>
              Logo URL
              <input
                disabled={!canManage}
                value={form.logoUrl}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, logoUrl: event.target.value }
                  )
                }
                placeholder="https://… 或 /manus-storage/…"
              />
            </label>
            <label>
              主色{" "}
              <span className="mvp-color-input">
                <input
                  disabled={!canManage}
                  type="color"
                  value={form.color}
                  onChange={event =>
                    setForm(
                      current =>
                        current && { ...current, color: event.target.value }
                    )
                  }
                />
                <input
                  disabled={!canManage}
                  value={form.color}
                  onChange={event =>
                    setForm(
                      current =>
                        current && { ...current, color: event.target.value }
                    )
                  }
                />
              </span>
            </label>
            <label>
              私隱告知
              <textarea
                disabled={!canManage}
                value={form.privacyText}
                onChange={event =>
                  setForm(
                    current =>
                      current && { ...current, privacyText: event.target.value }
                  )
                }
                placeholder="嘉賓可見的個人資料告知"
              />
            </label>
          </div>
        </section>
        {!attendanceOnly && (
          <section className="mvp-panel mvp-settings-card">
            <div className="mvp-panel-heading">
              <div>
                <span className="mvp-kicker">
                  DRAW RULES · VERSION {state.event.ruleVersion}
                </span>
                <h2>抽獎規則</h2>
              </div>
              <ShieldCheck size={18} />
            </div>
            <div className="mvp-form">
              <label>
                每次抽獎門檻（HK$）
                <input
                  disabled={!canManage}
                  required
                  inputMode="decimal"
                  value={form.threshold}
                  onChange={event =>
                    setForm(
                      current =>
                        current && { ...current, threshold: event.target.value }
                    )
                  }
                />
              </label>
              <label>
                機會累積方式
                <select
                  disabled={!canManage}
                  value={form.accumulation}
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          accumulation: event.target
                            .value as EventInfo["accumulation"],
                        }
                    )
                  }
                >
                  <option value="per_transaction">每筆獨立計算</option>
                  <option value="cumulative">跨筆累積計算</option>
                </select>
              </label>
              <label className="mvp-toggle-label">
                <input
                  disabled={!canManage}
                  type="checkbox"
                  checked={form.excludeWinners}
                  onChange={event =>
                    setForm(
                      current =>
                        current && {
                          ...current,
                          excludeWinners: event.target.checked,
                        }
                    )
                  }
                />
                排除已得獎嘉賓
              </label>
              <p className="mvp-rule-note">
                儲存規則會由伺服器建立新版本；已建立的交易保留原有規則快照，不會在瀏覽器中重算。
              </p>
            </div>
          </section>
        )}
        <InlineError message={validation || errorFor("settings-save")} />
      </form>

      <section className="mvp-panel mvp-members-panel">
        <div className="mvp-panel-heading">
          <div>
            <span className="mvp-kicker">MEMBERS & ACCESS</span>
            <h2>工作人員</h2>
          </div>
          {canManageMembers && (
            <button
              className="mvp-text-button"
              onClick={() => setShowInvite(true)}
            >
              <Plus size={15} />
              邀請成員
            </button>
          )}
        </div>
        <div className="mvp-data-table">
          <div className="mvp-table-head">
            <span>成員</span>
            <span>角色</span>
            <span>範圍</span>
            <span>狀態</span>
            <span>操作</span>
          </div>
          {state.members.map(member => (
            <div className="mvp-table-row" key={member.id}>
              <strong>{member.name}</strong>
              <span>{roleName(member.role)}</span>
              <span>
                {member.merchantId
                  ? state.merchants.find(
                      merchant => merchant.id === member.merchantId
                    )?.name || "指定商戶"
                  : "全活動"}
              </span>
              <div>
                <span
                  className={`mvp-status ${member.active ? "success" : "quiet"}`}
                >
                  {member.active ? "有效" : "已撤銷"}
                </span>
                {member.inviteExpiresAt && member.active && (
                  <small>
                    邀請至{" "}
                    {new Date(member.inviteExpiresAt).toLocaleString("zh-HK")}
                  </small>
                )}
              </div>
              <div>
                {canManageMembers &&
                  member.active &&
                  member.role !== "owner" && (
                    <button
                      className="mvp-text-button danger"
                      onClick={() => setRevoking(member)}
                    >
                      <UserRoundMinus size={14} />
                      撤銷
                    </button>
                  )}
              </div>
            </div>
          ))}
          {!state.members.length && (
            <div className="mvp-empty compact">
              <UsersRound size={24} />
              <p>尚未有額外工作人員。</p>
            </div>
          )}
        </div>
      </section>

      {showCopy && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="copy-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => setShowCopy(false)}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">EMPTY-RECORD COPY</span>
            <h2 id="copy-title">複製活動設定</h2>
            <p className="mvp-dialog-copy">
              會複製設定、圍枱版面、商戶與獎項名稱；嘉賓、憑證、收款、抽獎、成員、帳本及稽核紀錄一律不會複製。
            </p>
            {isLegacyEventDateTime(state.event.date) && (
              <p>舊時間未指定時區；複製前請先在活動設定確認時區，或清除時間。</p>
            )}
            <form className="mvp-form" onSubmit={copyEvent}>
              <label>
                新活動名稱
                <input
                  required
                  value={copyName}
                  onChange={event => setCopyName(event.target.value)}
                  placeholder="例如：2027 年度晚宴"
                />
              </label>
              <InlineError message={copyValidation || errorFor("event-copy")} />
              <div className="mvp-dialog-actions">
                <button
                  className="button button-white"
                  type="button"
                  onClick={() => setShowCopy(false)}
                >
                  取消
                </button>
                <button
                  className="button button-dark"
                  disabled={isPending("event-copy")}
                >
                  {isPending("event-copy") ? "複製中…" : "建立空白副本"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {showInvite && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => setShowInvite(false)}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">STAFF INVITATION</span>
            <h2 id="invite-title">邀請工作人員</h2>
            <p className="mvp-dialog-copy">
              邀請為一次性且 24 小時有效。接受後會綁定至其 OAuth 身份。
            </p>
            <form className="mvp-form" onSubmit={sendInvite}>
              <label>
                名稱
                <input
                  required
                  value={invite.name}
                  onChange={event =>
                    setInvite(current => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="姓名或職務名稱"
                />
              </label>
              <label>
                角色
                <select
                  value={invite.role}
                  onChange={event =>
                    setInvite(current => ({
                      ...current,
                      role: event.target.value as InviteForm["role"],
                      merchantId:
                        event.target.value === "merchant"
                          ? current.merchantId
                          : "",
                    }))
                  }
                >
                  <option value="admin">管理員</option>
                  <option value="project_manager">Project Manager</option>
                  <option value="guest_manager">嘉賓簽到及圍枱管理員</option>
                  <option value="checkin">簽到人員</option>
                  {!attendanceOnly && <option value="draw">抽獎人員</option>}
                  {!attendanceOnly && (
                    <option value="merchant">商戶人員</option>
                  )}
                </select>
              </label>
              {invite.role === "merchant" && (
                <label>
                  指定商戶
                  <select
                    required
                    value={invite.merchantId}
                    onChange={event =>
                      setInvite(current => ({
                        ...current,
                        merchantId: event.target.value,
                      }))
                    }
                  >
                    <option value="">選擇商戶</option>
                    {state.merchants.map(merchant => (
                      <option key={merchant.id} value={merchant.id}>
                        {merchant.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <InlineError
                message={inviteValidation || errorFor("member-invite")}
              />
              <div className="mvp-dialog-actions">
                <button
                  className="button button-white"
                  type="button"
                  onClick={() => setShowInvite(false)}
                >
                  取消
                </button>
                <button
                  className="button button-dark"
                  disabled={isPending("member-invite")}
                >
                  {isPending("member-invite") ? "建立中…" : "建立邀請"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {issuedInvitation && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog mvp-invitation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="issued-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => setIssuedInvitation(null)}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">ONE-TIME STAFF INVITATION</span>
            <h2 id="issued-title">工作人員邀請 QR</h2>
            <QRCode
              value={invitationUrl(issuedInvitation.path)}
              title="工作人員邀請 QR"
            />
            <a
              className="mvp-invite-url"
              href={invitationUrl(issuedInvitation.path)}
            >
              <Link2 size={14} />
              開啟一次性邀請連結
            </a>
          </section>
        </div>
      )}
      {revoking && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => setRevoking(null)}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">REVOKE ACCESS</span>
            <h2 id="revoke-title">撤銷 {revoking.name} 的存取權？</h2>
            <p className="mvp-dialog-copy">
              撤銷後該成員不能再以此角色存取目前活動；現有稽核紀錄會保留。
            </p>
            <InlineError message={errorFor(`member-revoke-${revoking.id}`)} />
            <div className="mvp-dialog-actions">
              <button
                className="button button-white"
                onClick={() => setRevoking(null)}
              >
                取消
              </button>
              <button
                className="button mvp-button-danger"
                disabled={isPending(`member-revoke-${revoking.id}`)}
                onClick={() => void revokeMember()}
              >
                {isPending(`member-revoke-${revoking.id}`)
                  ? "撤銷中…"
                  : "確認撤銷"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function makeForm(event: EventInfo): SettingsForm {
  const dateFields = eventDateFields(event.date);
  return {
    name: event.name,
    date: dateFields.date,
    time: dateFields.time,
    venue: event.venue,
    status: event.status,
    brandName: event.brand.name,
    logoUrl: event.brand.logoUrl,
    color: event.brand.color || "#C89538",
    privacyText: event.brand.privacyText,
    registrationOpen: event.registrationOpen,
    registrationCheckIn: Boolean(event.registrationCheckIn),
    rosterClaimEnabled:
      event.mode === "attendance" && Boolean(event.rosterClaimEnabled),
    threshold: `${Math.floor(event.thresholdCents / 100)}.${String(event.thresholdCents % 100).padStart(2, "0")}`,
    accumulation: event.accumulation,
    excludeWinners: event.excludeWinners,
    program: event.program,
  };
}
