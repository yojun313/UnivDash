// 탭을 새 창(팝업)으로 띄운 경우 (/?solo=term|pty|file …): 그 탭 하나만 보이는 창.
// 열린 탭 · 분할 · 탐색기 상태는 이 창에만 (sessionStorage) 두어 메인 창의 탭 배치를 건드리지 않는다. 테마 · 설정 등은 같이 쓴다.
(function(){try{var q=new URLSearchParams(location.search),solo=q.get('solo');if(!solo||location.pathname!=='/')return;
var d=document.documentElement;d.classList.add('ws-solo');
var ISO=/^univdash-(term-tabs|ws-(tab-order|layout|groups|split|side-|pty-open|file-open|mode)|pty-(tabs|active)|last-window|sidebar-collapsed|ws-(left|right)-collapsed|ex-(tabs|root|expanded|selected|tree-scroll|panel-open))/;
var P=Storage.prototype,g=P.getItem,st=P.setItem,rm=P.removeItem,ls=window.localStorage,ss=window.sessionStorage;
P.getItem=function(k){return this===ls&&ISO.test(k)?g.call(ss,'solo:'+k):g.call(this,k);};
P.setItem=function(k,v){return this===ls&&ISO.test(k)?st.call(ss,'solo:'+k,v):st.call(this,k,v);};
P.removeItem=function(k){return this===ls&&ISO.test(k)?rm.call(ss,'solo:'+k):rm.call(this,k);};
if(g.call(ss,'solo:seeded'))return;   // 새로고침: 이 창에서 바꾼 상태 그대로
var put=function(k,v){st.call(ss,'solo:univdash-'+k,JSON.stringify(v));};
put('ws-file-open',solo==='file');put('ws-pty-open',solo==='pty');put('ws-layout',null);put('ws-groups',{});
if(solo==='term'){var key=q.get('key')||'';put('term-tabs',[key]);put('last-window',key);put('ws-tab-order',['term:'+key]);}
else if(solo==='pty'){var id=q.get('id')||'';put('pty-tabs',[id]);put('pty-active',id);put('term-tabs',[]);put('ws-tab-order',['pty:'+id]);}
else if(solo==='file'){var path=q.get('path')||'',name=path.split('/').pop(),dot=name.lastIndexOf('.');put('ex-tabs',{tabs:[{path:path,name:name,ext:dot>0?name.slice(dot+1).toLowerCase():''}],active:path,view:{}});put('term-tabs',[]);put('ws-tab-order',['file:'+path]);}
st.call(ss,'solo:seeded','1');}catch(e){}})();
// 첫 페인트 전에 저장된 테마를 적용한다 (CSP 때문에 인라인 대신 파일로 둔다. defer 없이 head 에서 로드).
(function(){try{var d=document.documentElement,s=localStorage.getItem('univdash-theme-style'),m=localStorage.getItem('univdash-theme');if(s&&s!=='default')d.setAttribute('data-ui-theme',s);if(m!=='light'&&m!=='dark')m=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(m==='light')d.setAttribute('data-ui-theme-mode','light');d.style.colorScheme=m;}catch(e){}})();
// 접어 둔 사이드바(앱 메뉴 · 창 목록 · 파일)도 첫 페인트 전에 적용해 새로고침해도 깜빡이지 않게 한다.
// 기본 배치는 파일 탐색기 왼쪽 · 창(에이전트) 목록 오른쪽 (ws-swapped). 바꾸기 버튼으로 반대로 두면 저장된다.
// layout-v2: 예전 기본값(목록 왼쪽)으로 저장돼 있던 값은 한 번 지워 새 기본값을 따르게 한다.
(function(){try{var d=document.documentElement;[['sidebar-collapsed','sidebar-collapsed'],['ws-left-collapsed','ws-left-collapsed'],['ws-right-collapsed','ws-right-collapsed']].forEach(function(p){if(localStorage.getItem('univdash-'+p[0])==='true')d.classList.add(p[1]);});if(!localStorage.getItem('univdash-ws-layout-v2')){localStorage.removeItem('univdash-ws-swapped');localStorage.setItem('univdash-ws-layout-v2','1');}if(localStorage.getItem('univdash-ws-swapped')!=='false')d.classList.add('ws-swapped');}catch(e){}})();
