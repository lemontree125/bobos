/* Bobos · 효과음 탭 (1.1.0)
 * - 효과음 폴더를 추가하면 하위 폴더까지 읽어 목록을 만든다(wav·mp3·aif·aiff·m4a·aac). 목록은 저장해 두고 다음에 열 때 바로 보여 준 뒤 뒤에서 다시 읽는다.
 * - 파일·폴더를 패널로 끌어다 놓기: 폴더는 그대로 추가, 파일은 「문서/Bobos/내 효과음」에 복사해서 추가 ("업로드")
 * - 검색: sfx-dict.js (의성어 사전 + 파일명·폴더명 + 태그)
 * - 클릭 = 무한 반복 재생(같은 줄 다시 클릭 = 정지) · 더블클릭 = 재생 헤드 위치의 빈 오디오 트랙에 삽입(host.jsx SFX_insert)
 *   더블클릭은 클릭 두 번이라 e.detail로 구분: 첫 클릭(detail 1)에서 재생, 두 번째(detail 2)에서 삽입
 * - 키보드: ↑↓ 이동하며 미리듣기 · Enter 삽입 · Space 재생/정지 · Esc 정지
 * - 재생 못 하는 형식(AIFF 등 — Chromium은 AIFF를 못 읽음)은 ffmpeg로 임시 WAV를 만들어 재생
 * - 즐겨찾기(1.2.1): 줄마다 ☆ 버튼, 빠른 검색 줄 맨 앞 [★ 즐겨찾기] = 즐겨찾기만 보기(검색어와 같이 써도 됨). 저장: settings.favs { 키: 넣은 시각 }
 * - 태그·즐겨찾기 키(1.2.1~) = 「추가한 폴더 이름/그 안의 경로」 (예: 효과음팩/Cartoon/boing.wav). 같은 팩을 다른 PC·다른 드라이브에 풀어도 그대로 맞는다.
 *   (예전 1.1.x 태그는 절대 경로 키 → 켤 때 한 번 자동으로 옮김. 이름이 같은 폴더 두 개를 추가하면 키가 겹칠 수 있음)
 * - 설정·태그: %APPDATA%\Bobos\sfx-settings.json · 목록: sfx-index.json (맥은 ~/Library/Application Support/Bobos) */
(function () {
  'use strict';
  var nodeRequire = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var $ = function (id) { return document.getElementById(id); };
  var S = window.SfxSearch;
  var el = {
    q: $('sfxQ'), clear: $('sfxClear'), chips: $('sfxChips'), flist: $('sfxFolderList'), add: $('sfxAdd'), addFile: $('sfxAddFile'), rescan: $('sfxRescan'),
    list: $('sfxList'), empty: $('sfxEmpty'), status: $('sfxStatus'), vol: $('sfxVol'), drop: $('sfxDrop'), pane: $('tab-sfx')
  };
  var AUDIO_RE = /\.(wav|mp3|aif|aiff|m4a|aac)$/i;
  var PAGE = 200;

  function setStatus(msg, tone) { el.status.textContent = msg; el.status.className = tone ? 'sfx-' + tone : ''; }
  if (!nodeRequire) { setStatus('Node를 쓸 수 없는 환경이에요 (Premiere 2022 이상 필요).', 'err'); return; }
  var fs = nodeRequire('fs'), path = nodeRequire('path'), os = nodeRequire('os'), cp = nodeRequire('child_process'), crypto = nodeRequire('crypto');
  var IS_WIN = process.platform === 'win32';

  // ---- 저장 위치
  function winEnv(name) {
    try { var o = cp.execSync('cmd /d /u /c echo %' + name + '%', { encoding: 'utf16le', windowsHide: true, timeout: 5000 }).trim(); if (o && o !== '%' + name + '%') { return o; } } catch (e) {}
    return process.env[name] || '';
  }
  var DATA = IS_WIN ? path.join(winEnv('APPDATA'), 'Bobos') : path.join(os.homedir(), 'Library', 'Application Support', 'Bobos');
  var LIB = path.join(os.homedir(), 'Documents', 'Bobos', '내 효과음');
  var SETTINGS_F = path.join(DATA, 'sfx-settings.json'), INDEX_F = path.join(DATA, 'sfx-index.json');
  function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } }
  function writeJson(f, v) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v), 'utf8'); } catch (e) {} }

  var settings = readJson(SETTINGS_F, {});
  settings.folders = settings.folders || [];
  settings.tags = settings.tags || {};
  settings.favs = settings.favs || {};
  // 1.1.x의 절대 경로 키 → 「폴더 이름/상대 경로」 키로 한 번 옮긴다
  function keyFor(root, rel) { return (path.basename(root) + '/' + rel).replace(/\\/g, '/'); }
  (function migrateKeys() {
    var ABS = /^([a-zA-Z]:[\\\/]|[\\\/])/, changed = false;
    function under(abs) {
      var a = abs.replace(/\\/g, '/'), al = a.toLowerCase();
      for (var i = 0; i < settings.folders.length; i++) {
        var r = settings.folders[i].replace(/\\/g, '/').replace(/\/+$/, '');
        if (al.indexOf(r.toLowerCase() + '/') === 0) { return keyFor(settings.folders[i], a.slice(r.length + 1)); }
      }
      return null;
    }
    ['tags', 'favs'].forEach(function (bag) {
      Object.keys(settings[bag]).forEach(function (k) {
        if (!ABS.test(k)) { return; }
        var nk = under(k);
        if (nk) { if (!(nk in settings[bag])) { settings[bag][nk] = settings[bag][k]; } delete settings[bag][k]; changed = true; }
      });
    });
    if (changed) { writeJson(SETTINGS_F, settings); }
  }());
  if (typeof settings.vol !== 'number') { settings.vol = 80; }
  function saveSettings() { writeJson(SETTINGS_F, settings); }
  var index = readJson(INDEX_F, { v: 1, roots: {} });
  if (!index.roots) { index.roots = {}; }

  // ---- 목록 만들기
  var files = [];            // { abs, rel, root, name, ext, hay, nameHay, dur }
  function makeFile(root, rel) {
    var name = path.basename(rel), ext = path.extname(name).slice(1).toLowerCase();
    var folderLabel = path.basename(root) + '/' + rel;   // 최상위 폴더 이름도 검색에 넣는다 ("Cartoon SFX Pack")
    return { abs: path.join(root, rel), key: keyFor(root, rel), rel: rel, root: root, name: name.replace(/\.[^.]+$/, ''), ext: ext, hay: S.haystack(folderLabel), nameHay: S.haystack(name), dur: null };
  }
  function rebuild() {
    files = [];
    settings.folders.forEach(function (root) {
      var r = index.roots[root];
      if (r && r.files) { r.files.forEach(function (rel) { files.push(makeFile(root, rel)); }); }
    });
  }

  var scanning = 0;
  function scanFolder(root) {
    var out = [], count = 0;
    function walk(dir, depth) {
      if (depth > 12) { return Promise.resolve(); }
      return fs.promises.readdir(dir, { withFileTypes: true }).then(function (ents) {
        var subs = [];
        ents.forEach(function (d) {
          var n = d.name;
          if (n.charAt(0) === '.' || n === '__MACOSX' || n === '$RECYCLE.BIN') { return; }
          var full = path.join(dir, n);
          if (d.isDirectory()) { subs.push(full); }
          else if (AUDIO_RE.test(n)) { out.push(path.relative(root, full)); count++; }
        });
        if (count % 300 < 20) { setStatus('폴더 읽는 중… ' + count.toLocaleString() + '개', 'busy'); }
        return subs.reduce(function (p, s) { return p.then(function () { return walk(s, depth + 1); }); }, Promise.resolve());
      }, function () { /* 권한 없는 폴더는 건너뜀 */ });
    }
    return walk(root, 0).then(function () {
      out.sort();
      index.roots[root] = { at: Date.now(), files: out };
      return out.length;
    });
  }
  function scanAll(onlyRoot) {
    var roots = onlyRoot ? [onlyRoot] : settings.folders.slice();
    if (!roots.length) { refresh(); return Promise.resolve(); }
    scanning++;
    setStatus('폴더 읽는 중…', 'busy');
    return roots.reduce(function (p, r) {
      return p.then(function () {
        if (!fs.existsSync(r)) { index.roots[r] = { at: Date.now(), files: [], missing: true }; return; }
        return scanFolder(r);
      });
    }, Promise.resolve()).then(function () {
      // 목록에서 빠진 폴더 정리
      Object.keys(index.roots).forEach(function (k) { if (settings.folders.indexOf(k) < 0) { delete index.roots[k]; } });
      writeJson(INDEX_F, index);
      scanning--;
      rebuild(); renderFolders(); refresh();
    });
  }

  // ---- 폴더 관리
  function addFolder(dir) {
    if (!dir) { return; }
    dir = path.resolve(dir);
    try { if (!fs.statSync(dir).isDirectory()) { return; } } catch (e) { setStatus('폴더를 열 수 없어요: ' + dir, 'err'); return; }
    if (settings.folders.some(function (f) { return f.toLowerCase() === dir.toLowerCase(); })) { scanAll(dir); return; }
    settings.folders.push(dir); saveSettings(); renderFolders();
    scanAll(dir).then(function () { setStatus('「' + path.basename(dir) + '」 추가 — 효과음 ' + ((index.roots[dir] || {}).files || []).length.toLocaleString() + '개', 'ok'); });
  }
  function removeFolder(dir) {
    settings.folders = settings.folders.filter(function (f) { return f !== dir; });
    delete index.roots[dir];
    saveSettings(); writeJson(INDEX_F, index);
    rebuild(); renderFolders(); refresh();
    setStatus('「' + path.basename(dir) + '」를 목록에서 뺐어요 (파일은 그대로예요)');
  }
  function renderFolders() {
    el.flist.innerHTML = '';
    settings.folders.forEach(function (dir) {
      var r = index.roots[dir] || {}, chip = document.createElement('span');
      chip.className = 'sfx-fchip' + (r.missing ? ' missing' : '');
      chip.title = dir + (r.missing ? '\n(폴더를 찾을 수 없어요)' : '\n효과음 ' + ((r.files || []).length) + '개');
      var t = document.createElement('span'); t.textContent = path.basename(dir) || dir;
      var x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.title = '목록에서 빼기 (파일은 지우지 않아요)';
      x.addEventListener('click', function (e) { e.stopPropagation(); removeFolder(dir); });
      chip.appendChild(t); chip.appendChild(x);
      el.flist.appendChild(chip);
    });
  }
  function pickFolder() {
    var r = null;
    try { r = window.cep.fs.showOpenDialog(false, true, '효과음 폴더 선택', ''); } catch (e) {}
    if (r && r.data && r.data.length) { addFolder(r.data[0]); return; }
    if (!(window.cep && window.cep.fs)) { var p = window.prompt('효과음 폴더 경로'); if (p) { addFolder(p); } }
  }
  // 파일 "업로드" = 내 효과음 폴더로 복사
  function importFiles(list) {
    var copied = 0;
    try { fs.mkdirSync(LIB, { recursive: true }); } catch (e) {}
    list.forEach(function (src) {
      if (!AUDIO_RE.test(src)) { return; }
      var dst = path.join(LIB, path.basename(src)), n = 1;
      while (fs.existsSync(dst)) { dst = path.join(LIB, path.basename(src).replace(/(\.[^.]+)$/, ' (' + (++n) + ')$1')); }
      try { fs.copyFileSync(src, dst); copied++; } catch (e2) {}
    });
    if (!copied) { setStatus('넣을 수 있는 효과음 파일이 없어요 (wav·mp3·aif·m4a)', 'err'); return; }
    if (settings.folders.indexOf(LIB) < 0) { settings.folders.push(LIB); saveSettings(); }
    scanAll(LIB).then(function () { setStatus('「내 효과음」에 ' + copied + '개 넣었어요', 'ok'); });
  }
  function pickFiles() {
    var r = null;
    try { r = window.cep.fs.showOpenDialog(true, false, '효과음 파일 선택 (내 효과음 폴더로 복사돼요)', '', ['wav', 'mp3', 'aif', 'aiff', 'm4a', 'aac']); } catch (e) {}
    if (r && r.data && r.data.length) { importFiles(r.data); }
  }

  // ---- 검색 + 목록 그리기
  var results = [], shown = 0, sel = -1, query = '', favOnly = false;
  function tagsOf(f) { return settings.tags[f.key] || ''; }
  function isFav(f) { return !!settings.favs[f.key]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function highlight(name, words) {
    var html = esc(name);
    (words || []).forEach(function (w) {
      if (!w || w.length < 1) { return; }
      var re = new RegExp('(' + esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ _\\-]?') + ')', 'ig');
      html = html.replace(re, '<mark>$1</mark>');
    });
    return html.replace(/<mark>([^<]*)<mark>([^<]*)<\/mark>([^<]*)<\/mark>/g, '<mark>$1$2$3</mark>');
  }
  function fmtDur(d) { if (!(d > 0)) { return ''; } return d < 60 ? d.toFixed(1) + '초' : Math.floor(d / 60) + ':' + ('0' + Math.floor(d % 60)).slice(-2); }
  function subText(f) {
    var dir = path.dirname(f.rel);
    var where = path.basename(f.root) + (dir && dir !== '.' && dir !== '/' ? ' / ' + dir.split(/[\\\/]/).join(' / ') : '');
    return where + ' · ' + f.ext + (f.dur ? ' · ' + fmtDur(f.dur) : '');
  }

  var lastQuery = null;
  function refresh() {
    query = el.q.value.trim();
    // 검색어가 바뀌면(빠른 검색 버튼 [공포] → [두둥], 직접 입력, 지우기) 듣던 소리는 끈다 (1.1.1)
    if (lastQuery !== null && query !== lastQuery) { stop(); }
    lastQuery = query;
    results = S.search(favOnly ? files.filter(isFav) : files, query, tagsOf);
    if (favOnly && !query) { results.sort(function (a, b) { return (settings.favs[b.f.key] || 0) - (settings.favs[a.f.key] || 0); }); }   // 즐겨찾기만 볼 땐 최근에 넣은 것부터
    shown = 0; sel = results.length ? 0 : -1;
    el.list.innerHTML = '';
    renderMore();
    Array.prototype.forEach.call(el.chips.children, function (c) { if (c !== favChip) { c.className = 'sfx-chip' + (c.textContent === query ? ' on' : ''); } });
    updateFavChip();
    el.clear.hidden = !query;
    // 빈 화면 안내
    if (!settings.folders.length) {
      el.empty.innerHTML = '<b>효과음 폴더를 추가하세요</b>위의 <b>+ 폴더</b>를 누르거나, 효과음 폴더·파일을 이 패널로 끌어다 놓으세요.<br>하위 폴더까지 전부 읽어요.';
      el.empty.hidden = false;
    } else if (!files.length) {
      el.empty.innerHTML = scanning ? '<b>폴더 읽는 중…</b>' : '<b>효과음 파일이 없어요</b>추가한 폴더에 wav·mp3·aif·m4a 파일이 있는지 확인하세요.';
      el.empty.hidden = false;
    } else if (favOnly && !results.length) {
      el.empty.innerHTML = query
        ? '<b>즐겨찾기 중엔 「' + esc(query) + '」에 맞는 효과음이 없어요</b>위의 <b>★ 즐겨찾기</b>를 끄면 전체에서 찾아요.'
        : '<b>즐겨찾기가 아직 없어요</b>자주 쓰는 효과음 줄의 <b>☆</b>를 누르면 여기에 모여요.';
      el.empty.hidden = false;
    } else if (!results.length) {
      el.empty.innerHTML = '<b>「' + esc(query) + '」에 맞는 효과음이 없어요</b>다른 말로 찾아보세요 (예: 슉 → 휙, whoosh).<br>찾은 효과음에 <b>#</b>으로 태그를 달아 두면 다음부터 바로 나와요.';
      el.empty.hidden = false;
    } else { el.empty.hidden = true; }
    if (!scanning) {
      // 한/영 자판 실수로 바꿔 찾은 말이 있으면 알려 준다 (Eldyd → 띠용)
      var alts = query.split(/\s+/).map(function (t) { var a = S.altTerm(t); return a && /^[a-z]+$/i.test(t) ? t + ' → ' + a : null; }).filter(Boolean);
      setStatus(files.length ? ((alts.length ? '한/영 바꿔 찾음: ' + alts.join(', ') + ' · ' : '') + (favOnly ? '즐겨찾기 ' + Object.keys(settings.favs).length + '개' : '효과음 ' + files.length.toLocaleString() + '개') + (query ? ' · 결과 ' + results.length.toLocaleString() + '개' : '') + ' · 클릭 = 반복 재생, 더블클릭 = 타임라인에 넣기') : '');
    }
  }
  function renderMore() {
    var old = el.list.querySelector('.sfx-more'); if (old) { el.list.removeChild(old); }
    var end = Math.min(results.length, shown + PAGE), frag = document.createDocumentFragment();
    for (var i = shown; i < end; i++) { frag.appendChild(makeRow(i)); }
    shown = end;
    el.list.appendChild(frag);
    if (shown < results.length) {
      var b = document.createElement('button'); b.className = 'sfx-more'; b.type = 'button';
      b.textContent = '더 보기 (' + shown.toLocaleString() + ' / ' + results.length.toLocaleString() + ')';
      b.addEventListener('click', renderMore);
      el.list.appendChild(b);
    }
    markRows();
  }
  function makeRow(i) {
    var r = results[i], f = r.f, row = document.createElement('div');
    row.className = 'sfx-row'; row.setAttribute('data-i', i);
    row.innerHTML = '<span class="sfx-ico"></span>' +
      '<div class="sfx-main"><div class="sfx-name">' + highlight(f.name, r.words) + '</div><div class="sfx-sub"></div></div>' +
      '<span class="sfx-tags"></span><button type="button" class="sfx-favbtn" title="즐겨찾기"></button><button type="button" class="sfx-tagbtn" title="태그 달기 — 이 효과음을 이 단어로 바로 찾게 해요">#</button>' +
      '<div class="sfx-prog"></div>';
    row.querySelector('.sfx-sub').textContent = subText(f);
    fillTags(row, f); fillFav(row, f);
    return row;
  }
  function fillTags(row, f) {
    var t = tagsOf(f), box = row.querySelector('.sfx-tags');
    box.textContent = t ? t.split(' ').map(function (x) { return '#' + x; }).join(' ') : '';
  }
  function fillFav(row, f) {
    var on = isFav(f), b = row.querySelector('.sfx-favbtn');
    row.classList.toggle('fav', on);
    b.textContent = on ? '★' : '☆';
    b.title = on ? '즐겨찾기에서 빼기' : '즐겨찾기에 넣기';
  }
  function toggleFav(i) {
    var f = results[i].f, row = rowEl(i);
    if (isFav(f)) { delete settings.favs[f.key]; } else { settings.favs[f.key] = Date.now(); }
    saveSettings();
    if (row) { fillFav(row, f); }
    updateFavChip();
    setStatus(isFav(f) ? '★ 즐겨찾기에 넣었어요 — ' + f.name : '즐겨찾기에서 뺐어요 — ' + f.name, 'ok');
    // 즐겨찾기만 보는 중에 뺀 줄은 바로 사라지게 하지 않는다 (실수로 눌렀을 때 다시 누를 수 있게) — 다음 검색·새로고침 때 빠짐
  }
  function rowEl(i) { return el.list.querySelector('.sfx-row[data-i="' + i + '"]'); }
  function markRows() {
    Array.prototype.forEach.call(el.list.querySelectorAll('.sfx-row'), function (row) {
      var i = +row.getAttribute('data-i'), f = results[i] && results[i].f;
      row.classList.toggle('sel', i === sel);
      row.classList.toggle('playing', !!(f && playing && f.abs === playing.abs));
    });
  }
  function select(i, scroll) {
    if (i < 0 || i >= results.length) { return; }
    while (i >= shown) { renderMore(); }
    sel = i; markRows();
    var row = rowEl(i);
    if (scroll && row) { row.scrollIntoView({ block: 'nearest' }); }
  }

  // ---- 재생 (무한 반복)
  var audio = new Audio(); audio.loop = true; audio.volume = settings.vol / 100;
  var playing = null, raf = 0;
  function fileUrl(p) { return 'file:///' + encodeURI(p.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F'); }
  function stop() {
    audio.pause(); audio.removeAttribute('src'); try { audio.load(); } catch (e) {}
    playing = null; cancelAnimationFrame(raf);
    Array.prototype.forEach.call(el.list.querySelectorAll('.sfx-prog'), function (p) { p.style.width = '0'; });
    markRows();
  }
  function play(f) {
    stop();
    playing = { abs: f.abs, f: f, tried: false };
    audio.src = fileUrl(f.abs);
    audio.play().catch(function () {});
    markRows(); tick();
  }
  function tick() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () {
      if (!playing) { return; }
      var i = -1;
      for (var k = 0; k < shown; k++) { if (results[k].f.abs === playing.abs) { i = k; break; } }
      var row = i >= 0 ? rowEl(i) : null;
      if (row && audio.duration > 0) { row.querySelector('.sfx-prog').style.width = (audio.currentTime / audio.duration * 100) + '%'; }
      tick();
    });
  }
  audio.addEventListener('loadedmetadata', function () {
    if (!playing || !(audio.duration > 0) || !isFinite(audio.duration)) { return; }
    var f = playing.f;
    if (!f.dur) {
      f.dur = audio.duration;
      for (var k = 0; k < shown; k++) { if (results[k].f === f) { var r = rowEl(k); if (r) { r.querySelector('.sfx-sub').textContent = subText(f); } } }
    }
  });
  // Chromium이 못 읽는 형식(AIFF 등) → ffmpeg로 임시 WAV
  var FFMPEG;
  function findFfmpeg() {
    if (FFMPEG !== undefined) { return FFMPEG; }
    FFMPEG = null;
    try { var o = cp.execSync(IS_WIN ? 'chcp 65001 >nul & where ffmpeg' : 'command -v ffmpeg', { encoding: 'utf8', windowsHide: true, timeout: 5000 }).split(/\r?\n/)[0].trim(); if (o && fs.existsSync(o)) { FFMPEG = o; return o; } } catch (e) {}
    var c = IS_WIN ? [path.join(winEnv('LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')] : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(os.homedir(), '.local', 'bin', 'ffmpeg')];
    for (var i = 0; i < c.length; i++) { if (fs.existsSync(c[i])) { FFMPEG = c[i]; break; } }
    return FFMPEG;
  }
  audio.addEventListener('error', function () {
    if (!playing || !audio.getAttribute('src')) { return; }
    var p = playing;
    if (p.tried) { setStatus('이 파일은 미리듣기를 할 수 없어요: ' + p.f.name, 'err'); return; }
    p.tried = true;
    var ff = findFfmpeg();
    if (!ff) { setStatus('이 형식(' + p.f.ext + ')은 미리듣기에 ffmpeg가 필요해요 — ffmpeg를 설치한 뒤 Premiere를 다시 켜 주세요', 'err'); return; }
    var dir = path.join(os.tmpdir(), 'bobos-sfx'), out = path.join(dir, crypto.createHash('sha1').update(p.abs).digest('hex').slice(0, 16) + '.wav');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    var go = function () { if (playing === p) { audio.src = fileUrl(out); audio.play().catch(function () {}); } };
    if (fs.existsSync(out)) { go(); return; }
    setStatus('미리듣기용으로 변환 중…', 'busy');
    cp.execFile(ff, ['-v', 'error', '-y', '-i', p.abs, '-c:a', 'pcm_s16le', out], { windowsHide: true }, function (err) {
      if (err || !fs.existsSync(out)) { setStatus('이 파일은 미리듣기를 할 수 없어요: ' + p.f.name, 'err'); return; }
      setStatus(''); go();
    });
  });
  el.vol.value = settings.vol;
  el.vol.addEventListener('input', function () { settings.vol = +el.vol.value; audio.volume = settings.vol / 100; });
  el.vol.addEventListener('change', saveSettings);

  // ---- 타임라인에 넣기
  var inserting = false;
  function insert(i) {
    var r = results[i]; if (!r || inserting) { return; }
    var f = r.f;
    inserting = true;
    stop();
    setStatus('타임라인에 넣는 중… ' + f.name, 'busy');
    var enc = encodeURIComponent(f.abs.replace(/\\/g, '/'));
    window.__adobe_cep__.evalScript('SFX_insert("' + enc + '")', function (raw) {
      inserting = false;
      var res = null; try { res = JSON.parse(raw); } catch (e) {}
      if (!res) { setStatus('Premiere 응답을 읽지 못했어요: ' + String(raw).slice(0, 80) + ' — Premiere를 완전히 껐다 켜 보세요', 'err'); return; }
      if (!res.ok) { setStatus(res.error, 'err'); return; }
      setStatus('✔ A' + res.track + (res.added ? '(새 트랙)' : '') + '에 넣었어요 — ' + f.name, 'ok');
    });
  }

  // ---- 태그
  function editTags(i) {
    var row = rowEl(i), f = results[i].f;
    var old = el.list.querySelector('.sfx-tagedit'); if (old) { old.parentNode.removeChild(old); }
    var box = document.createElement('div'); box.className = 'sfx-tagedit';
    var cur = tagsOf(f), q = query && !(' ' + cur + ' ').match(new RegExp(' ' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ')) ? query : '';
    box.innerHTML = '<input type="text" spellcheck="false" placeholder="태그 (띄어쓰기로 구분, 예: 띠용 귀여운)"><button type="button" class="primary">저장</button><button type="button">취소</button>';
    var inp = box.querySelector('input');
    inp.value = (cur + (q ? ' ' + q : '')).trim();
    row.parentNode.insertBefore(box, row.nextSibling);
    inp.focus(); inp.select();
    function save() {
      var v = inp.value.toLowerCase().replace(/[#,]/g, ' ').split(/\s+/).filter(Boolean);
      v = v.filter(function (x, k) { return v.indexOf(x) === k; });
      if (v.length) { settings.tags[f.key] = v.join(' '); } else { delete settings.tags[f.key]; }
      saveSettings(); fillTags(row, f); box.parentNode.removeChild(box);
      setStatus(v.length ? '태그 저장: ' + v.map(function (x) { return '#' + x; }).join(' ') : '태그를 지웠어요', 'ok');
    }
    box.querySelectorAll('button')[0].addEventListener('click', save);
    box.querySelectorAll('button')[1].addEventListener('click', function () { box.parentNode.removeChild(box); });
    inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { save(); } else if (e.key === 'Escape') { box.parentNode.removeChild(box); } });
  }

  // ---- 이벤트
  el.list.addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.sfx-row') : null;
    if (!row) { return; }
    var i = +row.getAttribute('data-i');
    if (e.target.classList.contains('sfx-tagbtn')) { editTags(i); return; }
    if (e.target.classList.contains('sfx-favbtn')) { toggleFav(i); return; }
    select(i);
    if (e.detail >= 2) { insert(i); return; }                 // 더블클릭(두 번째 클릭) → 넣기
    var f = results[i].f;
    if (playing && playing.abs === f.abs) { stop(); } else { play(f); }
  });
  var tmr = 0;
  el.q.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(refresh, 120); });
  el.q.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); el.q.blur(); el.list.focus(); select(Math.max(0, sel), true); if (results[sel]) { play(results[sel].f); } }
    else if (e.key === 'Enter') { clearTimeout(tmr); refresh(); }
    else if (e.key === 'Escape') { el.q.value = ''; refresh(); }
  });
  el.clear.addEventListener('click', function () { el.q.value = ''; refresh(); el.q.focus(); });
  var favChip = document.createElement('span');
  favChip.title = '즐겨찾기만 보기 (검색어와 같이 써도 돼요)';
  favChip.addEventListener('click', function () { favOnly = !favOnly; settings.favOnly = favOnly; saveSettings(); stop(); refresh(); });
  el.chips.appendChild(favChip);
  function updateFavChip() {
    var n = Object.keys(settings.favs).length;
    favChip.className = 'sfx-chip sfx-favchip' + (favOnly ? ' on' : '');
    favChip.textContent = '★ 즐겨찾기' + (n ? ' ' + n : '');
  }
  favOnly = !!settings.favOnly;
  updateFavChip();
  S.CHIPS.forEach(function (c) {
    var b = document.createElement('span'); b.className = 'sfx-chip'; b.textContent = c;
    b.addEventListener('click', function () { el.q.value = el.q.value.trim() === c ? '' : c; refresh(); });
    el.chips.appendChild(b);
  });
  el.add.addEventListener('click', pickFolder);
  el.addFile.addEventListener('click', pickFiles);
  el.rescan.addEventListener('click', function () { scanAll(); });

  document.addEventListener('keydown', function (e) {
    if (el.pane.hidden) { return; }
    var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (typing) { return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var n = Math.min(results.length - 1, Math.max(0, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      select(n, true); if (results[n]) { play(results[n].f); }
    } else if (e.key === 'Enter') { if (sel >= 0) { e.preventDefault(); insert(sel); } }
    else if (e.key === ' ') { e.preventDefault(); if (playing) { stop(); } else if (results[sel]) { play(results[sel].f); } }
    else if (e.key === 'Escape') { stop(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { el.q.focus(); }   // 그냥 타이핑하면 검색창으로
  });
  // 다른 탭으로 가면 소리 끄기 (app.js가 보내는 이벤트)
  window.addEventListener('bobos:tab', function (e) { if (e.detail !== 'sfx') { stop(); } });
  /* Premiere 안에서 Bobos 패널이 가려질 때(같은 묶음의 다른 패널 탭으로 넘어감 · 패널 닫기 · 최소화)도 끈다 (1.1.1).
   * Premiere 버전마다 오는 신호가 달라서 세 가지를 다 건다:
   *   1) CEP 창 표시 이벤트  2) 페이지 visibilitychange  3) 화면 그리기(requestAnimationFrame)가 1.5초 넘게 멈춤 = 패널이 안 보임 */
  try {
    window.__adobe_cep__.addEventListener('com.adobe.csxs.events.WindowVisibilityChanged', function (ev) {
      var d = ev && typeof ev === 'object' ? ev.data : ev;
      if (String(d).indexOf('false') >= 0) { stop(); }
    });
  } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (document.hidden) { stop(); } });
  var lastFrame = Date.now();
  (function beat() { lastFrame = Date.now(); requestAnimationFrame(beat); }());
  setInterval(function () { if (playing && Date.now() - lastFrame > 1500) { stop(); } }, 500);

  // 끌어다 놓기: 폴더 = 추가, 파일 = 내 효과음으로 복사
  var dragDepth = 0;
  el.pane.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; el.drop.hidden = false; });
  el.pane.addEventListener('dragover', function (e) { e.preventDefault(); });
  el.pane.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
  el.pane.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; el.drop.hidden = true;
    var list = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []).map(function (f) { return f.path; }).filter(Boolean);
    if (!list.length) { setStatus('끌어다 놓기가 안 되는 환경이에요 — + 폴더 / + 파일 버튼을 써 주세요', 'err'); return; }
    var dirs = [], fl = [];
    list.forEach(function (p) { try { (fs.statSync(p).isDirectory() ? dirs : fl).push(p); } catch (e2) {} });
    dirs.forEach(addFolder);
    if (fl.length) { importFiles(fl); }
  });

  // ---- 시작: 저장된 목록으로 바로 보여 주고, 뒤에서 다시 읽기
  rebuild(); renderFolders(); refresh();
  if (settings.folders.length) { scanAll(); }
}());
