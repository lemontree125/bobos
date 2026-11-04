/* Bobos · 트래킹 탭 (구 Pin v1.1.0 main.js — Bobos에선 탭을 처음 열 때 app.js가 불러온다. 로그 위치만 Documents/Bobos로 바꿈)
 * Track — main.js (패널 컨트롤러)
 * 흐름(9/24 단계형 UI): 동작 선택 → ① 클립 불러오기(선택 클립·재생 헤드 읽기 → 소스 영상의 그 프레임을 ffmpeg로 뽑아 표시)
 *      → ② 핀 꽂기(박스 드래그) → ③ 실행(구간 디코드 → 양방향 추적 → Position 키프레임 기록)
 * 화면 갱신은 render() 한 곳: 단계 상태(todo/active/done)·단계별 안내(hint)·메시지(status가 단계를 골라 넣음)·버튼 활성.
 * 크기·회전은 두 점 방식(AE 트래커): 옵션을 켜면 두 번째 박스를 받아 쌍 추적 → Scale·Rotation 키도 기록.
 * 동작 「고정」(9/24): 대상 = 소스 영상 자신. 피사체가 재생 헤드 프레임의 자리에 머물도록 클립을 반대로 옮긴다(AE 모션 안정화) + 가장자리 채움 확대.
 * 소스 클립 속도: 9/24부터 지원(시퀀스 프레임 간격 = 1 / (미디어 fps × 속도)). 역재생·시간 리매핑은 미지원. */
(function () {
  'use strict';
  var nodeRequire = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var cs = window.__adobe_cep__;
  var $ = function (id) { return document.getElementById(id); };
  var ui = { img: $('frame'), cv: $('box'), run: $('run-btn'), refresh: $('refresh-btn'), load: $('load-btn'), stage: $('stage'), placeholder: $('placeholder'),
    fwd: $('fwd-only'), all: $('range-all'), ff: $('ff-btn'), scale: $('with-scale'), rot: $('with-rot'), follow: $('mode-follow'), lock: $('mode-lock'),
    fill: $('fill-edges'), fillRow: $('fill-row'), view: $('view'), zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoomReset: $('zoom-reset'),
    modeDesc: $('mode-desc'), howFollow: $('how-follow'), howLock: $('how-lock'), clips: $('clips'), cSrc: $('c-src'), cSpeed: $('c-speed'), cTgtRow: $('c-tgt-row'), cTgt: $('c-tgt'), tc: $('tc'),
    step: [null, $('step1'), $('step2'), $('step3')], msg: [null, $('msg1'), $('msg2'), $('msg3')] };

  var LONG = 640;        // 추적 해상도(긴 변)
  var R = 24;            // 프레임당 탐색 반경(px, 긴 변 LONG 기준 — 해상도가 다르면 비례, trackR)
  var LOCK_LONG = 1280;  // 고정 추적 해상도 상한(긴 변). 고정은 원본 전체를 보니 640이면 커서 같은 작은 피사체가 뭉개진다(9/24 실측: 같은 커서 핀 640은 0.8초에 놓침, 1280은 끝까지)
  var LOCK_BUDGET = 320e6;   // 고정 프레임 메모리 상한(바이트) — 긴 클립은 해상도를 LONG까지 낮춰 맞춘다(640 × 40초 × 30fps ≈ 옛 최대치)
  var MAX_SEC = 40;      // v1 구간 상한 — 메모리(프레임 230KB × fps × 초)
  var CHUNK = 300;       // evalScript 한 번에 보내는 키 수
  var MIN_DIST = 24;     // 두 점 최소 간격(추적 px) — 점당 ±0.5px 흔들림이 거리비로 번지므로 가까우면 배율 잡음(24px에서 ±4%/프레임, 평활화 전)
  var VIEW_MARGIN = 0.15;   // 보이는 영역 바깥 여유(한 변의 15%씩) — 피사체가 가장자리를 잠깐 넘나들어도 놓치지 않게, 패널에선 어둡게 표시
  var MAX_ZOOM = 3;      // 고정의 가장자리 채움 확대 상한(300%) — 피사체가 화면을 가로지르면 수십 배가 나온다. 넘으면 상한에서 자르고 상태줄에 알린다
  var HOST_REV = 5;      // jsx/host.jsx의 HOST_REV와 같아야 한다
  var SECOND_HINT = '둘째 핀: 같은 물체의 반대쪽 끝이나 옆에 붙은 물체처럼, 같이 움직이는 뚜렷한 곳에 꽂으세요(드래그).';

  var cp, fs, os, path;
  // box = 기준점(위치), box2 = 두 점 모드의 둘째 점, gray = 미리보기 프레임 흑백(품질 검사), msgs[1~3] = 단계별 메시지(없으면 안내문), busy = 읽기·실행 중
  var state = { ctx: null, media: null, W: 0, H: 0, box: null, box2: null, gray: null, tool: null, msgs: [null, null, null, null], busy: false, hostOk: false };
  var bound = false;   // 패널 이벤트를 이미 걸었나 (ffmpeg 설치 뒤 ready()가 다시 불린다)
  function twoPt() { return ui.scale.checked || ui.rot.checked; }
  function lockMode() { return ui.lock.checked; }
  function pinsDone() { return !!(state.box && (!twoPt() || state.box2)); }
  function phase() { return !state.media ? 1 : pinsDone() ? 3 : 2; }   // 지금 할 단계
  var center = function (b) { return [b.x + b.w / 2, b.y + b.h / 2]; };

  // ---- 화면 갱신: 상태 → 단계 표시·안내·버튼 (DOM을 만지는 곳은 여기와 드래그·확대뿐)
  function hint(s, st) {   // 메시지가 없을 때 그 단계에 보이는 안내문
    var lock = lockMode();
    if (s === 2 && st === 'active') {
      if (twoPt() && state.box) { return SECOND_HINT; }
      return (twoPt() ? '첫 핀(2개 중): ' : '') + (lock ? '고정할 피사체를' : '따라갈 부분을') + ' 드래그하세요. 글자·로고·모서리처럼 무늬가 뚜렷한 곳이 잘 잡혀요.';
    }
    if (s === 2 && st === 'done') { return '다시 꽂으려면 새로 드래그하세요.'; }
    if (s === 3 && st === 'active') {
      var tv = state.ctx && state.ctx.targets.some(function (t) { return t.timeVarying; });
      return (ui.fwd.checked ? '재생 헤드부터 끝까지만 다시 추적해요. 앞쪽 키는 그대로 둬요.' : lock ? '클립 구간 전체에서 피사체를 이 자리에 고정해요.' : '영상과 대상이 겹치는 구간 전체를 추적해요.')
        + (tv ? ' 구간 안에 이미 있는 ' + (lock ? '위치·크기·회전' : '위치') + ' 키는 새로 써져요.' : '');
    }
    return '';
  }
  function render() {
    var ph = phase(), lock = lockMode(), loaded = !!state.media, c = state.ctx, s, st, m;
    for (s = 1; s <= 3; s++) {
      st = s < ph ? 'done' : s === ph ? 'active' : 'todo';
      ui.step[s].className = 'step ' + st;
      ui.step[s].querySelector('.num').textContent = st === 'done' ? '✓' : String(s);
      m = state.msgs[s] || { text: hint(s, st), tone: '' };
      ui.msg[s].textContent = m.text;
      if (m.tone) { ui.msg[s].setAttribute('data-tone', m.tone); } else { ui.msg[s].removeAttribute('data-tone'); }
    }
    ui.modeDesc.textContent = lock ? '피사체를 한 자리에 고정해요 — 배경이 대신 움직여요.' : '자막·이미지가 핀 꽂은 부분을 따라다녀요.';
    // ① 불러오기 전 = 방법 안내 + 불러오기 버튼, 뒤 = 불러온 클립 요약 + [다시 불러오기]
    ui.howFollow.hidden = loaded || lock; ui.howLock.hidden = loaded || !lock;
    ui.load.hidden = loaded || !ui.ff.hidden; ui.clips.hidden = !loaded; ui.refresh.hidden = !loaded;
    if (loaded) {
      var sp = c.source.speed, src = c.source.name + ' · V' + (c.source.track + 1);
      var tgt = c.targets.map(function (t) { return t.name + ' · V' + (t.track + 1); }).join(', ');
      ui.cSrc.textContent = ui.cSrc.title = src;
      ui.cSpeed.hidden = !(Math.abs(sp - 1) > 0.001); ui.cSpeed.textContent = '속도 ' + Math.round(sp * 100) + '%';   // 이름이 길어 잘려도 속도는 보이게 따로
      ui.cTgtRow.hidden = lock; ui.cTgt.textContent = ui.cTgt.title = tgt;
      ui.tc.textContent = fmtTc(c.playheadSec, c.fps);   // 미리보기가 어느 장면인지 — 재생 헤드 위치
    }
    // ② 미리보기 자리
    ui.stage.hidden = !loaded; ui.placeholder.hidden = loaded;
    // ③ 실행
    ui.fillRow.hidden = !lock;
    ui.run.textContent = lock ? '고정 실행' : '따라가기 실행';
    ui.run.disabled = state.busy || ph < 3;
    ui.load.disabled = ui.refresh.disabled = state.busy || !state.hostOk;
    ui.follow.disabled = ui.lock.disabled = state.busy;
  }

  // ---- 진단 로그: Documents/Bobos/pin-log.txt (Bobos 전 Pin 단독판은 Documents/Pin) (9/21 전에는 Documents/Track/track-log.txt) (패널이 조용히 리셋돼도 파일은 남는다)
  var logPath = null;
  function log(msg) {
    var line = new Date().toISOString().slice(11, 19) + ' ' + msg;
    try { console.log('[Pin] ' + msg); } catch (e) {}
    if (!logPath || !fs) { return; }
    try { fs.appendFileSync(logPath, line + '\n'); } catch (e2) {}
  }
  /* 메시지는 그 단계 안에 (step 생략 = 지금 단계). 윗단계 메시지가 바뀌면 아랫단계 메시지는 낡은 것이라 지운다.
   * tone: '' 안내 · 'busy' 진행 중(돌아가는 표시) · 'success' · 'warning' · 'error' (셋은 상자로 강조) */
  function status(msg, tone, step) {
    var s = step || phase();
    state.msgs[s] = { text: msg, tone: tone || '' };
    for (var j = s + 1; j <= 3; j++) { state.msgs[j] = null; }
    log(msg); render();
  }

  // ---- 호스트 호출 (JSON 봉투)
  function host(script) {
    return new Promise(function (resolve, reject) {
      if (!cs) { reject(new Error('Premiere 연결을 찾지 못했습니다.')); return; }
      cs.evalScript(script, function (raw) {
        var r = null;
        try { r = JSON.parse(raw); } catch (e) { reject(new Error('Premiere 응답을 해석하지 못했습니다: ' + String(raw).slice(0, 80))); return; }
        if (!r || r.ok !== true) { var er = new Error((r && r.error) || 'Premiere 작업에 실패했습니다.'); er.code = r && r.code; reject(er); return; }
        resolve(r.data);
      });
    });
  }
  function literal(v) { return JSON.stringify(v).split('\u2028').join('\\u2028').split('\u2029').join('\\u2029'); }
  /* 패널 파일만 갱신하고 Premiere를 재시작하지 않으면 ExtendScript 쪽엔 옛 host.jsx가 남는다 (9/24 실기: 「고정」이 옛 Track_context로 가서 인자가 무시돼 NO_TARGET).
   * 번호가 안 맞으면 host.jsx를 $.evalFile로 다시 읽어 보고, 그래도 안 맞으면 재시작을 안내한다 (업데이트 배포 때 고객도 같은 상황) */
  function hostReady() {
    var check = function () { return host('Track_version()').then(function (v) { return v.rev >= HOST_REV; }, function () { return false; }); };
    return check().then(function (ok) {
      if (ok) { return true; }
      var jsx = (window.__BOBOS && window.__BOBOS.jsx) || decodeURIComponent(location.pathname).replace(/[^\/]*$/, 'jsx/host.jsx');   // 1.2.0: 로더가 띄운 버전의 host.jsx
      if (process.platform === 'win32') { jsx = jsx.replace(/^\/+/, ''); }
      log('host.jsx stale → evalFile ' + jsx);
      return new Promise(function (resolve) { cs.evalScript('$.evalFile(' + literal(jsx) + ')', function () { resolve(); }); }).then(check);
    }).then(function (ok) {
      if (!ok) { status('패널은 새 버전인데 Premiere가 이전 스크립트를 들고 있어요. Premiere를 완전히 종료했다가 다시 열어 주세요.', 'error', 1); }
      return ok;
    });
  }
  function fmtTc(sec, fps) {   // 시퀀스 경과 시간 → mm:ss:ff (시퀀스 표시 시작값은 무시)
    var fr = Math.round(sec * fps), f = fr % Math.round(fps), s = Math.floor(fr / Math.round(fps));
    return (s < 600 ? ('0' + Math.floor(s / 60)).slice(-2) : Math.floor(s / 60)) + ':' + ('0' + (s % 60)).slice(-2) + ':' + ('0' + f).slice(-2);
  }

  // ---- ffmpeg 찾기: PATH → winget Links → Homebrew
  // 윈도우: CEP Node의 process.env·where 출력은 한글 경로가 깨질 수 있어(LinkImport 실측) UTF-8/UTF-16으로 다시 읽는다
  function winEnv(name) {
    try { var out = cp.execSync('cmd /d /u /c echo %' + name + '%', { encoding: 'utf16le', windowsHide: true, timeout: 5000 }).trim(); if (out && out !== '%' + name + '%') { return out; } } catch (e) {}
    return process.env[name] || '';
  }
  function findTool(name) {
    var isWin = process.platform === 'win32', exe = isWin ? name + '.exe' : name;
    try {
      var out = cp.execSync(isWin ? ('chcp 65001 >nul & where ' + name) : ('command -v ' + name), { encoding: 'utf8', windowsHide: true, timeout: 5000 }).split(/\r?\n/)[0].trim();
      if (out && fs.existsSync(out)) { return out; }
    } catch (e) {}
    var cands = isWin
      ? [path.join(toolDir(), exe)]
      : ['/opt/homebrew/bin/' + exe, '/usr/local/bin/' + exe, path.join(toolDir(), exe)];
    for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) { return cands[i]; } } catch (e2) {} }
    return null;
  }
  // 패널이 PATH와 무관하게 직접 확인하는 자리 = LinkImport 설치 스크립트가 ffmpeg를 넣는 곳과 같다(LinkImport 사용자는 이미 있음)
  function toolDir() { return process.platform === 'win32' ? path.join(winEnv('LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links') : path.join(os.homedir(), '.local', 'bin'); }

  /* ---- ffmpeg 원클릭 설치 (없는 사용자용). 패키지 매니저 없이 배포처에서 직접 받는다 — 출처·위치는 LinkImport 설치 스크립트가 현장에서 검증한 것 그대로:
   *   윈도우: yt-dlp/FFmpeg-Builds win64 zip(약 190MB, 9/21 헤더 실측) → 내장 curl·tar(Win10 1803+) → toolDir
   *   맥: M칩 = osxexperts arm 빌드(ad-hoc 서명 포함, quarantine만 떼면 실행 — codesign 호출 금지: CLT를 요구한다) · 인텔 = evermeet.cx(인텔 전용) → ~/.local/bin
   * M칩 판별은 sysctl hw.optional.arm64 — 프리미어가 로제타로 돌면 process.arch·uname -m 둘 다 x64로 나온다. */
  function sh(cmd, args, onTick) {   // 비동기 실행 (패널이 얼지 않게) — 실패하면 stderr 끝줄과 함께 reject
    return new Promise(function (resolve, reject) {
      var p = cp.spawn(cmd, args, { windowsHide: true }), err = '', t = onTick ? setInterval(onTick, 1000) : null;
      p.stderr.on('data', function (d) { err = (err + d).slice(-400); });
      p.on('error', function (e) { if (t) { clearInterval(t); } reject(e); });
      p.on('close', function (code) { if (t) { clearInterval(t); } if (code === 0) { resolve(); } else { reject(new Error(cmd + ' 실패(' + code + '): ' + err.trim().split(/\r?\n/).pop())); } });
    });
  }
  function sys32(exe) { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe); }   // 윈도우 내장 curl·tar(bsdtar = zip도 푼다). PATH 앞쪽의 다른 tar(Git 등)를 피한다
  function download(url, file, label) {
    var tick = function () { try { ui.msg[1].textContent = label + ' 내려받는 중… ' + Math.round(fs.statSync(file).size / 1048576) + 'MB'; } catch (e) {} };   // 화면만 갱신 (로그에 초마다 쌓지 않는다)
    status(label + ' 내려받는 중…', 'busy', 1);
    return sh(process.platform === 'win32' ? sys32('curl.exe') : 'curl', ['-L', '--fail', '--silent', '--show-error', '-o', file, url], tick);
  }
  function findFile(dir, name) {   // 압축 푼 폴더에서 실행파일 찾기 (윈도우 zip은 하위 bin 폴더 안)
    var list = fs.readdirSync(dir), i, p, st, r;
    for (i = 0; i < list.length; i++) {
      p = path.join(dir, list[i]); st = fs.statSync(p);
      if (st.isDirectory()) { r = findFile(p, name); if (r) { return r; } } else if (list[i].toLowerCase() === name) { return p; }
    }
    return null;
  }
  function installFfmpeg() {
    var isWin = process.platform === 'win32', dest = toolDir(), tmp = path.join(os.tmpdir(), 'haru-pin-ff'), ext = isWin ? '.exe' : '';
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
    var arm = false;
    if (!isWin) { try { arm = cp.execSync('sysctl -n hw.optional.arm64', { encoding: 'utf8', timeout: 5000 }).trim() === '1'; } catch (e1) {} }
    var jobs = isWin ? [['ffmpeg·ffprobe(약 190MB)', 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip']]
      : arm ? [['ffmpeg', 'https://www.osxexperts.net/ffmpeg9arm.zip'], ['ffprobe', 'https://www.osxexperts.net/ffprobe9arm.zip']]
        : [['ffmpeg', 'https://evermeet.cx/ffmpeg/getrelease/zip'], ['ffprobe', 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip']];
    log('ffmpeg install start → ' + dest + (isWin ? '' : ' arm=' + arm));
    return jobs.reduce(function (chain, job, i) {
      var zip = path.join(tmp, 'f' + i + '.zip');
      return chain.then(function () { return download(job[1], zip, job[0]); }).then(function () {
        status(job[0] + ' 압축 푸는 중…', 'busy', 1);
        return isWin ? sh(sys32('tar.exe'), ['-xf', zip, '-C', tmp]) : sh('unzip', ['-oq', zip, '-d', tmp]);
      });
    }, Promise.resolve()).then(function () {
      ['ffmpeg', 'ffprobe'].forEach(function (n) {
        var src = findFile(tmp, n + ext);
        if (!src) { throw new Error('압축 안에서 ' + n + '를 찾지 못했습니다.'); }
        fs.copyFileSync(src, path.join(dest, n + ext));
        if (!isWin) { fs.chmodSync(path.join(dest, n), 493); }   // 0755
      });
      if (!isWin) { try { cp.execSync('xattr -dr com.apple.quarantine "' + dest + '"', { timeout: 10000 }); } catch (e2) {} }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e3) {}
      cp.execFileSync(path.join(dest, 'ffmpeg' + ext), ['-version'], { windowsHide: true, timeout: 20000 });   // 실제로 실행되는지까지 확인
      log('ffmpeg install ok');
    });
  }

  function probe(file) {
    var out = cp.execFileSync(state.tool.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true });
    var a = out.trim().split(','), fr = (a[2] || '30/1').split('/');
    var w = +a[0], h = +a[1], fps = (+fr[0]) / ((+fr[1]) || 1);
    if (!(w > 0 && h > 0 && fps > 0)) { throw new Error('영상 정보를 읽지 못했습니다: ' + file); }
    return { w: w, h: h, fps: fps };
  }
  /* 영역(미디어 px) → 긴 변 LONG px 해상도를 붙인 영역. 보이는 영역만 잘라도 해상도 체계(긴 변 640)는 그대로라 추적기 설정(R 등)이 튜닝된 조건과 같다
   * — 잘린 영역 = 시청자가 보는 화면이므로 프레임당 이동 px도 평소 클립과 같은 범위 */
  function fitRegion(c, long) { var sc = (long || LONG) / Math.max(c.w, c.h); return { x: c.x, y: c.y, w: c.w, h: c.h, W: Math.round(c.w * sc / 2) * 2, H: Math.round(c.h * sc / 2) * 2 }; }
  function cropArg(c) { var m = state.media; return (c.x || c.y || c.w !== m.w || c.h !== m.h) ? 'crop=' + c.w + ':' + c.h + ':' + c.x + ':' + c.y + ',' : ''; }
  /* 9/24: 미리보기 = 시퀀스에 보이는 영역 + 여유(view). 추적 영역(track) = 따라가기는 view와 같고, 고정은 원본 전체 —
   * 고정은 피사체가 지금 보이는 곳 밖으로 걸어 나가도(16:9 원본을 9:16에 얹고 가로지르는 사람) 계속 잡아야 결과 화면에 피사체가 남는다. */
  function regions(m, ctx, lock) {
    var r = TrackCore.viewRegion({ w: m.w, h: m.h, fw: ctx.fw, fh: ctx.fh, pos: ctx.source.posPx, scale: ctx.source.scale / 100, margin: VIEW_MARGIN });
    m.vis = r.vis; m.view = fitRegion(r.crop);
    m.track = m.view;
    if (lock) {   // 긴 변 = 메모리 상한 안에서 가장 크게(LONG~LOCK_LONG, 원본보다 키우지 않음). 프레임 수 = 클립 전체(구간 상한 MAX_SEC 안)
      var big = Math.max(m.w, m.h), n = Math.min((ctx.source.endSec - ctx.source.startSec) * (ctx.source.speed || 1), MAX_SEC) * m.fps;
      m.track = fitRegion({ x: 0, y: 0, w: m.w, h: m.h }, Math.max(LONG, Math.min(LOCK_LONG, big, Math.sqrt(LOCK_BUDGET * big / (n * Math.min(m.w, m.h))))));
    }
    m.W = m.track.W; m.H = m.track.H;
    return m;
  }
  /* ffmpeg에 넘기는 초는 고정 소수점으로. String(3.55e-14) = "3.552713678800501e-14" 같은 지수 표기를 ffmpeg가 못 읽는다("Invalid duration", 맥 실기 9/21 —
   * 시각 빼기에서 생긴 부동소수 찌꺼기가 0이 아닌 아주 작은 수로 남은 경우). 음수 찌꺼기도 0으로. */
  /* 탐색 옵션: 해상도가 LONG의 c배면 성긴(c칸)→정밀 탐색 = 튜닝한 640과 같은 위치 밀도 (봉우리 좁은 핀은 추적기가 1칸으로 되돌림).
   * 9/24 실측: 1280 시계 핀 추적 4.9초 → 1.6초 (결과 동일), 여러 영상 15건 궤적 품질 차이 없음 */
  function searchOpt(m) { return { coarse: Math.max(1, Math.floor(Math.max(m.W, m.H) / LONG)) }; }
  function trackR(m) { return Math.round(R * Math.max(m.W, m.H) / LONG); }   // 탐색 반경을 해상도에 비례 = 화면 대비 같은 이동 범위
  function secArg(sec) { return Math.max(0, sec).toFixed(6); }
  /* 시퀀스 초 → 원본 파일 초. ★ Premiere의 inPoint는 속도 적용 뒤 단위(= 원본 시각 ÷ 속도)라 inPoint까지 속도를 곱해야 한다.
   * 9/24 실기: 194% 클립 in=80.566인데 모니터 장면은 원본 158.5초(= (80.566 + 0.967) × 1.944, 프레임 대조로 확인). 예전 식 in + 경과×속도는 82.4초 = 전혀 다른 장면 */
  function mediaTime(seqSec) { var s = state.ctx.source; return (s.inSec + (seqSec - s.startSec)) * s.speed; }
  // 소스와 모든 대상이 겹치는 시퀀스 구간 [t0, t1)
  function overlap(ctx) {
    var t0 = ctx.source.startSec, t1 = ctx.source.endSec;
    ctx.targets.forEach(function (t) { t0 = Math.max(t0, t.startSec); t1 = Math.min(t1, t.endSec); });
    return [t0, t1];
  }

  // ---- 미리보기 프레임: 재생 헤드 시각의 소스 프레임을 PNG로 + 같은 프레임의 흑백 원본(박스 품질 검사용)을 stdout으로 (한 번의 디코드, 출력 둘)
  function previewFrame() {
    var m = state.media, v = m.view, t = m.track, p = path.join(os.tmpdir(), 'haru-pin'), f = path.join(p, 'preview.png');
    try { fs.mkdirSync(p); } catch (e) {}
    var buf = cp.execFileSync(state.tool.ffmpeg, ['-v', 'error', '-y', '-ss', secArg(mediaTime(state.ctx.playheadSec)), '-i', state.ctx.source.mediaPath,
      '-vf', cropArg(v) + 'scale=' + v.W + ':' + v.H, '-frames:v', '1', f,                                                    // 보여 줄 영역
      '-vf', cropArg(t) + 'scale=' + t.W + ':' + t.H + ',format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 26, windowsHide: true });   // 추적할 영역(품질 검사)
    state.gray = buf.length >= m.W * m.H ? buf.subarray(0, m.W * m.H) : null;
    ui.img.src = 'file:///' + encodeURI(f.replace(/\\/g, '/').replace(/^\/+/, '')) + '?t=' + Date.now();   // 맥 경로는 '/'로 시작 → file://// 방지
    ui.stage.hidden = false;   // 프레임이 생기기 전엔 빈 상자를 안 보여준다
  }
  // 박스 품질 경고문 (없으면 ''). 실기 사고: 단색 파우치 속을 둘째 점으로 찍어 배율이 들쭉날쭉·회전 34° 표류
  function qualityNote(b, label) {
    /* 추적 해상도에서 너무 작은 핀: 9/24 실기 — 고정(원본 전체를 640px로 추적)에서 확대된 미리보기로는 커 보이던 커서 핀이 추적 화면에선 13×10px,
     * 커서의 1~2px 선은 1px도 안 돼 사라지고 추적기가 뒤의 체크무늬 배경에 붙어 190프레임 동안 멈춰 있었다(결과 = 고정이 안 된 것처럼 보임) */
    if (Math.min(b.w, b.h) < 16) {
      var coarse = state.media.track !== state.media.view;
      return label + ' 추적하는 화면에선 ' + b.w + '×' + b.h + 'px밖에 안 돼요' + (coarse ? '(고정은 피사체가 화면 밖으로 가도 잡으려고 원본 전체를 추적해서, 미리보기보다 작게 잡혀요)' : '')
        + '. 마우스 커서 같은 가는 선은 사라져서 배경에 붙어요. 핀을 더 크게 꽂거나 굵고 뚜렷한 물체에 꽂으세요. ';
    }
    if (!state.gray) { return ''; }
    var q = TrackCore.quality(state.gray, state.media.W, state.media.H, b);
    log('quality ' + label + ' std=' + q.std.toFixed(1) + ' distinct=' + q.distinct.toFixed(2) + ' slide=' + q.slide.toFixed(2));
    if (q.std < 8) { return label + ' 무늬가 약해요(단색). 글자·모서리처럼 뚜렷한 곳이 안 미끄러져요. '; }
    if (q.slide > 0.9) { return label + ' 한 방향으로 밀어도 똑같아 보여요(선·단색 가장자리). 미끄러질 수 있으니 무늬가 있는 곳을 고르세요. '; }
    if (q.distinct > 0.9) { return label + ' 주변과 비슷해서 미끄러질 수 있어요. 더 뚜렷한 부분을 고르세요. '; }
    return '';
  }
  function decode(ssSec, durSec) {
    var m = state.media;
    var buf = cp.execFileSync(state.tool.ffmpeg, ['-v', 'error', '-ss', secArg(ssSec), '-t', secArg(durSec), '-i', state.ctx.source.mediaPath,
      '-vf', cropArg(m.track) + 'scale=' + m.W + ':' + m.H + ',format=gray', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 30, windowsHide: true });
    var n = Math.floor(buf.length / (m.W * m.H)), frames = [];
    for (var i = 0; i < n; i++) { frames.push(buf.subarray(i * m.W * m.H, (i + 1) * m.W * m.H)); }
    return frames;
  }

  // ---- 박스 드래그 (마우스 이벤트 — 맥 CEP는 pointer 이벤트가 오지 않는다)
  /* 표시 px(미리보기 img 안) ↔ 추적 px. 미리보기는 view 영역, 추적은 track 영역(고정은 원본 전체)이라 미디어 px를 거친다. 핀(state.box)은 추적 px로 저장 */
  function d2t(x, y) {
    var v = state.media.view, t = state.media.track;
    return [(v.x + x * v.w / ui.img.clientWidth - t.x) * t.W / t.w, (v.y + y * v.h / ui.img.clientHeight - t.y) * t.H / t.h];
  }
  function t2d(x, y) {
    var v = state.media.view, t = state.media.track;
    return [(t.x + x * t.w / t.W - v.x) * ui.img.clientWidth / v.w, (t.y + y * t.h / t.H - v.y) * ui.img.clientHeight / v.h];
  }
  function drawBox() {
    var c = ui.cv, g = c.getContext('2d'), m = state.media;
    c.width = ui.img.clientWidth; c.height = ui.img.clientHeight;
    g.clearRect(0, 0, c.width, c.height);
    if (!m) { return; }
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--mg-accent') || '#fff', pair = twoPt();
    var boxes = [state.box, pair ? state.box2 : null];
    // 액센트가 흰색이라 밝은 피사체 위에서 묻힌다 → 전부 어두운 밑선 위에 흰 선(이중). 첫 핀 = 실선, 둘째 핀 = 점선
    var DARK = 'rgba(0,0,0,0.55)';
    // 시퀀스 프레임 밖(여유 부분)은 어둡게 + 경계선 — 프로그램 모니터에 보이는 구도가 밝은 사각형 안
    var sx = m.vis.x - m.view.x, sy = m.vis.y - m.view.y, kx = c.width / m.view.w, ky = c.height / m.view.h;
    var fx0 = Math.max(0, sx * kx), fy0 = Math.max(0, sy * ky), fx1 = Math.min(c.width, (sx + m.vis.w) * kx), fy1 = Math.min(c.height, (sy + m.vis.h) * ky);
    if (fx0 > 0.5 || fy0 > 0.5 || fx1 < c.width - 0.5 || fy1 < c.height - 0.5) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, 0, c.width, fy0); g.fillRect(0, fy1, c.width, c.height - fy1); g.fillRect(0, fy0, fx0, fy1 - fy0); g.fillRect(fx1, fy0, c.width - fx1, fy1 - fy0);
      g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.strokeRect(fx0 + 0.5, fy0 + 0.5, fx1 - fx0 - 1, fy1 - fy0 - 1);
    }
    boxes.forEach(function (b, i) {
      if (!b) { return; }
      var p0 = t2d(b.x, b.y), p1 = t2d(b.x + b.w, b.y + b.h), x = p0[0], y = p0[1], w = p1[0] - x, h = p1[1] - y;
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, y, w, h);
      g.lineWidth = 4; g.strokeStyle = DARK; g.strokeRect(x, y, w, h);
      g.setLineDash(i ? [5, 4] : []); g.lineWidth = 2; g.strokeStyle = accent; g.strokeRect(x, y, w, h); g.setLineDash([]);
      if (pair) {
        g.font = 'bold 11px sans-serif'; g.lineWidth = 3; g.strokeStyle = DARK; g.strokeText(String(i + 1), x + 4, y + 13);
        g.fillStyle = accent; g.fillText(String(i + 1), x + 4, y + 13);
      }
    });
    if (pair && state.box && state.box2) {   // 두 핀 연결선 — 이 길이의 변화가 배율, 기울기의 변화가 회전
      var a = t2d.apply(null, center(state.box)), b2 = t2d.apply(null, center(state.box2));
      [[3, DARK, []], [1, 'rgba(255,255,255,0.8)', [4, 4]]].forEach(function (s) {
        g.lineWidth = s[0]; g.strokeStyle = s[1]; g.setLineDash(s[2]);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b2[0], b2[1]); g.stroke();
      });
      g.setLineDash([]);
    }
  }
  /* ---- 미리보기 확대 (9/24 실기: 작은 핀포인트가 패널에서 안 보인다)
   * img는 기준 크기(CSS 캡대로 놓인 크기) × zoom, view(스크롤 상자)는 기준 크기로 고정, canvas는 drawBox가 img 크기로 맞춘다(속성 크기 = 표시 크기라 선 굵기가 확대에 안 변함).
   * 상한 = 추적 픽셀 하나가 화면 4px가 될 때까지 — 그 위는 640px 프레임의 흐린 픽셀만 커진다. Ctrl(⌘)+휠 = 커서 기준, 휠만 = 스크롤, 버튼 −/100%/+ */
  var zoom = 1;
  function layoutZoom() {
    if (!state.media) { drawBox(); return; }
    ui.img.style.width = ui.img.style.height = ui.img.style.maxWidth = ui.img.style.maxHeight = '';   // 확대 스타일을 걷고 CSS 캡대로 놓인 기준 크기를 잰다
    ui.view.style.width = ui.view.style.height = '';
    var v = state.media.view, t = state.media.track, trackPx = v.w * t.W / t.w;   // 표시 폭 안에 들어가는 추적 px 수 (고정은 원본 전체를 추적해서 view보다 성기다)
    var bw = ui.img.clientWidth, bh = ui.img.clientHeight, max = Math.min(12, Math.max(1, 4 * trackPx / bw));
    zoom = Math.max(1, Math.min(max, zoom));
    if (zoom > 1) {
      ui.view.style.width = bw + 'px'; ui.view.style.height = bh + 'px';
      ui.img.style.maxWidth = ui.img.style.maxHeight = 'none';
      ui.img.style.width = Math.round(bw * zoom) + 'px'; ui.img.style.height = Math.round(bh * zoom) + 'px';
    }
    ui.zoomReset.textContent = Math.round(zoom * 100) + '%';
    ui.zoomIn.disabled = zoom >= max - 0.001; ui.zoomOut.disabled = zoom <= 1;
    drawBox();
  }
  function setZoom(z, ax, ay) {   // (ax, ay) = view 안 기준점(뷰포트 px, 없으면 가운데) — 그 아래 픽셀이 제자리에 남게 스크롤을 맞춘다
    var v = ui.view, old = zoom, cx = ax === undefined ? v.clientWidth / 2 : ax, cy = ay === undefined ? v.clientHeight / 2 : ay;
    var px = (v.scrollLeft + cx) / old, py = (v.scrollTop + cy) / old;   // 기준 크기 좌표
    zoom = z; layoutZoom();
    v.scrollLeft = px * zoom - cx; v.scrollTop = py * zoom - cy;
  }
  (function bindZoom() {
    ui.view.addEventListener('wheel', function (e) {
      if (!state.media || !(e.ctrlKey || e.metaKey)) { return; }   // 그냥 휠은 스크롤 — Ctrl 없이 확대하면 확대 상태의 스크롤·패널 스크롤과 싸운다
      e.preventDefault();
      var r = ui.view.getBoundingClientRect();
      setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    ui.zoomIn.addEventListener('click', function () { setZoom(zoom * 1.5); });
    ui.zoomOut.addEventListener('click', function () { setZoom(zoom / 1.5); });
    ui.zoomReset.addEventListener('click', function () { setZoom(1); });
  }());
  (function bindDrag() {
    var start = null;
    function pos(e) { var r = ui.cv.getBoundingClientRect(), p = d2t(e.clientX - r.left, e.clientY - r.top); return { x: p[0], y: p[1] }; }
    ui.cv.addEventListener('mousedown', function (e) {
      if (!state.media) { return; }
      start = pos(e);
      start.second = !!(twoPt() && state.box && !state.box2);   // 두 점 모드에서 기준 박스만 있으면 둘째 박스, 아니면 처음부터
      if (!start.second) { state.box = null; state.box2 = null; }
      /* 이전 경고·실행 결과는 낡았다 — 지우기만 하고 화면 갱신(render)은 놓을 때(mouseup)로 미룬다. 누르는 순간 경고 상자가 사라지면 단계 영역 높이·스크롤바가 바뀌어
       * 미리보기가 커서 밑에서 몇 px 움직이고, 핀이 그린 것보다 좁게 잡힌다(9/24 하네스 실측: 가로 29→23 추적 px) */
      state.msgs[2] = state.msgs[3] = null;
      drawBox(); e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!start) { return; }
      var p = pos(e), x0 = Math.min(start.x, p.x), y0 = Math.min(start.y, p.y);
      var b = { x: Math.round(x0), y: Math.round(y0), w: Math.round(Math.abs(p.x - start.x)), h: Math.round(Math.abs(p.y - start.y)) };
      if (start.second) { state.box2 = b; } else { state.box = b; }
      drawBox();
    });
    window.addEventListener('mouseup', function () {
      if (!start) { return; }
      var second = start.second, b = second ? state.box2 : state.box;
      start = null;
      if (!b || b.w < 8 || b.h < 8) {
        if (second) { state.box2 = null; } else { state.box = null; }
        drawBox(); status('핀이 너무 작아요. 조금 더 크게 드래그하세요.', 'warning', 2); return;
      }
      if (second) {
        var a = center(state.box), c2 = center(b), d = Math.round(Math.hypot(c2[0] - a[0], c2[1] - a[1]));
        var inside = c2[0] >= state.box.x && c2[0] <= state.box.x + state.box.w && c2[1] >= state.box.y && c2[1] <= state.box.y + state.box.h;
        if (inside) {   // 기준 박스 위에 다시 그림 = 기준 박스를 고치려는 것 (실기: 같은 자리에 다시 그려 "3px" 경고를 받음)
          state.box = b; state.box2 = null; drawBox(); status('첫 핀을 다시 꽂았어요. ' + SECOND_HINT, '', 2); return;
        }
        if (d < MIN_DIST) { state.box2 = null; drawBox(); status('두 핀이 너무 가까워요. 더 떨어진 곳에 꽂을수록 크기·회전이 정확해요. ' + SECOND_HINT, 'warning', 2); return; }
        var q2 = qualityNote(b, '둘째 핀:');
        log('pin2 ' + b.x + ',' + b.y + ',' + b.w + ',' + b.h + ' d=' + d);
        if (q2) { status(q2, 'warning', 2); } else { render(); }
        return;
      }
      var q1 = qualityNote(b, '핀:');
      log('pin ' + b.x + ',' + b.y + ',' + b.w + ',' + b.h);
      if (q1) { status(q1 + (twoPt() ? SECOND_HINT : ''), 'warning', 2); } else { render(); }
    });
    window.addEventListener('resize', layoutZoom);
  }());
  function onOptChange() {   // 크기·회전을 끄면 둘째 박스는 의미가 없다 (켜면 안내문이 둘째 핀을 요청한다)
    if (!twoPt()) { state.box2 = null; }
    state.msgs[2] = state.msgs[3] = null;
    drawBox(); render();
  }
  function onModeChange() {   // 따라가기 ↔ 고정: 대상이 달라지므로(고정 = 소스 자신) 선택을 다시 읽는다. 불러오기가 실패해 있던 상태면(예: 「고정」을 고르라는 안내) 바로 다시 시도
    render();
    if (!state.busy && (state.media || (state.msgs[1] && state.msgs[1].tone === 'error' && state.hostOk))) { refresh(); }
  }

  // ---- ① 불러오기: 컨텍스트 → 미디어 → 미리보기. quiet = 패널을 열 때 자동 시도(선택이 없어도 빨간 오류 대신 방법 안내만 보인다)
  function refresh(quiet) {
    state.busy = true; state.box = null; state.box2 = null; state.media = null; state.gray = null; drawBox();
    status('선택한 클립을 읽는 중…', 'busy', 1);
    return host('Track_context(' + (lockMode() ? 'true' : 'false') + ')').then(function (ctx) {
      state.ctx = ctx;
      if (ctx.source.reversed) { throw new Error('거꾸로 재생(역재생)한 영상 클립은 아직 지원하지 않아요. 속도/지속 시간에서 역재생을 끄고 다시 불러오세요.'); }
      state.media = regions(probe(ctx.source.mediaPath), ctx, lockMode());
      var tInfo = ctx.targets.map(function (t) { return 'V' + (t.track + 1) + '[' + t.startSec.toFixed(3) + '~' + t.endSec.toFixed(3) + '] pos=' + Math.round(t.posPx[0]) + ',' + Math.round(t.posPx[1]); }).join(' ');
      log('ctx media=' + ctx.source.mediaPath + ' | ' + state.media.w + 'x' + state.media.h + '@' + state.media.fps.toFixed(3) + ' | view ' + JSON.stringify(state.media.view) + ' track ' + JSON.stringify(state.media.track)
        + ' | playhead=' + ctx.playheadSec.toFixed(3) + 's mediaT=' + mediaTime(ctx.playheadSec).toFixed(3) + 's | src[' + ctx.source.startSec.toFixed(3) + '~' + ctx.source.endSec.toFixed(3) + '] in=' + ctx.source.inSec.toFixed(3) + ' scale=' + ctx.source.scale
        + ' | tgt ' + tInfo + ' seq=' + ctx.fw + 'x' + ctx.fh + ' speed=' + ctx.source.speed);
      previewFrame();
      var ov = overlap(ctx);
      if (!(ov[1] > ov[0])) { throw new Error('영상과 따라갈 클립이 시간상 겹치지 않아요. 자막을 영상 위 트랙, 같은 구간에 놓으세요.'); }
      if (!(ctx.playheadSec >= ov[0] && ctx.playheadSec < ov[1])) {
        throw new Error(lockMode() ? '재생 헤드가 고정할 영상 클립 밖에 있어요. 재생 헤드를 그 영상 위에 두고 다시 불러오세요.' : '재생 헤드가 영상과 따라갈 클립이 겹치는 구간 밖에 있어요. 둘이 겹치는 장면에 재생 헤드를 두고 다시 불러오세요.');
      }
      state.busy = false; state.msgs = [null, null, null, null]; render();   // 성공: 단계 안내문이 다음 할 일(핀 꽂기)을 알려준다
    }).catch(function (e) {
      state.busy = false; state.media = null; state.gray = null;
      if (quiet) { log('auto load skipped: ' + (e.message || e)); state.msgs[1] = null; render(); return; }
      status(e.message || String(e), 'error', 1);
    });
  }

  // ---- ③ 실행
  function run() {
    if (!state.ctx) { return; }
    /* 새로고침 뒤에 재생 헤드를 옮겼으면 핀은 옛 프레임 위에 꽂힌 것이고 범위·기준 프레임도 옛 지점 기준이다 → 새 프레임을 띄우고 다시 꽂게 한다.
     * (맥 실기 9/21: 재생 헤드를 중간에 옮기고 「뒤만」으로 돌렸는데 전체가 추적됨 — 패널은 새로고침 때의 지점을 기억하고 있었다) */
    host('Track_playhead()').then(function (ph) {
      if (Math.abs(ph.playheadSec - state.ctx.playheadSec) > 0.5 / state.media.fps) {
        return refresh().then(function () { if (state.media) { status('재생 헤드가 움직여서 그 장면을 새로 띄웠어요. 이 장면에 핀을 다시 꽂고 실행하세요.', 'warning', 2); } });
      }
      runNow();
    }, function () { runNow(); });
  }
  function runNow() {
    var ctx = state.ctx, m = state.media, box = state.box, box2 = twoPt() ? state.box2 : null;
    if (!ctx || !m || !box || (twoPt() && !box2)) { return; }
    state.busy = true;
    var ov = overlap(ctx), t0 = ov[0], t1 = ov[1], P = ctx.playheadSec;
    /* 소스 속도 sp: 미디어 프레임 하나 = 시퀀스 1/(fps·sp)초 (194%면 시퀀스 한 프레임에 미디어 약 2프레임). 미디어 프레임을 전부 추적하고(프레임당 이동이 속도와 무관)
     * 키 시각만 이 간격으로 놓는다. 구간 상한은 메모리(미디어 프레임 수) 기준이라 시퀀스로는 MAX_SEC / sp */
    var sp = ctx.source.speed || 1, seqFps = m.fps * sp, maxSeq = MAX_SEC / sp;
    var capped = false, fwdOnly = ui.fwd.checked;
    if (fwdOnly) { t0 = P; }                                // 앞으로만: 재생 헤드 앞 구간의 기존 키는 보존 (놓친 지점에서 다시 잡을 때)
    if (t1 - t0 > maxSeq) { t0 = Math.max(t0, P - maxSeq / 2); t1 = Math.min(t1, t0 + maxSeq); capped = true; }
    var iP = Math.round((P - t0) * seqFps);
    t0 = P - iP / seqFps;                                  // 프레임 격자를 재생 헤드에 맞춘다
    status('영상 프레임 읽는 중… (' + (t1 - t0).toFixed(1) + '초 구간)', 'busy', 3);
    setTimeout(function () {
      try {
        var tA = Date.now();
        var frames = decode(mediaTime(t0), (t1 - t0) * sp + 0.5 / m.fps);
        if (frames.length <= iP) { throw new Error('영상 프레임을 충분히 읽지 못했어요 (' + frames.length + '장). 영상 파일이 옮겨졌거나 손상됐는지 확인하세요.'); }
        status('추적 중… ' + frames.length + '프레임', 'busy', 3);
        setTimeout(function () {
          try {
            // 두 점 모드: 두 박스를 한 루프에서 쌍 추적(배율 되먹임) → 거리비·각도. 아니면 기준 박스만
            var pair = box2 ? TrackCore.trackPairAround(frames, m.W, m.H, iP, box, box2, trackR(m), searchOpt(m)) : null;
            var res = pair ? pair.a : TrackCore.trackAround(frames, m.W, m.H, iP, box, trackR(m), searchOpt(m));
            var tp = pair ? TrackCore.twoPoint(res, pair.b, iP) : null;
            var lost = 0, firstLost = -1;
            for (var i = 0; i < res.length; i++) { if (res[i].src === 'lost') { lost++; if (firstLost < 0 || (i > iP && firstLost < iP)) { firstLost = i; } } }
            // 진단: 박스·시작 프레임·점수 흐름 (오프라인 재현용: probe/run.js <media> <mediaT0> <dur> <iP> <box> [--box2=…])
            log('run box=' + box.x + ',' + box.y + ',' + box.w + ',' + box.h + (box2 ? ' box2=' + box2.x + ',' + box2.y + ',' + box2.w + ',' + box2.h : '') + ' iP=' + iP + ' t0=' + t0.toFixed(3) + ' mediaT0=' + mediaTime(t0).toFixed(3) + ' dur=' + (t1 - t0).toFixed(3) + ' speed=' + sp + ' R=' + trackR(m) + ' res=' + m.W + 'x' + m.H + ' coarse=' + (res[iP].coarse || 1) + (pair ? '/' + (pair.b[iP].coarse || 1) : ''));
            var trace = '', step = Math.max(1, Math.round(res.length / 30));
            for (i = 0; i < res.length; i += step) { trace += i + ':' + res[i].score.toFixed(2) + res[i].src.charAt(0) + ' '; }
            log('trace ' + trace);
            if (tp) {
              var mm = function (v) { return Math.min.apply(null, v).toFixed(2) + '~' + Math.max.apply(null, v).toFixed(2); }, lostB = 0;
              for (i = 0; i < pair.b.length; i++) { if (pair.b[i].src === 'lost') { lostB++; } }
              log('twoPoint d0=' + tp.d0.toFixed(1) + 'px s=' + mm(tp.s) + (tp.sActive ? '' : ' (8% 미만)') + ' rot=' + mm(tp.rot) + '°' + (tp.rActive ? '' : ' (3° 미만)') + ' lostB=' + lostB);
            }
            try {   // 추적 시작 프레임을 PGM으로 남긴다 — 미리보기와 같은 프레임인지 대조용
              var pgmDir = path.dirname(logPath), pgm = path.join(pgmDir, 'frame_iP.pgm');
              fs.writeFileSync(pgm, Buffer.concat([Buffer.from('P5\n' + m.W + ' ' + m.H + '\n255\n', 'ascii'), Buffer.from(frames[iP])]));
              fs.copyFileSync(path.join(os.tmpdir(), 'haru-pin', 'preview.png'), path.join(pgmDir, 'preview.png'));
            } catch (eD) { log('diag save fail ' + eD.message); }
            /* 진단: 프레임 간 큰 이동(12px↑, 추적 해상도) 상위 5개를 로그에, 전체 궤적은 last-run.json에 남긴다 — 영상 없이도 "갑자기 확 움직였다"가
             * 추적점이 뛴 건지(여기 찍힘) 키·보간 문제인지(안 찍힘) 가를 수 있게 (맥 실기 9/21: 거위 영상, 이 PC에 파일이 없어 재현 불가였다) */
            try {
              var jumps = [];
              for (i = 1; i < res.length; i++) {
                if (res[i].src === 'lost' || res[i - 1].src === 'lost') { continue; }
                var jdx = res[i].cx - res[i - 1].cx, jdy = res[i].cy - res[i - 1].cy, jd = Math.sqrt(jdx * jdx + jdy * jdy);
                if (jd > 12) { jumps.push({ d: jd, t: 'f' + i + '@' + fmtTc(t0 + i / seqFps, ctx.fps) + ' (' + Math.round(jdx) + ',' + Math.round(jdy) + ') ' + res[i].src + ' ' + res[i].score.toFixed(2) }); }
              }
              jumps.sort(function (x, y) { return y.d - x.d; });
              log('jumps>12px: ' + jumps.length + (jumps.length ? ' | ' + jumps.slice(0, 5).map(function (j) { return j.t; }).join(' | ') : ''));
              var pack = function (r) { return r.map(function (e) { return [Math.round(e.cx * 10) / 10, Math.round(e.cy * 10) / 10, Math.round(e.score * 100) / 100, e.src.charAt(0), Math.round(e.s * 1000) / 1000, Math.round(e.th * 10) / 10]; }); };
              fs.writeFileSync(path.join(path.dirname(logPath), 'last-run.json'), JSON.stringify({ media: ctx.source.mediaPath, W: m.W, H: m.H, track: tr, fps: m.fps, speed: sp, t0: t0, iP: iP, box: box, box2: box2, res: pack(res), res2: pair ? pack(pair.b) : null }));
            } catch (eJ) { log('diag jumps fail ' + eJ.message); }
            var tr = m.track, k = (tr.w / tr.W) * (ctx.source.scale / 100);   // 추적 px → 미디어 px → 시퀀스 px (잘라 읽었으면 영역 기준)
            var lostAtSec = firstLost >= 0 ? t0 + firstLost / seqFps : -1;
            log('decode+track ' + (Date.now() - tA) + 'ms, frames=' + frames.length + ', lost=' + lost + ', targets=' + ctx.targets.length);
            // 대상마다: 같은 추적 결과에 그 클립의 현재 위치를 기준점으로 키 생성 → 청크로 기록 (첫 청크가 구간의 기존 키를 지운다)
            var p = Promise.resolve(), written = 0, scaleWritten = 0, rotWritten = 0, total = 0, wantScale = ui.scale.checked, wantRot = ui.rot.checked;
            // 플레이헤드의 추적점(기준 박스 중심)을 시퀀스 px로: 소스 클립 위치 + (미디어 px − 미디어 중심) × 소스 Scale
            var mk = tr.w / tr.W, ss = ctx.source.scale / 100;
            var trackP = [ctx.source.posPx[0] + (tr.x + res[iP].cx * mk - m.w / 2) * ss, ctx.source.posPx[1] + (tr.y + res[iP].cy * mk - m.h / 2) * ss];
            var scaleSeries = (wantScale && tp && tp.sActive) ? tp.s : null, rotSeries = (wantRot && tp && tp.rActive) ? tp.rot : null;
            log('trackP=' + Math.round(trackP[0]) + ',' + Math.round(trackP[1]) + ' srcPos=' + Math.round(ctx.source.posPx[0]) + ',' + Math.round(ctx.source.posPx[1]) + ' scale=' + (scaleSeries ? 'y' : 'n') + ' rot=' + (rotSeries ? 'y' : 'n'));
            var kt = { t0Sec: t0, fps: seqFps }, tW = Date.now();
            /* 고정 모드: 대상 = 소스 클립 자신. 피사체를 재생 헤드 프레임의 화면 위치(trackP)에 못 박도록 클립을 반대로 옮기고 크기·회전은 역으로 건다(lockKeys).
             * 밀린 반대쪽 가장자리가 비지 않는 최소 확대(zNeed)를 재서 「가장자리 채우기」면 그만큼 Scale을 올린다(상한 MAX_ZOOM).
             * 「재생 헤드 뒤만」에선 앞 구간과 배율이 어긋나 그 지점에서 튀므로 확대하지 않는다(현재 배율 유지) */
            var lock = lockMode(), zoom = 1, zNeed = 1;   // lockZoom·lockKeys의 W·H = 원본 전체 테두리 — 고정은 track이 원본 전체라 그대로 맞다(regions)
            if (lock) {
              zNeed = TrackCore.lockZoom(res, { k: k, C: trackP, W: m.W, H: m.H, fw: ctx.fw, fh: ctx.fh, scale: scaleSeries, rot: rotSeries });
              zoom = (ui.fill.checked && !fwdOnly) ? Math.min(zNeed, MAX_ZOOM) : 1;
              log('lock zoomNeed=' + zNeed.toFixed(3) + ' zoom=' + zoom.toFixed(3) + (ui.fill.checked ? '' : ' (채우기 끔)'));
            }
            var tEnd = t0 + (res.length - 1) / seqFps;
            ctx.targets.forEach(function (tg) {
              /* 놓친 프레임(null)엔 키를 안 박고(앞뒤 키 사이 보간), 직선 보간으로 대신할 수 있는 키는 뺀다 — 키 하나 20~30ms라 기록 시간이 곧 키 수.
               * 허용치: 위치 1px(시퀀스 px, 0.5px는 추적 잡음 ±1px에 걸려 30%밖에 안 줄고 1px은 눈에 안 띈다) · 크기 0.5% · 회전 0.3°.
               * 오프라인 실측: 시계 326프레임 → 위치 143·크기 60, 레코드판 273 → 위치 264(원운동이라 직선이 안 됨)·크기 44·회전 39 */
              var full, sVals = null, rVals = null;
              if (lock) {
                full = TrackCore.lockKeys(res, { t0Sec: t0, fps: seqFps, k: k, C: trackP, W: m.W, H: m.H, zoom: zoom, scale: scaleSeries, rot: rotSeries });
                sVals = scaleSeries ? scaleSeries.map(function (v) { return tg.scale * zoom / v; }) : null;   // 피사체가 커진 만큼 클립을 줄인다
                rVals = rotSeries ? rotSeries.map(function (v) { return tg.rotation - v; }) : null;             // 기운 만큼 반대로 돌린다
              } else {
                full = TrackCore.toKeys(res, { iP: iP, t0Sec: t0, fps: seqFps, k: k, base: tg.posPx, trackP: trackP, scale: scaleSeries, rot: rotSeries });
                sVals = scaleSeries ? scaleSeries.map(function (v) { return tg.scale * v; }) : null;
                rVals = rotSeries ? rotSeries.map(function (v) { return tg.rotation + v; }) : null;
              }
              var keys = TrackCore.simplifyKeys(full, 1);
              // 고정은 크기·회전을 안 켜도 상수 키 2개(확대 포함)를 써서 구간을 비운다 — 전에 켜고 돌린 역배율·역회전 키가 남으면 위치 계산과 어긋난다 (따라가기는 대상 자체 애니메이션일 수 있어 안 건드림)
              var sKeys = sVals ? TrackCore.simplifyKeys(TrackCore.toValueKeys(res, sVals, kt), 0.005 * tg.scale) : (lock ? [[t0, tg.scale * zoom], [tEnd, tg.scale * zoom]] : []);   // 허용치는 대상 크기의 0.5% — 절대 0.5로 두면 Scale 12%짜리 큰 사진에선 4% 오차까지 버려 키 7개로 뭉개진다(실기)
              var rKeys = rVals ? TrackCore.simplifyKeys(TrackCore.toValueKeys(res, rVals, kt), 0.3) : (lock ? [[t0, tg.rotation], [tEnd, tg.rotation]] : []);
              log('keys ' + tg.name + ' pos ' + full.filter(function (kv) { return kv !== null; }).length + '→' + keys.length + (scaleSeries ? ' scale ' + sKeys.length : '') + (rotSeries ? ' rot ' + rKeys.length : ''));
              total += keys.length;
              for (var c = 0; c < Math.max(keys.length, sKeys.length, rKeys.length); c += CHUNK) {
                (function (ch, sch, rch, first) {
                  p = p.then(function () {
                    status('키프레임 기록 중… ' + tg.name, 'busy', 3);
                    return host('Track_apply(' + literal({ track: tg.track, startSec: tg.startSec, keys: ch, scaleKeys: sch, rotKeys: rch, clear: first ? [t0, t1 + 0.5 / m.fps] : null }) + ')')
                      .then(function (r) { written += r.written; scaleWritten += r.scaleWritten || 0; rotWritten += r.rotWritten || 0; });
                  });
                }(keys.slice(c, c + CHUNK), sKeys.slice(c, c + CHUNK), rKeys.slice(c, c + CHUNK), c === 0));
              }
            });
            p.then(function () {
              log('write ' + (Date.now() - tW) + 'ms for ' + (written + scaleWritten + rotWritten) + ' keys');
              var lostNote = lost ? ', 놓친 프레임 ' + lost + '개 (첫 놓침 ' + fmtTc(lostAtSec, ctx.fps) + '. 그 지점에 재생 헤드를 두고 [다시 불러오기] → 핀 다시 꽂기 → 범위 「재생 헤드 뒤만」으로 실행하면 이어서 잡아요)' : '';
              var scaleNote = wantScale ? (scaleSeries ? ', 크기 ' + scaleWritten + '개' : ', 크기 변화 8% 미만이라 안 씀') : '';
              var rotNote = wantRot ? (rotSeries ? ', 회전 ' + rotWritten + '개' : ', 회전 3° 미만이라 안 씀') : '';
              var zoomNote = !lock ? '' : zoom > 1.0005 ? ', 가장자리 채움 확대 ' + Math.round(zoom * 100) + '%' + (zNeed > zoom + 0.0005 ? ' (상한 — 일부 가장자리는 비어요, 다 채우려면 ' + Math.round(zNeed * 100) + '%)' : '')
                : zNeed > 1.0005 ? ', 가장자리가 비는 구간 있음 (채우려면 확대 ' + Math.round(zNeed * 100) + '% — ' + (ui.fill.checked ? '범위 「전체」에서 자동 적용' : '「가장자리 채우기」 켜기') + ')' : '';
              state.busy = false;
              status((lock ? '고정 완료' : '완료') + (fwdOnly ? ' (' + fmtTc(P, ctx.fps) + ' 뒤만 다시 씀, 앞쪽 키 유지)' : '') + ' — 위치 키 ' + written + '개' + scaleNote + rotNote + zoomNote + (ctx.targets.length > 1 ? ' (대상 ' + ctx.targets.length + '개)' : '') + lostNote + (capped ? ' (구간이 길어 ' + Math.round(maxSeq) + '초로 제한)' : '') + '. 재생해서 확인하세요.', lost ? 'warning' : 'success', 3);
            }).catch(function (e) { state.busy = false; status('키프레임 기록 실패: ' + e.message, 'error', 3); });
          } catch (e2) { state.busy = false; status('추적 실패: ' + e2.message, 'error', 3); }
        }, 30);
      } catch (e3) { state.busy = false; status('영상 프레임 읽기 실패: ' + e3.message, 'error', 3); }
    }, 30);
  }

  // ---- 시작
  (function init() {
    render();
    if (!nodeRequire) { status('Node를 쓸 수 없는 패널이에요 (manifest --enable-nodejs 확인).', 'error', 1); return; }
    cp = nodeRequire('child_process'); fs = nodeRequire('fs'); os = nodeRequire('os'); path = nodeRequire('path');
    try {
      var home = os.homedir();
      var dir = path.join(home, 'Documents', 'Bobos'); try { fs.mkdirSync(dir); } catch (e0) {}
      logPath = path.join(dir, 'pin-log.txt');
    } catch (e) { logPath = null; }
    log('panel start ' + process.platform);
    $('log-btn').addEventListener('click', function () {   // 문의 대응용: 로그 폴더 열기 (맥 실기 때 사용자도 위치를 못 찾았다)
      if (!logPath) { status('로그 폴더를 만들지 못했어요 (문서 폴더 접근 권한을 확인하세요).', 'warning'); return; }
      try { cp.spawn(process.platform === 'win32' ? 'explorer.exe' : 'open', [path.dirname(logPath)], { detached: true, stdio: 'ignore' }).unref(); } catch (eL) { status('로그 위치: ' + logPath); }
    });
    ui.ff.addEventListener('click', function () {
      ui.ff.disabled = true;
      new Promise(function (res) { res(installFfmpeg()); }).then(function () { ui.ff.hidden = true; ready(); }, function (e) {
        ui.ff.disabled = false;
        status('ffmpeg 설치 실패: ' + (e.message || e) + ' — 인터넷 연결을 확인하고 다시 눌러 주세요. 계속 안 되면 ' + (process.platform === 'darwin' ? '터미널에서 brew install ffmpeg' : '명령 프롬프트에서 winget install ffmpeg') + ' 후 Premiere를 다시 시작하세요.', 'error', 1);
      });
    });
    ready();
  }());
  // 도구가 있으면 패널을 켜고, 없으면 설치 버튼을 보여준다. 설치가 끝나면 다시 불린다(프리미어 재시작 불필요 — 경로를 직접 확인하므로)
  function ready() {
    state.tool = { ffmpeg: findTool('ffmpeg'), ffprobe: findTool('ffprobe') };
    if (!state.tool.ffmpeg || !state.tool.ffprobe) {
      ui.ff.hidden = false; ui.ff.disabled = false;
      status('영상 프레임을 읽는 데 ffmpeg(무료)가 필요한데 이 컴퓨터에 없어요. [ffmpeg 설치]를 누르면 자동으로 받아 설치해요. (' + (process.platform === 'win32' ? '약 190MB' : '약 50MB') + ', 한 번만)', 'warning', 1);
      return;
    }
    log('ffmpeg=' + state.tool.ffmpeg);
    ui.ff.hidden = true;
    state.msgs[1] = null; render();
    var go = function () { hostReady().then(function (ok) { state.hostOk = ok; render(); if (ok) { refresh(true); } }); };
    if (bound) { go(); return; }
    bound = true;
    ui.refresh.addEventListener('click', function () { refresh(); });
    ui.load.addEventListener('click', function () { refresh(); });
    ui.run.addEventListener('click', run);
    ui.scale.addEventListener('change', onOptChange);
    ui.rot.addEventListener('change', onOptChange);
    ui.follow.addEventListener('change', onModeChange);
    ui.lock.addEventListener('change', onModeChange);
    [ui.fwd, ui.all].forEach(function (r) {   // 범위를 고르면 ③의 안내문이 뜻을 설명한다 (라디오는 새로 선택된 쪽에서만 change가 난다)
      r.addEventListener('change', function () { state.msgs[3] = null; render(); });
    });
    ui.img.addEventListener('load', layoutZoom);
    go();
  }
}());
