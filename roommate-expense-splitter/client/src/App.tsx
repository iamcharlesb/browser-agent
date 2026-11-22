import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronRight, CircleDollarSign, Copy, Home, LogOut, Plus, ReceiptText, Users, X } from "lucide-react";

type User = { id: number; name: string; email: string };
type Group = { id: number; name: string; inviteCode: string; memberCount: number };
type Member = { id: number; name: string };
type Expense = { id: number; description: string; amountCents: number; createdAt: string; payerId: number; payerName: string };
type Payment = { fromUserId: number; from: string; toUserId: number; to: string; cents: number };
type GroupDetails = { group: Group; members: Member[]; expenses: Expense[] };

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, credentials: "include", headers: { "Content-Type": "application/json", ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);

export default function App() {
  const groupRequest = useRef(0);
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [details, setDetails] = useState<GroupDetails | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"group" | "join" | "expense" | null>(null);
  const [copied, setCopied] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");

  async function refreshGroups(selectId?: number) {
    const data = await api<{ groups: Group[] }>("/api/groups");
    setGroups(data.groups);
    const nextId = selectId ?? (data.groups.some(group => group.id === selected) ? selected : data.groups[0]?.id) ?? null;
    setSelected(nextId);
    if (nextId) await refreshGroup(nextId);
    else { setDetails(null); setPayments([]); }
  }
  async function refreshGroup(id: number) {
    const requestId = ++groupRequest.current;
    setDetails(null); setPayments([]);
    const [groupData, balanceData] = await Promise.all([
      api<GroupDetails>(`/api/groups/${id}`), api<{ payments: Payment[] }>(`/api/groups/${id}/balances`)
    ]);
    if (requestId !== groupRequest.current) return;
    setDetails(groupData); setPayments(balanceData.payments);
  }
  useEffect(() => {
    api<{ user: User }>("/api/auth/me").then(data => { setUser(data.user); return refreshGroups(); })
      .catch(() => setUser(null)).finally(() => setBusy(false));
  }, []);

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const form = new FormData(event.currentTarget);
    try {
      const endpoint = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const data = await api<{ user: User }>(endpoint, { method: "POST", body: JSON.stringify({
        ...(authMode === "signup" ? { name: form.get("name") } : {}), email: form.get("email"), password: form.get("password")
      }) });
      setUser(data.user); await refreshGroups();
    } catch (e) { setError((e as Error).message); }
  }
  async function logout() { await api("/api/auth/logout", { method: "POST" }); groupRequest.current++; setUser(null); setGroups([]); setSelected(null); setDetails(null); setPayments([]); setModal(null); }
  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name") ?? "");
    try { const data = await api<{ group: Group }>("/api/groups", { method: "POST", body: JSON.stringify({ name }) }); setModal(null); await refreshGroups(data.group.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function joinGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const inviteCode = String(new FormData(event.currentTarget).get("inviteCode") ?? "");
    try { const data = await api<{ group: Group }>("/api/groups/join", { method: "POST", body: JSON.stringify({ inviteCode }) }); setModal(null); await refreshGroups(data.group.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function addExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !details) return;
    const form = new FormData(event.currentTarget); const splitType = String(form.get("splitType"));
    const payload: Record<string, unknown> = { description: form.get("description"), amount: form.get("amount"), splitType, payerId: Number(form.get("payerId")) };
    if (splitType === "custom") payload.splits = details.members.map(member => ({ userId: member.id, cents: Math.round(Number(form.get(`share-${member.id}`) ?? 0) * 100) }));
    try { await api(`/api/groups/${selected}/expenses`, { method: "POST", body: JSON.stringify(payload) }); setModal(null); await refreshGroup(selected); }
    catch (e) { setError((e as Error).message); }
  }
  if (busy) return <div className="loading">Loading your home…</div>;
  if (!user) return <main className="auth-page"><div className="auth-brand"><div className="brand-icon"><Home size={22}/></div><span>roomie</span></div><section className="auth-card"><p className="eyebrow">LESS MONEY TALK. MORE HOME.</p><h1>Good roommates<br/>keep it <em>simple.</em></h1><p className="muted">Track shared costs and settle up without the awkward math.</p>
    <form onSubmit={handleAuth} className="stack">{authMode === "signup" && <label>Your name<input name="name" required maxLength={60} autoComplete="name" placeholder="Sam Rivera"/></label>}<label>Email<input name="email" type="email" required autoComplete="email" placeholder="you@example.com"/></label><label>Password<input name="password" type="password" required minLength={authMode === "signup" ? 10 : 1} autoComplete={authMode === "signup" ? "new-password" : "current-password"} placeholder={authMode === "signup" ? "At least 10 characters" : "Your password"}/></label>{error && <p className="error">{error}</p>}<button className="primary wide">{authMode === "signup" ? "Create your account" : "Sign in"}<ArrowRight size={17}/></button></form>
    <p className="switch-auth">{authMode === "signup" ? "Already have an account?" : "New to Roomie?"} <button className="text-button" onClick={() => {setError("");setAuthMode(authMode === "signup" ? "login" : "signup");}}>{authMode === "signup" ? "Sign in" : "Create account"}</button></p></section></main>;
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#"><span className="brand-icon"><Home size={19}/></span>roomie</a><div className="side-label">YOUR HOUSEHOLDS <span>{groups.length}</span></div><nav className="group-nav">{groups.map(group => <button key={group.id} className={`group-link ${selected === group.id ? "active" : ""}`} onClick={() => {setSelected(group.id);void refreshGroup(group.id).catch(e => setError((e as Error).message));}}><span className="group-dot">{group.name.slice(0,1).toUpperCase()}</span><span className="truncate">{group.name}</span><ChevronRight size={15}/></button>)}</nav><button className="side-action" onClick={() => setModal("group")}><Plus size={16}/> Create a household</button><button className="side-action" onClick={() => setModal("join")}><Users size={16}/> Join with invite code</button><div className="sidebar-bottom"><div className="avatar">{user.name.slice(0,1).toUpperCase()}</div><div className="profile-name"><b>{user.name}</b><small>Roomie account</small></div><button className="icon-button" title="Sign out" onClick={logout}><LogOut size={17}/></button></div></aside>
    <main className="main-area"><header className="topbar"><div className="crumb">Home <ChevronRight size={14}/><b>{details?.group.name ?? "Overview"}</b></div><button className="profile-pill"><span className="avatar small">{user.name.slice(0,1).toUpperCase()}</span>{user.name}</button></header>
    <div className="content">{error && <div className="notice"><span>{error}</span><button onClick={() => setError("")}><X size={16}/></button></div>}
      {!details ? <section className="empty-state"><div className="empty-illustration"><Home size={34}/></div><p className="eyebrow">YOUR SHARED HOME</p><h1>Start with your household.</h1><p className="muted">Create a household and invite your roommates, or join one with an invite code.</p><div className="empty-actions"><button className="primary" onClick={() => setModal("group")}><Plus size={17}/> Create household</button><button className="secondary" onClick={() => setModal("join")}>Join with code</button></div></section> : <>
        <div className="welcome-row"><div><p className="eyebrow">YOUR HOUSEHOLD</p><h1>{details.group.name}</h1><p className="muted">Shared expenses, sorted out.</p></div><div className="header-actions"><button className="secondary invite-button" onClick={async () => {await navigator.clipboard.writeText(details.group.inviteCode);setCopied(true);setTimeout(()=>setCopied(false),1600);}}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? "Copied!" : "Copy invite code"}</button><button className="primary" onClick={() => setModal("expense")}><Plus size={17}/> Add expense</button></div></div>
        <section className="invite-strip"><div className="invite-symbol"><Users size={19}/></div><div><b>Bring your roommates in</b><span>Share this code to add them to {details.group.name}.</span></div><button onClick={() => navigator.clipboard.writeText(details.group.inviteCode)}>{details.group.inviteCode}<Copy size={14}/></button></section>
        <div className="section-heading"><div><h2>Settle up</h2><p className="muted">The fewest payments to get everyone square.</p></div><span className="member-count"><Users size={15}/> {details.members.length} {details.members.length === 1 ? "roommate" : "roommates"}</span></div>
        <section className="settlement-list">{payments.length ? payments.map((p, i) => <div className="payment-row" key={`${p.fromUserId}-${p.toUserId}-${i}`}><div className="payment-people"><span className="avatar debtor">{p.from.slice(0,1).toUpperCase()}</span><b>{p.fromUserId === user.id ? "You" : p.from}</b><ArrowRight size={17} className="arrow-muted"/><span className="avatar creditor">{p.to.slice(0,1).toUpperCase()}</span><b>{p.toUserId === user.id ? "you" : p.to}</b></div><strong>{money(p.cents)}</strong></div>) : <div className="all-even"><span><Check size={17}/></span><div><b>All settled up</b><p>No payments needed right now.</p></div></div>}</section>
        <div className="section-heading expense-heading"><div><h2>Recent expenses</h2><p className="muted">The latest shared costs in this household.</p></div><button className="text-button" onClick={() => setModal("expense")}>Add expense <ArrowRight size={15}/></button></div>
        <section className="expense-list">{details.expenses.length ? details.expenses.map(expense => <article className="expense-row" key={expense.id}><div className="receipt-icon"><ReceiptText size={18}/></div><div className="expense-info"><b>{expense.description}</b><span>Paid by {expense.payerId === user.id ? "you" : expense.payerName} · {new Date(expense.createdAt + "Z").toLocaleDateString()}</span></div><b className="expense-amount">{money(expense.amountCents)}</b></article>) : <div className="empty-expenses"><CircleDollarSign size={23}/><span>No expenses yet. Add your first shared cost.</span></div>}</section>
      </>}
    </div></main>
    {modal && <div className="modal-backdrop" onMouseDown={e => {if (e.target === e.currentTarget) setModal(null);}}><section className="modal-card"><div className="modal-heading"><div><p className="eyebrow">{modal === "expense" ? "ADD TO THE HOUSE TAB" : "HOUSEHOLD SETUP"}</p><h2>{modal === "expense" ? "Add an expense" : modal === "group" ? "Create a household" : "Join a household"}</h2></div><button className="icon-button" onClick={() => setModal(null)}><X size={19}/></button></div>
      {modal === "group" && <form className="stack" onSubmit={createGroup}><label>Household name<input name="name" required maxLength={80} placeholder="Maple Street apartment"/></label><button className="primary wide">Create household <ArrowRight size={16}/></button></form>}
      {modal === "join" && <form className="stack" onSubmit={joinGroup}><label>Invite code<input name="inviteCode" required minLength={12} maxLength={12} placeholder="e.g. 3AF09D8B7C21"/></label><button className="primary wide">Join household <ArrowRight size={16}/></button></form>}
      {modal === "expense" && details && <form className="stack" onSubmit={addExpense}><label>What was it for?<input name="description" required maxLength={120} placeholder="Groceries, internet, cleaning supplies"/></label><label>Total amount<input name="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"/></label><label>Paid by<select name="payerId" defaultValue={user.id}>{details.members.map(m => <option key={m.id} value={m.id}>{m.id === user.id ? "You" : m.name}</option>)}</select></label><fieldset><legend>Split between</legend><label className="radio-option"><input type="radio" name="splitType" value="equal" defaultChecked/> Split equally</label><label className="radio-option"><input type="radio" name="splitType" value="custom"/> Custom amounts</label><div className="custom-hint">For custom shares, enter each roommate’s amount; shares must add up to the total.</div><div className="custom-shares">{details.members.map(member => <label key={member.id}>{member.id === user.id ? "You" : member.name}<input name={`share-${member.id}`} type="number" min="0" step="0.01" defaultValue="0.00"/></label>)}</div></fieldset><button className="primary wide">Save expense <ArrowRight size={16}/></button></form>}
    </section></div>}
  </div>;
}
