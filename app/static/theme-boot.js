// A tab opened in a new window (popup) (/?solo=term|pty|file …): a window that shows only that one tab.
// Open tabs, splits and explorer state are kept in this window only (sessionStorage) so the main window's tab layout is untouched. Theme, settings, etc. are shared.
(function(){try{var q=new URLSearchParams(location.search),solo=q.get('solo');if(!solo||location.pathname!=='/')return;
var d=document.documentElement;d.classList.add('ws-solo');
var ISO=/^univdash-(term-tabs|ws-(tab-order|layout|groups|split|side-|pty-open|file-open|mode)|pty-(tabs|active)|last-window|sidebar-collapsed|ws-(left|right)-collapsed|ex-(tabs|root|expanded|selected|tree-scroll|panel-open))/;
var P=Storage.prototype,g=P.getItem,st=P.setItem,rm=P.removeItem,ls=window.localStorage,ss=window.sessionStorage;
P.getItem=function(k){return this===ls&&ISO.test(k)?g.call(ss,'solo:'+k):g.call(this,k);};
P.setItem=function(k,v){return this===ls&&ISO.test(k)?st.call(ss,'solo:'+k,v):st.call(this,k,v);};
P.removeItem=function(k){return this===ls&&ISO.test(k)?rm.call(ss,'solo:'+k):rm.call(this,k);};
if(g.call(ss,'solo:seeded'))return;   // reload: keep the state changed in this window
var put=function(k,v){st.call(ss,'solo:univdash-'+k,JSON.stringify(v));};
put('ws-file-open',solo==='file');put('ws-pty-open',solo==='pty');put('ws-layout',null);put('ws-groups',{});
if(solo==='term'){var key=q.get('key')||'';put('term-tabs',[key]);put('last-window',key);put('ws-tab-order',['term:'+key]);}
else if(solo==='pty'){var id=q.get('id')||'';put('pty-tabs',[id]);put('pty-active',id);put('term-tabs',[]);put('ws-tab-order',['pty:'+id]);}
else if(solo==='file'){var path=q.get('path')||'',name=path.split('/').pop(),dot=name.lastIndexOf('.');put('ex-tabs',{tabs:[{path:path,name:name,ext:dot>0?name.slice(dot+1).toLowerCase():''}],active:path,view:{}});put('term-tabs',[]);put('ws-tab-order',['file:'+path]);}
st.call(ss,'solo:seeded','1');}catch(e){}})();
// Apply the saved theme before first paint (kept in a file instead of inline because of CSP; loaded in head without defer).
(function(){try{var d=document.documentElement,s=localStorage.getItem('univdash-theme-style'),m=localStorage.getItem('univdash-theme');if(s&&s!=='default')d.setAttribute('data-ui-theme',s);if(m!=='light'&&m!=='dark')m=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(m==='light')d.setAttribute('data-ui-theme-mode','light');d.style.colorScheme=m;if(localStorage.getItem('univdash-lite')==='1')d.setAttribute('data-ui-lite','');}catch(e){}})();
// Collapsed sidebars (app menu, window list, files) are also applied before first paint so a reload does not flicker.
// Default layout: file explorer on the left, window (agent) list on the right (ws-swapped). Swapping them with the swap button is saved.
// layout-v2: a value saved under the old default (list on the left) is cleared once so the new default applies.
(function(){try{var d=document.documentElement;[['sidebar-collapsed','sidebar-collapsed'],['ws-left-collapsed','ws-left-collapsed'],['ws-right-collapsed','ws-right-collapsed']].forEach(function(p){if(localStorage.getItem('univdash-'+p[0])==='true')d.classList.add(p[1]);});if(!localStorage.getItem('univdash-ws-layout-v2')){localStorage.removeItem('univdash-ws-swapped');localStorage.setItem('univdash-ws-layout-v2','1');}if(localStorage.getItem('univdash-ws-swapped')!=='false')d.classList.add('ws-swapped');}catch(e){}})();
