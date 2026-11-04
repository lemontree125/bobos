// Bobos — Premiere Pro 호스트 스크립트 (ExtendScript)
// 링크 임포트(LI_*) + 트래킹(TrackHost / Track_*) 를 한 파일로 합친 것. 두 쪽 함수 이름은 겹치지 않는다.

// ====================== 링크 임포트 ======================
// Link Import — Premiere Pro 호스트 스크립트 (ExtendScript)

// 현재 열린 프로젝트의 폴더 경로 반환 (저장 안 된 프로젝트면 "")
function LI_getProjectDir() {
    try {
        if (!app.project || !app.project.path || app.project.path === "") return "";
        var f = new File(app.project.path);
        return f.parent.fsName;
    } catch (e) {
        return "";
    }
}

// 활성 시퀀스의 트랙 정보 반환: {"name":..,"v":비디오트랙수,"a":오디오트랙수} / 없으면 ""
function LI_getSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "";
        var name = String(seq.name).replace(/\\/g, "").replace(/"/g, "'");
        return '{"name":"' + name + '","v":' + seq.videoTracks.numTracks + ',"a":' + seq.audioTracks.numTracks + '}';
    } catch (e) {
        return "";
    }
}

// 미디어 경로로 프로젝트 아이템 재귀 탐색
function LI_findItemByPath(bin, fsPath) {
    var lower = fsPath.toLowerCase();
    for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) {
            var found = LI_findItemByPath(it, fsPath);
            if (found) return found;
        } else {
            try {
                var mp = it.getMediaPath();
                if (mp && String(mp).toLowerCase() === lower) return it;
            } catch (e) {}
        }
    }
    return null;
}

// 임포트 전용 빈 "00 링크임포트" 반환 — 최상위에서 찾고, 없으면 생성 (00 접두어 = 정렬 최상단)
function LI_getImportBin() {
    var root = app.project.rootItem;
    try {
        for (var i = 0; i < root.children.numItems; i++) {
            var it = root.children[i];
            if (it.type === ProjectItemType.BIN && String(it.name) === "00 링크임포트") return it;
        }
        var bin = root.createBin("00 링크임포트");
        if (bin) return bin;
    } catch (e) {}
    return root;
}

// 파일 임포트 (+옵션: 활성 시퀀스의 지정 트랙, 플레이헤드 위치에 삽입)
// insertMode "1"이면 vIdx/aIdx 트랙 인덱스(0부터)에 insertClip
// filePath는 URI 인코딩(ASCII)으로 전달됨 — 한글 경로가 evalScript에서 깨지는 것 방지
function LI_importFile(filePath, insertMode, vIdx, aIdx) {
    try {
        try { filePath = decodeURIComponent(filePath); } catch (eDec) {}
        var f = new File(filePath);
        if (!f.exists) return "err:파일 없음 - " + filePath;
        var ok = app.project.importFiles([f.fsName], true, LI_getImportBin(), false);
        if (!ok) return "err:importFiles 실패";
        if (insertMode !== "1") return "ok";

        var seq = app.project.activeSequence;
        if (!seq) return "ok:no-seq";
        var item = LI_findItemByPath(app.project.rootItem, f.fsName);
        if (!item) return "ok:no-item";

        var time = seq.getPlayerPosition();
        var v = parseInt(vIdx, 10) || 0;
        var a = parseInt(aIdx, 10) || 0;
        try {
            seq.insertClip(item, time, v, a);
        } catch (e1) {
            try {
                seq.insertClip(item, time.ticks, v, a);
            } catch (e2) {
                return "ok:insert-fail:" + e2.toString();
            }
        }
        return "ok:inserted";
    } catch (e) {
        return "err:" + e.toString();
    }
}


// ====================== 트래킹 (구 Pin) ======================
/* Track host adapter — ES3. 시퀀스·선택 클립 정보 읽기(Track_context) + Position 키프레임 쓰기(Track_apply).
 * 모션 컴포넌트는 matchName('AE.ADBE Motion')으로 찾는다 — UI 언어와 무관 (palette와 같은 통로).
 * Position 값은 시퀀스 크기로 정규화된 [0~1, 0~1] (palette 실측). 패널은 px로 주고받고 여기서 변환한다. */
var HOST_REV = 5;   // 패널(main.js HOST_REV)이 호스트 스크립트가 최신인지 확인하는 번호 — 함수 서명이 바뀌면 올린다 (2 = 9/24 Track_context(lock), 3 = reversed, 4 = 되돌림, 5 = 키 시각 = 원본 파일 시각(실기 확정))
var TrackHost = (function () {
    var TICKS = 254016000000;
    var VIDEO_EXT = /\.(mp4|m4v|mov|mxf|mkv|avi|webm|mts|m2ts|mpg|mpeg|wmv|flv|ts|3gp|braw|r3d)$/i;
    var CH = String.fromCharCode;
    // 이스케이프 대상: 백슬래시·따옴표·제어문자·U+2028/2029 (소스에 제어문자 리터럴을 두지 않으려고 코드로 만든다)
    var ESC = new RegExp('[' + CH(92) + CH(92) + '"' + CH(0) + '-' + CH(31) + CH(8232) + CH(8233) + ']', 'g');

    function quote(v) {
        return '"' + String(v).replace(ESC, function (ch) {
            var code = ch.charCodeAt(0).toString(16);
            return CH(92) + 'u' + ('0000' + code).slice(-4);
        }) + '"';
    }
    function serialize(v) {
        var parts = [], key, i;
        if (v === null || typeof v === 'undefined') { return 'null'; }
        if (typeof v === 'string') { return quote(v); }
        if (typeof v === 'number') { return isFinite(v) ? String(v) : 'null'; }
        if (typeof v === 'boolean') { return v ? 'true' : 'false'; }
        if (v instanceof Array) { for (i = 0; i < v.length; i++) { parts.push(serialize(v[i])); } return '[' + parts.join(',') + ']'; }
        for (key in v) { if (Object.prototype.hasOwnProperty.call(v, key)) { parts.push(quote(key) + ':' + serialize(v[key])); } }
        return '{' + parts.join(',') + '}';
    }
    function fail(code, message) { var e = new Error(message); e.trackCode = code; throw e; }
    function envelope(fn) {
        try { return serialize({ ok: true, data: fn() }); }
        catch (e) { return serialize({ ok: false, error: String(e.message || e), code: e.trackCode || 'HOST_ERROR' }); }
    }
    function tickTime(sec) { var T = new Time(); T.ticks = String(Math.round(sec * TICKS)); return T; }
    function sec(t) { try { return parseFloat(t.ticks) / TICKS; } catch (e) { return NaN; } }

    function compByMatch(clip, match) {
        var comps = null, n = 0, j, mn;
        try { comps = clip.components; n = comps.numItems; } catch (e) { return null; }
        for (j = 0; j < n; j++) {
            mn = ''; try { mn = '' + comps[j].matchName; } catch (e2) {}
            if (mn === match) { return comps[j]; }
        }
        return null;
    }
    function propAt(comp, idx) {
        var ps = null, n = 0;
        try { ps = comp.properties; n = ps.numItems; } catch (e) { return null; }
        return (idx >= 0 && idx < n) ? ps[idx] : null;
    }
    function motionOf(clip) {
        var m = compByMatch(clip, 'AE.ADBE Motion');
        if (!m) { fail('NO_MOTION', '이 클립에는 모션(위치·비율) 속성이 없어요. 일반 영상·텍스트·이미지 클립을 선택하세요.'); }
        return m;
    }
    // 대상의 Position(0)·Scale(1)·Rotation(4) 파라미터 (인덱스 = palette 실측 0=위치 1=비율 4=회전): Motion → 없으면 그래픽 클립의 Vector Motion에서 표시명으로
    var PROP_NAMES = { 0: ['position', '위치'], 1: ['scale', '비율 조정', '비율'], 4: ['rotation', '회전'] };
    function motionProp(clip, idx) {
        var m = compByMatch(clip, 'AE.ADBE Motion');
        if (m) { return propAt(m, idx); }
        var comps = null, n = 0, j, dn, ps, k, pn, q, want = PROP_NAMES[idx] || [];
        try { comps = clip.components; n = comps.numItems; } catch (e) { n = 0; }
        for (j = 0; j < n; j++) {
            dn = ''; try { dn = ('' + comps[j].displayName).toLowerCase(); } catch (e2) {}
            if (dn.indexOf('vector motion') < 0 && dn.indexOf('벡터 모션') < 0) { continue; }
            try { ps = comps[j].properties; } catch (e3) { continue; }
            for (k = 0; k < ps.numItems; k++) {
                pn = ''; try { pn = ('' + ps[k].displayName).toLowerCase(); } catch (e4) {}
                for (q = 0; q < want.length; q++) { if (pn === want[q]) { return ps[k]; } }
            }
        }
        if (idx === 0) { fail('NO_MOTION', '따라갈 클립의 위치 속성을 찾지 못했어요. 텍스트·이미지·영상 클립을 선택하세요.'); }
        return null;
    }
    function positionProp(clip) { return motionProp(clip, 0); }
    // 스칼라 파라미터(Scale·Rotation)의 현재 값. 키가 있으면 클립 내부 시간 T의 값
    function scalarOf(clip, idx, T, dflt) {
        var p = motionProp(clip, idx), v = NaN, tv = false;
        if (!p) { return dflt; }
        try { tv = !!p.isTimeVarying(); } catch (e) {}
        try { v = Number(tv ? p.getValueAtTime(T) : p.getValue()); } catch (e2) {}
        return isFinite(v) ? v : dflt;
    }
    function active() {
        var seq = null;
        try { seq = app.project.activeSequence; } catch (e) {}
        if (!seq) { fail('NO_SEQUENCE', '열린 시퀀스가 없어요. 타임라인을 연 뒤 다시 불러오세요.'); }
        return seq;
    }
    function mediaPathOf(clip) {
        var p = '';
        try { p = '' + clip.projectItem.getMediaPath(); } catch (e) { p = ''; }
        return p;
    }
    // 실제 영상 파일을 가리키는 클립만 추적 소스가 될 수 있다 (그래픽·조정 레이어·중첩 시퀀스 제외)
    function isSourceCandidate(clip) {
        var p = mediaPathOf(clip);
        if (!p || !VIDEO_EXT.test(p)) { return false; }
        try { if (clip.projectItem.isSequence()) { return false; } } catch (e) {}
        return true;
    }
    function selectedVideo(seq) {
        var out = [], vt = seq.videoTracks, t, c, trk, clip, sel;
        for (t = 0; t < vt.numTracks; t++) {
            trk = vt[t];
            for (c = 0; c < trk.clips.numItems; c++) {
                clip = trk.clips[c]; sel = false;
                try { sel = clip.isSelected(); } catch (e) {}
                if (sel) { out.push({ track: t, clip: clip }); }
            }
        }
        return out;   // 트랙 오름차순
    }
    function clipAt(seq, track, startSec) {
        var trk = seq.videoTracks[track], c, clip;
        for (c = 0; c < trk.clips.numItems; c++) {
            clip = trk.clips[c];
            if (Math.abs(sec(clip.start) - startSec) < 0.0005) { return clip; }
        }
        fail('CLIP_MOVED', '불러온 뒤 클립이 옮겨졌어요. [다시 불러오기]를 누르고 핀을 다시 꽂으세요.');
    }
    function posPx(prop, T, fw, fh) {
        var v = null, tv = false;
        try { tv = !!prop.isTimeVarying(); } catch (e) {}
        try { v = tv ? prop.getValueAtTime(T) : prop.getValue(); } catch (e2) { v = null; }
        if (!v || v.length < 2) { fail('NO_POSITION', '클립의 위치 값을 읽지 못했어요.'); }
        return { px: [Number(v[0]) * fw, Number(v[1]) * fh], timeVarying: tv };
    }

    function context(lock) {   // lock = 고정 모드: 소스 영상 자체가 대상(키를 소스 클립의 Motion에 쓴다)
        var seq = active(), tb = Number(seq.timebase);
        var fw = Number(seq.frameSizeHorizontal), fh = Number(seq.frameSizeVertical);
        var P = sec(seq.getPlayerPosition());
        var sel = selectedVideo(seq), target = null, source = null, srcIdx = -1, t, trk, c, clip, i;
        if (!sel.length) { fail('NO_SELECTION', lock ? '타임라인에서 고정할 영상 클립을 선택하세요.' : '타임라인에서 영상 클립과 따라갈 자막·이미지 클립을 함께 선택하세요.'); }
        // 재생 헤드에 걸친 클립을 track 트랙에서 찾는다
        function clipUnderPlayhead(track, wantSource) {
            var tr = seq.videoTracks[track], k, cl;
            for (k = 0; k < tr.clips.numItems; k++) {
                cl = tr.clips[k];
                if (sec(cl.start) <= P && P < sec(cl.end) && (!wantSource || isSourceCandidate(cl))) { return { track: track, clip: cl }; }
            }
            return null;
        }
        /* 대상 규칙: 함께 선택한 클립은 전부 대상(여러 개 가능). 영상만 선택했으면 위 트랙에서 재생 헤드에 걸친 클립이 딱 하나일 때만 자동,
         * 둘 이상이면 추측하지 않고 후보를 보여주며 멈춘다 (자막·워터마크가 걸린 프로젝트에서 엉뚱한 클립에 붙는 부작용 차단). */
        var targets = [], cands = [], names = [];
        for (i = 0; i < sel.length; i++) { if (isSourceCandidate(sel[i].clip)) { srcIdx = i; break; } }   // 영상 파일 클립 중 가장 아래 트랙 = 소스
        if (lock) {
            if (srcIdx < 0) { fail('NO_SOURCE', '선택한 것 중에 영상 파일 클립이 없어요. 고정은 영상 파일 클립만 돼요(그래픽·중첩 시퀀스 제외).'); }
            source = sel[srcIdx]; targets = [source];
        } else if (srcIdx >= 0) {
            source = sel[srcIdx];
            for (i = 0; i < sel.length; i++) { if (i !== srcIdx) { targets.push(sel[i]); } }
            if (!targets.length) {
                for (t = source.track + 1; t < seq.videoTracks.numTracks; t++) { clip = clipUnderPlayhead(t, false); if (clip) { cands.push(clip); } }
                if (cands.length === 1) { targets = cands; }
                else if (!cands.length) { fail('NO_TARGET', '따라갈 자막·이미지가 없어요. 영상(V' + (source.track + 1) + ') 위 트랙에 자막을 놓고 함께 선택하세요. 영상 속 피사체를 제자리에 붙잡으려면 위에서 「고정」을 고르세요.'); }
                else {
                    for (i = 0; i < cands.length; i++) { names.push('V' + (cands[i].track + 1) + ' ' + cands[i].clip.name); }
                    fail('AMBIGUOUS_TARGET', '위 트랙에 클립이 ' + cands.length + '개라 어느 것을 따라가게 할지 몰라요 (' + names.join(', ') + '). 따라갈 클립을 영상과 함께 선택하세요.');
                }
            }
        } else {
            targets = sel;                                                                                  // 텍스트·이미지만 선택 → 전부 대상, 아래 트랙에서 영상 자동
            for (t = sel[0].track - 1; t >= 0 && !source; t--) { source = clipUnderPlayhead(t, true); }
            if (!source) {
                var ext = mediaPathOf(sel[0].clip); ext = ext ? ext.slice(ext.lastIndexOf('.')) : '(경로 없음)';
                fail('NO_SOURCE', '추적할 영상을 못 찾았어요. 선택한 클립(V' + (sel[0].track + 1) + ' ' + sel[0].clip.name + ', ' + ext + ') 아래 트랙에서 재생 헤드에 걸친 영상 클립이 없어요. 재생 헤드를 영상 위에 두거나 영상 클립을 함께 선택하세요.');
            }
        }
        var tList = [];
        for (i = 0; i < targets.length; i++) {
            var TL = localTime(targets[i].clip, P), tp = posPx(positionProp(targets[i].clip), TL, fw, fh);   // 키가 있으면 클립 내부 시간으로 읽는다
            tList.push({ track: targets[i].track, name: '' + targets[i].clip.name, startSec: sec(targets[i].clip.start), endSec: sec(targets[i].clip.end),
                         posPx: tp.px, timeVarying: tp.timeVarying, scale: scalarOf(targets[i].clip, 1, TL, 100), rotation: scalarOf(targets[i].clip, 4, TL, 0) });
        }
        var sm = motionOf(source.clip), sTL = localTime(source.clip, P), speed = 1;
        var sPos = posPx(propAt(sm, 0), sTL, fw, fh).px;   // 소스 클립의 앵커가 놓인 시퀀스 px (기본 앵커 = 미디어 중심 가정)
        var sScale = scalarOf(source.clip, 1, sTL, 100);   // 키가 있으면(고정을 한 번 돌린 뒤) 재생 헤드 시각의 값 — getValue()는 키 있는 파라미터에서 믿을 수 없다
        var reversed = false;
        speed = speedOf(source.clip);
        try { reversed = !!source.clip.isSpeedReversed(); } catch (e2) {}
        if (!(sScale > 0)) { sScale = 100; }
        return {
            fps: TICKS / tb, fw: fw, fh: fh, playheadSec: P,
            targets: tList,
            source: { track: source.track, name: '' + source.clip.name, startSec: sec(source.clip.start), endSec: sec(source.clip.end),
                      inSec: sec(source.clip.inPoint), speed: speed, reversed: reversed, scale: sScale, posPx: sPos, mediaPath: mediaPathOf(source.clip) }
        };
    }

    /* payload = { track, startSec, keys: [[sec, px, py], …], scaleKeys?: [[sec, %], …], rotKeys?: [[sec, 도], …], clear: [fromSec, toSec] | null }
     * clear가 있으면 그 구간의 기존 키를 지우고 시작한다 (첫 청크). 이후 청크는 keys만. */
    /* ★ 키프레임 시각은 시퀀스 시간이 아니라 클립 내부 시간(inPoint 기점) — palette engine.jsx:1005·Excalibur 분석과 동일.
     *   local = (inPoint + (seqSec - clip.start)) × 속도 = 원본 파일 시각. 패널은 시퀀스 초로 주고 여기서 변환한다.
     *   ★★ 속도 바뀐 클립에서 Premiere API의 두 시각 단위가 다르다 (9/24 실기로 확정, PPro 26):
     *     · TrackItem.inPoint/outPoint = 속도 적용 뒤 단위(원본 시각 ÷ 속도) — 194% 클립 in=80.566인데 모니터 장면은 원본 158.5초
     *     · 효과 키(addKey·getKeys·getValueAtTime·removeKeyRange) = 원본 파일 시각 — 286% 클립에 inPoint 단위(39~42초)로 쓴 키 42개가
     *       전혀 적용 안 됨(클립 원본 시작 112.5초보다 앞이라 마지막 키 값으로 굳음). 같은 키를 시각만 × 속도로 옮기자 exportFramePNG 렌더에서 움직임 확인.
     *   속도 100%면 예전 식과 같다. 텍스트·이미지 대상은 늘 100%. (그 전 두 번의 식 — 경과만 × 속도, 속도 없음 — 은 둘 다 틀렸다. HOST_REV 5) */
    function speedOf(clip) { var v = 1; try { v = Number(clip.getSpeed()); } catch (e) {} return v > 0 ? v : 1; }
    function localTime(clip, seqSec) { return tickTime((sec(clip.inPoint) + (seqSec - sec(clip.start))) * speedOf(clip)); }

    function apply(payload) {
        var seq = active(), fw = Number(seq.frameSizeHorizontal), fh = Number(seq.frameSizeVertical);
        var clip = clipAt(seq, payload.track, payload.startSec);
        var prop = positionProp(clip), keys = payload.keys || [], i, T, n = 0, interpErr = 0;
        if (!prop) { fail('NO_POSITION', '이 클립에는 위치 속성이 없어요.'); }
        try { prop.setTimeVarying(true); } catch (e) { fail('KEY_UNSUPPORTED', '이 클립의 위치에는 키프레임을 넣을 수 없어요.'); }
        if (payload.clear) {
            try { prop.removeKeyRange(localTime(clip, payload.clear[0]), localTime(clip, payload.clear[1]), 1); } catch (e2) {}
        }
        for (i = 0; i < keys.length; i++) {
            T = localTime(clip, keys[i][0]);
            try { prop.addKey(T); } catch (e3) {}
            prop.setValueAtKey(T, [keys[i][1] / fw, keys[i][2] / fh], 1);
            try { prop.setInterpolationTypeAtKey(T, 0, 0); } catch (e4) { interpErr++; }
            n++;
        }
        // 크기(1)·회전(4)는 선택. 크기는 비율 조정(균일) 파라미터에만 쓴다 — 균일 비율이 꺼진 클립의 폭은 v1 미지원
        return { written: n, scaleWritten: writeScalar(clip, 1, payload.scaleKeys || [], payload.clear), rotWritten: writeScalar(clip, 4, payload.rotKeys || [], payload.clear), interpErr: interpErr };
    }
    function writeScalar(clip, idx, keys, clear) {
        var p = keys.length ? motionProp(clip, idx) : null, i, T, n = 0;
        if (!p) { return 0; }
        try { p.setTimeVarying(true); } catch (e) { return 0; }
        if (clear) { try { p.removeKeyRange(localTime(clip, clear[0]), localTime(clip, clear[1]), 1); } catch (e2) {} }
        for (i = 0; i < keys.length; i++) {
            T = localTime(clip, keys[i][0]);
            try { p.addKey(T); } catch (e3) {}
            p.setValueAtKey(T, keys[i][1], 1);
            try { p.setInterpolationTypeAtKey(T, 0, 0); } catch (e4) {}
            n++;
        }
        return n;
    }

    return {
        version: function () { return envelope(function () { return { rev: HOST_REV }; }); },
        context: function (lock) { return envelope(function () { return context(!!lock); }); },
        playhead: function () { return envelope(function () { var seq = app.project.activeSequence; if (!seq) { throw new Error('활성 시퀀스가 없습니다.'); } return { playheadSec: sec(seq.getPlayerPosition()) }; }); },
        apply: function (payload) { return envelope(function () { return apply(payload); }); }
    };
}());

function Track_version() { return TrackHost.version(); }
function Track_context(lock) { return TrackHost.context(lock); }
function Track_playhead() { return TrackHost.playhead(); }
function Track_apply(payload) { return TrackHost.apply(payload); }


// ====================== 효과음 (Bobos 1.1.0) ======================
// SFX_insert(경로URI인코딩) → 재생 헤드 위치에, 그 구간이 비어 있는 오디오 트랙을 찾아 overwriteClip.
//   빈 트랙이 없으면 QE로 오디오 트랙을 하나 추가해 본다. 효과음은 프로젝트 빈 "00 효과음"에 한 번만 임포트하고 재사용.
//   결과는 JSON 문자열: {"ok":true,"track":2,"added":false,"reused":true} / {"ok":false,"error":"..."}
function SFX_q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ") + '"'; }
function SFX_err(msg) { return '{"ok":false,"error":' + SFX_q(msg) + '}'; }

function SFX_findItem(bin, lowerPath) {
    for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) {
            var f = SFX_findItem(it, lowerPath);
            if (f) return f;
        } else {
            try { var mp = it.getMediaPath(); if (mp && String(mp).toLowerCase() === lowerPath) return it; } catch (e) {}
        }
    }
    return null;
}
function SFX_bin() {
    var root = app.project.rootItem;
    try {
        for (var i = 0; i < root.children.numItems; i++) {
            var it = root.children[i];
            if (it.type === ProjectItemType.BIN && String(it.name) === "00 효과음") return it;
        }
        var b = root.createBin("00 효과음");
        if (b) return b;
    } catch (e) {}
    return root;
}
function SFX_secs(t) { try { return parseFloat(t.ticks) / 254016000000; } catch (e) { try { return Number(t.seconds); } catch (e2) { return NaN; } } }
function SFX_duration(item) {
    var d = NaN;
    try { d = SFX_secs(item.getOutPoint(2)) - SFX_secs(item.getInPoint(2)); } catch (e) {}       // 2 = 오디오
    if (!(d > 0)) { try { d = SFX_secs(item.getOutPoint()) - SFX_secs(item.getInPoint()); } catch (e2) {} }
    return d > 0 ? d : 2;
}
function SFX_freeTrack(seq, t0, t1) {
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
        var tr = seq.audioTracks[i], busy = false;
        try { if (tr.isLocked && tr.isLocked()) continue; } catch (eL) {}
        for (var j = 0; j < tr.clips.numItems; j++) {
            var c = tr.clips[j], s = SFX_secs(c.start), e = SFX_secs(c.end);
            if (s < t1 - 0.0005 && e > t0 + 0.0005) { busy = true; break; }
        }
        if (!busy) return i;
    }
    return -1;
}

function SFX_insert(pathEnc) {
    try {
        var p = pathEnc;
        try { p = decodeURIComponent(pathEnc); } catch (eD) {}
        var f = new File(p);
        if (!f.exists) return SFX_err("파일이 없어요: " + p);
        var seq = app.project.activeSequence;
        if (!seq) return SFX_err("열려 있는 시퀀스가 없어요. 타임라인에 시퀀스를 먼저 여세요.");

        var lower = String(f.fsName).toLowerCase();
        var item = SFX_findItem(app.project.rootItem, lower), reused = !!item;
        if (!item) {
            if (!app.project.importFiles([f.fsName], true, SFX_bin(), false)) return SFX_err("임포트에 실패했어요.");
            item = SFX_findItem(app.project.rootItem, lower);
            if (!item) return SFX_err("임포트한 파일을 프로젝트에서 찾지 못했어요.");
        }

        var pos = seq.getPlayerPosition(), t0 = SFX_secs(pos), dur = SFX_duration(item), t1 = t0 + dur;
        var idx = SFX_freeTrack(seq, t0, t1), added = false;
        if (idx < 0) {
            var before = seq.audioTracks.numTracks;
            try {
                app.enableQE();
                // addTracks(비디오 수, 비디오 뒤 위치, 오디오 수, 오디오 종류(1=스테레오), 오디오 뒤 위치, 서브믹스 수, …)
                qe.project.getActiveSequence().addTracks(0, 0, 1, 1, before, 0, 0, 0);
            } catch (eQ) {}
            seq = app.project.activeSequence;
            if (seq.audioTracks.numTracks > before) { idx = seq.audioTracks.numTracks - 1; added = true; }
            else return SFX_err("재생 헤드 위치에 빈 오디오 트랙이 없어요. 오디오 트랙을 하나 추가하고 다시 더블클릭하세요.");
        }

        var track = seq.audioTracks[idx];
        // Time 객체 → 초 → ticks 순으로 시도 (버전마다 받는 형식이 달라서 — 링크 임포트의 insertClip과 같은 방식)
        try { track.overwriteClip(item, pos); }
        catch (e1) {
            try { track.overwriteClip(item, pos.seconds); }
            catch (e2) { try { track.overwriteClip(item, pos.ticks); } catch (e3) { return SFX_err("타임라인에 넣지 못했어요: " + e3.toString()); } }
        }
        return '{"ok":true,"track":' + (idx + 1) + ',"added":' + added + ',"reused":' + reused + ',"dur":' + dur.toFixed(3) + '}';
    } catch (e) {
        return SFX_err(e.toString());
    }
}
