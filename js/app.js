/* Bobos — 셸 (키 확인 → 탭 전환 → 탭 코드 지연 로드)
 * - 키가 없거나 맞지 않으면 등록 화면(#gate)만 보이고, 탭 코드는 아예 불러오지 않는다.
 * - 탭 코드는 그 탭을 처음 열 때 불러온다: 링크 임포트 = js/linkimport.js, 트래킹 = js/tracker.js → js/pin.js, 효과음 = js/sfx-dict.js → js/sfx.js
 *   (트래킹은 열리는 순간 타임라인 선택을 자동으로 읽으므로, 실제로 탭을 열 때 시작하는 게 맞다)
 * - 다시 돌아온 탭엔 resize 이벤트를 보내 트래킹 미리보기 크기를 다시 잰다(숨겨져 있는 동안엔 크기가 0) */
(function () {
  'use strict';
  var L = window.BobosLicense;
  var $ = function (id) { return document.getElementById(id); };
  var TAB_KEY = 'bobos_tab';
  var SCRIPTS = { li: ['js/linkimport.js'], pin: ['js/tracker.js', 'js/pin.js'], sfx: ['js/sfx-dict.js', 'js/sfx.js'] };
  var loaded = { li: false, pin: false, sfx: false };
  var current = null;

  function loadScripts(list, done) {
    var i = 0;
    (function next() {
      if (i >= list.length) { if (done) { done(); } return; }
      var s = document.createElement('script');
      s.src = list[i++];
      s.onload = next;
      s.onerror = function () { alert('Bobos 파일을 불러오지 못했어요: ' + s.src + '\n설치 파일을 다시 실행해 주세요.'); };
      document.body.appendChild(s);
    }());
  }

  function activate(tab) {
    if (!SCRIPTS[tab]) { tab = 'li'; }
    current = tab;
    Object.keys(SCRIPTS).forEach(function (t) { $('tab-' + t).hidden = t !== tab; });
    try { window.dispatchEvent(new CustomEvent('bobos:tab', { detail: tab })); } catch (e) {}   // 효과음 탭: 다른 탭으로 가면 소리 끔
    $('log-btn').hidden = tab !== 'pin';
    Array.prototype.forEach.call(document.querySelectorAll('.bb-tab'), function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.className = 'bb-tab' + (on ? ' on' : '');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    try { localStorage.setItem(TAB_KEY, tab); } catch (e) {}
    if (!loaded[tab]) {
      loaded[tab] = true;
      loadScripts(SCRIPTS[tab]);
    } else {
      setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 0);
    }
  }

  // 링크 임포트: 작업·검색 결과가 없을 때만 빈 화면 안내를 보인다 (원래 코드는 건드리지 않고 바깥에서 지켜봄)
  function watchLiEmpty() {
    var empty = $('liEmpty'), jobs = $('jobs'), wrap = $('searchWrap');
    function upd() { empty.hidden = jobs.children.length > 0 || wrap.classList.contains('on'); }
    try { new MutationObserver(upd).observe($('content'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); } catch (e) {}
    upd();
  }

  function startApp(lic) {
    $('gate').hidden = true;
    $('app').hidden = false;
    var owner = $('owner');
    owner.textContent = (lic.n || '') + '님 전용';
    owner.title = '키 정보 보기';
    bindKeyPop(lic);
    Array.prototype.forEach.call(document.querySelectorAll('.bb-tab'), function (b) {
      b.addEventListener('click', function () { if (b.getAttribute('data-tab') !== current) { activate(b.getAttribute('data-tab')); } });
    });
    watchLiEmpty();
    var saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch (e) {}
    activate(saved || 'li');
  }

  // 키 정보 창 + 키 삭제 (PC를 넘길 때). 삭제는 두 번 눌러야 실행 — 첫 번째는 버튼이 빨갛게 "한 번 더 누르면 삭제"로 바뀜
  function bindKeyPop(lic) {
    var pop = $('keyPop'), del = $('kp-delete'), armTimer = null;
    $('kp-name').textContent = lic.n || '-';
    $('kp-device').textContent = lic.d || '-';
    $('kp-date').textContent = lic.i || '-';
    function disarm() { clearTimeout(armTimer); del.className = 'bb-danger'; del.textContent = '키 삭제'; }
    function close() { pop.hidden = true; disarm(); }
    $('owner').addEventListener('click', function (e) { e.stopPropagation(); if (pop.hidden) { pop.hidden = false; } else { close(); } });
    $('kp-close').addEventListener('click', close);
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { if (!pop.hidden) { close(); } });
    del.addEventListener('click', function () {
      if (del.className.indexOf('armed') < 0) {
        del.className = 'bb-danger armed';
        del.textContent = '한 번 더 누르면 삭제';
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      L.clear();          // 키 파일 + 패널 저장 공간 백업 둘 다
      location.reload();  // 탭 코드까지 깨끗하게 다시 시작 → 키 등록 화면
    });
  }

  function copyText(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  function showGate(reason) {
    $('app').hidden = true;
    $('gate').hidden = false;
    var msg = $('gate-msg');
    function say(text, cls) { msg.textContent = text; msg.className = 'bb-gate-msg' + (cls ? ' ' + cls : ''); }
    var dev = L ? L.deviceCode() : '';
    $('gate-device').textContent = dev || '(확인 불가)';
    if (reason && reason !== 'none') { say(L ? L.message(reason) : 'license.js를 불러오지 못했어요.', 'err'); }

    $('gate-copy').addEventListener('click', function () {
      if (!dev) { return; }
      say(copyText(dev) ? '기기 코드를 복사했어요. 카톡 등에 붙여 넣어 보내 주세요.' : '복사가 안 되면 코드를 드래그해서 복사해 주세요.', 'ok');
    });
    $('gate-ok').addEventListener('click', function () {
      var key = $('gate-key').value;
      if (!key.trim()) { say('받은 키를 위 칸에 붙여 넣어 주세요.', 'err'); return; }
      var r = L.activate(key);
      if (!r.ok) { say(L.message(r.reason), 'err'); return; }
      startApp(r.lic);
    });
  }

  if (!L) { showGate('node'); return; }
  var r = L.check();
  if (r.ok) { startApp(r.lic); } else { showGate(r.reason); }
}());
