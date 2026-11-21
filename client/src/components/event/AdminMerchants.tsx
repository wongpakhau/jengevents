import { useState } from "react";
import { Link2, Plus, Store, ToggleLeft, ToggleRight, UsersRound, X } from "lucide-react";
import type { Invitation, Merchant } from "@shared/eventflow";
import QRCode from "@/components/event/QRCode";
import { PageHeading } from "@/components/event/EventShell";
import { money } from "@/lib/eventflow-api";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { hasRole, InlineError, invitationUrl, managerRoles, RoleNotice, useWorkspaceMutation } from "./AdminShared";

export default function AdminMerchants() {
  const { state, eventId } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  const [showMerchantForm, setShowMerchantForm] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState<Merchant | null>(null);
  const [merchantName, setMerchantName] = useState("");
  const [staffName, setStaffName] = useState("");
  const [invitation, setInvitation] = useState<{ merchant: Merchant; invitation: Invitation } | null>(null);

  if (!state) return null;
  const canManage = hasRole(state.role, managerRoles);
  const receiptCount = (merchantId: string) => state.receipts.filter(receipt => receipt.merchantId === merchantId && receipt.status === "valid").length;
  const totalSales = (merchantId: string) => state.receipts.filter(receipt => receipt.merchantId === merchantId && receipt.status === "valid").reduce((total, receipt) => total + receipt.amountCents, 0);

  const addMerchant = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = merchantName.trim();
    if (!name) return;
    const result = await mutate<Merchant>("merchant-create", `/events/${eventId}/merchants`, "POST", { name });
    if (result) { setMerchantName(""); setShowMerchantForm(false); }
  };
  const toggleMerchant = async (merchant: Merchant) => {
    await mutate<Merchant>(`merchant-toggle-${merchant.id}`, `/events/${eventId}/merchants/${merchant.id}`, "PATCH", { active: !merchant.active });
  };
  const inviteStaff = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!showInviteForm || !staffName.trim()) return;
    const result = await mutate<Invitation>(`merchant-invite-${showInviteForm.id}`, `/events/${eventId}/members`, "POST", { role: "merchant", merchantId: showInviteForm.id, name: staffName.trim() });
    if (result) { setInvitation({ merchant: showInviteForm, invitation: result }); setShowInviteForm(null); setStaffName(""); }
  };

  return <>
    <PageHeading eyebrow="CONNECT EVERY MERCHANT" title="商戶管理" description="商戶啟用狀態及工作人員範圍由目前活動的伺服器權限控制。" action={canManage ? <button className="button button-dark" onClick={() => setShowMerchantForm(true)}><Plus size={16} />新增商戶</button> : undefined} />
    <RoleNotice allowed={managerRoles}>商戶人員只可於已授權的商戶範圍內操作；建立、啟停及發出工作人員邀請需要擁有者或管理員。</RoleNotice>
    <section className="mvp-merchant-grid">
      {state.merchants.map(merchant => <article className="mvp-panel mvp-merchant-card" key={merchant.id}>
        <div className="mvp-merchant-top"><span className="mvp-merchant-mark">{merchant.name.slice(0, 1)}</span><span className={`mvp-status ${merchant.active ? "success" : "quiet"}`}>{merchant.active ? "營運中" : "已停用"}</span></div>
        <h2>{merchant.name}</h2><p>{receiptCount(merchant.id)} 筆有效消費憑證 · 有效消費 {money(totalSales(merchant.id))}</p>
        {canManage && <div className="mvp-card-actions"><button className="mvp-text-button" disabled={isPending(`merchant-toggle-${merchant.id}`)} onClick={() => void toggleMerchant(merchant)}>{merchant.active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}{merchant.active ? "停用商戶" : "啟用商戶"}</button><button className="mvp-text-button" onClick={() => setShowInviteForm(merchant)}><UsersRound size={15} />邀請工作人員</button></div>}
        <InlineError message={errorFor(`merchant-toggle-${merchant.id}`)} />
      </article>)}
      {!state.merchants.length && <section className="mvp-empty"><Store size={28} /><h2>尚未設定商戶</h2><p>建立商戶後才可發出消費憑證及記錄對帳。</p></section>}
    </section>
    <InlineError message={errorFor("merchant-create")} />

    {showMerchantForm && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog" role="dialog" aria-modal="true" aria-labelledby="merchant-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setShowMerchantForm(false)}><X size={18} /></button><span className="mvp-kicker">MERCHANT SETUP</span><h2 id="merchant-title">新增商戶</h2><form className="mvp-form" onSubmit={addMerchant}><label>商戶名稱<input required value={merchantName} onChange={event => setMerchantName(event.target.value)} placeholder="例如：海港茶舍" /></label><div className="mvp-dialog-actions"><button type="button" className="button button-white" onClick={() => setShowMerchantForm(false)}>取消</button><button className="button button-dark" disabled={isPending("merchant-create")}>{isPending("merchant-create") ? "建立中…" : "建立商戶"}</button></div></form></section></div>}

    {showInviteForm && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog" role="dialog" aria-modal="true" aria-labelledby="merchant-invite-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setShowInviteForm(null)}><X size={18} /></button><span className="mvp-kicker">SCOPED STAFF INVITE</span><h2 id="merchant-invite-title">邀請 {showInviteForm.name} 工作人員</h2><p className="mvp-dialog-copy">此邀請只會授權指定商戶，且一次性、24 小時有效。</p><form className="mvp-form" onSubmit={inviteStaff}><label>工作人員名稱<input required value={staffName} onChange={event => setStaffName(event.target.value)} placeholder="姓名或職務名稱" /></label><InlineError message={errorFor(`merchant-invite-${showInviteForm.id}`)} /><div className="mvp-dialog-actions"><button type="button" className="button button-white" onClick={() => setShowInviteForm(null)}>取消</button><button className="button button-dark" disabled={isPending(`merchant-invite-${showInviteForm.id}`)}>{isPending(`merchant-invite-${showInviteForm.id}`) ? "建立中…" : "建立邀請"}</button></div></form></section></div>}

    {invitation && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog mvp-invitation-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-link-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setInvitation(null)}><X size={18} /></button><span className="mvp-kicker">MERCHANT STAFF INVITATION</span><h2 id="staff-link-title">{invitation.merchant.name} 工作人員邀請</h2><QRCode value={invitationUrl(invitation.invitation.path)} title="商戶工作人員邀請 QR" /><a className="mvp-invite-url" href={invitationUrl(invitation.invitation.path)}><Link2 size={14} />開啟一次性邀請連結</a></section></div>}
  </>;
}
