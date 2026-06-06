'use strict';
/* Caba Life CRM — front end. Vanilla JS SPA, no build step. */
let TOKEN = localStorage.getItem('caba_token') || null;
let ME = null;
let TAB = 'today';

const $ = (s, r = document) => r.querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString();
const titleize = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const r = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Error');
  return data;
}
function toast(msg) {
  const t = el(`<div class="toast">${esc(msg)}</div>`); document.body.appendChild(t);
  setTimeout(() => t.remove(), 1700);
}

/* ---------- auth ---------- */
async function login() {
  $('#loginErr').textContent = '';
  try {
    const { token, user } = await api('/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
    TOKEN = token; localStorage.setItem('caba_token', token); ME = user; boot();
  } catch (e) { $('#loginErr').textContent = e.message; }
}
function logout() {
  TOKEN = null; ME = null; localStorage.removeItem('caba_token');
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}

async function submitPasswordChange(cur, nw, conf, errEl) {
  errEl.textContent = '';
  if (nw !== conf) { errEl.textContent = 'New passwords do not match.'; return false; }
  try {
    await api('/change-password', { method: 'POST', body: { current_password: cur, new_password: nw } });
    ME.must_change_password = 0; toast('Password updated'); return true;
  } catch (e) { errEl.textContent = e.message; return false; }
}

function renderForcedPasswordChange() {
  const v = $('#view');
  v.innerHTML = '';
  const card = el(`<div class="card" style="padding:24px;max-width:420px;margin:8vh auto 0">
    <div class="section-h">Secure your account</div>
    <h2 style="margin:6px 0 6px">Set a new password</h2>
    <p class="muted" style="margin:0 0 16px;font-size:14px">For security, you must replace the default password before using the CRM. Minimum 10 characters, with a letter and a number.</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="cpCur" type="password" placeholder="current password">
      <input id="cpNew" type="password" placeholder="new password">
      <input id="cpConf" type="password" placeholder="confirm new password">
      <button class="btn" id="cpGo">Update password</button>
      <div id="cpErr" class="muted" style="color:var(--cold);font-size:13px;min-height:16px"></div>
    </div></div>`);
  card.querySelector('#cpGo').onclick = async () => {
    const ok = await submitPasswordChange(card.querySelector('#cpCur').value, card.querySelector('#cpNew').value, card.querySelector('#cpConf').value, card.querySelector('#cpErr'));
    if (ok) boot();
  };
  v.appendChild(card);
}

function openChangePassword() {
  if (!ME) return;
  const scrim = el('<div class="scrim"></div>');
  const d = el(`<aside class="drawer" style="width:min(420px,100%)">
    <header><div style="flex:1;font-weight:800;font-size:18px">Change password</div><button class="btn ghost sm" data-x>Close</button></header>
    <div class="body">
      <input id="mpCur" type="password" placeholder="current password">
      <input id="mpNew" type="password" placeholder="new password">
      <input id="mpConf" type="password" placeholder="confirm new password">
      <button class="btn sm" data-go>Update password</button>
      <div id="mpErr" class="muted" style="color:var(--cold);font-size:13px;min-height:16px"></div>
    </div></aside>`);
  const close = () => { scrim.remove(); d.remove(); };
  scrim.onclick = close; d.querySelector('[data-x]').onclick = close;
  d.querySelector('[data-go]').onclick = async () => {
    const ok = await submitPasswordChange(d.querySelector('#mpCur').value, d.querySelector('#mpNew').value, d.querySelector('#mpConf').value, d.querySelector('#mpErr'));
    if (ok) close();
  };
  $('#modalRoot').append(scrim, d);
}

const TABS = [
  { id: 'today', label: 'Today', roles: ['owner','manager','agent'] },
  { id: 'assistant', label: 'Assistant', roles: ['owner','manager','agent'] },
  { id: 'callnext', label: 'Call Next', roles: ['owner','manager','agent'] },
  { id: 'pipeline', label: 'Pipeline', roles: ['owner','manager','agent'] },
  { id: 'recruiting', label: 'Recruiting', roles: ['owner','manager','recruiter','admin'] },
  { id: 'onboarding', label: 'Onboarding', roles: ['owner','manager','recruiter','admin'] },
  { id: 'resources', label: 'Playbook', roles: ['owner','manager','agent','recruiter','admin'] },
  { id: 'commissions', label: 'Commissions', roles: ['owner','manager','agent','admin'] },
  { id: 'insurance', label: 'Insurance', roles: ['owner','manager','agent','admin'] },
  { id: 'scoreboard', label: 'Scoreboard', roles: ['owner','manager','agent','recruiter','admin'] },
];

async function boot() {
  try { const me = await api('/me'); ME = me.user; ME.ai_enabled = me.ai_enabled; } catch { return logout(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#uname').textContent = ME.name; $('#urole').textContent = titleize(ME.role);
  $('#av').textContent = (ME.name || '?')[0];
  // Force a password change on first login (or after an admin reset).
  if (ME.must_change_password) { $('#tabs').innerHTML = ''; renderForcedPasswordChange(); return; }
  const tabs = TABS.filter(t => t.roles.includes(ME.role));
  if (!tabs.find(t => t.id === TAB)) TAB = tabs[0].id;
  $('#tabs').innerHTML = '';
  tabs.forEach(t => {
    const b = el(`<button class="tab ${t.id === TAB ? 'on' : ''}">${t.label}</button>`);
    b.onclick = () => { TAB = t.id; boot(); };
    $('#tabs').appendChild(b);
  });
  render();
}

function render() {
  const v = $('#view'); v.innerHTML = '<p class="muted">Loading…</p>';
  ({ today: viewToday, assistant: viewAssistant, callnext: viewCallNext, pipeline: viewPipeline, recruiting: viewRecruiting,
     onboarding: viewOnboarding, resources: viewResources, commissions: viewCommissions,
     insurance: viewInsurance, scoreboard: viewScoreboard }[TAB])(v);
}

/* ---------- Insurance: chargeback runway, AP vs IP, carriers, comp grid ---------- */
async function viewInsurance(v) {
  v.innerHTML = '<h2 style="margin:0 0 12px">Insurance — your book of business</h2>';
  const [e, risk, carr, cg] = await Promise.all([
    api('/insurance/earnings'), api('/insurance/at-risk'), api('/insurance/by-carrier'), api('/insurance/comp-grid')
  ]);

  // top numbers
  const nb = el('<div class="numberbar"></div>');
  nb.appendChild(el(`<div class="stat"><div class="k">In-force premium (IP)</div><div class="v">${money(e.IP)}</div><div class="bar"><i style="width:${e.ip_ratio}%"></i></div><div class="muted" style="font-size:12px;margin-top:6px">${e.ip_ratio}% of ${money(e.AP)} sold (AP)</div></div>`));
  nb.appendChild(el(`<div class="stat"><div class="k">Monthly commission</div><div class="v">${money(e.monthly_commission)}</div><div class="muted" style="font-size:12px;margin-top:6px">${money(e.annual_run_rate)}/yr run-rate</div></div>`));
  nb.appendChild(el(`<div class="stat"><div class="k">In-force policies</div><div class="v">${e.counts.inforce}</div><div class="muted" style="font-size:12px;margin-top:6px">${e.counts.paying} actively paying</div></div>`));
  nb.appendChild(el(`<div class="stat"><div class="k">Chargeback exposure</div><div class="v" style="color:${risk.totals.missed>0?'var(--cold)':'var(--warn)'}">${money(risk.totals.exposure_total)}</div><div class="muted" style="font-size:12px;margin-top:6px">${risk.totals.missed} missed · ${money(risk.totals.missed_exposure)} at risk now</div></div>`));
  v.appendChild(nb);

  // deposit forecast
  v.appendChild(el('<div class="section-h" style="margin-top:6px">6-month deposit forecast</div>'));
  const fc = el('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">' +
    e.forecast.map(f => `<div class="card" style="padding:10px 14px;min-width:96px"><div class="muted" style="font-size:12px">${esc(f.month)}</div><div style="font-weight:800;font-size:17px">${money(f.deposit)}</div></div>`).join('') + '</div>');
  v.appendChild(fc);

  // chargeback runway
  v.appendChild(el(`<div class="section-h">⚠️ Chargeback runway <span class="muted" style="text-transform:none;font-weight:400">— issued policies until 12 months on the books; protect your advances</span></div>`));
  const rt = el(`<table><thead><tr><th>Client</th><th>Carrier</th><th class="num">AP</th><th class="num">Comm</th><th class="num">On books</th><th class="num">Exposure</th><th>Payment</th></tr></thead><tbody></tbody></table>`);
  const tb = rt.querySelector('tbody');
  risk.rows.filter(r => r.in_window || r.risk === 'high').slice(0, 40).forEach(r => {
    const color = r.risk === 'high' ? 'var(--cold)' : r.risk === 'watch' ? 'var(--warn)' : 'inherit';
    const row = el(`<tr style="border-left:3px solid ${color}">
      <td>${esc(r.name)}</td><td>${esc(r.carrier||'')}</td><td class="num">${money(r.annual)}</td>
      <td class="num">${r.comm_pct!=null?r.comm_pct+'%':'—'}</td>
      <td class="num">${r.months_on_books==null?'—':r.months_on_books+'mo'}</td>
      <td class="num" style="color:${color}">${money(r.exposure)}</td>
      <td><select data-pay style="width:auto;padding:4px 8px;font-size:12px">
        <option value="active"${r.payment_status==='active'?' selected':''}>active</option>
        <option value="missed"${r.payment_status==='missed'?' selected':''}>⚠ missed</option>
        <option value="chargeback"${r.payment_status==='chargeback'?' selected':''}>chargeback</option></select></td></tr>`);
    row.querySelector('[data-pay]').onchange = async (ev) => { await api(`/policies/${r.id}/payment`, { method:'POST', body:{ status: ev.target.value } }); toast('Updated'); render(); };
    tb.appendChild(row);
  });
  v.appendChild(rt);

  // by carrier
  v.appendChild(el('<div class="section-h" style="margin-top:20px">In-force by carrier</div>'));
  const ct = el(`<table><thead><tr><th>Carrier</th><th class="num">In-force / total</th><th class="num">In-force premium</th></tr></thead><tbody></tbody></table>`);
  carr.carriers.forEach(c => ct.querySelector('tbody').appendChild(el(`<tr><td>${esc(c.carrier||'—')}</td><td class="num">${c.inforce} / ${c.policies}</td><td class="num"><b>${money(c.ip)}</b></td></tr>`)));
  v.appendChild(ct);

  // comp grid
  const canEdit = ['owner','manager','admin'].includes(ME.role);
  v.appendChild(el('<div class="section-h" style="margin-top:20px">Comp grid <span class="muted" style="text-transform:none;font-weight:400">— commission % by carrier / product</span></div>'));
  const gt = el(`<table><thead><tr><th>Carrier</th><th>Product</th><th class="num">Rate %</th></tr></thead><tbody></tbody></table>`);
  cg.grid.forEach(r => {
    const tr = el(`<tr><td>${esc(r.carrier||'')}</td><td>${esc(r.product||'')}</td><td class="num">${canEdit?`<input value="${r.rate}" data-rate style="width:80px;text-align:right;padding:4px 8px">`:r.rate+'%'}</td></tr>`);
    if (canEdit) tr.querySelector('[data-rate]').onchange = async (ev) => { await api('/insurance/comp-grid', { method:'POST', body:{ carrier:r.carrier, product:r.product, rate:Number(ev.target.value) } }); toast('Rate saved'); };
    gt.querySelector('tbody').appendChild(tr);
  });
  v.appendChild(gt);
}

/* ---------- Assistant (AI) ---------- */
async function viewAssistant(v) {
  v.innerHTML = '';
  const aiTag = ME.ai_enabled ? '<span class="pill">AI: live</span>' : '<span class="pill" style="background:rgba(91,155,216,.16);color:var(--info)">offline mode</span>';
  v.appendChild(el(`<div style="display:flex;align-items:center;gap:10px;margin:0 0 12px"><h2 style="margin:0">Assistant</h2>${aiTag}</div>`));
  if (!ME.ai_enabled) v.appendChild(el(`<p class="muted" style="margin:-6px 0 14px;font-size:13px">Running on the built-in deterministic engine (no API key). Set <b>ANTHROPIC_API_KEY</b> to upgrade every answer to natural language — the numbers stay the same.</p>`));

  // daily briefing
  const brief = el(`<div class="card" style="padding:18px;max-width:820px;margin-bottom:16px"><div class="section-h">Today's briefing</div><div id="brief" class="muted">Loading…</div></div>`);
  v.appendChild(brief);
  api('/briefing').then(b => { brief.querySelector('#brief').innerHTML = esc(b.text).replace(/\n/g, '<br>'); brief.querySelector('#brief').style.color = 'var(--text)'; }).catch(()=>{});

  // chat
  const box = el(`<div style="max-width:820px">
     <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>
     <div style="display:flex;gap:8px"><input id="q" placeholder="Ask: how are we pacing? who's cold? cost per producing agent?"><button class="btn" data-ask>Ask</button></div>
     <div id="ans" style="margin-top:14px;display:flex;flex-direction:column;gap:10px"></div></div>`);
  const chips = box.querySelector('.row');
  ['How are we pacing to goal?','Who is going cold?','Who are my top producers?','What\'s our cost per producing agent?','How much commission this month?','How is persistency?']
    .forEach(qq => { const c = el(`<button class="btn ghost sm">${esc(qq)}</button>`); c.onclick = () => ask(qq); chips.appendChild(c); });
  const ans = box.querySelector('#ans');
  async function ask(q) {
    if (!q) return;
    ans.prepend(el(`<div class="tl" style="border-left:3px solid var(--accent)"><div class="t">you</div><div>${esc(q)}</div></div>`));
    const a = await api('/assistant', { method:'POST', body:{ q } });
    ans.prepend(el(`<div class="card" style="padding:13px"><div class="t muted" style="font-size:11px;margin-bottom:4px">assistant${a.ai?' · AI':''}</div><div>${esc(a.text)}</div></div>`));
  }
  box.querySelector('[data-ask]').onclick = () => { const q = box.querySelector('#q'); ask(q.value); q.value=''; };
  box.querySelector('#q').addEventListener('keydown', e => { if (e.key === 'Enter') box.querySelector('[data-ask]').click(); });
  v.appendChild(box);
}

/* ---------- Commissions ---------- */
async function viewCommissions(v) {
  v.innerHTML = '';
  const j = await api('/commissions');
  const a = j.agency;
  const nb = el('<div class="numberbar"></div>');
  nb.appendChild(el(`<div class="stat"><div class="k">Net commission · MTD</div><div class="v" style="color:${a.net>=0?'var(--good)':'var(--cold)'}">${money(a.net)}</div><div class="muted" style="font-size:12px;margin-top:6px">FYC ${money(a.fyc)} + override ${money(a.override)} − chargeback ${money(a.chargeback)}</div></div>`));
  nb.appendChild(el(`<div class="stat"><div class="k">Pending (submitted)</div><div class="v">${money(a.pending)}</div><div class="muted" style="font-size:12px;margin-top:6px">in underwriting</div></div>`));
  nb.appendChild(el(`<div class="stat"><div class="k">Persistency</div><div class="v" style="color:${j.persistency.rate>=85?'var(--good)':j.persistency.rate>=70?'var(--warn)':'var(--cold)'}">${j.persistency.rate}%</div><div class="muted" style="font-size:12px;margin-top:6px">${j.persistency.lapsed} lapsed of ${j.persistency.active + j.persistency.lapsed}</div></div>`));
  v.appendChild(nb);
  if (j.persistency.rate < 85) v.appendChild(el(`<p class="muted" style="margin:0 0 12px;color:var(--warn)">⚠ Persistency under 85% — lapses are clawing back commission. In life insurance this is a survival metric; chase pending and shore up month-2 retention.</p>`));
  v.appendChild(el('<h2 style="margin:6px 0 12px">Commission by producer</h2>'));
  const t = el(`<table><thead><tr><th>Producer</th><th>Contract</th><th class="num">FYC</th><th class="num">Override</th><th class="num">Pending</th><th class="num">Chargeback</th><th class="num">Net</th></tr></thead><tbody></tbody></table>`);
  const tb = t.querySelector('tbody');
  j.rows.forEach(r => tb.appendChild(el(`<tr>
     <td>${esc(r.name)} ${r.role!=='agent'?'<span class="pill">'+esc(r.role)+'</span>':''}</td>
     <td>${Math.round(r.comp_rate*100)}%</td>
     <td class="num">${money(r.fyc)}</td><td class="num">${money(r.override)}</td>
     <td class="num muted">${money(r.pending)}</td>
     <td class="num" style="color:${r.chargeback>0?'var(--cold)':'inherit'}">${r.chargeback?'-'+money(r.chargeback):'—'}</td>
     <td class="num"><b style="color:${r.net>=0?'inherit':'var(--cold)'}">${money(r.net)}</b></td></tr>`)));
  v.appendChild(t);
  v.appendChild(el(`<p class="muted" style="margin-top:12px">Override = the spread between your contract level and your downline's, paid on their AP — telescoped up every level. This is the engine of owner income at scale: your pen goes to zero, override goes up.</p>`));
}

/* ---------- Today: action queue + speed-to-lead demo ---------- */
async function viewToday(v) {
  v.innerHTML = '';
  try { v.appendChild(await numberBar()); } catch {}
  const head = el(`<div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px;flex-wrap:wrap">
     <h2 style="margin:0">Today — do this now</h2><span class="pill">speed-to-lead queue</span>
     <button class="btn sm right" data-intake>⚡ Test new lead (fire speed-to-lead)</button></div>`);
  head.querySelector('[data-intake]').onclick = fireIntake;
  v.appendChild(head);
  const { tasks } = await api('/tasks');
  const list = el('<div class="cn"></div>');
  if (!tasks.length) list.appendChild(el(`<div class="card" style="padding:18px"><b>Queue clear.</b>
     <div class="muted" style="margin-top:6px">No calls due this second. Hit “Test new lead” to watch a fresh lead get an instant SMS + email and drop a call task right here.</div></div>`));
  tasks.forEach((t) => {
    const age = t.hours_since >= 48 ? 'age-red' : t.hours_since >= 24 ? 'age-amber' : '';
    const c = el(`<div class="lead ${age}">
      <div>
        <div class="nm"><span class="dot p${t.priority}"></span>${esc(t.first_name)} ${esc(t.last_name)}
          <span class="muted" style="font-weight:500">· ${esc(t.stage)} · ${esc(t.state||'')}</span></div>
        <div class="meta">${esc(t.body)}</div>
        <div class="row">
          <button data-call>📞 Call</button><button data-sms>💬 Text</button>
          <button data-open>Open</button><button data-done>✓ Done</button>
        </div>
      </div>
      <div class="score">${titleize(t.product_interest)}<br><span class="muted" style="font-size:12px">${money(t.premium_potential)}</span></div>
    </div>`);
    c.querySelector('[data-call]').onclick = () => { if (t.phone) location.href = 'tel:' + t.phone; };
    c.querySelector('[data-sms]').onclick = () => { if (t.phone) location.href = 'sms:' + t.phone; };
    c.querySelector('[data-open]').onclick = () => openLead(t.lead_id);
    c.querySelector('[data-done]').onclick = async () => { await api(`/touches/${t.touch_id}/done`, { method: 'POST' }); toast('Task done'); render(); };
    list.appendChild(c);
  });
  v.appendChild(list);
}
async function fireIntake() {
  const firsts = ['Jordan','Casey','Morgan','Riley','Avery','Quinn','Reese','Skyler','Devon','Harper'];
  const lasts = ['Bennett','Carter','Foster','Hayes','Patel','Nguyen','Rivera','Brooks','Coleman','Reed'];
  const states = ['TX','FL','GA','OH','NC','TN'];
  const products = ['mortgage_protection','final_expense','term'];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const body = { first_name: pick(firsts), last_name: pick(lasts), phone: '555' + (1000000 + Math.floor(Math.random()*8999999)),
    state: pick(states), product_interest: pick(products) };
  const r = await api('/intake', { method: 'POST', body });
  const s = r.speed_to_lead || {};
  toast(`Speed-to-lead fired → ${s.sent||0} sent, call task queued`);
  render();
}

/* ---------- The Number bar (shared header) ---------- */
async function numberBar() {
  const s = await api('/scoreboard');
  const wrap = el('<div class="numberbar"></div>');
  const pace = s.onPace ? '<span class="tag-pace pace-on">ON PACE</span>' : '<span class="tag-pace pace-off">BEHIND</span>';
  const pct = s.agencyGoal ? Math.min(100, Math.round(s.agencyAP / s.agencyGoal * 100)) : 0;
  wrap.appendChild(el(`<div class="stat">
     <div class="k">Agency AP · month-to-date</div>
     <div class="v">${money(s.agencyAP)} <small>/ ${money(s.agencyGoal)} ${pace}</small></div>
     <div class="bar"><i style="width:${pct}%"></i></div></div>`));
  wrap.appendChild(el(`<div class="stat"><div class="k">Expected by today</div>
     <div class="v">${money(s.expectedByNow)}</div>
     <div class="muted" style="font-size:12px;margin-top:6px">Gap ${money(Math.max(0, s.expectedByNow - s.agencyAP))}</div></div>`));
  if (s.scope === 'team') {
    wrap.appendChild(el(`<div class="stat"><div class="k">Dials to goal</div>
       <div class="v">${(s.dialsNeeded||0).toLocaleString()}</div>
       <div class="muted" style="font-size:12px;margin-top:6px">Day ${s.dayOfMonth} of ${s.daysInMonth}</div></div>`));
  } else if (s.mine) {
    wrap.appendChild(el(`<div class="stat"><div class="k">My AP</div>
       <div class="v">${money(s.mine.ap)} <small>${s.mine.pace}% of ${money(s.mine.goal)}</small></div>
       <div class="bar"><i style="width:${Math.min(100,s.mine.pace)}%"></i></div></div>`));
  }
  wrap.appendChild(el(`<div class="stat"><div class="k">My leads going cold</div>
     <div class="v" style="color:${s.goingCold>0?'var(--cold)':'var(--good)'}">${s.goingCold}</div>
     <div class="muted" style="font-size:12px;margin-top:6px">untouched 48h+</div></div>`));
  return wrap;
}

/* ---------- Call Next ---------- */
async function viewCallNext(v) {
  v.innerHTML = '';
  try { v.appendChild(await numberBar()); } catch {}
  const { leads } = await api('/call-next');
  const head = el(`<div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px">
     <h2 style="margin:0">Who to call right now</h2><span class="pill">ranked by score</span></div>`);
  v.appendChild(head);
  const list = el('<div class="cn"></div>');
  if (!leads.length) list.appendChild(el('<p class="muted">Nothing actionable — your book is clean.</p>'));
  leads.forEach((l, i) => {
    const age = l.hours_since >= 48 ? 'age-red' : l.hours_since >= 24 ? 'age-amber' : '';
    const c = el(`<div class="lead ${age}">
      <div>
        <div class="nm"><span class="dot p${l.priority}"></span>${esc(l.first_name)} ${esc(l.last_name)}
          <span class="muted" style="font-weight:500">· ${esc(l.stage)}</span></div>
        <div class="meta">${titleize(l.product_interest)} · ${money(l.premium_potential)} AP · ${esc(l.state||'')} ·
          ${l.last_contact_at ? l.hours_since + 'h since contact' : '<b class="accent">never contacted</b>'}</div>
        ${l.why ? `<div class="meta accent" style="margin-top:4px">▸ ${esc(l.why)}</div>` : ''}
        <div class="row">
          <button data-call>📞 Call</button>
          <button data-sms>💬 Text</button>
          <button data-open>Open</button>
        </div>
      </div>
      <div class="score">${l.score}</div>
    </div>`);
    c.querySelector('[data-call]').onclick = () => { if (l.phone) location.href = 'tel:' + l.phone; quickLog(l.id, 'call'); };
    c.querySelector('[data-sms]').onclick = () => { if (l.phone) location.href = 'sms:' + l.phone; quickLog(l.id, 'sms'); };
    c.querySelector('[data-open]').onclick = () => openLead(l.id);
    list.appendChild(c);
  });
  v.appendChild(list);
}
async function quickLog(id, type) {
  try { await api(`/leads/${id}/activity`, { method: 'POST', body: { type, outcome: type === 'call' ? 'attempted' : 'sent' } });
    toast(type === 'call' ? 'Dial logged' : 'Text logged'); } catch {}
}

/* ---------- Pipeline (kanban, drag + move) ---------- */
async function viewPipeline(v) {
  v.innerHTML = '';
  const { stages, leads } = await api('/leads');
  const byStage = {}; stages.forEach(s => byStage[s] = []);
  leads.forEach(l => (byStage[l.stage] = byStage[l.stage] || []).push(l));
  const board = el('<div class="board"></div>');
  stages.forEach(stage => {
    const col = el(`<div class="col" data-stage="${esc(stage)}">
       <h3>${esc(stage)}<span class="n">${byStage[stage].length}</span></h3>
       <div class="drop"></div></div>`);
    const drop = col.querySelector('.drop');
    byStage[stage].sort((a,b)=>b.score-a.score).forEach(l => drop.appendChild(leadCard(l, stages)));
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/id'); if (!id) return;
      await moveStage(+id, stage);
    });
    board.appendChild(col);
  });
  v.appendChild(el('<h2 style="margin:0 0 12px">Sales pipeline</h2>'));
  v.appendChild(board);
}
function leadCard(l, stages) {
  const age = l.hours_since >= 48 ? 'age-red' : l.hours_since >= 24 ? 'age-amber' : '';
  const c = el(`<div class="lead ${age}" draggable="true">
     <div class="nm"><span class="dot p${l.priority}"></span>${esc(l.first_name)} ${esc(l.last_name)}</div>
     <div class="meta">${titleize(l.product_interest)} · ${money(l.premium_potential)} AP${l.owner_name ? ' · ' + esc(l.owner_name) : ''}</div>
     <div class="meta">${l.last_contact_at ? l.hours_since + 'h since contact' : '<b class="accent">new</b>'} · score ${l.score}</div>
     <div class="row">
       <button data-call>📞</button><button data-sms>💬</button>
       <select data-move title="Move stage" style="width:auto;padding:5px 8px;font-size:12px"></select>
     </div></div>`);
  c.addEventListener('dragstart', e => e.dataTransfer.setData('text/id', l.id));
  c.querySelector('.nm').style.cursor = 'pointer';
  c.onclick = (e) => { if (e.target.closest('button,select')) return; openLead(l.id); };
  c.querySelector('[data-call]').onclick = () => { if (l.phone) location.href = 'tel:' + l.phone; quickLog(l.id, 'call'); };
  c.querySelector('[data-sms]').onclick = () => { if (l.phone) location.href = 'sms:' + l.phone; quickLog(l.id, 'sms'); };
  const sel = c.querySelector('[data-move]');
  sel.appendChild(el(`<option value="">move…</option>`));
  stages.forEach(s => sel.appendChild(el(`<option value="${esc(s)}" ${s===l.stage?'disabled':''}>${esc(s)}</option>`)));
  sel.onchange = () => sel.value && moveStage(l.id, sel.value);
  return c;
}
async function moveStage(id, stage) {
  try { await api(`/leads/${id}/stage`, { method: 'POST', body: { stage } }); toast('Moved → ' + stage); render(); }
  catch (e) { toast(e.message); }
}

/* ---------- Lead drawer ---------- */
async function openLead(id) {
  const { lead, activities, policies, messages = [], upcoming = [], cadence = 'none' } = await api('/leads/' + id);
  const scrim = el('<div class="scrim"></div>'); scrim.onclick = close;
  const consent = lead.dnc ? '<span class="tag-pace pace-off">DNC / OPTED OUT</span>'
    : lead.consent_tcpa ? '<span class="pill">TCPA ✓</span>' : '<span class="tag-pace pace-off">NO CONSENT</span>';
  const cadPill = { active: '<span class="pill">cadence active</span>', paused: '<span class="tag-pace pace-off">cadence paused</span>',
    done: '<span class="muted">cadence done</span>', none: '<span class="muted">no cadence</span>' }[cadence] || '';
  const commsHtml = `
    <div>
      <div class="section-h">Automation ${cadPill}</div>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${cadence === 'active' ? '<button class="btn ghost sm" data-pause>⏸ Pause cadence</button>' : '<button class="btn ghost sm" data-start>▶ Start cadence</button>'}
        <button class="btn ghost sm" data-reply>↩︎ Simulate reply</button>
        <button class="btn ghost sm" data-optout>⛔ Opt-out (STOP)</button>
      </div>
      ${upcoming.length ? `<div class="muted" style="font-size:12px;margin-bottom:6px">Next ${upcoming.length} scheduled:</div>` +
        upcoming.slice(0,5).map(u=>`<div class="tl"><div>${esc(titleize(u.channel))} · <span class="t">${esc(u.due_at)}</span></div><div class="t">${esc((u.body||'').slice(0,70))}…</div></div>`).join('')
        : '<div class="muted" style="font-size:12px">No upcoming automated touches.</div>'}
      ${messages.length ? `<div class="section-h" style="margin-top:10px">Comms log</div>` +
        messages.slice(0,6).map(mm=>`<div class="tl"><div>${mm.direction==='in'?'⬅︎ inbound':'➡︎ '+esc(titleize(mm.channel))} <span class="pill" style="background:${mm.status==='sent'?'var(--accent-soft)':'rgba(200,85,61,.18)'};color:${mm.status==='sent'?'var(--accent)':'var(--cold)'}">${esc(mm.status)}${mm.block_reason?' · '+esc(mm.block_reason):''}</span></div><div class="t">${esc((mm.body||'').slice(0,80))}</div></div>`).join('') : ''}
    </div>`;
  const d = el(`<aside class="drawer">
    <header>
      <div style="flex:1"><div style="font-weight:800;font-size:18px">${esc(lead.first_name)} ${esc(lead.last_name)}</div>
        <div class="muted" style="font-size:12px">${esc(lead.stage)} · score ${lead.score} ${consent}</div></div>
      <button class="btn ghost sm" data-x>Close</button>
    </header>
    <div class="body">
      <div class="row" style="display:flex;gap:8px">
        <button class="btn sm" data-call>📞 Call</button>
        <button class="btn ghost sm" data-sms>💬 Text</button>
        <button class="btn ghost sm" data-email>✉️ Email</button>
      </div>
      <div class="kv">
        <div class="muted">Phone</div><div>${esc(lead.phone||'—')}</div>
        <div class="muted">Email</div><div>${esc(lead.email||'—')}</div>
        <div class="muted">State</div><div>${esc(lead.state||'—')}</div>
        <div class="muted">Product</div><div>${titleize(lead.product_interest)}</div>
        <div class="muted">Est. AP</div><div>${money(lead.premium_potential)}</div>
        <div class="muted">Owner</div><div>${esc(lead.owner_name||'—')}</div>
        <div class="muted">Last contact</div><div>${lead.last_contact_at ? esc(lead.last_contact_at) : 'never'}</div>
      </div>
      ${policies.length ? `<div><div class="section-h">Policies</div>` +
        policies.map(p=>`<div class="tl"><b>${money(p.annual_premium)}</b> ${esc(p.carrier)} · ${titleize(p.product)} <span class="pill">${esc(p.status)}</span></div>`).join('') + `</div>` : ''}
      ${commsHtml}
      <div>
        <div class="section-h">AI tools</div>
        <textarea id="aiText" rows="2" placeholder="Paste a call transcript to summarize, or a lead's text to draft a reply…"></textarea>
        <div class="row" style="display:flex;gap:8px;margin-top:8px">
          <button class="btn sm" data-summarize>🧠 Summarize → log</button>
          <button class="btn ghost sm" data-suggest>💬 Draft reply</button>
        </div>
        <div id="aiOut" style="font-size:13px;margin-top:8px"></div>
      </div>
      <div>
        <div class="section-h">Log activity</div>
        <div class="grid2">
          <select id="actType"><option value="call">Call</option><option value="sms">SMS</option><option value="email">Email</option><option value="note">Note</option></select>
          <select id="actOutcome"><option value="">outcome…</option><option>connected</option><option>no_answer</option><option>voicemail</option><option>not_interested</option><option>sold</option></select>
        </div>
        <textarea id="actBody" rows="2" placeholder="What happened / next step…" style="margin-top:8px"></textarea>
        <button class="btn sm" data-log style="margin-top:8px">Save to timeline</button>
      </div>
      <div>
        <div class="section-h">Timeline</div>
        <div class="timeline" id="tl">${
          activities.length ? activities.map(a=>`<div class="tl"><div>${esc(titleize(a.type))}${a.outcome?' · '+esc(a.outcome):''} ${a.body?'— '+esc(a.body):''}</div>
            <div class="t">${esc(a.agent_name||'')} · ${esc(a.created_at)}${a.next_step?' · next: '+esc(a.next_step):''}</div></div>`).join('')
          : '<p class="muted">No activity yet.</p>'}</div>
      </div>
    </div></aside>`);
  function close() { scrim.remove(); d.remove(); }
  d.querySelector('[data-x]').onclick = close;
  d.querySelector('[data-call]').onclick = () => { if (lead.phone) location.href='tel:'+lead.phone; };
  d.querySelector('[data-sms]').onclick = () => { if (lead.phone) location.href='sms:'+lead.phone; };
  d.querySelector('[data-email]').onclick = () => { if (lead.email) location.href='mailto:'+lead.email; };
  d.querySelector('[data-log]').onclick = async () => {
    await api(`/leads/${id}/activity`, { method:'POST', body:{ type:$('#actType').value, outcome:$('#actOutcome').value, body:$('#actBody').value } });
    toast('Logged'); close(); openLead(id);
  };
  const aiOut = d.querySelector('#aiOut');
  d.querySelector('[data-summarize]').onclick = async () => {
    const transcript = d.querySelector('#aiText').value.trim();
    if (!transcript) { aiOut.innerHTML = '<span class="muted">Paste a transcript first.</span>'; return; }
    aiOut.innerHTML = '<span class="muted">Summarizing…</span>';
    const r = await api(`/leads/${id}/call-summary`, { method:'POST', body:{ transcript } });
    toast('Summary logged'); close(); openLead(id);
  };
  d.querySelector('[data-suggest]').onclick = async () => {
    let txt = d.querySelector('#aiText').value.trim();
    if (!txt) { const lastIn = messages.find(m => m.direction === 'in'); txt = lastIn ? lastIn.body : ''; }
    if (!txt) { aiOut.innerHTML = '<span class="muted">Paste the lead\'s message first (or log an inbound reply).</span>'; return; }
    aiOut.innerHTML = '<span class="muted">Drafting…</span>';
    const r = await api(`/leads/${id}/suggest-reply`, { method:'POST', body:{ body: txt } });
    aiOut.innerHTML = `<div class="tl"><div class="t">suggested reply${r.ai?' · AI':''}</div><div>${esc(r.reply)}</div></div>`;
  };
  const reopen = (msg) => { toast(msg); close(); openLead(id); };
  d.querySelector('[data-pause]')?.addEventListener('click', async () => { await api(`/leads/${id}/cadence/pause`, { method:'POST' }); reopen('Cadence paused'); });
  d.querySelector('[data-start]')?.addEventListener('click', async () => { await api(`/leads/${id}/cadence/start`, { method:'POST' }); reopen('Cadence started'); });
  d.querySelector('[data-optout]')?.addEventListener('click', async () => { await api(`/leads/${id}/optout`, { method:'POST' }); reopen('Opted out — DNC set'); });
  d.querySelector('[data-reply]')?.addEventListener('click', async () => {
    const body = prompt('Inbound text from the lead (try "STOP" to test opt-out):', 'Sounds good, call me');
    if (body == null) return;
    await api(`/leads/${id}/reply`, { method:'POST', body:{ body } }); reopen('Reply logged');
  });
  $('#modalRoot').append(scrim, d);
}

/* ---------- Recruiting ---------- */
async function viewRecruiting(v) {
  v.innerHTML = '';
  const head = el(`<div style="display:flex;align-items:center;gap:10px;margin:0 0 4px;flex-wrap:wrap">
     <h2 style="margin:0">Recruiting machine</h2>
     <button class="btn sm right" data-intake>⚡ New applicant (speed-to-recruit)</button></div>`);
  head.querySelector('[data-intake]').onclick = fireRecruitIntake;
  v.appendChild(head);
  v.appendChild(el('<p class="muted" style="margin:0 0 14px">Your growth engine — agents are the constraint to $1M.</p>'));

  // funnel stats
  try {
    const f = await api('/recruiting-funnel');
    const nb = el('<div class="numberbar"></div>');
    nb.appendChild(el(`<div class="stat"><div class="k">In pipeline</div><div class="v">${f.total}</div><div class="muted" style="font-size:12px;margin-top:6px">${f.producing} producing</div></div>`));
    nb.appendChild(el(`<div class="stat"><div class="k">Applied → Producing</div><div class="v">${f.appliedToProducing}%</div><div class="bar"><i style="width:${f.appliedToProducing}%"></i></div></div>`));
    nb.appendChild(el(`<div class="stat"><div class="k">Recruit ad spend</div><div class="v">${money(f.spend)}</div></div>`));
    nb.appendChild(el(`<div class="stat"><div class="k">Cost / producing agent</div><div class="v">${f.costPerProducing==null?'—':money(f.costPerProducing)}</div><div class="muted" style="font-size:12px;margin-top:6px">lower = healthier</div></div>`));
    v.appendChild(nb);
  } catch {}

  // recruiter "call now" queue
  try {
    const { tasks } = await api('/recruiter-queue');
    if (tasks.length) {
      v.appendChild(el(`<div class="section-h" style="margin-top:4px">Recruiter queue — call now (${tasks.length})</div>`));
      const cn = el('<div class="cn" style="margin-bottom:16px"></div>');
      tasks.slice(0, 6).forEach(t => {
        const c = el(`<div class="lead"><div><div class="nm">${esc(t.name)} <span class="muted" style="font-weight:500">· ${esc(t.stage)}</span></div>
          <div class="meta">${esc(t.body)}</div>
          <div class="row"><button data-call>📞 Call</button><button data-open>Open</button><button data-done>✓ Done</button></div></div></div>`);
        c.querySelector('[data-call]').onclick = () => { if (t.phone) location.href = 'tel:' + t.phone; };
        c.querySelector('[data-open]').onclick = () => openApplicant(t.applicant_id);
        c.querySelector('[data-done]').onclick = async () => { await api(`/recruit-touches/${t.touch_id}/done`, { method:'POST' }); toast('Done'); render(); };
        cn.appendChild(c);
      });
      v.appendChild(cn);
    }
  } catch {}

  const { stages, applicants } = await api('/applicants');
  const by = {}; stages.forEach(s => by[s] = []);
  applicants.forEach(a => (by[a.stage] = by[a.stage] || []).push(a));
  const board = el('<div class="board"></div>');
  stages.forEach(stage => {
    const col = el(`<div class="col" data-stage="${esc(stage)}"><h3>${esc(stage)}<span class="n">${by[stage].length}</span></h3><div class="drop"></div></div>`);
    const drop = col.querySelector('.drop');
    by[stage].forEach(a => {
      const card = el(`<div class="lead" draggable="true">
        <div class="nm">${esc(a.name)}</div>
        <div class="meta">${esc(a.email||'')}</div>
        <div class="meta">${a.last_contact_at ? a.hours_since+'h since contact' : 'new'} · ${esc(a.recruiter_name||'')}</div>
        <div class="row"><button data-call>📞</button>
          <select data-move style="width:auto;padding:5px 8px;font-size:12px"></select></div></div>`);
      card.addEventListener('dragstart', e => e.dataTransfer.setData('text/id', a.id));
      card.style.cursor = 'pointer';
      card.onclick = (e) => { if (e.target.closest('button,select')) return; openApplicant(a.id); };
      card.querySelector('[data-call]').onclick = () => { if (a.phone) location.href='tel:'+a.phone; };
      const sel = card.querySelector('[data-move]');
      sel.appendChild(el('<option value="">move…</option>'));
      stages.forEach(s => sel.appendChild(el(`<option ${s===a.stage?'disabled':''}>${esc(s)}</option>`)));
      sel.onchange = async () => { if (sel.value) { await api(`/applicants/${a.id}/stage`,{method:'POST',body:{stage:sel.value}}); toast('Moved → '+sel.value); render(); } };
      drop.appendChild(card);
    });
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async e => { e.preventDefault(); col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/id'); if (id) { await api(`/applicants/${id}/stage`,{method:'POST',body:{stage}}); toast('Moved → '+stage); render(); } });
    board.appendChild(col);
  });
  v.appendChild(board);
}

async function fireRecruitIntake() {
  const firsts = ['Jordan','Casey','Morgan','Riley','Avery','Quinn','Devon','Skyler'];
  const lasts = ['Bennett','Carter','Foster','Hayes','Patel','Rivera','Brooks','Reed'];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const name = pick(firsts) + ' ' + pick(lasts);
  const r = await api('/recruit-intake', { method: 'POST', body: { name, phone: '555' + (1000000 + Math.floor(Math.random()*8999999)) } });
  toast(`Speed-to-recruit fired → ${(r.speed_to_recruit||{}).sent||0} sent, call queued`);
  render();
}
async function openApplicant(id) {
  const { applicant, messages = [], upcoming = [], cadence = 'none' } = await api('/applicants/' + id);
  const scrim = el('<div class="scrim"></div>'); scrim.onclick = close;
  const cadPill = { active: '<span class="pill">nurture active</span>', paused: '<span class="tag-pace pace-off">paused</span>',
    done: '<span class="muted">nurture done</span>', none: '<span class="muted">no nurture</span>' }[cadence] || '';
  const d = el(`<aside class="drawer">
    <header><div style="flex:1"><div style="font-weight:800;font-size:18px">${esc(applicant.name)}</div>
      <div class="muted" style="font-size:12px">${esc(applicant.stage)} ${cadPill}</div></div>
      <button class="btn ghost sm" data-x>Close</button></header>
    <div class="body">
      <div class="row" style="display:flex;gap:8px"><button class="btn sm" data-call>📞 Call</button>
        <button class="btn ghost sm" data-sms>💬 Text</button></div>
      <div class="kv"><div class="muted">Phone</div><div>${esc(applicant.phone||'—')}</div>
        <div class="muted">Email</div><div>${esc(applicant.email||'—')}</div>
        <div class="muted">Recruiter</div><div>${esc(applicant.recruiter_name||'—')}</div>
        <div class="muted">Notes</div><div>${esc(applicant.notes||'—')}</div></div>
      ${upcoming.length ? `<div><div class="section-h">Next scheduled</div>` +
        upcoming.slice(0,5).map(u=>`<div class="tl"><div>${esc(titleize(u.channel))} · <span class="t">${esc(u.due_at)}</span></div><div class="t">${esc((u.body||'').slice(0,70))}…</div></div>`).join('') + `</div>` : ''}
      ${messages.length ? `<div><div class="section-h">Comms log</div>` +
        messages.slice(0,6).map(mm=>`<div class="tl"><div>${mm.direction==='in'?'⬅︎ inbound':'➡︎ '+esc(titleize(mm.channel))} <span class="pill">${esc(mm.status)}</span></div><div class="t">${esc((mm.body||'').slice(0,80))}</div></div>`).join('') + `</div>` : ''}
    </div></aside>`);
  function close() { scrim.remove(); d.remove(); }
  d.querySelector('[data-x]').onclick = close;
  d.querySelector('[data-call]').onclick = () => { if (applicant.phone) location.href='tel:'+applicant.phone; };
  d.querySelector('[data-sms]').onclick = () => { if (applicant.phone) location.href='sms:'+applicant.phone; };
  $('#modalRoot').append(scrim, d);
}

/* ---------- Onboarding / ramp ---------- */
async function viewOnboarding(v) {
  v.innerHTML = '<h2 style="margin:0 0 4px">Onboarding & ramp</h2><p class="muted" style="margin:0 0 14px">Agent-in-a-box. The faster they ramp, the less of your time each new agent costs.</p>';
  const { agents } = await api('/onboarding');
  const grid = el('<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px"></div>');
  const canEdit = ['owner','manager'].includes(ME.role);
  agents.forEach(a => {
    const card = el(`<div class="card" style="padding:16px">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="avatar">${esc(a.name[0])}</div>
        <div style="flex:1"><div style="font-weight:700">${esc(a.name)}</div>
          <div class="muted" style="font-size:12px">${esc(titleize(a.license_status))} · ${a.ttfaDays==null?'no first app yet':'first app in '+a.ttfaDays+'d'}</div></div>
        <div class="score">${a.pct}%</div>
      </div>
      <div class="bar" style="margin:10px 0 12px"><i style="width:${a.pct}%"></i></div>
      <div class="steps"></div></div>`);
    const steps = card.querySelector('.steps');
    a.steps.forEach(s => {
      const row = el(`<label style="display:flex;align-items:center;gap:9px;padding:5px 0;font-size:14px;cursor:${canEdit?'pointer':'default'}">
        <input type="checkbox" ${s.done?'checked':''} ${canEdit?'':'disabled'} style="width:auto">
        <span style="${s.done?'color:var(--muted);text-decoration:line-through':''}">${esc(s.step)}</span></label>`);
      if (canEdit) row.querySelector('input').onchange = async () => { await api(`/onboarding/${s.id}/toggle`, { method:'POST' }); render(); };
      steps.appendChild(row);
    });
    grid.appendChild(card);
  });
  v.appendChild(grid);
}

/* ---------- Playbook / resources ---------- */
async function viewResources(v) {
  v.innerHTML = '<h2 style="margin:0 0 4px">The Playbook</h2><p class="muted" style="margin:0 0 14px">Scripts, objection handling, hooks, and product cheat-sheets — what new agents get on day one.</p>';
  const r = await api('/resources');
  const sec = (title, inner) => { v.appendChild(el(`<div class="section-h" style="margin-top:8px;font-size:13px">${title}</div>`)); v.appendChild(inner); };
  const wrapList = (items, fn) => { const w = el('<div style="display:flex;flex-direction:column;gap:10px;max-width:820px"></div>'); items.forEach(i=>w.appendChild(fn(i))); return w; };
  sec('Scripts', wrapList(r.scripts, s => el(`<div class="card" style="padding:14px"><div style="font-weight:700;margin-bottom:5px">${esc(s.title)}</div><div class="muted" style="font-size:14px;line-height:1.6">${esc(s.body)}</div></div>`)));
  sec('Objection handling', wrapList(r.objections, o => el(`<div class="card" style="padding:14px"><div style="font-weight:700;margin-bottom:5px">${esc(o.o)}</div><div class="muted" style="font-size:14px;line-height:1.6">${esc(o.a)}</div></div>`)));
  sec('Hooks', (() => { const w = el('<div style="display:flex;flex-wrap:wrap;gap:8px;max-width:820px"></div>'); r.hooks.forEach(h=>w.appendChild(el(`<span class="pill" style="font-size:13px;padding:7px 12px">${esc(h)}</span>`))); return w; })());
  sec('Product cheat-sheets', wrapList(r.cheatsheets, c => el(`<div class="card" style="padding:14px"><div style="font-weight:700;margin-bottom:5px">${esc(c.title)}</div><div class="muted" style="font-size:14px;line-height:1.6">${esc(c.body)}</div></div>`)));
}

/* ---------- Scoreboard ---------- */
async function viewScoreboard(v) {
  v.innerHTML = '';
  const s = await api('/scoreboard');
  v.appendChild(await numberBar());
  if (s.scope !== 'team') {
    v.appendChild(el(`<div class="card" style="padding:18px;max-width:520px">
      <div class="section-h">Your month</div>
      <div style="font-size:30px;font-weight:800">${money(s.mine?s.mine.ap:0)} <span class="muted" style="font-size:16px">/ ${money(s.mine?s.mine.goal:0)}</span></div>
      <div class="bar" style="margin:12px 0"><i style="width:${Math.min(100,s.mine?s.mine.pace:0)}%"></i></div>
      <p class="muted">Keep your "going cold" count at zero and the AP follows. Three by eleven.</p></div>`));
    return;
  }
  v.appendChild(el('<h2 style="margin:6px 0 12px">Producer leaderboard</h2>'));
  const max = Math.max(1, ...s.board.map(b => b.ap));
  const table = el(`<table><thead><tr>
     <th>#</th><th>Producer</th><th class="num">AP (MTD)</th><th>Pace</th>
     <th class="num">Dials 7d</th><th class="num">Connects</th><th class="num">Apps 30d</th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector('tbody');
  s.board.forEach((r, i) => {
    tb.appendChild(el(`<tr>
      <td class="rank">${i+1}</td>
      <td>${esc(r.name)} ${r.role==='manager'?'<span class="pill">mgr</span>':''}</td>
      <td class="num"><b>${money(r.ap)}</b><div class="minibar"><i style="width:${Math.round(r.ap/max*100)}%"></i></div></td>
      <td>${r.goal?`<span class="tag-pace ${r.pace>=100?'pace-on':'pace-off'}">${r.pace}%</span>`:'—'}</td>
      <td class="num">${r.dials}</td><td class="num">${r.connects}</td><td class="num">${r.apps}</td></tr>`));
  });
  v.appendChild(table);
  v.appendChild(el('<p class="muted" style="margin-top:12px">Ranked board → run it Monday (the number) and Friday (week-in-review). What gets ranked gets penned.</p>'));

  // Attribution — which spend produces AP vs recruits
  try {
    const at = await api('/attribution');
    v.appendChild(el('<h2 style="margin:22px 0 12px">Source ROI — where AP & agents come from</h2>'));
    const ct = el(`<table><thead><tr><th>Client source</th><th>CTA</th><th class="num">Leads</th><th class="num">Issued</th><th class="num">AP</th><th class="num">Spend</th><th class="num">AP / $</th><th class="num">CPA</th></tr></thead><tbody></tbody></table>`);
    const cb = ct.querySelector('tbody');
    at.client.forEach(s => cb.appendChild(el(`<tr><td>${esc(s.name)}</td><td>${s.cta_keyword?'<span class="pill">'+esc(s.cta_keyword)+'</span>':'—'}</td>
      <td class="num">${s.leads}</td><td class="num">${s.issued}</td><td class="num">${money(s.issued_ap)}</td>
      <td class="num">${money(s.spend)}</td><td class="num"><b style="color:${s.apPerDollar>=1?'var(--good)':s.apPerDollar==null?'inherit':'var(--cold)'}">${s.apPerDollar==null?'—':s.apPerDollar+'×'}</b></td>
      <td class="num">${s.cpa==null?'—':money(s.cpa)}</td></tr>`)));
    v.appendChild(ct);
    if (at.recruit.length) {
      v.appendChild(el('<div class="section-h" style="margin:16px 0 8px">Recruit sources</div>'));
      const rt = el(`<table><thead><tr><th>Recruit source</th><th>CTA</th><th class="num">Applicants</th><th class="num">Producing</th><th class="num">Spend</th><th class="num">Cost / producing</th></tr></thead><tbody></tbody></table>`);
      const rb = rt.querySelector('tbody');
      at.recruit.forEach(s => rb.appendChild(el(`<tr><td>${esc(s.name)}</td><td>${s.cta_keyword?'<span class="pill">'+esc(s.cta_keyword)+'</span>':'—'}</td>
        <td class="num">${s.applicants}</td><td class="num">${s.producing}</td><td class="num">${money(s.spend)}</td>
        <td class="num"><b>${s.costPerProducing==null?'—':money(s.costPerProducing)}</b></td></tr>`)));
      v.appendChild(rt);
    }
    v.appendChild(el('<p class="muted" style="margin-top:12px">Put spend behind anything returning &gt; 1× AP per dollar (and a low cost-per-producing-agent). Kill the rest.</p>'));
  } catch {}

  // Book of business
  try {
    const bk = await api('/book');
    v.appendChild(el('<h2 style="margin:22px 0 12px">Book of business</h2>'));
    const wrap = el('<div class="numberbar"></div>');
    wrap.appendChild(el(`<div class="stat"><div class="k">Total policies</div><div class="v">${bk.total.c}</div><div class="muted" style="font-size:12px;margin-top:6px">${money(bk.total.ap)} total AP</div></div>`));
    bk.byStatus.forEach(s => wrap.appendChild(el(`<div class="stat"><div class="k">${esc(titleize(s.status))}</div><div class="v">${s.c}</div><div class="muted" style="font-size:12px;margin-top:6px">${money(s.ap)} AP</div></div>`)));
    v.appendChild(wrap);
  } catch {}
}

/* ---------- start ---------- */
if (TOKEN) boot();
