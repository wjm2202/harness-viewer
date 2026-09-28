import type { Graph } from "./schema.js";
import type { LintReport } from "./lint.js";
import { buildMachine, type Machine } from "./machine.js";

const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");

/** Escape JSON so it is safe inside <script type="application/json">. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A single self-contained HTML file: no network, no build, no dependencies.
 * Two views:
 *  - State machine (default): start condition at the top, stages flowing down
 *    in one lane per agent, gates (◇) between them, loops drawn as back edges.
 *  - Knowledge graph: every node and relation (tools, artifacts, rules…).
 * Client JS avoids template literals so it can live inside this TS template.
 */
export function renderViewer(g: Graph, lint: LintReport, machine: Machine = buildMachine(g)): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(g.meta.name)} · harness state machine</title>
<style>
:root{--bg:#f6f6f3;--panel:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#dcdce0;--hi:#0a66ff;--edge:#8e8e98;--warn:#b25e00;--err:#c62828;--info:#4f6d8a;
--laneA:#fbfbf9;--laneB:#f1f1ec;--state:#16a34a;--start:#1d1d1f;
--g-human:#db2777;--g-automated:#0d9488;--g-agent:#7c3aed;--g-implicit:#8b8b93;
--k-instruction:#6b7280;--k-agent:#2563eb;--k-prompt:#7c3aed;--k-skill:#0d9488;--k-mcp_server:#b45309;--k-tool:#d97706;--k-state:#16a34a;--k-gate:#db2777;--k-artifact:#475569;--k-trigger:#1d1d1f;--k-actor:#0891b2;--k-rule:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#131316;--panel:#1c1c21;--ink:#ececf1;--muted:#9a9aa6;--line:#30303a;--hi:#5b9dff;--edge:#74747f;--warn:#f0a040;--err:#ff6b6b;--info:#8fb3d9;--laneA:#18181c;--laneB:#1f1f25;--start:#ececf1;--k-trigger:#ececf1}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
#app{display:grid;grid-template-columns:270px 1fr 330px;height:100vh}
aside{background:var(--panel);border-right:1px solid var(--line);overflow:auto;padding:14px}
#detail{border-right:0;border-left:1px solid var(--line)}
h1{font-size:15px;margin:0 0 2px}h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 6px}
.muted{color:var(--muted)}input[type=search],select{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
.kinds label{display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer}.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.seg{display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.seg button{flex:1;border:0;background:transparent;color:var(--ink);padding:6px;cursor:pointer;font:inherit}.seg button.on{background:var(--hi);color:#fff}
.btn{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit}
.f{padding:6px 8px;cursor:pointer;margin:2px 0;border-left:3px solid var(--info)}.f:hover{background:var(--bg)}.f.error{border-color:var(--err)}.f.warn{border-color:var(--warn)}.f .r{font-size:11px;color:var(--muted)}
#canvas{position:relative;overflow:hidden}svg{width:100%;height:100%;display:block;cursor:grab}svg.drag{cursor:grabbing}
.n{cursor:pointer}.n text{fill:var(--ink);font-size:11.5px;pointer-events:none}.n .cap{fill:var(--muted);font-size:9.5px;letter-spacing:.04em;text-transform:uppercase}
.n.sel .shape{stroke:var(--hi)!important;stroke-width:3}.dim{opacity:.15}
.e path{fill:none;stroke:var(--edge);stroke-width:1.4}.e.back path{stroke-dasharray:6 4}.e text{font-size:10px;fill:var(--muted)}.e.hot path{stroke:var(--hi);stroke-width:2.2}
.lane-h{font-size:12px;font-weight:600;fill:var(--ink)}.lane-k{font-size:9.5px;fill:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.kg .edge path{fill:none;stroke:var(--edge);stroke-width:1.1}.kg .edge.inferred path{stroke-dasharray:5 3}.kg .edge.speculative path{stroke-dasharray:2 3}.kg .edge.hot path{stroke:var(--hi);stroke-width:2}
dl{margin:0}dt{color:var(--muted);font-size:11px;margin-top:8px}dd{margin:2px 0 0}code{font:11px ui-monospace,Menlo,monospace;background:var(--bg);padding:1px 4px;border-radius:4px;word-break:break-all}
.rel{cursor:pointer;color:var(--hi)}.rel:hover{text-decoration:underline}.pill{display:inline-block;font-size:10px;padding:1px 6px;border-radius:9px;border:1px solid var(--line);color:var(--muted);margin-right:4px}
ul.crit{margin:4px 0 0;padding-left:18px}
#legend{position:absolute;left:10px;bottom:10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:11px;color:var(--muted)}
#crumb{position:absolute;left:10px;top:10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;display:none}
@media (max-width:900px){#app{grid-template-columns:1fr;grid-template-rows:auto 65vh auto;height:auto}aside{border:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<div id="app">
<aside id="side">
  <h1 id="title"></h1><div class="muted" id="sub"></div>
  <h2>View</h2><div class="seg"><button id="v-sm" class="on">State machine</button><button id="v-kg">Knowledge graph</button></div>
  <div id="sm-ctl"><h2>Workflow</h2><select id="wf"></select>
    <h2>Gates</h2><div class="kinds">
      <label><span class="sw" style="background:var(--g-human)"></span>human approval</label>
      <label><span class="sw" style="background:var(--g-automated)"></span>automated check</label>
      <label><span class="sw" style="background:var(--g-agent)"></span>agent judgement</label>
      <label><span class="sw" style="background:var(--g-implicit)"></span>implicit (no criteria written)</label></div></div>
  <div id="kg-ctl" style="display:none"><h2>Layout</h2><div class="seg"><button id="lay-flow" class="on">Flow</button><button id="lay-net">Network</button></div>
    <h2>Show</h2><div class="kinds" id="kinds"></div>
    <label style="display:flex;gap:6px;margin-top:6px"><input type="checkbox" id="showInferred" checked> inferred / speculative</label></div>
  <h2>Search</h2><input type="search" id="q" placeholder="label, id, file…">
  <h2>Findings <span class="muted" id="fcount"></span></h2><div id="findings"></div>
</aside>
<div id="canvas"><svg id="svg"><defs>
<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#8e8e98"/></marker>
<marker id="arrhi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#0a66ff"/></marker>
</defs><g id="vp"><g id="lanes"></g><g id="edges"></g><g id="nodes"></g></g></svg>
<div id="crumb"></div>
<div id="legend"></div></div>
<aside id="detail"><div class="muted">Click a stage or gate to see who does it, what it needs, what it produces and what must be true to move on. Drag to pan, scroll to zoom.</div></aside>
</div>
<script type="application/json" id="graph-data">${embedJson({ graph: g, lint, machine })}</script>
<script>
(function(){
var DATA=JSON.parse(document.getElementById('graph-data').textContent);
var G=DATA.graph,LINT=DATA.lint,M=DATA.machine;
var byId={},outE={},inE={};
G.nodes.forEach(function(n){byId[n.id]=n;outE[n.id]=[];inE[n.id]=[];});
G.edges.forEach(function(e){if(byId[e.from]&&byId[e.to]){outE[e.from].push(e);inE[e.to].push(e);}});
var view='sm',wfIdx=0,sel=null,q='',vp={x:40,y:20,k:1};
function $(id){return document.getElementById(id);}
function el(tag,attrs,parent){var x=document.createElementNS('http://www.w3.org/2000/svg',tag);for(var k in attrs)x.setAttribute(k,attrs[k]);if(parent)parent.appendChild(x);return x;}
function h(tag,text,cls){var x=document.createElement(tag);if(text!=null)x.textContent=text;if(cls)x.className=cls;return x;}
function wrap(t,max,lines){var w=String(t).split(/\\s+/),out=[],cur='';for(var i=0;i<w.length;i++){var nx=cur?cur+' '+w[i]:w[i];if(nx.length>max&&cur){out.push(cur);cur=w[i];if(out.length===lines){cur='';break;}}else cur=nx;}
  if(out.length<lines&&cur)out.push(cur);if(out.join(' ').length<String(t).length){var l=out[out.length-1]||'';out[out.length-1]=(l.length>max-1?l.slice(0,max-1):l)+'…';}return out;}
function matches(n){if(!q)return true;return ((n.label||'')+' '+(n.id||'')+' '+(n.description||'')+' '+(n.source?n.source.file:'')+' '+(n.criteria||[]).join(' ')).toLowerCase().indexOf(q)>=0;}
$('title').textContent=G.meta.name;
$('sub').textContent=M.workflows.filter(function(w){return !w.scope;}).length+' workflow(s) · '+G.nodes.filter(function(n){return n.kind==='gate';}).length+' gates · '+LINT.counts.error+' errors · '+LINT.counts.warn+' warnings';

// ================= STATE MACHINE =================
var SLOT=250,ROWH=112,TOP=70,SW=204,SH=58,GW=176,GH=78;
M.workflows.forEach(function(w,i){var o=h('option',(w.scope?'  ↳ ':'')+w.title+'  ('+w.nodes.filter(function(n){return n.kind==='state';}).length+' stages)');o.value=i;$('wf').appendChild(o);});
$('wf').onchange=function(e){wfIdx=+e.target.value;sel=null;renderSM();fit();showDetail(null);};
var P={};
function smLayout(w){P={};var laneX={},x=0;w.lanes.forEach(function(l){laneX[l.id]=x;x+=l.width*SLOT;});
  w.nodes.forEach(function(n){P[n.id]={x:laneX[n.lane]+n.sub*SLOT+SLOT/2,y:TOP+n.rank*ROWH+SH/2};});return {laneX:laneX,width:x};}
function half(n){return n.kind==='gate'?GH/2:n.kind==='end'?12:n.kind==='start'?18:n.kind==='ghost'?20:SH/2;}
function halfW(n){return n.kind==='gate'?GW/2:n.kind==='end'?12:SW/2;}
function renderSM(){
  var w=M.workflows[wfIdx];var L=$('lanes'),E=$('edges'),N=$('nodes');L.innerHTML='';E.innerHTML='';N.innerHTML='';$('svg').setAttribute('class','');
  if(!w){P={};var t0=el('text',{x:20,y:40,'class':'lane-h'},N);t0.textContent='No workflows found. Follow AGENT_BRIEF.md to add stages and gates.';$('legend').textContent='';return;}
  var lay=smLayout(w);var H=TOP+w.ranks*ROWH+40;
  w.lanes.forEach(function(l,i){var x=lay.laneX[l.id];el('rect',{x:x,y:0,width:l.width*SLOT,height:H,fill:i%2?'var(--laneB)':'var(--laneA)'},L);
    var t=el('text',{x:x+12,y:22,'class':'lane-h'},L);t.textContent=l.label;var k=el('text',{x:x+12,y:36,'class':'lane-k'},L);k.textContent=l.kind==='none'?'no owner':l.kind;});
  var nodeOf={};w.nodes.forEach(function(n){nodeOf[n.id]=n;});
  var backN=0;var focus=null;if(sel&&nodeOf[sel]){focus={};focus[sel]=1;w.edges.forEach(function(e){if(e.from===sel||e.to===sel){focus[e.from]=1;focus[e.to]=1;}});}
  w.edges.forEach(function(e){var a=nodeOf[e.from],b=nodeOf[e.to];var pa=P[a.id],pb=P[b.id];var g=el('g',{'class':'e'+(e.back?' back':'')},E);
    var hot=sel&&(e.from===sel||e.to===sel);if(hot)g.classList.add('hot');else if(focus)g.classList.add('dim');
    var d,lx,ly;
    if(e.back){var x1=pa.x+halfW(a),y1=pa.y,x2=pb.x+halfW(b),y2=pb.y;var lo=Math.min(a.rank,b.rank),hi=Math.max(a.rank,b.rank),right=Math.max(x1,x2);
      w.nodes.forEach(function(o){if(o.rank>=lo&&o.rank<=hi)right=Math.max(right,P[o.id].x+halfW(o));});backN++;
      var bx=right+24+backN*14,r=10,s=y2<y1?-1:1;
      d='M'+x1+','+y1+' L'+(bx-r)+','+y1+' Q'+bx+','+y1+' '+bx+','+(y1+s*r)+' L'+bx+','+(y2-s*r)+' Q'+bx+','+y2+' '+(bx-r)+','+y2+' L'+x2+','+y2;lx=bx+4;ly=(y1+y2)/2;}
    else{var sx=pa.x,sy=pa.y+half(a),tx=pb.x,ty=pb.y-half(b);var my=(sy+ty)/2;d=Math.abs(sx-tx)<2?'M'+sx+','+sy+' L'+tx+','+ty:'M'+sx+','+sy+' C'+sx+','+my+' '+tx+','+my+' '+tx+','+ty;lx=(sx+tx)/2+6;ly=my-3;}
    el('path',{d:d,'marker-end':hot?'url(#arrhi)':'url(#arr)'},g);
    if(e.label&&a.kind!=='start'){var t=el('text',{x:lx,y:ly},g);t.textContent=e.label;}});
  w.nodes.forEach(function(n){var p=P[n.id];var g=el('g',{'class':'n','transform':'translate('+p.x+','+p.y+')'},N);g.dataset.id=n.ref;g.dataset.kind=n.kind;
    var gn=byId[n.ref]||{};if(n.ref===sel&&n.kind!=='end'&&n.kind!=='ghost')g.classList.add('sel');if((focus&&!focus[n.id])||(q&&!matches(gn)))g.classList.add('dim');
    if(n.kind==='start'){el('rect',{'class':'shape',x:-SW/2,y:-18,width:SW,height:36,rx:18,fill:'var(--panel)',stroke:'var(--start)','stroke-width':1.5},g);el('circle',{cx:-SW/2+18,cy:0,r:7,fill:'var(--start)'},g);
      var t1=el('text',{x:-SW/2+32,y:4},g);t1.textContent=wrap(n.label,26,1)[0];var c1=el('text',{x:-SW/2+8,y:-23,'class':'cap'},g);c1.textContent=gn.kind==='prompt'?'start · prompt':'start condition';}
    else if(n.kind==='state'){el('rect',{'class':'shape',x:-SW/2,y:-SH/2,width:SW,height:SH,rx:10,fill:'var(--panel)',stroke:'var(--state)','stroke-width':n.compound?3:1.5},g);
      if(n.compound)el('rect',{x:-SW/2+4,y:-SH/2+4,width:SW-8,height:SH-8,rx:8,fill:'none',stroke:'var(--state)','stroke-width':0.8},g);
      var ls=wrap(n.label,30,2);ls.forEach(function(s,i){var t=el('text',{x:0,y:(ls.length===1?4:-4)+i*14,'text-anchor':'middle'},g);t.textContent=s;});
      var cp=el('text',{x:-SW/2+8,y:-SH/2-5,'class':'cap'},g);cp.textContent=(gn.props&&gn.props.stage?'stage':gn.props&&gn.props.step?'step '+gn.props.step:'state')+(n.compound?' · sub-flow ▸':'');}
    else if(n.kind==='gate'){var col='var(--g-'+(n.gateType||'implicit')+')';el('polygon',{'class':'shape',points:'0,'+(-GH/2)+' '+(GW/2)+',0 0,'+(GH/2)+' '+(-GW/2)+',0',fill:'var(--panel)',stroke:col,'stroke-width':2,'stroke-dasharray':n.gateType==='implicit'?'5 3':''},g);
      var gl=wrap(n.label,20,2);gl.forEach(function(s,i){var t=el('text',{x:0,y:(gl.length===1?4:-3)+i*13,'text-anchor':'middle'},g);t.textContent=s;});
      var gc=el('text',{x:GW/2-14,y:-GH/2+8,'class':'cap'},g);gc.textContent=(n.gateType||'gate');}
    else if(n.kind==='end'){el('circle',{cx:0,cy:0,r:11,fill:'none',stroke:'var(--start)','stroke-width':1.5},g);el('circle',{cx:0,cy:0,r:6,fill:'var(--start)'},g);}
    else if(n.kind==='ghost'){el('rect',{'class':'shape',x:-SW/2,y:-20,width:SW,height:40,rx:8,fill:'none',stroke:'var(--edge)','stroke-dasharray':'4 3'},g);var gt=el('text',{x:0,y:4,'text-anchor':'middle'},g);gt.textContent='↗ '+wrap(n.label,28,1)[0];}
    var tt=el('title',{},g);tt.textContent=n.label;
    g.addEventListener('mousedown',function(ev){ev.stopPropagation();downNode={n:n,x:ev.clientX,y:ev.clientY};});
    g.addEventListener('dblclick',function(){if(n.compound)openSub(n.ref);});
  });
  var crumb=$('crumb');if(w.scope){crumb.style.display='block';crumb.innerHTML='';var b=h('span','← back to parent flow','rel');b.onclick=function(){gotoNode(w.scope);};crumb.appendChild(b);}else crumb.style.display='none';
  $('legend').textContent='● start   ▭ stage (lane = who does it)   ◇ gate   ◉ end   ⤺ dashed = loop / retry';
}
function openSub(stateId){for(var i=0;i<M.workflows.length;i++){if(M.workflows[i].scope===stateId){setView('sm');wfIdx=i;$('wf').value=i;sel=null;renderSM();fit();return true;}}return false;}
function wfOf(id){for(var i=0;i<M.workflows.length;i++){if(M.workflows[i].nodes.some(function(n){return n.id===id&&n.kind!=='ghost';}))return i;}return -1;}
function gotoNode(id){var i=wfOf(id);if(i>=0){setView('sm');if(i!==wfIdx){wfIdx=i;$('wf').value=i;}sel=id;renderSM();centerOn(id);showDetail(id);}else{setView('kg');kgSelect(id);}}

// ================= KNOWLEDGE GRAPH =================
var KINDS=['trigger','prompt','actor','instruction','agent','state','gate','skill','mcp_server','tool','artifact','rule'];
var hidden={rule:true},showInferred=true,kgLayout='flow',KP={};var W=170,H=38;
KINDS.forEach(function(k){var n=G.nodes.filter(function(x){return x.kind===k;}).length;if(!n)return;var l=h('label');var c=h('input');c.type='checkbox';c.checked=!hidden[k];c.dataset.k=k;
  c.onchange=function(){hidden[k]=!c.checked;kgDoLayout();renderKG();};var sw=h('span',null,'sw');sw.style.background='var(--k-'+k+')';l.appendChild(c);l.appendChild(sw);l.appendChild(document.createTextNode(k+' ('+n+')'));$('kinds').appendChild(l);});
$('showInferred').onchange=function(e){showInferred=e.target.checked;kgDoLayout();renderKG();};
$('lay-flow').onclick=function(){kgLayout='flow';$('lay-flow').className='on';$('lay-net').className='';kgDoLayout();renderKG();fit();};
$('lay-net').onclick=function(){kgLayout='net';$('lay-net').className='on';$('lay-flow').className='';kgDoLayout();renderKG();fit();};
function kvis(n){return !hidden[n.kind]&&(showInferred||n.confidence==='declared');}
function kgDoLayout(){var ids=G.nodes.filter(kvis).map(function(n){return n.id;});var set={};ids.forEach(function(i){set[i]=1;});
  var es=G.edges.filter(function(e){return set[e.from]&&set[e.to]&&e.kind!=='references';}).map(function(e){return e.kind==='reads'||e.kind==='performed_by'||e.kind==='constrains'?[e.to,e.from]:[e.from,e.to];});
  var adj={};ids.forEach(function(i){adj[i]=[];});es.forEach(function(p){adj[p[0]].push(p[1]);});
  var st={},keep=[];function dfs(u){st[u]=1;adj[u].forEach(function(v){if(st[v]===1)return;keep.push([u,v]);if(!st[v])dfs(v);});st[u]=2;}ids.forEach(function(i){if(!st[i])dfs(i);});
  var indeg={},ad2={};ids.forEach(function(i){indeg[i]=0;ad2[i]=[];});keep.forEach(function(p){ad2[p[0]].push(p[1]);indeg[p[1]]++;});
  var rank={},qq=ids.filter(function(i){return !indeg[i];});qq.forEach(function(i){rank[i]=0;});while(qq.length){var u=qq.shift();ad2[u].forEach(function(v){rank[v]=Math.max(rank[v]||0,rank[u]+1);if(--indeg[v]===0)qq.push(v);});}
  var cols={};ids.forEach(function(i){var r=rank[i]||0;(cols[r]=cols[r]||[]).push(i);});KP={};
  Object.keys(cols).map(Number).sort(function(a,b){return a-b;}).forEach(function(r,ci){var c=cols[r].sort(function(a,b){return byId[a].kind.localeCompare(byId[b].kind)||a.localeCompare(b);});c.forEach(function(id,k){KP[id]={x:ci*240,y:(k-(c.length-1)/2)*56};});});
  if(kgLayout==='net'){var P2=ids.map(function(i){return KP[i];}),ix={};ids.forEach(function(i,k){ix[i]=k;});var links=G.edges.filter(function(e){return ix[e.from]!=null&&ix[e.to]!=null;});
    for(var it=0;it<240;it++){var t=1-it/240;for(var a=0;a<P2.length;a++)for(var b=a+1;b<P2.length;b++){var dx=P2[a].x-P2[b].x,dy=P2[a].y-P2[b].y,d2=dx*dx+dy*dy+0.01;if(d2>250000)continue;var f=9000/d2*t;P2[a].x+=dx*f;P2[a].y+=dy*f;P2[b].x-=dx*f;P2[b].y-=dy*f;}
      links.forEach(function(e){var s=P2[ix[e.from]],u=P2[ix[e.to]];var dx=u.x-s.x,dy=u.y-s.y,d=Math.sqrt(dx*dx+dy*dy)||1;var f=(d-200)/d*0.06*t;s.x+=dx*f;s.y+=dy*f;u.x-=dx*f;u.y-=dy*f;});}}}
function renderKG(){var L=$('lanes'),E=$('edges'),N=$('nodes');L.innerHTML='';E.innerHTML='';N.innerHTML='';$('svg').setAttribute('class','kg');
  var focus=null;if(sel){focus={};focus[sel]=1;(outE[sel]||[]).concat(inE[sel]||[]).forEach(function(e){focus[e.from]=1;focus[e.to]=1;});}
  G.edges.forEach(function(e){if(!KP[e.from]||!KP[e.to]||!kvis(byId[e.from])||!kvis(byId[e.to]))return;if(!showInferred&&e.confidence!=='declared')return;var a=KP[e.from],b=KP[e.to];
    var g=el('g',{'class':'edge '+e.confidence},E);if(sel&&(e.from===sel||e.to===sel))g.classList.add('hot');else if(sel)g.classList.add('dim');
    var x1=a.x+W/2,x2=b.x-W/2;if(b.x<=a.x){x1=a.x-W/2;x2=b.x+W/2;}var mx=(x1+x2)/2;el('path',{d:'M'+x1+','+a.y+' C'+mx+','+a.y+' '+mx+','+b.y+' '+x2+','+b.y,'marker-end':'url(#arr)'},g);
    var t=el('title',{},g);t.textContent=e.from+' —'+e.kind+'→ '+e.to;});
  G.nodes.forEach(function(n){if(!KP[n.id]||!kvis(n))return;var p=KP[n.id];var g=el('g',{'class':'n node','transform':'translate('+(p.x-W/2)+','+(p.y-H/2)+')'},N);g.dataset.id=n.id;
    if(n.id===sel)g.classList.add('sel');if((focus&&!focus[n.id])||!matches(n))g.classList.add('dim');
    el('rect',{'class':'shape',width:W,height:H,rx:7,fill:'var(--panel)',stroke:'var(--k-'+n.kind+')','stroke-dasharray':n.confidence==='declared'?'':'5 3'},g);el('rect',{width:5,height:H,fill:'var(--k-'+n.kind+')',rx:2},g);
    var k=el('text',{x:12,y:13,'class':'cap'},g);k.textContent=n.kind.replace('_',' ');var t=el('text',{x:12,y:28},g);t.textContent=n.label.length>26?n.label.slice(0,25)+'…':n.label;
    g.addEventListener('mousedown',function(ev){ev.stopPropagation();downNode={n:{ref:n.id,kind:n.kind},x:ev.clientX,y:ev.clientY};});});
  $('legend').textContent='— declared   - - inferred   ··· speculative';$('crumb').style.display='none';}
function kgSelect(id){var n=byId[id];if(n&&hidden[n.kind]){hidden[n.kind]=false;var b=$('kinds').querySelector('input[data-k="'+n.kind+'"]');if(b)b.checked=true;kgDoLayout();}sel=id;renderKG();centerOn(id);showDetail(id);}

// ================= shared =================
function setView(v){if(view===v)return;view=v;$('v-sm').className=v==='sm'?'on':'';$('v-kg').className=v==='kg'?'on':'';$('sm-ctl').style.display=v==='sm'?'':'none';$('kg-ctl').style.display=v==='kg'?'':'none';
  if(v==='kg'){kgDoLayout();renderKG();}else renderSM();fit();}
$('v-sm').onclick=function(){setView('sm');};$('v-kg').onclick=function(){setView('kg');};
$('q').oninput=function(e){q=e.target.value.toLowerCase();if(view==='sm')renderSM();else renderKG();};
function pos(){return view==='sm'?P:KP;}
function applyVp(){$('vp').setAttribute('transform','translate('+vp.x+','+vp.y+') scale('+vp.k+')');}
function fit(){var ps=pos(),ids=Object.keys(ps);var r=$('svg').getBoundingClientRect();if(!ids.length||!r.width){applyVp();return;}var minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  ids.forEach(function(i){var p=ps[i];minx=Math.min(minx,p.x-130);maxx=Math.max(maxx,p.x+170);miny=Math.min(miny,p.y-60);maxy=Math.max(maxy,p.y+60);});if(view==='sm')miny=Math.min(miny,0);
  var k=Math.min(1.1,(r.width-20)/(maxx-minx||1),(r.height-20)/(maxy-miny||1));vp.k=Math.max(0.2,isFinite(k)&&k>0?k:1);
  vp.x=(r.width-(maxx-minx)*vp.k)/2-minx*vp.k;vp.y=view==='sm'?10-miny*vp.k:(r.height-(maxy-miny)*vp.k)/2-miny*vp.k;applyVp();}
function centerOn(id){var p=pos()[id];if(!p)return;var r=$('svg').getBoundingClientRect();if(!r.width)return;vp.x=r.width/2-p.x*vp.k;vp.y=r.height/2-p.y*vp.k;applyVp();}
var svg=$('svg'),pan=null,downNode=null;
svg.addEventListener('mousedown',function(ev){pan={x:ev.clientX,y:ev.clientY,vx:vp.x,vy:vp.y,moved:false};svg.classList.add('drag');});
window.addEventListener('mousemove',function(ev){if(pan){vp.x=pan.vx+ev.clientX-pan.x;vp.y=pan.vy+ev.clientY-pan.y;if(Math.abs(ev.clientX-pan.x)+Math.abs(ev.clientY-pan.y)>3)pan.moved=true;applyVp();}});
window.addEventListener('mouseup',function(ev){if(downNode&&Math.abs(ev.clientX-downNode.x)+Math.abs(ev.clientY-downNode.y)<4){clickNode(downNode.n);}else if(pan&&!pan.moved&&sel){sel=null;if(view==='sm')renderSM();else renderKG();showDetail(null);}downNode=null;pan=null;svg.classList.remove('drag');});
svg.addEventListener('wheel',function(ev){ev.preventDefault();var r=svg.getBoundingClientRect();var mx=ev.clientX-r.left,my=ev.clientY-r.top;var k=Math.min(3,Math.max(0.1,vp.k*Math.exp(-ev.deltaY*0.0015)));
  vp.x=mx-(mx-vp.x)*(k/vp.k);vp.y=my-(my-vp.y)*(k/vp.k);vp.k=k;applyVp();},{passive:false});
function clickNode(n){if(n.kind==='ghost'){gotoNode(n.ref);return;}select(n.ref);}
function select(id){sel=id;if(view==='sm')renderSM();else kgSelect(id);showDetail(id);}

function showDetail(id){var D=$('detail');D.innerHTML='';if(!id||!byId[id]){D.appendChild(h('div','Click a stage or gate to see who does it, what it needs, what it produces and what must be true to move on.','muted'));return;}
  var n=byId[id];var head=h('div',null,'muted');var sw=h('span',null,'sw');sw.style.background=n.kind==='gate'?'var(--g-'+(n.gateType||'implicit')+')':'var(--k-'+n.kind+')';head.appendChild(sw);head.appendChild(document.createTextNode(' '+(n.kind==='gate'?'gate · '+(n.gateType||'?'):n.kind)));D.appendChild(head);
  D.appendChild(h('h1',n.label));var pills=h('div');[n.confidence,n.origin].concat(n.initial?['initial']:[]).concat(n.terminal?['terminal']:[]).forEach(function(p){pills.appendChild(h('span',p,'pill'));});D.appendChild(pills);
  if(n.kind==='gate'){D.appendChild(h('h2','Criteria to pass'));if(n.criteria&&n.criteria.length){var ul=h('ul',null,'crit');n.criteria.forEach(function(c){ul.appendChild(h('li',c));});D.appendChild(ul);}else D.appendChild(h('div','None written down: this is an implicit gate.','muted'));}
  var subs=M.workflows.filter(function(w){return w.scope===id;});if(subs.length){var b=h('button','Open sub-flow ▸','btn');b.style.marginTop='10px';b.onclick=function(){openSub(id);showDetail(id);};D.appendChild(b);}
  var dl=h('dl');function row(k,v){if(v==null||v==='')return;dl.appendChild(h('dt',k));var dd=h('dd');if(typeof v==='string')dd.textContent=v;else dd.appendChild(v);dl.appendChild(dd);}
  row('description',n.description);row('id',h('code',n.id));if(n.source)row('source',h('code',n.source.file+(n.source.line?':'+n.source.line:'')));
  if(n.parent)row('part of',(function(){var a=h('span',byId[n.parent]?byId[n.parent].label:n.parent,'rel');a.onclick=function(){gotoNode(n.parent);};return a;})());
  if(n.props)Object.keys(n.props).forEach(function(k){if(k==='owner')return;var v=n.props[k];row(k,typeof v==='string'?v:JSON.stringify(v));});D.appendChild(dl);
  function group(title,list,dir,showKind){if(!list.length)return;D.appendChild(h('h2',title));list.forEach(function(e){var other=dir==='out'?e.to:e.from;var d=h('div');
    if(showKind)d.appendChild(h('span',(dir==='out'?e.kind+' → ':'← '+e.kind+' '),'muted'));var a=h('span',byId[other]?byId[other].label:other,'rel');a.onclick=function(){gotoNode(other);};d.appendChild(a);
    if(e.label)d.appendChild(h('span',' ('+e.label+')','muted'));if(e.confidence!=='declared')d.appendChild(h('span',' · '+e.confidence,'muted'));D.appendChild(d);});}
  var o=outE[id],i=inE[id],of=function(k){return o.filter(function(e){return e.kind===k;});};var FLOW=['transitions_to','invokes','triggers'];
  group('Who',of('performed_by'),'out');group('Needs (inputs)',of('reads'),'out');group('Produces (outputs)',of('writes'),'out');group('Uses',of('uses'),'out');
  group('Comes from',i.filter(function(e){return FLOW.indexOf(e.kind)>=0;}),'in');group('Goes to',o.filter(function(e){return FLOW.indexOf(e.kind)>=0;}),'out');
  group('Constrained by',i.filter(function(e){return e.kind==='constrains';}),'in');
  group('Relations',o.filter(function(e){return ['performed_by','reads','writes','uses'].concat(FLOW).indexOf(e.kind)<0;}),'out',true);
  group('Referenced by',i.filter(function(e){return FLOW.concat(['constrains']).indexOf(e.kind)<0;}),'in',true);
  var fs=LINT.findings.filter(function(f){return f.nodes.indexOf(id)>=0;});if(fs.length){D.appendChild(h('h2','Findings'));fs.forEach(function(f){D.appendChild(h('div',f.message,'f '+f.severity));});}}

$('fcount').textContent='('+LINT.findings.length+')';
LINT.findings.forEach(function(f){var d=h('div',null,'f '+f.severity);d.appendChild(h('div',f.rule,'r'));d.appendChild(h('div',f.message));if(f.nodes.length)d.onclick=function(){gotoNode(f.nodes[0]);};$('findings').appendChild(d);});
renderSM();applyVp();requestAnimationFrame(fit);window.addEventListener('resize',fit);
window.__harnessGraph={select:select,gotoNode:gotoNode,openSub:openSub,setView:setView,data:DATA,state:function(){return {view:view,wf:wfIdx,sel:sel};}};
})();
</script>
</body>
</html>
`;
}
