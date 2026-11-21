import { useState } from "react";
import { ExternalLink, Gift, Play, Plus, Sparkles, X } from "lucide-react";
import type { Draw, Prize } from "@shared/eventflow";
import { PageHeading } from "@/components/event/EventShell";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { drawRoles, formatIso, hasRole, InlineError, managerRoles, RoleNotice, useWorkspaceMutation } from "./AdminShared";

export default function AdminDraw() {
  const { state, eventId } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  const [prizeName, setPrizeName] = useState("");
  const [showPrize, setShowPrize] = useState(false);
  const [revealing, setRevealing] = useState<Draw | null>(null);
  if (!state) return null;
  const canCreatePrize = hasRole(state.role, managerRoles);
  const canDraw = hasRole(state.role, drawRoles);
  const pending = state.draws.filter(draw => !draw.revealedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const revealed = state.draws.filter(draw => draw.revealedAt).sort((a, b) => (b.revealedAt ?? "").localeCompare(a.revealedAt ?? ""));
  const availablePrizes = state.prizes.filter(prize => !prize.drawId);

  const createPrize = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prizeName.trim()) return;
    const result = await mutate<Prize>("prize-create", `/events/${eventId}/prizes`, "POST", { name: prizeName.trim() });
    if (result) { setPrizeName(""); setShowPrize(false); }
  };
  const startDraw = async (prize: Prize) => {
    await mutate<Draw>(`draw-start-${prize.id}`, `/events/${eventId}/draws`, "POST", { prizeId: prize.id });
  };
  const reveal = async () => {
    if (!revealing) return;
    const result = await mutate<Draw>(`draw-reveal-${revealing.id}`, `/events/${eventId}/draws/${revealing.id}/reveal`, "POST", {});
    if (result) setRevealing(null);
  };
  const openScreen = () => {
    window.open(`/screen?event=${encodeURIComponent(eventId)}`, "_blank", "noopener,noreferrer");
  };

  return <>
    <PageHeading eyebrow="MAKE THE MOMENT COUNT" title="抽獎控制" description="後端先安全選出並封存結果；控制台不會在舞台揭曉前顯示得獎者。" action={<button className="button button-white" onClick={openScreen}><ExternalLink size={15} />開啟大屏幕</button>} />
    <RoleNotice allowed={drawRoles}>你沒有操作抽獎的角色。未揭曉結果不會在此控制台或公開舞台預先展示。</RoleNotice>
    <section className="mvp-draw-hero"><div><span className="mvp-kicker">SERVER-CHOSEN · STAGE-REVEALED</span><h2>公平交給伺服器，精彩交給舞台。</h2><p>啟動抽獎只會要求伺服器從有效機會快照選出一位得獎者。再次點選同一獎項不會重新抽人。</p></div><button className="button button-gold" onClick={openScreen}><Sparkles size={16} />前往舞台</button></section>
    <section className="mvp-draw-layout">
      <article className="mvp-panel"><div className="mvp-panel-heading"><div><span className="mvp-kicker">PRIZES</span><h2>獎項設定</h2></div>{canCreatePrize && <button className="mvp-text-button" onClick={() => setShowPrize(true)}><Plus size={15} />新增獎項</button>}</div><div className="mvp-prize-list">{state.prizes.map(prize => <div key={prize.id}><div><Gift size={16} /><strong>{prize.name}</strong></div>{prize.drawId ? <span className="mvp-status quiet">已抽取</span> : canDraw ? <button className="button button-dark" disabled={isPending(`draw-start-${prize.id}`)} onClick={() => void startDraw(prize)}><Play size={14} />{isPending(`draw-start-${prize.id}`) ? "啟動中…" : "開始抽獎"}</button> : <span className="mvp-status quiet">等待抽獎人員</span>}<InlineError message={errorFor(`draw-start-${prize.id}`)} /></div>)}{!state.prizes.length && <div className="mvp-empty compact"><Gift size={25} /><p>尚未建立獎項。</p></div>}</div></article>
      <article className="mvp-panel mvp-pending-draws"><div className="mvp-panel-heading"><div><span className="mvp-kicker">WAITING FOR STAGE</span><h2>等待揭曉</h2></div><strong>{pending.length}</strong></div>{pending.map(draw => <div className="mvp-pending-draw" key={draw.id}><div><strong>{draw.prizeName}</strong><small>{draw.eligibleGuests} 位合資格嘉賓 · {draw.totalChances} 個有效機會</small><small>已在 {formatIso(draw.createdAt)} 由伺服器封存結果</small></div>{canDraw && <button className="button button-gold" onClick={() => setRevealing(draw)}>標記揭曉</button>}</div>)}{!pending.length && <div className="mvp-empty compact"><p>目前沒有等待舞台揭曉的抽獎結果。</p></div>}</article>
    </section>
    <section className="mvp-panel mvp-revealed-panel"><div className="mvp-panel-heading"><div><span className="mvp-kicker">REVEALED HISTORY</span><h2>已揭曉紀錄</h2></div></div>{revealed.length ? <div className="mvp-revealed-list">{revealed.map(draw => <div key={draw.id}><span className="mvp-reveal-ticket">{draw.winner.ticket}</span><div><strong>{draw.prizeName} · {draw.winner.name}</strong><small>{draw.winner.tableNumber ? `${draw.winner.tableNumber} 號枱` : "尚未安排座位"} · {formatIso(draw.revealedAt)}</small></div></div>)}</div> : <div className="mvp-empty compact"><p>尚未有已揭曉抽獎紀錄。</p></div>}</section>

    {showPrize && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog" role="dialog" aria-modal="true" aria-labelledby="prize-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setShowPrize(false)}><X size={18} /></button><span className="mvp-kicker">PRIZE SETUP</span><h2 id="prize-title">新增獎項</h2><form className="mvp-form" onSubmit={createPrize}><label>獎項名稱<input required value={prizeName} onChange={event => setPrizeName(event.target.value)} placeholder="例如：頭獎" /></label><InlineError message={errorFor("prize-create")} /><div className="mvp-dialog-actions"><button type="button" className="button button-white" onClick={() => setShowPrize(false)}>取消</button><button className="button button-dark" disabled={isPending("prize-create")}>{isPending("prize-create") ? "建立中…" : "建立獎項"}</button></div></form></section></div>}
    {revealing && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog" role="dialog" aria-modal="true" aria-labelledby="reveal-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setRevealing(null)}><X size={18} /></button><span className="mvp-kicker">REVEAL CONFIRMATION</span><h2 id="reveal-title">標記「{revealing.prizeName}」已揭曉？</h2><p className="mvp-dialog-copy">此動作只會公開同一個既有的伺服器結果，絕不會另行抽選得獎者。請確認舞台已完成揭曉。</p><InlineError message={errorFor(`draw-reveal-${revealing.id}`)} /><div className="mvp-dialog-actions"><button className="button button-white" onClick={() => setRevealing(null)}>返回</button><button className="button button-gold" disabled={isPending(`draw-reveal-${revealing.id}`)} onClick={() => void reveal()}>{isPending(`draw-reveal-${revealing.id}`) ? "標記中…" : "確認已揭曉"}</button></div></section></div>}
  </>;
}
