// 첫 페인트 전에 저장된 테마를 적용한다 (CSP 때문에 인라인 대신 파일로 둔다. defer 없이 head 에서 로드).
(function(){try{var d=document.documentElement,s=localStorage.getItem('univdash-theme-style'),m=localStorage.getItem('univdash-theme');if(s&&s!=='default')d.setAttribute('data-ui-theme',s);if(m!=='light'&&m!=='dark')m=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(m==='light')d.setAttribute('data-ui-theme-mode','light');d.style.colorScheme=m;}catch(e){}})();
// 접어 둔 사이드바(앱 메뉴 · 창 목록 · 파일)도 첫 페인트 전에 적용해 새로고침해도 깜빡이지 않게 한다.
// 기본 배치는 파일 탐색기 왼쪽 · 창(에이전트) 목록 오른쪽 (ws-swapped). 바꾸기 버튼으로 반대로 두면 저장된다.
// layout-v2: 예전 기본값(목록 왼쪽)으로 저장돼 있던 값은 한 번 지워 새 기본값을 따르게 한다.
(function(){try{var d=document.documentElement;[['sidebar-collapsed','sidebar-collapsed'],['ws-left-collapsed','ws-left-collapsed'],['ws-right-collapsed','ws-right-collapsed']].forEach(function(p){if(localStorage.getItem('univdash-'+p[0])==='true')d.classList.add(p[1]);});if(!localStorage.getItem('univdash-ws-layout-v2')){localStorage.removeItem('univdash-ws-swapped');localStorage.setItem('univdash-ws-layout-v2','1');}if(localStorage.getItem('univdash-ws-swapped')!=='false')d.classList.add('ws-swapped');}catch(e){}})();
