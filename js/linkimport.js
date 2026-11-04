// Bobos · 링크 임포트 탭 (구 Link Import v1.2.1 main.js — Bobos에선 탭을 처음 열 때 app.js가 불러온다. 로직은 그대로)
// Link Import — 패널 로직 (리디자인)
// 옴니박스(링크/검색 자동판별) · 액션 카드 · 다운로드 큐+히스토리 · 트랙 목적지 스냅샷

(function () {
  "use strict";

  // ---- CEP / Node 브릿지 ----------------------------------------------------
  function evalScript(script, cb) {
    window.__adobe_cep__.evalScript(script, cb || function () {});
  }
  var nodeRequire = (typeof cep_node !== "undefined" && cep_node.require)
    ? cep_node.require
    : (typeof require !== "undefined" ? require : null);

  var $ = function (id) { return document.getElementById(id); };
  var elOmni = $("omni");
  var elDestTimeline = $("destTimeline"), elDestProject = $("destProject");
  var elSeqName = $("seqName"), elVTrack = $("vTrack"), elATrack = $("aTrack");
  var elActionCard = $("actionCard"), elAcThumb = $("acThumb"), elAcTitle = $("acTitle"), elAcMeta = $("acMeta");
  var elSearchWrap = $("searchWrap"), elSearchHead = $("searchHead"), elResults = $("results");
  var elJobs = $("jobs"), elJobsHead = $("jobsHead");
  var elStatus = $("statusText");
  var elOverlay = $("previewOverlay"), elVideo = $("previewVideo"), elPvStatus = $("previewStatus");
  var elSecDisplay = $("secDisplay");
  var elPvBar = $("pvBar"), elPvSel = $("pvSel"), elPvHead = $("pvHead");

  function setStatus(msg, isErr) {
    elStatus.textContent = msg;
    elStatus.parentElement.className = "status" + (isErr ? " err" : "");
  }

  if (!nodeRequire) {
    setStatus("Node.js 사용 불가 — manifest의 --enable-nodejs 확인 필요", true);
    return;
  }

  var cp = nodeRequire("child_process");
  var fs = nodeRequire("fs");
  var path = nodeRequire("path");

  // ---- 실행 파일 경로 확인 ---------------------------------------------------
  var IS_WIN = process.platform === "win32";
  var EXE = IS_WIN ? ".exe" : "";
  var HOME = process.env.HOME || "";

  // macOS: CEP 패널은 launchd에서 뜨므로 PATH에 Homebrew 등이 없다 —
  // 자식 프로세스(yt-dlp가 ffmpeg/deno를 찾을 때 포함)를 위해 미리 보강
  if (!IS_WIN) {
    var extraPaths = [
      "/opt/homebrew/bin",            // Homebrew (Apple Silicon)
      "/usr/local/bin",               // Homebrew (Intel) / 수동 설치
      path.join(HOME, ".local", "bin"),  // pipx
      path.join(HOME, ".deno", "bin")    // deno 공식 설치 스크립트
    ];
    process.env.PATH = extraPaths.join(":") + ":" + (process.env.PATH || "");
  }

  var YTDLP = null, FFMPEG_DIR = null, NODE_EXE = null, DENO_EXE = null;

  function resolveExe(name, fallbacks) {
    try {
      var out = cp.execSync((IS_WIN ? "where " : "which ") + name, { encoding: "utf8" }).split(/\r?\n/)[0].trim();
      if (out && fs.existsSync(out)) return out;
    } catch (e) { /* PATH에 없음 */ }
    for (var i = 0; i < fallbacks.length; i++) {
      if (fs.existsSync(fallbacks[i])) return fallbacks[i];
    }
    return null;
  }

  function baseArgs() {
    var a = [];
    if (FFMPEG_DIR) a.push("--ffmpeg-location", FFMPEG_DIR);
    // deno 우선 (yt-dlp 공식 권장 — node는 실험 지원이라 유튜브 403 발생)
    if (DENO_EXE) a.push("--js-runtimes", "deno:" + DENO_EXE);
    else if (NODE_EXE) a.push("--js-runtimes", "node:" + NODE_EXE);
    return a;
  }

  function spawnYtdlp(args) {
    return cp.spawn(YTDLP, args, {
      env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" })
    });
  }

  // 유튜브: 최고화질 우선 + VP9 계열 제외 (h264/h265/AV1로도 최고화질 가능) + 오디오 aac 우선 (opus 회피)
  var YT_VIDEO_FORMAT = [
    "-f", "bv*[vcodec!~='vp0?9']+ba[acodec^=mp4a]/bv*[vcodec!~='vp0?9']+ba/b",
    "-S", "res,vcodec:h264,acodec:aac",
    "--merge-output-format", "mp4"
  ];
  // 인스타·틱톡 등: 코덱 제한 없이 무조건 최고화질 — VP9였으면 다운로드 후 h264로 자동 변환
  // (인스타는 1080p가 VP9로만 제공되므로 제외하면 저화질로 떨어짐 — 2026-07-27 확인)
  var GENERIC_VIDEO_FORMAT = [
    "-f", "bv*+ba/b",
    "-S", "res,br",
    "--merge-output-format", "mp4"
  ];

  function init() {
    if (IS_WIN) {
      var appData = process.env.APPDATA || "";
      var wingetLinks = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links");
      YTDLP = resolveExe("yt-dlp", [
        path.join(wingetLinks, "yt-dlp.exe"),
        path.join(appData, "Python", "Python314", "Scripts", "yt-dlp.exe"),
        path.join(appData, "Python", "Python313", "Scripts", "yt-dlp.exe")
      ]);
      var ffmpeg = resolveExe("ffmpeg", [path.join(wingetLinks, "ffmpeg.exe")]);
      if (ffmpeg) FFMPEG_DIR = path.dirname(ffmpeg);
      NODE_EXE = resolveExe("node", ["C:\\Program Files\\nodejs\\node.exe"]);
      DENO_EXE = resolveExe("deno", [
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "deno.exe")
      ]);
    } else {
      // macOS — PATH는 위에서 보강했으므로 which가 대부분 잡지만, 만약을 위한 폴백
      YTDLP = resolveExe("yt-dlp", [
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
        path.join(HOME, ".local", "bin", "yt-dlp")
      ]);
      var ffmpegMac = resolveExe("ffmpeg", [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg"
      ]);
      if (ffmpegMac) FFMPEG_DIR = path.dirname(ffmpegMac);
      NODE_EXE = resolveExe("node", [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node"
      ]);
      DENO_EXE = resolveExe("deno", [
        "/opt/homebrew/bin/deno",
        "/usr/local/bin/deno",
        path.join(HOME, ".deno", "bin", "deno")
      ]);
    }

    if (!YTDLP) {
      setStatus("yt-dlp를 찾을 수 없음 — 설치 후 패널을 다시 열어줘", true);
      return;
    }
    if (!DENO_EXE && !NODE_EXE) setStatus("경고: deno/node 없음 — 유튜브 다운로드 실패 가능", true);
    else if (!FFMPEG_DIR) setStatus("경고: ffmpeg 없음 — 병합/추출 실패 가능", true);
    else setStatus("준비 완료 · " + (DENO_EXE ? "deno" : "node"));

    refreshSequenceInfo();
    renderHistory();
  }

  // ---- 목적지 (시퀀스 트랙) --------------------------------------------------
  var destMode = "timeline"; // "timeline" | "project"
  var hasSequence = false;

  function currentDest() {
    return {
      insert: destMode === "timeline" && hasSequence,
      v: parseInt(elVTrack.value, 10) || 0,
      a: parseInt(elATrack.value, 10) || 0
    };
  }

  function setDestMode(mode) {
    destMode = mode;
    elDestTimeline.className = mode === "timeline" ? "on" : "";
    elDestProject.className = mode === "project" ? "on" : "";
  }
  elDestTimeline.addEventListener("click", function () { setDestMode("timeline"); });
  elDestProject.addEventListener("click", function () { setDestMode("project"); });

  function refreshSequenceInfo(cb) {
    evalScript("LI_getSequenceInfo()", function (result) {
      var info = null;
      try { if (result && result !== "null") info = JSON.parse(result); } catch (e) {}
      var prevV = elVTrack.value, prevA = elATrack.value;
      elVTrack.innerHTML = "";
      elATrack.innerHTML = "";
      hasSequence = !!info;
      if (info) {
        elSeqName.textContent = info.name;
        elSeqName.title = info.name;
        for (var v = 0; v < info.v; v++) {
          var ov = document.createElement("option");
          ov.value = v; ov.textContent = "V" + (v + 1);
          elVTrack.appendChild(ov);
        }
        for (var a = 0; a < info.a; a++) {
          var oa = document.createElement("option");
          oa.value = a; oa.textContent = "A" + (a + 1);
          elATrack.appendChild(oa);
        }
        if (prevV !== "" && prevV < info.v) elVTrack.value = prevV;
        if (prevA !== "" && prevA < info.a) elATrack.value = prevA;
      } else {
        elSeqName.textContent = "시퀀스 없음";
      }
      if (cb) cb(info);
    });
  }
  $("btnRefreshSeq").addEventListener("click", function () { refreshSequenceInfo(); });

  function getProjectDir(cb) {
    evalScript("LI_getProjectDir()", function (result) {
      cb(result && result !== "" && result !== "null" ? result : null);
    });
  }

  // ---- 공용 포맷터 -----------------------------------------------------------
  function fmtSec(s) {
    s = Math.floor(s);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function fmtDuration(sec) {
    if (!sec && sec !== 0) return "";
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h > 0 && m < 10 ? "0" : "") + m;
    var ss = (s < 10 ? "0" : "") + s;
    return (h > 0 ? h + ":" : "") + mm + ":" + ss;
  }
  function fmtViews(n) {
    if (!n && n !== 0) return "";
    if (n >= 100000000) return (n / 100000000).toFixed(1) + "억회";
    if (n >= 10000) return (n / 10000).toFixed(1) + "만회";
    return n + "회";
  }
  function fmtClock(ts) {
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  function destLabel(dest) {
    return dest.insert ? "V" + (dest.v + 1) + "/A" + (dest.a + 1) : "프로젝트";
  }

  // ---- 히스토리 (localStorage) -----------------------------------------------
  var HISTORY_KEY = "li_history";

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveToHistory(entry) {
    var h = loadHistory();
    h = h.filter(function (x) { return x.filePath !== entry.filePath; });
    h.unshift(entry);
    if (h.length > 20) h = h.slice(0, 20);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
  }
  function renderHistory() {
    loadHistory().forEach(function (h) {
      if (!fs.existsSync(h.filePath)) return;
      addDoneCard(h, true);
    });
    updateJobsHead();
  }
  $("btnClearHistory").addEventListener("click", function () {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
    Array.prototype.slice.call(elJobs.querySelectorAll(".job[data-done='1']")).forEach(function (n) {
      elJobs.removeChild(n);
    });
    updateJobsHead();
  });

  function updateJobsHead() {
    elJobsHead.style.display = elJobs.children.length > 0 ? "flex" : "none";
  }

  // ---- 작업 카드 -------------------------------------------------------------
  function makeJobCard(title, thumb) {
    var card = document.createElement("div");
    card.className = "job";
    var img = document.createElement("img");
    if (thumb) img.src = thumb;
    img.onerror = function () { img.style.visibility = "hidden"; };
    var body = document.createElement("div");
    body.className = "body";
    var t = document.createElement("div");
    t.className = "title";
    t.textContent = title;
    var bar = document.createElement("div");
    bar.className = "bar";
    var barFill = document.createElement("div");
    bar.appendChild(barFill);
    var sub = document.createElement("div");
    sub.className = "sub";
    body.appendChild(t); body.appendChild(bar); body.appendChild(sub);
    var side = document.createElement("div");
    side.className = "side";
    card.appendChild(img); card.appendChild(body); card.appendChild(side);
    return { card: card, img: img, title: t, bar: bar, barFill: barFill, sub: sub, side: side };
  }

  // 완료(히스토리) 카드 — "다시 임포트" 버튼 포함
  function addDoneCard(entry, append) {
    var ui = makeJobCard(entry.title, entry.thumb);
    ui.card.setAttribute("data-done", "1");
    ui.bar.style.display = "none";
    ui.sub.className = "sub ok";
    ui.sub.textContent = (entry.kind === "audio" ? "오디오" : "비디오") +
      (entry.quality ? " · " + entry.quality : "") +
      (entry.ts ? " · " + fmtClock(entry.ts) : "");
    var btn = document.createElement("button");
    btn.textContent = "다시 임포트";
    btn.addEventListener("click", function () {
      if (!fs.existsSync(entry.filePath)) {
        ui.sub.className = "sub err";
        ui.sub.textContent = "파일이 없어졌어: " + entry.filePath;
        return;
      }
      refreshSequenceInfo(function () {
        importToPremiere(entry.filePath, currentDest(), function (msg, ok) {
          ui.sub.className = "sub " + (ok ? "ok" : "err");
          ui.sub.textContent = msg;
        });
      });
    });
    ui.side.appendChild(btn);
    if (append) elJobs.appendChild(ui.card);
    else elJobs.insertBefore(ui.card, elJobs.firstChild);
    updateJobsHead();
  }

  // ---- 임포트 ----------------------------------------------------------------
  function importToPremiere(filePath, dest, done) {
    // URI 인코딩(ASCII만 통과)으로 한글 경로가 evalScript 계층에서 깨지는 것 방지
    var enc = encodeURIComponent(filePath.replace(/\\/g, "/"));
    var call = 'LI_importFile("' + enc + '","' + (dest.insert ? "1" : "0") + '","' +
               dest.v + '","' + dest.a + '")';
    evalScript(call, function (result) {
      if (result === "ok") done("✔ 프로젝트에 임포트 완료", true);
      else if (result === "ok:inserted") done("✔ " + destLabel(dest) + " 삽입 완료", true);
      else if (result === "ok:no-seq") done("✔ 임포트 완료 (시퀀스 없어 삽입 생략)", true);
      else if (result === "ok:no-item") done("✔ 임포트 완료 (아이템 탐색 실패로 삽입 생략)", true);
      else if (result && result.indexOf("ok:insert-fail") === 0) done("임포트됨 · 삽입 실패: " + result.slice(15), false);
      else done("임포트 실패: " + result, false);
    });
  }

  // 비디오 스트림 코덱 조회 (ffprobe)
  function probeVcodec(file, cb) {
    if (!FFMPEG_DIR) { cb(""); return; }
    cp.execFile(
      path.join(FFMPEG_DIR, "ffprobe" + EXE),
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file],
      function (err, stdout) { cb(err ? "" : String(stdout).trim()); }
    );
  }

  // 다운로드된 파일 후처리: 구간 잘라내기 + VP9→h264 변환(Premiere 호환) 후 임포트
  function processAndImport(srcPath, job, ui, entryBase) {
    var section = job.section;

    function finish(p, extraQ) {
      importToPremiere(p, job.dest, function (msg, ok) {
        ui.sub.className = "sub " + (ok ? "ok" : "err");
        var q = entryBase.quality ? " · " + entryBase.quality + (extraQ || "") : "";
        ui.sub.textContent = msg + q;
        if (ok) {
          finalizeDone(ui, Object.assign({}, entryBase, {
            filePath: p,
            quality: (entryBase.quality || "") + (extraQ || "")
          }));
        }
      });
    }

    function run(needsTranscode) {
      if (!section && !needsTranscode) { finish(srcPath, ""); return; }

      var srcExt = path.extname(srcPath);
      var ext = needsTranscode ? ".mp4" : srcExt;
      var suffix = "";
      if (section) {
        var s = Math.floor(section.start || 0);
        var e = section.end != null ? Math.ceil(section.end) : null;
        suffix += " " + s + "s-" + (e != null ? e + "s" : "end");
      }
      if (needsTranscode) suffix += " h264";
      var outPath = srcPath.slice(0, -srcExt.length) + suffix + ext;
      var extraQ = needsTranscode ? " → h264" : "";

      if (fs.existsSync(outPath)) { finish(outPath, extraQ); return; }
      if (!FFMPEG_DIR) { finish(srcPath, ""); return; }

      ui.sub.textContent = needsTranscode
        ? "h264 변환 중… (Premiere 호환용)" + (section ? " · 구간만" : "")
        : "구간 잘라내는 중…";

      var ffArgs = ["-y", "-v", "error"];
      if (section) {
        var ss = Math.floor(section.start || 0);
        ffArgs.push("-ss", String(ss));
        if (section.end != null) ffArgs.push("-t", String(Math.max(1, Math.ceil(section.end) - ss)));
      }
      ffArgs.push("-i", srcPath);
      if (needsTranscode) ffArgs.push("-c:v", "libx264", "-crf", "16", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k");
      else ffArgs.push("-c", "copy");
      ffArgs.push(outPath);

      var ff = cp.spawn(path.join(FFMPEG_DIR, "ffmpeg" + EXE), ffArgs);
      ff.on("error", function () { finish(srcPath, ""); });
      ff.on("close", function (code) {
        if (code === 0 && fs.existsSync(outPath)) finish(outPath, extraQ);
        else {
          ui.sub.textContent = "후처리 실패 — 원본 파일 임포트";
          finish(srcPath, "");
        }
      });
    }

    if (job.kind === "video") {
      // VP9(인스타)와 AV1(유튜브 4K)은 Premiere가 디코딩 못 함 → h264로 변환
      probeVcodec(srcPath, function (vc) { run(/^(vp0?9|av0?1)/i.test(vc)); });
    } else {
      run(false);
    }
  }

  // 완료 처리: 히스토리 저장 + 카드에 "다시 임포트" 추가
  function finalizeDone(ui, entry) {
    entry.ts = Date.now();
    saveToHistory(entry);
    ui.card.setAttribute("data-done", "1");
    ui.bar.style.display = "none";
    ui.side.innerHTML = "";
    var btn = document.createElement("button");
    btn.textContent = "다시 임포트";
    btn.addEventListener("click", function () {
      refreshSequenceInfo(function () {
        importToPremiere(entry.filePath, currentDest(), function (msg, ok) {
          ui.sub.className = "sub " + (ok ? "ok" : "err");
          ui.sub.textContent = msg;
        });
      });
    });
    ui.side.appendChild(btn);
  }

  // ---- 다운로드 큐 -----------------------------------------------------------
  var MAX_CONCURRENT = 2;
  var activeCount = 0;
  var pendingQueue = [];

  // opts: {url, kind, section, title, thumb}
  function enqueueJob(opts) {
    refreshSequenceInfo(function () {
      var job = {
        url: opts.url,
        kind: opts.kind,
        section: opts.section || null,
        title: opts.title || opts.url,
        thumb: opts.thumb || "",
        dest: currentDest(),
        quality: "",
        child: null,
        canceled: false
      };
      var ui = makeJobCard(job.title, job.thumb);
      job.ui = ui;
      var secMsg = job.section ? " · 구간 " + fmtSec(job.section.start) +
        "~" + (job.section.end != null ? fmtSec(job.section.end) : "끝") : "";
      ui.sub.textContent = "대기 중 · " + destLabel(job.dest) + secMsg;
      var cancel = document.createElement("span");
      cancel.className = "cancel";
      cancel.textContent = "✕";
      cancel.title = "취소";
      cancel.addEventListener("click", function () {
        job.canceled = true;
        if (job.child) { try { job.child.kill(); } catch (e) {} }
        var idx = pendingQueue.indexOf(job);
        if (idx >= 0) pendingQueue.splice(idx, 1);
        ui.sub.className = "sub err";
        ui.sub.textContent = "취소됨";
        ui.bar.style.display = "none";
        ui.side.innerHTML = "";
      });
      ui.side.appendChild(cancel);
      elJobs.insertBefore(ui.card, elJobs.firstChild);
      updateJobsHead();
      pendingQueue.push(job);
      pump();
    });
  }

  function pump() {
    while (activeCount < MAX_CONCURRENT && pendingQueue.length > 0) {
      runJob(pendingQueue.shift());
    }
  }

  function runJob(job) {
    if (job.canceled) { pump(); return; }
    activeCount++;
    var ui = job.ui;

    getProjectDir(function (projDir) {
      if (!projDir) {
        activeCount--;
        ui.sub.className = "sub err";
        ui.sub.textContent = "프로젝트를 먼저 저장/열어줘 (저장 위치를 알 수 없음)";
        pump();
        return;
      }
      var outDir = path.join(projDir, "_downloads");
      try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir); } catch (e) {
        activeCount--;
        ui.sub.className = "sub err";
        ui.sub.textContent = "폴더 생성 실패: " + outDir;
        pump();
        return;
      }

      // 구간 지정 시에도 전체본을 받은 뒤 로컬에서 잘라낸다 (전체본은 재사용됨)
      var args = [
        job.url,
        "-P", outDir,
        "-o", "%(title).80s [%(id)s].%(ext)s",
        "--windows-filenames",
        "--no-playlist",
        "--newline",
        "--no-simulate",
        "--progress",
        "--print", "after_move:ID::%(id)s",
        "--print", "after_move:▶%(resolution)s %(vcodec).15s"
      ].concat(baseArgs());
      if (job.kind === "audio") args.push("-x", "--audio-format", "wav");
      else if (/youtube\.com|youtu\.be/i.test(job.url)) args = args.concat(YT_VIDEO_FORMAT);
      else args = args.concat(GENERIC_VIDEO_FORMAT);

      ui.sub.className = "sub";
      ui.sub.textContent = "다운로드 중 · " + destLabel(job.dest);

      var child = spawnYtdlp(args);
      job.child = child;
      var ids = [];
      var stderrTail = "";

      function noteId(id) {
        if (id && ids.indexOf(id) < 0) ids.push(id);
      }

      // 영상 ID(ASCII)로 실제 파일을 fs에서 직접 찾는다 —
      // yt-dlp stdout의 한글 경로는 환경에 따라 인코딩이 깨질 수 있음 (fs는 안 깨짐)
      function filesForIds() {
        var names;
        try { names = fs.readdirSync(outDir); } catch (e) { return []; }
        var extRe = job.kind === "audio" ? /\.wav$/i : /\.(mp4|mkv|mov|webm)$/i;
        var out = [];
        ids.forEach(function (id) {
          var esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          var exact = new RegExp("\\[" + esc + "\\]" + (job.kind === "audio" ? "\\.wav$" : "\\.(mp4|mkv|mov|webm)$"), "i");
          var found = null;
          for (var i = 0; i < names.length; i++) {
            if (exact.test(names[i])) { found = names[i]; break; }
          }
          if (!found) {
            for (var j = 0; j < names.length; j++) {
              var n = names[j];
              if (n.indexOf("[" + id + "]") >= 0 && extRe.test(n) &&
                  !/ \d+s-(\d+s|end)/.test(n) && n.indexOf(" h264") < 0 && !/\.part$/i.test(n)) {
                found = n;
                break;
              }
            }
          }
          if (found) out.push(path.join(outDir, found));
        });
        return out;
      }

      child.stdout.on("data", function (data) {
        String(data).split(/\r?\n/).forEach(function (line) {
          line = line.trim();
          if (!line) return;
          var m = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)%/);
          if (m) {
            ui.barFill.style.width = m[1] + "%";
            ui.sub.textContent = m[1] + "% · " + destLabel(job.dest);
            return;
          }
          if (line.indexOf("ID::") === 0) { noteId(line.slice(4).trim()); return; }
          // 이미 받아둔 파일 안내 라인 — 파일명 속 [id]만 추출 (ASCII라 인코딩 무관)
          var dup = line.match(/\[([\w-]{5,})\]\.[A-Za-z0-9]+ has already been downloaded/);
          if (dup) { noteId(dup[1]); return; }
          if (line.charAt(0) === "▶") {
            job.quality = line.slice(1).replace(/\s+none$/, "").trim();
            return;
          }
          if (/^\[(ExtractAudio|Merger|VideoRemuxer)\]/.test(line)) ui.sub.textContent = "변환 중…";
        });
      });

      child.stderr.on("data", function (data) {
        stderrTail = (stderrTail + String(data)).slice(-1500);
      });

      child.on("error", function (err) {
        activeCount--;
        ui.sub.className = "sub err";
        ui.sub.textContent = "실행 실패: " + err.message;
        pump();
      });

      child.on("close", function (code) {
        activeCount--;
        pump();
        if (job.canceled) return;
        ui.barFill.style.width = "100%";

        function handleFile(f) {
          var entryBase = {
            url: job.url, title: job.title, thumb: job.thumb,
            kind: job.kind, quality: job.quality, filePath: f
          };
          processAndImport(f, job, ui, entryBase);
        }

        var files = filesForIds();
        if (code === 0 && files.length > 0) {
          files.forEach(handleFile);
        } else {
          // 파일 잠김(WinError 32) 등: 오류 메시지 속 [id]로 기존 파일 재탐색 후 재사용
          var m2 = stderrTail.match(/\[([\w-]{5,})\]\s*[\w-]*\.[A-Za-z0-9]+/);
          if (m2) {
            noteId(m2[1]);
            var retry = filesForIds();
            if (retry.length > 0) { retry.forEach(handleFile); return; }
          }
          ui.sub.className = "sub err";
          var errLine = (stderrTail.match(/ERROR:[^\r\n]*/) || [])[0];
          ui.sub.textContent = errLine || ("다운로드 실패 (코드 " + code + ")");
          ui.bar.style.display = "none";
        }
      });
    });
  }

  // ---- 액션 카드 (붙여넣은 링크) ----------------------------------------------
  var acState = { url: null, meta: null, token: 0 };

  function closeActionCard() {
    acState.url = null;
    elActionCard.classList.remove("on");
  }
  $("acClose").addEventListener("click", closeActionCard);

  function showActionCard(url) {
    var token = ++acState.token;
    acState.url = url;
    acState.meta = null;
    elAcThumb.removeAttribute("src");
    elAcThumb.style.visibility = "hidden";
    elAcTitle.textContent = "정보 가져오는 중…";
    try { elAcMeta.textContent = url.split("/")[2] || ""; } catch (e) { elAcMeta.textContent = ""; }
    elActionCard.classList.add("on");

    var child = spawnYtdlp([url, "-J", "--no-playlist", "--no-warnings"].concat(baseArgs()));
    var out = "";
    child.stdout.on("data", function (d) { out += String(d); });
    child.on("close", function (code) {
      if (token !== acState.token || acState.url !== url) return; // 다른 링크로 교체됨
      var meta = null;
      try { meta = JSON.parse(out); } catch (e) {}
      if (code !== 0 || !meta) {
        elAcTitle.textContent = url;
        elAcMeta.textContent = "정보 조회 실패 — 그래도 다운로드는 시도할 수 있어";
        return;
      }
      acState.meta = meta;
      elAcTitle.textContent = meta.title || url;
      var host = meta.extractor_key || "";
      elAcMeta.textContent = [host, fmtDuration(meta.duration), meta.uploader || meta.channel || ""]
        .filter(Boolean).join(" · ");
      var thumb = meta.thumbnail ||
        (meta.thumbnails && meta.thumbnails.length ? meta.thumbnails[meta.thumbnails.length - 1].url : "");
      if (thumb) {
        elAcThumb.src = thumb;
        elAcThumb.style.visibility = "visible";
      }
    });
  }

  function acJob(kind, section) {
    if (!acState.url) return;
    enqueueJob({
      url: acState.url,
      kind: kind,
      section: section || null,
      title: (acState.meta && acState.meta.title) || acState.url,
      thumb: (acState.meta && (acState.meta.thumbnail ||
        (acState.meta.thumbnails && acState.meta.thumbnails.length
          ? acState.meta.thumbnails[acState.meta.thumbnails.length - 1].url : ""))) || ""
    });
    closeActionCard();
  }
  $("acVideo").addEventListener("click", function () { acJob("video"); });
  $("acAudio").addEventListener("click", function () { acJob("audio"); });
  $("acSection").addEventListener("click", function () {
    if (!acState.url) return;
    openPreview(acState.url, (acState.meta && acState.meta.title) || acState.url,
      (elAcThumb.getAttribute("src") || ""));
  });

  // ---- 유튜브 검색 (페이지네이션) ---------------------------------------------
  var PAGE_SIZE = 10;
  var searchState = { query: "", count: 0, busy: false, exhausted: false };
  var elMoreBtn = null;

  function closeSearch() {
    elSearchWrap.classList.remove("on");
    elResults.innerHTML = "";
    searchState.query = "";
  }
  $("searchClose").addEventListener("click", closeSearch);

  function search(q, append) {
    if (searchState.busy) return;
    if (!append) {
      searchState.query = q;
      searchState.count = 0;
      searchState.exhausted = false;
      elResults.innerHTML = "";
      elSearchHead.textContent = '"' + q + '" 검색 결과';
      elSearchWrap.classList.add("on");
    }
    searchState.busy = true;
    setStatus("검색 중…");

    var start = searchState.count + 1;
    var end = searchState.count + PAGE_SIZE;
    var args = [
      "ytsearch" + end + ":" + searchState.query,
      "--playlist-items", start + ":" + end,
      "--flat-playlist", "-J", "--no-warnings"
    ].concat(baseArgs());

    var child = spawnYtdlp(args);
    var out = "";
    child.stdout.on("data", function (d) { out += String(d); });
    child.on("close", function (code) {
      searchState.busy = false;
      setStatus("준비 완료 · " + (DENO_EXE ? "deno" : "node"));
      if (code !== 0) { setStatus("검색 실패 (코드 " + code + ")", true); return; }
      var entries = [];
      try { entries = (JSON.parse(out).entries || []); } catch (e) {
        setStatus("검색 결과 파싱 실패", true);
        return;
      }
      searchState.count += entries.length;
      if (entries.length < PAGE_SIZE) searchState.exhausted = true;
      if (entries.length === 0 && searchState.count === 0) {
        setStatus("검색 결과 없음: " + searchState.query, true);
        return;
      }
      renderResults(entries);
    });
  }

  function renderResults(entries) {
    if (elMoreBtn && elMoreBtn.parentElement) elMoreBtn.parentElement.removeChild(elMoreBtn);
    entries.forEach(function (e) {
      if (!e || !e.id) return;
      var url = "https://www.youtube.com/watch?v=" + e.id;
      var thumb = "https://i.ytimg.com/vi/" + e.id + "/mqdefault.jpg";
      var title = e.title || "(제목 없음)";

      var row = document.createElement("div");
      row.className = "result";
      var img = document.createElement("img");
      img.src = thumb;
      img.title = "클릭하면 미리보기";
      img.addEventListener("click", function () { openPreview(url, title, thumb); });
      var info = document.createElement("div");
      info.className = "info";
      var t = document.createElement("div");
      t.className = "title";
      t.textContent = title;
      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [e.channel || "", fmtDuration(e.duration), fmtViews(e.view_count)]
        .filter(Boolean).join(" · ");
      var acts = document.createElement("div");
      acts.className = "acts";
      var bPv = document.createElement("button");
      bPv.textContent = "미리보기";
      bPv.addEventListener("click", function () { openPreview(url, title, thumb); });
      var bV = document.createElement("button");
      bV.textContent = "비디오";
      bV.addEventListener("click", function () { enqueueJob({ url: url, kind: "video", title: title, thumb: thumb }); });
      var bA = document.createElement("button");
      bA.textContent = "오디오";
      bA.addEventListener("click", function () { enqueueJob({ url: url, kind: "audio", title: title, thumb: thumb }); });
      acts.appendChild(bPv); acts.appendChild(bV); acts.appendChild(bA);
      info.appendChild(t); info.appendChild(meta); info.appendChild(acts);
      row.appendChild(img); row.appendChild(info);
      elResults.appendChild(row);
    });

    if (!searchState.exhausted) {
      elMoreBtn = document.createElement("button");
      elMoreBtn.textContent = "결과 더 보기 (" + searchState.count + "개 로드됨)";
      elMoreBtn.style.width = "100%";
      elMoreBtn.addEventListener("click", function () {
        elMoreBtn.disabled = true;
        elMoreBtn.textContent = "불러오는 중…";
        search(searchState.query, true);
      });
      elResults.appendChild(elMoreBtn);
    }
  }

  // ---- 미리보기 --------------------------------------------------------------
  var pv = { url: null, title: "", thumb: "", proc: null, local: false };
  var secStart = null, secEnd = null;

  function updateSecDisplay() {
    if (secStart == null && secEnd == null) {
      elSecDisplay.textContent = "전체";
    } else {
      elSecDisplay.textContent =
        (secStart != null ? fmtSec(secStart) : "0:00") + " → " +
        (secEnd != null ? fmtSec(secEnd) : "끝");
    }
    var dur = elVideo.duration;
    if (!dur || !isFinite(dur) || (secStart == null && secEnd == null)) {
      elPvSel.style.display = "none";
      return;
    }
    var s = secStart != null ? secStart : 0;
    var e = secEnd != null ? secEnd : dur;
    elPvSel.style.left = (s / dur * 100) + "%";
    elPvSel.style.width = (Math.max(0, e - s) / dur * 100) + "%";
    elPvSel.style.display = "block";
  }

  function currentSection() {
    if (secStart == null && secEnd == null) return null;
    return { start: secStart != null ? secStart : 0, end: secEnd };
  }

  elVideo.addEventListener("timeupdate", function () {
    var dur = elVideo.duration;
    if (dur && isFinite(dur)) elPvHead.style.left = (elVideo.currentTime / dur * 100) + "%";
  });
  elVideo.addEventListener("loadedmetadata", updateSecDisplay);
  elPvBar.addEventListener("click", function (ev) {
    var dur = elVideo.duration;
    if (!dur || !isFinite(dur)) return;
    var rect = elPvBar.getBoundingClientRect();
    var ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    elVideo.currentTime = ratio * dur;
  });

  /* 미리보기 (Bobos 1.0.1 수정)
   * 1단계: 영상+소리가 합쳐진 저화질 스트림 주소(-g)를 바로 재생 — 빠름
   * 2단계: 1단계가 안 되면 480p 미리보기 파일을 임시 폴더(%TEMP%\bobos-preview)에 받아서 재생
   *   요즘 유튜브는 합쳐진 저화질 파일(18번 등)을 거의 주지 않고 영상·소리를 따로 준다 → 1단계가
   *   "Requested format is not available"로 실패하던 문제 (2026-10-04 실기 + --load-info-json 재현)
   *   스트림 주소가 m3u8(HLS)이거나 CEF에서 403으로 안 열려도 2단계로 넘어간다.
   * 3단계: 받은 mp4(H.264)를 이 환경이 못 틀면 webm(VP9/AV1+Opus)으로 한 번 더 받아 본다.
   * 미리보기 파일은 영상 전체 길이라 I/O로 찍은 시각이 원본과 같다. 하루 지난 파일은 자동 정리. */
  var PREVIEW_HINT = "I 시작 · O 끝 · Space 재생 · 타임라인 바 클릭으로 이동";
  var pvToken = 0;

  function pvShowError(msg) { elPvStatus.textContent = msg; elPvStatus.className = "err"; }
  function lastYtError(stderr) {
    var m = String(stderr || "").match(/ERROR:[^\r\n]*/g);
    return m ? m[m.length - 1].replace(/^ERROR:\s*/, "") : "";
  }
  function fileUrl(p) { return "file:///" + encodeURI(p.replace(/\\/g, "/").replace(/^\/+/, "")); }

  function previewDir() {
    var d = path.join(nodeRequire("os").tmpdir(), "bobos-preview");
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
    try {
      var now = Date.now();
      fs.readdirSync(d).forEach(function (n) {
        var p = path.join(d, n);
        try { if (now - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch (e2) {}
      });
    } catch (e3) {}
    return d;
  }
  function findPreview(dir, base) {
    try {
      var names = fs.readdirSync(dir);
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        // base.mp4 / base.webm 만 — 병합 전 조각(base.f135.mp4)·받는 중(.part)은 제외
        if (n.indexOf(base + ".") === 0 && /\.(mp4|webm|mkv)$/i.test(n) && !/\.part$/i.test(n) && !/\.f\d+\./i.test(n)) return path.join(dir, n);
      }
    } catch (e) {}
    return null;
  }

  function playLocal(p, token, webm) {
    if (token !== pvToken || !elOverlay.classList.contains("on")) return;
    pv.local = webm ? "webm" : "mp4";
    elPvStatus.textContent = PREVIEW_HINT;
    elPvStatus.className = "";
    elVideo.src = fileUrl(p);
    elVideo.play().catch(function () {});
  }

  function previewByDownload(url, token, webm) {
    if (token !== pvToken || !elOverlay.classList.contains("on")) return;
    var dir = previewDir();
    var base = "pv-" + nodeRequire("crypto").createHash("sha1").update(url).digest("hex").slice(0, 12) + (webm ? "-w" : "");
    var have = findPreview(dir, base);
    if (have) { playLocal(have, token, webm); return; }

    var fmt = webm
      ? "bv*[height<=480][vcodec~='^(vp0?9|av01)']+ba[acodec=opus]/bv*[vcodec~='^(vp0?9|av01)']+ba[acodec=opus]"
      : "bv*[height<=480][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=480]+ba/b[height<=480]/wv*+wa/w";
    var args = [
      url, "-f", fmt,
      "--merge-output-format", webm ? "webm" : "mp4",
      "-P", dir, "-o", base + ".%(ext)s",
      "--no-playlist", "--newline", "--progress", "--no-warnings"
    ].concat(baseArgs());

    pv.local = "dl";
    elPvStatus.className = "";
    elPvStatus.textContent = "미리보기용 저화질 영상 받는 중…";
    var child = spawnYtdlp(args);
    pv.proc = child;
    var err = "", done = false;
    child.stdout.on("data", function (d) {
      if (token !== pvToken) return;
      var m = String(d).match(/\[download\]\s+(\d+(?:\.\d+)?)%/g);
      if (m) {
        var pct = Math.floor(parseFloat(m[m.length - 1].replace(/[^\d.]/g, "")));
        elPvStatus.textContent = "미리보기용 저화질 영상 받는 중… " + pct + "%";
      }
    });
    child.stderr.on("data", function (d) { err = (err + String(d)).slice(-1500); });
    function finish(code) {
      if (done) return;
      done = true;
      if (token !== pvToken || !elOverlay.classList.contains("on")) return;
      var f = findPreview(dir, base);
      if (code === 0 && f) { playLocal(f, token, webm); return; }
      var why = lastYtError(err);
      pvShowError("미리보기를 못 불러왔어" + (why ? " (" + why.slice(0, 140) + ")" : "") +
        " — yt-dlp를 업데이트하고 다시 해보거나 '브라우저' 버튼을 써줘");
    }
    child.on("error", function (e) { err += "\nERROR: " + e.message; finish(-1); });
    child.on("close", finish);
  }

  function openPreview(url, title, thumb) {
    pv.url = url; pv.title = title || url; pv.thumb = thumb || ""; pv.local = false;
    secStart = null; secEnd = null;
    elPvHead.style.left = "0%";
    updateSecDisplay();
    elVideo.removeAttribute("src");
    elVideo.load();
    elPvStatus.textContent = "미리보기 불러오는 중…";
    elPvStatus.className = "";
    elOverlay.classList.add("on");

    var token = ++pvToken;
    var args = [
      url,
      "-f", "b*[vcodec!=none][acodec!=none][height<=480]/18/b",
      "-g", "--no-playlist", "--no-warnings"
    ].concat(baseArgs());

    if (pv.proc) { try { pv.proc.kill(); } catch (e) {} }
    var child = spawnYtdlp(args);
    pv.proc = child;
    var out = "", fell = false;
    function fallback() { if (fell) return; fell = true; previewByDownload(url, token, false); }
    child.stdout.on("data", function (d) { out += String(d); });
    child.on("error", fallback);
    child.on("close", function (code) {
      if (fell || token !== pvToken || !elOverlay.classList.contains("on")) return;
      var streamUrl = out.split(/\r?\n/).filter(Boolean)[0];
      // 합쳐진 저화질 파일이 없거나(유튜브 대부분) HLS 목록 주소면 CEF에서 못 트니 바로 2단계로
      if (code !== 0 || !streamUrl || /\.m3u8|\/manifest\//i.test(streamUrl)) { fallback(); return; }
      fell = true;
      elPvStatus.textContent = PREVIEW_HINT;
      elVideo.src = streamUrl;
      elVideo.play().catch(function () {});
    });
  }

  function closePreview() {
    pvToken++;
    if (pv.proc) { try { pv.proc.kill(); } catch (e) {} pv.proc = null; }
    elVideo.pause();
    elVideo.removeAttribute("src");
    elVideo.load();
    elOverlay.classList.remove("on");
  }

  elVideo.addEventListener("error", function () {
    if (!elOverlay.classList.contains("on") || !elVideo.getAttribute("src") || pv.local === "dl") return;
    if (!pv.local) { previewByDownload(pv.url, pvToken, false); return; }      // 스트림 주소가 이 환경에서 안 열림(403 등) → 파일로
    if (pv.local === "mp4") { previewByDownload(pv.url, pvToken, true); return; } // H.264를 못 트는 환경 → webm으로 한 번 더
    pvShowError("이 환경에서 재생할 수 없는 영상이야 — '브라우저' 버튼을 사용해줘");
  });

  function pvSetStart() {
    secStart = elVideo.currentTime || 0;
    if (secEnd != null && secEnd <= secStart) secEnd = null;
    updateSecDisplay();
  }
  function pvSetEnd() {
    secEnd = elVideo.currentTime || 0;
    if (secStart != null && secEnd <= secStart) secStart = null;
    updateSecDisplay();
  }
  $("btnSecStart").addEventListener("click", pvSetStart);
  $("btnSecEnd").addEventListener("click", pvSetEnd);
  $("btnSecClear").addEventListener("click", function () {
    secStart = null; secEnd = null;
    updateSecDisplay();
  });

  function pvDownload(kind) {
    if (!pv.url) return;
    var sec = currentSection();
    var opts = { url: pv.url, kind: kind, section: sec, title: pv.title, thumb: pv.thumb };
    closePreview();
    closeActionCard();
    enqueueJob(opts);
  }
  $("btnPvClose").addEventListener("click", closePreview);
  $("btnPvVideo").addEventListener("click", function () { pvDownload("video"); });
  $("btnPvAudio").addEventListener("click", function () { pvDownload("audio"); });
  $("btnPvBrowser").addEventListener("click", function () {
    if (pv.url && window.cep && window.cep.util) {
      window.cep.util.openURLInDefaultBrowser(pv.url);
    }
  });

  // 편집자 단축키: I=시작, O=끝, Space=재생/정지, Esc=닫기
  document.addEventListener("keydown", function (e) {
    if (!elOverlay.classList.contains("on")) return;
    var k = e.key.toLowerCase();
    if (k === "i") { pvSetStart(); e.preventDefault(); }
    else if (k === "o") { pvSetEnd(); e.preventDefault(); }
    else if (k === " ") {
      if (elVideo.paused) elVideo.play().catch(function () {});
      else elVideo.pause();
      e.preventDefault();
    }
    else if (k === "escape") { closePreview(); }
  });

  // ---- 옴니박스 --------------------------------------------------------------
  function isUrl(s) { return /^https?:\/\//i.test(s); }

  function handleOmni() {
    var v = elOmni.value.trim();
    if (!v) return;
    if (isUrl(v)) {
      showActionCard(v);
      elOmni.value = "";
    } else {
      search(v, false);
    }
  }
  elOmni.addEventListener("keydown", function (e) {
    if (e.key === "Enter") handleOmni();
  });
  elOmni.addEventListener("paste", function () {
    setTimeout(function () {
      var v = elOmni.value.trim();
      if (isUrl(v)) {
        showActionCard(v);
        elOmni.value = "";
      }
    }, 50);
  });

  init();
})();
