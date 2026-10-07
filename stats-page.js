'use strict';
// صفحة الإحصائيات (بالفصحى) — تُعرض على /stats?key=...
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('en-US');

function bars(obj, limit) {
  const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!rows.length) return '<p class="empty">لا توجد بيانات بعد.</p>';
  const max = rows[0][1] || 1;
  return '<div class="bars">' + rows.map(([k, v]) =>
    `<div class="br" title="${esc(k)}: ${fmt(v)}"><span class="bk">${esc(k)}</span><span class="bt"><i style="width:${Math.max(2, v / max * 100)}%"></i></span><span class="bv">${fmt(v)}</span></div>`).join('') + '</div>';
}

function days(d) {
  const out = [];
  const now = Date.now() + 3 * 3600 * 1000;
  for (let i = 13; i >= 0; i--) {
    const k = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push([k, (d && d[k]) || { visits: 0, games: 0, finals: 0, players: 0 }]);
  }
  const max = Math.max(1, ...out.map(([, v]) => v.games));
  return `<div class="cols">${out.map(([k, v], i) => `<div class="col" tabindex="0"><span class="tip">${k.slice(5).replace('-', '/')}<br>${fmt(v.games)} لعبة · ${fmt(v.players)} لاعب · ${fmt(v.visits)} زيارة</span><span class="cv">${v.games || ''}</span><i style="height:${v.games ? Math.max(4, v.games / max * 100) : 0}%"></i><span class="cl">${i % 2 === 1 ? '' : k.slice(8)}</span></div>`).join('')}</div>`;
}

module.exports = function page(s, live) {
  const avg = s.games ? (s.players / s.games).toFixed(1) : '0';
  const doneRate = s.games ? Math.round(s.finals / s.games * 100) : 0;
  const tiles = [
    ['زيارات الصفحة', s.visits], ['جلسات فُتحت', s.rooms], ['ألعاب بدأت', s.games],
    ['ألعاب اكتملت', s.finals, `${doneRate}% من الألعاب`], ['لاعبون', s.players, `بمعدل ${avg} في الجلسة`], ['جولات لُعبت', s.rounds, `${fmt(s.custom)} سؤالًا مخصصًا`]
  ];
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>إحصائيات مين أكتر حدا</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Lalezar&family=Rubik:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#F4EFE7;--surface:#FFFCF7;--ink:#1D1834;--ink2:#625B78;--line:#DDD4C5;--acc:#1F7570;--fd:"Lalezar","Rubik",sans-serif;--fb:"Rubik",system-ui,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15112A;--surface:#252046;--ink:#F5EFE4;--ink2:#ADA4C8;--line:#383160;--acc:#39A49B;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--fb);padding:24px 16px 48px}
.w{max-width:920px;margin:0 auto;display:grid;gap:18px}
h1{font-family:var(--fd);font-weight:400;font-size:34px;margin:0}h2{font-family:var(--fd);font-weight:400;font-size:22px;margin:0 0 12px}
.sub{color:var(--ink2);font-size:14px;margin-top:4px}
.live{display:inline-flex;align-items:center;gap:8px;font-size:14px;background:var(--surface);border:1.5px solid var(--line);border-radius:999px;padding:6px 14px}
.live i{width:8px;height:8px;border-radius:50%;background:var(--acc)}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}@media (max-width:560px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.t{background:var(--surface);border:1.5px solid var(--line);border-radius:18px;padding:14px 16px}
.t .k{font-size:13px;color:var(--ink2)}.t .v{font-family:var(--fd);font-size:34px;line-height:1.3;font-variant-numeric:tabular-nums}.t .n{font-size:12px;color:var(--ink2)}
.card{background:var(--surface);border:1.5px solid var(--line);border-radius:20px;padding:18px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
.bars{display:grid;gap:10px}.br{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) auto;gap:10px;align-items:center;font-size:14px}
.bk{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{height:10px;background:var(--bg);border-radius:4px;overflow:hidden}.bt i{display:block;height:100%;background:var(--acc);border-radius:4px 0 0 4px}
.bv{font-variant-numeric:tabular-nums;color:var(--ink2);min-width:2.5em;text-align:left}
.cols{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:4px;height:180px;align-items:end;padding-top:22px;border-bottom:1.5px solid var(--line)}
.col{position:relative;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;outline:none}
.col i{display:block;width:70%;background:var(--acc);border-radius:4px 4px 0 0}
.cv{font-size:11px;color:var(--ink2);font-variant-numeric:tabular-nums}
.cl{position:absolute;bottom:-20px;font-size:11px;color:var(--ink2)}
.tip{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);font-size:12px;line-height:1.6;padding:6px 10px;border-radius:8px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s;z-index:2}
.col:hover .tip,.col:focus .tip{opacity:1}
.empty{color:var(--ink2);font-size:14px;margin:0}
.foot{font-size:12px;color:var(--ink2)}
</style></head><body><div class="w">
<div><h1>إحصائيات «مين أكتر حدا؟»</h1><div class="sub">منذ ${esc(String(s.since).slice(0, 10))} · الأرقام لا تتضمن أي أسماء أو صور</div></div>
<div><span class="live"><i></i> الآن: ${fmt(live.rooms)} جلسة مفتوحة · ${fmt(live.players)} لاعب متصل</span></div>
<div class="tiles">${tiles.map(([k, v, n]) => `<div class="t"><div class="k">${k}</div><div class="v">${fmt(v)}</div>${n ? `<div class="n">${n}</div>` : ''}</div>`).join('')}</div>
<div class="card"><h2>الألعاب خلال آخر 14 يومًا</h2>${days(s.days)}<div style="height:22px"></div></div>
<div class="two">
<div class="card"><h2>الأسئلة الأكثر لعبًا</h2>${bars(s.questions, 12)}</div>
<div class="card"><h2>نوع المجموعة</h2>${bars(s.groups, 8)}<h2 style="margin-top:22px">عدد اللاعبين في الجلسة</h2>${bars(s.groupSizes, 10)}</div>
</div>
<div class="foot">للبيانات الخام: <span dir="ltr">/stats.json</span> بالمفتاح نفسه.</div>
</div></body></html>`;
};
