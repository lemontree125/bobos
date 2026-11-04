/* Track — tracker.js
 * 순수 JS 템플릿 매칭 추적기 (NCC). 패널(CEF 99)과 Node 테스트가 같은 파일을 쓴다.
 * 좌표는 "긴 변 = long px"로 축소한 흑백 프레임 기준. 추적점 = 박스 중심.
 *
 * 구조:
 *   위치  — 직전 프레임 템플릿(adapt)으로 탐색창(±R) 안에서 NCC 최대점(서브픽셀 포물선 보정). 외형이 서서히 변해도 따라간다.
 *   보정  — 기준 템플릿(원본, 아주 확실할 때만 갈아끼움)이 아직 잘 맞으면 그 위치로 스냅. 위치 드리프트 누적 방지.
 *   재탐색 — 점수가 lost 아래로 떨어지면 전체 프레임을 성긴 격자로 훑어 원본·마지막 템플릿을 다시 찾는다.
 *   크기·회전 — 박스 하나로는 안 잰다(9/16 실측: NCC 배율 후보·사분면 기하 모두 얼굴·털에서 쓰레기, 게이트는 강체 신호까지 죽임).
 *             AE 트래커처럼 박스 두 개를 한 루프에서 각각 위치 추적해 중심 거리비 = 배율, 각도 차 = 회전 (trackPair → twoPoint).
 *             잰 배율·회전은 두 추적기의 템플릿 격자에 되먹인다(격자를 s배 키우고 θ만큼 돌림) — 안 그러면 확대·회전된 피사체 위에서
 *             원본 모양 템플릿이 엉뚱한 곳에 스냅한다(합성 1.5배 실측 1.32 / 회전 레코드판 실측: 거리가 0.73~2.17로 요동).
 *
 * API:
 *   TrackCore.track(frames, W, H, box, R, opt?)             // frames[0]에서 박스 시작, 앞으로
 *   TrackCore.trackAround(frames, W, H, iP, box, R, opt?)   // frames[iP]에서 시작, 앞뒤 양방향 → 프레임 순 배열
 *   opt.coarse = c: 창 탐색을 c칸 간격 → 봉우리 주변 1칸(고해상도 추적용, 봉우리가 좁은 핀은 1칸 그대로)
 *   TrackCore.trackPair(frames, W, H, boxA, boxB, R, opt?)  // 두 박스 동시 추적(배율·회전 되먹임) → { a, b }
 *   TrackCore.trackPairAround(frames, W, H, iP, boxA, boxB, R, opt?)
 *   TrackCore.twoPoint(resA, resB, iP, opt?)                // 두 추적 결과 → { s[], rot[](도), sActive, rActive, d0 }
 *   TrackCore.quality(frame, W, H, box, R)                  // 박스 품질 → { std(무늬 세기), distinct(주변 최고 유사도) }
 *   TrackCore.toKeys(res, o)                                // 추적 결과 → [[초, x px, y px] | null(놓침), …] (시퀀스 좌표)
 *   TrackCore.toValueKeys(res, vals, o)                     // 값 시계열 → [[초, 값] | null(놓침), …]
 *   TrackCore.simplifyKeys(keys, tol)                       // 직선 보간으로 대신할 수 있는 키 제거 (기록 시간 = 키 수)
 * 결과 원소: { f, x, y(축 정렬 박스 좌상단), cx, cy(박스 중심 = 추적점), s, th(템플릿 배율·회전), score, src: 'init'|'adapt'|'wide'|'orig'|'reacq'|'lost' }
 */
(function (root) {
  'use strict';

  /* 샘플 격자: 박스 중심 기준 단위 오프셋(초기 박스 px), 최대 40×40. 배율 s·회전 θ(라디안)를 적용해 정수 오프셋으로 만든다.
   * ★ 템플릿 읽기와 match 읽기가 같은 정수 오프셋을 써야 한다 (어긋나면 0.5px씩 밀려 달아난다: 실측). */
  function gridOf(w, h) {
    const nx = Math.max(4, Math.min(40, Math.round(w))), ny = Math.max(4, Math.min(40, Math.round(h))), n = nx * ny;
    const ux = new Float32Array(n), uy = new Float32Array(n);
    let k = 0;
    // 격자 좌표는 정수 배수로(중심에서 i−nx/2 칸): (i+0.5)식 반칸 좌표는 배율이 1을 스치기만 해도 반올림이 한꺼번에 뒤집혀 템플릿 무게중심이 0.5px 튄다(실측)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { ux[k] = (i - Math.floor(nx / 2)) * w / nx; uy[k] = (j - Math.floor(ny / 2)) * h / ny; k++; }
    return { ux, uy, n, w, h };
  }
  function offsets(g, s, th) {
    const cs = Math.cos(th || 0), sn = Math.sin(th || 0), ix = new Int32Array(g.n), iy = new Int32Array(g.n);
    // 0에서 대칭인 반올림(.5는 바깥쪽으로): floor는 평균 −0.5px 편향이 생기고 회전하면 그 방향이 돌아 원본 격자와 어긋난다. Math.round는 −14.5→−14, 14.5→15로 비대칭이라 격자가 +0.5px 치우친다
    const rd = v => v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
    for (let k = 0; k < g.n; k++) { const dx = g.ux[k] * s, dy = g.uy[k] * s; ix[k] = rd(dx * cs - dy * sn); iy[k] = rd(dx * sn + dy * cs); }
    return { ix, iy, margin: Math.ceil(Math.hypot(g.w, g.h) * s / 2) + 1 };
  }

  /* 박스(중심 cx,cy · 초기 크기 w,h)를 배율 s·회전 θ로 읽어 템플릿을 만든다.
   * ★ cx,cy는 소수 위치 그대로(쌍선형 샘플). 정수로 반올림해 뜨면 프레임당 1px 미만의 이동을 템플릿이 매번 흡수해 추적이 제자리에 멈춘다
   *   (실측: 0.3px/프레임 회전이 3프레임 뒤 정지) — 두 점 배율·회전은 바로 그 느린 상대 이동이 신호다. */
  function makeTemplate(frame, W, H, cx, cy, w, h, s, th) {
    s = s || 1; th = th || 0;
    const g = gridOf(w, h), o = offsets(g, s, th), v = new Float32Array(g.n);
    let sum = 0;
    for (let k = 0; k < g.n; k++) { const p = sample(frame, W, H, cx + o.ix[k], cy + o.iy[k]); v[k] = p; sum += p; }
    const mean = sum / g.n; let ss = 0;
    for (let k = 0; k < g.n; k++) { v[k] -= mean; ss += v[k] * v[k]; }
    // 격자 u_k는 "피사체 자체 좌표"(초기 박스)라 템플릿 값 k = 피사체의 점 u_k. 뜰 때 (s0,θ0)로 읽었어도 대조 땐 지금의 절대 (s,θ)를 그대로 적용한다 (상대값 s/s0으로 하면 틀린다: 실측)
    return { v, g, n: g.n, norm: Math.sqrt(ss) || 1, std: Math.sqrt(ss / g.n), w, h };
  }
  function sample(frame, W, H, fx, fy) {   // 쌍선형 (가장자리는 고정)
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const top = frame[y0 * W + x0] * (1 - ax) + frame[y0 * W + x1] * ax, bot = frame[y1 * W + x0] * (1 - ax) + frame[y1 * W + x1] * ax;
    return top * (1 - ay) + bot * ay;
  }

  // 템플릿(배율 s·회전 θ)을 프레임과 NCC. (cx,cy) = 탐색 중심, 반경 R, 격자 step. 최대점 주변 포물선 보정으로 서브픽셀 중심.
  // excl > 0 이면 중심 ±excl 안은 건너뛴다 (품질 검사: 자기 자신 제외 주변 최고 유사도). K > 0 이면 격자 봉우리 상위 K개도 돌려준다(peaks: [x, y, 점수])
  function match(frame, W, H, tpl, cx, cy, R, s, th, step, excl, K) {
    step = step || 1;
    const { v, n, norm } = tpl, o = offsets(tpl.g, s || 1, th || 0), m = o.margin, off = new Int32Array(n);
    for (let k = 0; k < n; k++) off[k] = o.iy[k] * W + o.ix[k];   // 표본 → 프레임 인덱스 차를 한 번만 (위치마다 곱셈을 빼면 결과 그대로 빨라진다)
    let best = -2, bx = Math.round(cx), by = Math.round(cy);
    const x0 = Math.max(m, Math.round(cx - R)), x1 = Math.min(W - 1 - m, Math.round(cx + R));
    const y0 = Math.max(m, Math.round(cy - R)), y1 = Math.min(H - 1 - m, Math.round(cy + R));
    // 점수판: step 칸마다 한 칸, 안 잰 칸(excl) = NaN. Map은 칸당 비용이 커서 1280 추적에서 병목이었다
    const nx = x1 >= x0 ? Math.floor((x1 - x0) / step) + 1 : 0, ny = y1 >= y0 ? Math.floor((y1 - y0) / step) + 1 : 0, sc = new Float64Array(nx * ny).fill(NaN);
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        if (excl && Math.abs(x - cx) <= excl && Math.abs(y - cy) <= excl) continue;
        let sum = 0, sq = 0, dot = 0;
        const base = y * W + x;
        for (let k = 0; k < n; k++) { const p = frame[base + off[k]]; sum += p; sq += p * p; dot += p * v[k]; }
        const varp = sq - sum * sum / n;
        const c = varp > 1e-6 ? dot / (Math.sqrt(varp) * norm) : -1;
        sc[(y - y0) / step * nx + (x - x0) / step] = c;
        if (c > best) { best = c; bx = x; by = y; }
      }
    }
    const g = (x, y) => {   // 잰 칸이면 그 점수, 아니면 best (포물선 보정 없음)
      const i = x - x0, j = y - y0;
      if (i < 0 || j < 0 || i % step || j % step || i / step >= nx || j / step >= ny) return best;
      const c = sc[j / step * nx + i / step]; return c === c ? c : best;
    };
    const sub = (l, c, r) => { const d = l - 2 * c + r; return d < 0 ? 0.5 * (l - r) / d : 0; };
    const res = { x: bx + sub(g(bx - 1, by), best, g(bx + 1, by)), y: by + sub(g(bx, by - 1), best, g(bx, by + 1)), ix: bx, iy: by, score: best };
    if (K) {   // 봉우리 = 이웃 8칸 어느 것보다 낮지 않은 칸
      const pk = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = sc[j * nx + i]; if (!(c === c)) continue;
        let top = true;
        for (let dj = -1; dj <= 1 && top; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if ((di || dj) && ii >= 0 && jj >= 0 && ii < nx && jj < ny && sc[jj * nx + ii] > c) { top = false; break; }
        }
        if (top) pk.push([x0 + i * step, y0 + j * step, c]);
      }
      res.peaks = pk.sort((a, b) => b[2] - a[2]).slice(0, K);
    }
    return res;
  }
  /* 성긴 탐색 → 정밀 (고해상도 추적용, c = 해상도/640): c칸 간격으로 창 전체를 재고(= 튜닝한 640 추적과 같은 위치 밀도) 봉우리 상위 PEAKS개 주변 ±c를 1칸 간격으로 다시 잰다.
   * 탐색 비용 약 1/c². 봉우리를 여럿 다시 재는 이유: 가는 선(커서)은 1px 폭 봉우리라 성긴 칸에선 옆 배경보다 낮게 찍힐 수 있다 */
  const PEAKS = 3;
  function matchCoarse(frame, W, H, tpl, cx, cy, R, s, th, c) {
    let best = null;
    for (const p of match(frame, W, H, tpl, cx, cy, R, s, th, c, 0, PEAKS).peaks) {
      const f = match(frame, W, H, tpl, p[0], p[1], c, s, th);
      if (!best || f.score > best.score) best = f;
    }
    return best || match(frame, W, H, tpl, cx, cy, R, s, th);
  }

  /* 한 점 추적기(상태 유지). step(fr, f, s, th, hint)로 프레임을 하나씩 먹인다.
   * s·th = 이 프레임에서 쓸 템플릿 배율·회전(단독 추적은 1·0, 쌍 추적은 twoPoint 되먹임). 상태는 박스 중심(추적점). */
  function makeTracker(frame0, W, H, box, R, opt) {
    opt = opt || {};
    /* lost 0.45: 0.6으로 올리면 60fps 댄스 얼굴(케이스 A)이 61프레임 놓친다. 0.5대 점수로 옆 배경에 걸치는 경우(햄스터 달리기, 프레임당 40px)는
     * 이 계열 추적기의 한계로 두고, 패널 쪽 "앞으로만 다시 잡기"로 복구한다. */
    const thLost = opt.lost || 0.45, thAnchor = opt.anchor || 0.7, thReacq = opt.reacq || 0.6, minStd = opt.minStd || 6, w = box.w, h = box.h;
    let px = box.x + w / 2, py = box.y + h / 2, vx = 0, vy = 0, lost = false, lostTick = 0, refFrame = 0, s = 1, th = 0;   // s·th = 이 점의 템플릿 변환(원본 모습으로 확인된 값만)
    const tpl0 = makeTemplate(frame0, W, H, px, py, w, h, 1, 0);
    /* 성긴 탐색(opt.coarse)은 봉우리가 넓은 핀만: 첫 프레임에서 1px 옆 8칸 점수가 모두 0.8 이상일 때(시계 0.93). 커서처럼 가는 선은 0.26 —
     * 성긴 칸이 봉우리를 놓쳐 옆 배경을 따라갔다(9/24 실측: 봉우리 10개를 다시 재도 107프레임 어긋남, 20개면 일치) → 그런 핀은 1칸 탐색 */
    let C = opt.coarse || 1;
    for (let d = 0; C > 1 && d < 8; d++) { const a = d * Math.PI / 4; if (match(frame0, W, H, tpl0, px + Math.round(Math.cos(a)), py + Math.round(Math.sin(a)), 0, 1, 0).score < 0.8) C = 1; }
    const find = (fr, tp, x, y, r, s, th) => C > 1 ? matchCoarse(fr, W, H, tp, x, y, r, s, th, C) : match(fr, W, H, tp, x, y, r, s, th);
    let tplA = tpl0, tplRef = tpl0;   // tplRef: 위치 드리프트 보정의 잣대. 대조가 아주 확실할 때(≥0.85, 45프레임 간격)만 현재 모습으로 갈아끼운다
    const global = (fr, s, th) => {   // 전체 프레임 재탐색: 원본 템플릿과 마지막 확신 템플릿(표적이 돌아선 채 멈추면 원본보다 이쪽이 맞는다) 둘 다, 성긴 격자 → 정밀
      let best = null;
      for (const tp of [tpl0, tplA]) {
        const c1 = match(fr, W, H, tp, W / 2, H / 2, Math.max(W, H), s, th, 4);
        const c2 = match(fr, W, H, tp, c1.ix, c1.iy, 4, s, th, 1);
        if (!best || c2.score > best.score) best = c2;
      }
      return best;
    };
    /* 짝 추적(hint = 짝 기준으로 예측한 이 점의 중심)일 때는 예측 위치 ±2R에서만 다시 찾는다.
     * 전체 재탐색은 닮은 배경으로 점프한다(헤드폰 점이 얼굴 반대편에 붙어 s 5.6, 실측) — 짝이 살아 있는데 멀리서 찾을 이유가 없다. */
    const local = (fr, s, th, hint) => {
      let best = null;
      for (const tp of [tpl0, tplA]) {
        const c = find(fr, tp, hint[0], hint[1], 2 * R, s, th);
        if (!best || c.score > best.score) best = c;
      }
      return best;
    };
    const out = (f, s, th, score, src) => ({ f, x: px - w * s / 2, y: py - h * s / 2, cx: px, cy: py, s, th: (th || 0) * 180 / Math.PI, score, src });
    return {
      init: () => Object.assign(out(0, 1, 0, 1, 'init'), { coarse: C }),   // coarse = 실제로 쓴 탐색 간격(로그용)
      std0: tpl0.std,
      /* sC·thC = 쌍 기하가 제안하는 배율·회전(후보). ★ 이 점의 원본 모습(tplRef)이 후보 변환에서 더 잘 맞을 때만 채택한다(s·th 갱신).
       * 확인이 안 되면 굳은 변환으로 적응 추적만 한다 = 단독 추적과 같은 강건성. 점수 게이트로 걸러 보려던 시도는 케이스마다 뒤집혔다(실측):
       * 'orig'만 인정 → 레코드판 A 굳어 회전 13% 뒤처짐 · 적응 점수 ≥0.85 인정 → 댄스 상의가 미끄러진 기하(s 5.5)를 얼굴에 먹여 230프레임 놓침. */
      /* 보조점 되잡기: 기준점이 확인한 변환(sN·thN)으로 예측한 자리 근처에서 이 점의 원본 모습을 찾아, 맞으면(≥thAnchor) 그리로 옮긴다.
       * 적응 추적으로 미끄러진 보조점은 스스로는 못 돌아온다(원본 대조는 제자리·제 배율에서만 맞는다). 모습이 맞아야만 옮기므로 틀린 예측은 그냥 무시된다. */
      relock(fr, f, at, sN, thN, r) {
        const c = match(fr, W, H, tplRef, at[0], at[1], r, sN, thN);
        if (c.score < thAnchor) return null;
        px = c.x; py = c.y; vx = vy = 0; s = sN; th = thN; lost = false;
        const t = makeTemplate(fr, W, H, px, py, w, h, s, th); if (t.std >= minStd) tplA = t;
        return out(f, s, th, c.score, 'orig');
      },
      step(fr, f, sC, thC, hint) {
        let m = null, src = '', so = false;   // so = 이번 프레임에 자기 모습만으로 배율이 관측됐나 (쌍 추적의 A 우선 규칙이 본다)
        if (opt.alwaysAdopt) { s = sC; th = thC; }   // 보조점(B): 기하를 무조건 따른다 — 굳으면 회전 레코드판에서 6.5°/프레임씩 뒤처져 무너진다(실측). 틀려도 피해는 배율·회전 출력에 한정
        if (!lost) {
          // 속도 예측: 탐색창 중심을 예상 위치로, 빠를수록 넓게 (프레임당 20px 이동도 R=24 안에)
          const Rv = R + Math.min(R, Math.round(Math.sqrt(vx * vx + vy * vy)));
          m = find(fr, tplA, px + vx, py + vy, Rv, s, th); src = 'adapt';
          /* ★ 창 안 점수가 낮으면 3배 넓은 창을 한 번 더 — 표적이 갑자기 달리면(햄스터 실측 프레임당 40px) 창 밖으로 나가고,
           *   창 안에서는 비슷한 무늬의 배경이 최선이 돼 미끄러진다. 넓은 창이 뚜렷이(+0.1) 더 좋을 때만 채택해 오탐을 막는다. */
          if (m.score < 0.7 && !opt.noWide) {   // 보조점(B)은 넓은 창 금지 — 짝 예측이 있으니 멀리 뛸 이유가 없고, 뛰면 배경에 붙어 3프레임에 240px 미끄러졌다(얼굴+헤드폰 실측)
            const wide = find(fr, tplA, px + vx, py + vy, Rv * 3, s, th);
            if (wide.score > m.score + 0.1) { m = wide; src = 'wide'; }
          }
          // 기준 대조: 점수만 보고 채택. "직전 일치−0.05" 조건은 60fps에서 영원히 미채택이라 뺐다. 후보 변환에서도 대조해 더 잘 맞으면 변환을 갈아탄다.
          let bo = match(fr, W, H, tplRef, m.ix, m.iy, 4, s, th);
          if (sC !== s || thC !== th) {
            /* 채택 기준은 상대 비교(후보 ≥ 현재) + 바닥 0.5. 절대 문턱 0.7을 요구하면 블러 진 회전 레코드판(원본 대조 0.7 안팎)에서 첫 미채택 뒤 격자가 굳고
             * 6.5°/프레임씩 뒤처져 영영 못 따라간다(실측 A orig 32, 회전 651°/1780°). 미끄러진 후보(얼굴 s 3, 댄스 s 5)는 원본 대조가 현재보다 낮아 걸러진다. */
            const bc = match(fr, W, H, tplRef, m.ix, m.iy, 4, sC, thC);
            if (bc.score >= Math.max(0.5, bo.score)) { bo = bc; s = sC; th = thC; }
          }
          if (opt.selfScale) {
            /* 기준점(A) 자기 배율: 원본 모습을 s·1.03^±1에서도 대조해 세 점수의 포물선 꼭짓점으로 s를 옮긴다(프레임당 ≤3%).
             * 두 점 기하는 둘째 핀이 미끄러지면 통째로 틀린다(시계 실기: 둘째 핀 = 단색 파우치, 빠른 움직임 뒤 적응 추적이 파우치 위를 떠다녀 실제 2.4배를 1.38배로,
             * 실제 0.92배를 0.48배로 냄 — A는 기하 후보만 받아서 s 1.44에 굳고 원본 대조도 영영 실패). 강체 A는 자기 모습만으로 배율이 나온다(전수 대조 정답과 일치).
             * 얼굴·털처럼 원본 대조가 약한 표적은 문턱(thAnchor) 미달이라 여기서 s가 안 움직인다 = 예전 단일 박스 배율의 잡음 문제를 피한다. */
            /* ★ 잣대는 첫 프레임 템플릿(tpl0) — 갈아끼우는 tplRef로 재면 갈아끼울 때마다 그 순간의 배율 오차가 굳어 누적된다(얼굴+헤드폰 실측: 실제 0.85배를 0.64배로). 배율은 원본 대비 절대값만. */
            // 배율 간격 K: 기본 3%, 작은 박스는 더 크게 — 격자 오프셋이 정수라 바깥 칸이 1px은 움직여야 다른 격자가 된다(30px 박스에서 3%는 0.45px → 세 점수가 똑같아 영영 안 움직임, 합성 실측)
            const K = 1 + Math.max(0.03, 2 / (Math.min(w, h) * s)), DEN = 0.005, c0 = tplRef === tpl0 ? bo : match(fr, W, H, tpl0, m.ix, m.iy, 4, s, th);
            const up = match(fr, W, H, tpl0, m.ix, m.iy, 4, s * K, th), dn = match(fr, W, H, tpl0, m.ix, m.iy, 4, s / K, th);
            if (Math.max(up.score, dn.score, c0.score) >= thAnchor) {
              /* ★ 배율이 "보이는" 표적에서만 움직인다: 점수 곡선이 뾰족하거나(den ≥ 0.005) 가파를 때(6% 폭에서 0.03↑)만.
               * 실측 — 시계(강체): den 0.04~0.07, 비탈 0.12. 얼굴: 정면 den 0.007·비탈 0.01, 고개 돌린 뒤엔 0.7~1.3배가 전부 0.84로 평평(배율 관측 불가) →
               * 게이트 없이 언덕을 오르면 얼굴에서 s가 0.5까지 흘러내렸다(정답 0.85). 관측 불가면 s는 예전처럼 확인된 기하 후보로만 바뀐다. */
              const den = 2 * c0.score - up.score - dn.score, slope = up.score - dn.score;
              const x = den >= DEN ? Math.max(-1, Math.min(1, 0.5 * slope / den)) : Math.abs(slope) >= 0.03 ? Math.sign(slope) : 0;
              so = den >= DEN || Math.abs(slope) >= 0.03;
              if (x !== 0) { s *= Math.pow(K, x); if (tplRef === tpl0) bo = x > 0.5 ? up : x < -0.5 ? dn : bo; }
            } else {
              /* 원본 대조가 문턱 아래(미확인)여도 이웃 배율이 뚜렷이(+0.02) 낫고 바닥 0.5는 넘으면 그쪽으로 한 칸 — 안 그러면 빠른 접근+블러로 한 번 놓친 뒤
               * s가 굳어 원본 대조가 영영 안 맞는다(시계 실측: f284에서 s 1.65에 굳고 실제는 2.1배, 기하는 미끄러진 B를 따라 1.2배). 기하 후보 채택과 같은 상대 비교 규칙 */
              const nb = up.score >= dn.score ? up : dn;
              if (nb.score >= 0.5 && nb.score > c0.score + 0.02) { s *= nb === up ? K : 1 / K; so = true; if (tplRef === tpl0) bo = nb; }
            }
          }
          if (bo.score >= thAnchor) {
            m = bo; src = 'orig';
            if (bo.score >= 0.85 && f - refFrame >= 45) { const t = makeTemplate(fr, W, H, bo.x, bo.y, w, h, s, th); if (t.std >= minStd) { tplRef = t; refFrame = f; } }
          }
        }
        if (lost) {
          // 놓친 상태: 짝이 있으면 매 프레임 근처만, 없으면 3프레임마다 전체 재탐색 (비용 절감), 사이 프레임은 유지
          const g = hint ? local(fr, s, th, hint) : (++lostTick % 3 === 1 ? global(fr, s, th) : null);
          if (g && g.score >= thReacq) { m = g; src = 'reacq'; lost = false; } else return out(f, s, th, g ? g.score : 0, 'lost');
        } else if (m.score < thLost) {
          const g = hint ? local(fr, s, th, hint) : global(fr, s, th);
          if (g.score >= thReacq) { m = g; src = 'reacq'; }
          else {
            lost = true; vx = vy = 0;
            if (opt.resetOnLost) tplA = tplRef;   // 보조점: 놓치면 적응 템플릿을 버리고 검증된 모습으로 다시 찾는다 (미끄러진 모습으로 재탐색하면 미끄러진 자리를 다시 찾는다)
            return out(f, s, th, g.score, 'lost');
          }
        }
        vx = 0.7 * (m.x - px); vy = 0.7 * (m.y - py);             // 감쇠한 속도 (예측 과신 방지)
        px = m.x; py = m.y;                                        // 소수 위치 유지
        // 매 프레임 갱신 — 외형 변화 추종 (갱신을 아끼면 낡아서 미끄러진다: 케이스 A 실측).
        // ★ 단, 무늬가 없는 곳(단색 파우치 속, std<6)으로는 갱신하지 않는다 — 단색 위 NCC는 어디서나 1.0이라 점이 자유롭게 미끄러진다(시계 실측: 회전 19° 표류)
        const t = makeTemplate(fr, W, H, px, py, w, h, s, th);
        if (t.std >= minStd) tplA = t;
        return Object.assign(out(f, s, th, m.score, src), { so });
      }
    };
  }

  function track(frames, W, H, box, R, opt) {
    const t = makeTracker(frames[0], W, H, box, R, opt), out = [t.init()];
    for (let f = 1; f < frames.length; f++) out.push(t.step(frames[f], f, 1, 0));
    return out;
  }

  /* 두 박스 동시 추적. 매 프레임 두 중심 벡터의 길이비 = 배율, 각도 차 = 회전을 다음 프레임 템플릿 격자에 되먹인다
   * (프레임당 ±5%·±15° 제한, 한쪽 놓치면 유지). 회전 되먹임이 없으면 축 정렬 템플릿이 돌아간 무늬 위를 미끄러진다(레코드판 실측).
   * 기하가 내는 (s,θ)는 두 점에 "후보"로만 준다 — 각 점은 자기 원본 모습이 그 변환에서 더 잘 맞을 때만 채택한다(step 참조).
   * 그래서 B가 미끄러진 기하(얼굴+헤드폰 실측: 거리 60→350px, s 5.8)가 A 템플릿을 키워 A까지 놓치게 하는 사고가 구조적으로 막힌다.
   *   - B(보조점)는 놓치면 적응 템플릿을 버리고 검증된 모습으로 다시 찾는다. 놓친 쪽의 예측 위치 = 짝 + R(θ)·s·(초기 벡터) */
  function trackPair(frames, W, H, boxA, boxB, R, opt) {
    /* A(위치 기준점) = 자기 원본 모습이 확인한 변환만 채택(step 참조) → 미끄러진 기하가 A를 오염시키지 못한다(얼굴+헤드폰·댄스 실측 A lost 0).
     * B(보조점) = 기하를 무조건 채택 → 회전 레코드판처럼 원본 대조가 약해지는 구간에도 격자가 따라간다. B 놓침 문턱은 A와 같은 0.45(0.6은 레코드판 35프레임 놓침 실측). */
    // B 재탐색 문턱 0.75: 보조점은 잘못 다시 잡는 것(얼굴+헤드폰 실측: 예측 위치 근처 배경을 0.6대로 잡고 30프레임 미끄러져 s 5.9)보다 놓친 채 보간되는 게 낫다
    const tA = makeTracker(frames[0], W, H, boxA, R, Object.assign({ selfScale: true }, opt || {})), tB = makeTracker(frames[0], W, H, boxB, R, Object.assign({ resetOnLost: true, alwaysAdopt: true, reacq: 0.75, noWide: true }, opt || {}));
    const a = [tA.init()], b = [Object.assign(tB.init(), { ps: 1, pth: 0 })];
    const u = [b[0].cx - a[0].cx, b[0].cy - a[0].cy], d0 = Math.hypot(u[0], u[1]) || 1, a0 = Math.atan2(u[1], u[0]);
    const rel = (sP, thP) => { const cs = Math.cos(thP), sn = Math.sin(thP); return [(u[0] * cs - u[1] * sn) * sP, (u[0] * sn + u[1] * cs) * sP]; };
    let s = 1, th = 0, dth = 0, ds = 1;   // dth·ds = 직전 프레임의 각속도·배율 변화 → 다음 프레임 후보는 예측값으로 (레코드판 6.5°/프레임: 한 프레임 뒤처진 격자가 옆 글자로 건너뛰게 한다)
    const LIM = 15 * Math.PI / 180;
    let aSeen = -99;   // A의 배율이 자기 모습으로 관측된 마지막 프레임
    for (let f = 1; f < frames.length; f++) {
      const pa = a[f - 1], pb = b[f - 1], sP = s * Math.pow(ds, 0.7), thP = th + 0.7 * dth, v = rel(sP, thP);
      const ra = tA.step(frames[f], f, sP, thP, pb.src !== 'lost' ? [pb.cx - v[0], pb.cy - v[1]] : null);
      let rb = tB.step(frames[f], f, sP, thP, ra.src !== 'lost' ? [ra.cx + v[0], ra.cy + v[1]] : null);
      const aOK = ra.src === 'orig' && ra.so, thA = ra.th * Math.PI / 180;
      if (aOK && rb.src !== 'orig') {   // B가 미확인(적응·놓침)이고 A는 확인됨 → A의 변환으로 예측한 자리에서 B의 원본 모습을 되잡아 본다
        const pv = rel(ra.s, thA), k = tB.relock(frames[f], f, [ra.cx + pv[0], ra.cy + pv[1]], ra.s, thA, Math.max(4, Math.round(0.15 * d0 * ra.s)));
        if (k) rb = k;
      }
      a.push(ra); b.push(rb);
      let gs = null;
      const sBefore = s;
      if (ra.src !== 'lost' && rb.src !== 'lost') {
        const off = [rb.cx - ra.cx, rb.cy - ra.cy];
        gs = Math.hypot(off[0], off[1]) / d0;
        const ns = Math.min(5, Math.max(0.2, Math.min(s * 1.05, Math.max(s * 0.95, gs))));
        let d = Math.atan2(off[1], off[0]) - a0 - th;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        d = Math.max(-LIM, Math.min(LIM, d));
        ds = ns / s; dth = d; s = ns; th += d;
      } else { ds = 1; dth = 0; }
      /* A 우선 규칙: A는 원본 모습으로 확인됐고 배율도 자기 모습으로 관측되는데(so) B는 미확인이고, 두 점 거리가 A의 자기 배율과 5% 넘게 어긋나면(또는 B를 놓쳤으면 — 처음엔 12%였는데 둘째 핀이 다른 깊이의 키보드일 때 실제 0.85배를 0.78배로 냄, 실기) B가 미끄러진 것 → 쌍 배율·회전을 A 것으로.
       * 둘 다 확인됐거나 A가 미확인(얼굴 등)이면 지금까지처럼 두 점 기하를 쓴다. */
      if (aOK) aSeen = f;
      let known = gs !== null;
      /* A 관측이 몇 프레임 끊긴 사이(블러·게이트 미달, 최근 15프레임 안엔 관측됨) 미확인 B의 기하가 A.s와 12%↑ 어긋나면 배율만 직전 값으로 붙든다 — 안 그러면 그 몇 프레임 동안
       * 미끄러진 B 쪽으로 프레임당 5%씩 끌려갔다 돌아온다(시계 실기 f306~316: 2.42→2.07→2.41 펌핑 = "크기가 부자연스럽다"). 회전은 건드리지 않는다:
       * 이 구간에 th까지 A 것으로 묶으면 도는 레코드판에서 B 격자가 뒤처져 61프레임 놓쳤다(실측). 얼굴처럼 한 번도 관측 안 되는 표적은 해당 없음. */
      if (!aOK && f - aSeen <= 15 && gs !== null && rb.src !== 'orig' && Math.abs(gs / ra.s - 1) > 0.12) { s = sBefore; ds = 1; }
      if (aOK && rb.src !== 'orig' && (gs === null || Math.abs(gs / ra.s - 1) > 0.05)) { s = ra.s; th = thA; ds = 1; dth = 0; known = true; }
      rb.ps = known ? s : null; rb.pth = known ? th * 180 / Math.PI : null;
    }
    return { a, b };
  }

  // frames[iP]에서 시작해 앞(iP→끝)·뒤(iP→0) 양방향으로 돌린 두 결과를 프레임 순서(f = 0..N-1)로 합친다
  function merge(n, iP, fwd, bwd) {
    const out = new Array(n);
    for (let i = 0; i < bwd.length; i++) out[iP - i] = Object.assign({}, bwd[i], { f: iP - i });
    for (let i = 0; i < fwd.length; i++) out[iP + i] = Object.assign({}, fwd[i], { f: iP + i });
    return out;
  }
  const halves = (frames, iP) => [frames.slice(iP), frames.slice(0, iP + 1).reverse()];
  function trackAround(frames, W, H, iP, box, R, opt) {
    const [fw, bw] = halves(frames, iP);
    return merge(frames.length, iP, track(fw, W, H, box, R, opt), track(bw, W, H, box, R, opt));
  }
  function trackPairAround(frames, W, H, iP, boxA, boxB, R, opt) {
    const [fw, bw] = halves(frames, iP), F = trackPair(fw, W, H, boxA, boxB, R, opt), B = trackPair(bw, W, H, boxA, boxB, R, opt);
    return { a: merge(frames.length, iP, F.a, B.a), b: merge(frames.length, iP, F.b, B.b) };
  }

  // null(놓친 프레임)을 앞뒤 유효값으로 선형 보간, 양 끝은 가장 가까운 값으로
  function fill(a) {
    const out = a.slice(), n = a.length;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (out[i] === null) continue;
      if (prev < 0) { for (let j = 0; j < i; j++) out[j] = out[i]; }
      else for (let j = prev + 1; j < i; j++) out[j] = out[prev] + (out[i] - out[prev]) * (j - prev) / (i - prev);
      prev = i;
    }
    if (prev < 0) return out.map(() => 0);
    for (let j = prev + 1; j < n; j++) out[j] = out[prev];
    return out;
  }
  /* 중앙값(5) → 이동평균(5): 서브픽셀 위치 잡음(±0.5px)이 거리비·각도로 번지는 걸 누른다.
   * 양 끝은 첫·끝 5개의 기울기로 선형 외삽해 채운 뒤 거른다 — 창을 그냥 잘라 쓰면 끝에서 뒤따르는 필터가 돼 경사가 2프레임 뒤처진다(합성 60° 회전 실측 57.2°) */
  function smooth(a) {
    const n = a.length, P = 4;
    if (n < 2) return a.slice();
    const k = Math.min(4, n - 1), s0 = (a[k] - a[0]) / k, s1 = (a[n - 1] - a[n - 1 - k]) / k, p = [];
    for (let i = P; i >= 1; i--) p.push(a[0] - s0 * i);
    for (let i = 0; i < n; i++) p.push(a[i]);
    for (let i = 1; i <= P; i++) p.push(a[n - 1] + s1 * i);
    const med = p.map((_, i) => { const w = p.slice(Math.max(0, i - 2), i + 3).sort((x, y) => x - y); return w[w.length >> 1]; });
    const out = med.map((_, i) => { const w = med.slice(Math.max(0, i - 2), i + 3); return w.reduce((x, y) => x + y, 0) / w.length; });
    return out.slice(P, P + n);
  }

  /* 두 점 기하 (AE 트래커 방식): 두 박스 중심을 잇는 벡터의 길이비 = 배율, 각도 차 = 회전(도, 화면 기준 시계 방향 + = 프리미어 Rotation과 같다).
   * 한쪽이 놓친 프레임은 보간, 평활화 후 플레이헤드 프레임(iP)을 1·0으로 정규화(대상은 그 프레임의 현재 크기·회전을 유지).
   * active 게이트: 배율은 전체 변화 ≥ minScale(8%), 회전은 ≥ minRot(3°)일 때만 — 정지 피사체의 떨림을 키로 쓰지 않는다. */
  function twoPoint(resA, resB, iP, opt) {
    opt = opt || {};
    const vec = i => [resB[i].cx - resA[i].cx, resB[i].cy - resA[i].cy];
    const v0 = vec(iP), d0 = Math.hypot(v0[0], v0[1]) || 1;
    const n = resA.length, s = new Array(n), rot = new Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      if ('ps' in resB[i]) { s[i] = resB[i].ps; rot[i] = resB[i].pth; continue; }   // 쌍 추적 결과: 프레임별 쌍 배율·회전(A 우선 규칙 반영). 없으면(단독 추적 두 개) 중심 기하로
      if (resA[i].src === 'lost' || resB[i].src === 'lost') { s[i] = rot[i] = null; continue; }
      const v = vec(i); s[i] = Math.hypot(v[0], v[1]) / d0;
      let a = Math.atan2(v[1], v[0]) * 180 / Math.PI;
      while (a - prev > 180) a -= 360; while (a - prev < -180) a += 360;   // 연속 각도로 (±180 경계 점프 방지, 여러 바퀴 회전도 누적)
      rot[i] = a; prev = a;
    }
    let S = smooth(fill(s));
    const Rt = smooth(fill(rot));
    /* 도는 물체(누적 한 바퀴 이상): 비스듬히 찍힌 원판 위 두 점의 거리는 회전 위상 따라 출렁인다(원근 — 레코드판 실기: 한 바퀴마다 0.79~1.09, 글자가 숨쉬듯 커졌다 작아짐).
     * 실제 크기 변화가 아니므로 한 바퀴 길이의 창으로 기하평균해 출렁임만 뺀다 — 카메라 줌 같은 추세는 남는다. 양 끝은 추세 외삽. */
    const turn = Math.abs(Rt[n - 1] - Rt[0]);
    if (turn >= 360) {
      const P = Math.min(n - 1, Math.round(360 * (n - 1) / turn)), L = S.map(Math.log), cum = [0];
      for (let i = 0; i < n; i++) cum.push(cum[i] + L[i]);
      const h = P >> 1, M = i => (cum[i - h + P + 1] - cum[i - h]) / (P + 1), a = h, b = n - 1 - (P - h);   // M(i) = i를 가운데 둔 한 바퀴 평균(로그), a..b = 창이 온전히 들어가는 범위
      const q = Math.max(1, Math.min(P, b - a)), sa = (M(Math.min(b, a + q)) - M(a)) / q, sb = (M(b) - M(Math.max(a, b - q))) / q;   // 양 끝은 첫·끝 한 바퀴의 추세로 외삽 (창을 밀어 쓰면 줌 추세가 반 바퀴만큼 평평해진다)
      S = S.map((_, i) => Math.exp(i < a ? M(a) + sa * (i - a) : i > b ? M(b) + sb * (i - b) : M(i)));
    }
    const s0 = S[iP] || 1, r0 = Rt[iP];
    let maxDev = 0, maxRot = 0;
    for (let i = 0; i < n; i++) { S[i] /= s0; Rt[i] -= r0; maxDev = Math.max(maxDev, Math.abs(S[i] - 1)); maxRot = Math.max(maxRot, Math.abs(Rt[i])); }
    return { s: S, rot: Rt, sActive: maxDev >= (opt.minScale || 0.08), rActive: maxRot >= (opt.minRot || 3), d0 };
  }

  /* 박스 품질 (그리는 순간 경고용): std = 무늬 세기(8비트 표준편차, 단색 3~5 · 얼굴 20+),
   * distinct = 같은 프레임에서 박스 크기만큼 둘러본 범위 중 자기 자리(±짧은변/4)를 뺀 최고 유사도 — 0.9 넘으면 박스 크기 안에서 자리를 못 잡고 미끄러진다
   * (실측: 단색 파우치 모서리 0.95·보조배터리 0.89 vs 시계 0.59·얼굴 0.78·레코드 글자 0.38). ±2px 제외로는 큰 매끈한 박스(얼굴 0.96)까지 걸려 못 쓴다. */
  function quality(frame, W, H, box) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, m = Math.min(box.w, box.h), t = makeTemplate(frame, W, H, cx, cy, box.w, box.h, 1, 0);
    const ex = Math.max(2, Math.round(m / 4)), R = Math.max(24, m);
    // slide = 한 축으로만 밀었을 때의 최고 유사도(가로선·세로선만 있는 박스는 그 방향으로 자유롭게 미끄러진다: 검은 파우치 실측)
    const axis = (dx, dy) => { let best = -2; for (let k = -R; k <= R; k++) { if (Math.abs(k) <= ex) continue; const c = match(frame, W, H, t, cx + dx * k, cy + dy * k, 0, 1, 0, 1).score; if (c > best) best = c; } return best; };
    return { std: t.std, distinct: match(frame, W, H, t, cx, cy, R, 1, 0, 1, ex).score, slide: Math.max(axis(1, 0), axis(0, 1)) };
  }

  /* 추적 결과 → Position 키 목록 (놓친 프레임은 null → 키를 안 박아 앞뒤 키 사이가 부드럽게 보간된다).
   * 대상이 피사체에 단단히 붙은 것처럼:  pos_i = T_i + R(θ_i)·(base − T_P)·s_i
   *   (T = 추적점(첫 박스 중심)의 시퀀스 px, s·θ = twoPoint 배율·회전, 없으면 1·0)
   * 오프셋을 같이 키우고 돌리면 대상의 앵커가 어디 있든 결과가 같다(피사체+대상 전체가 추적점 중심으로 변환되는 것과 동일).
   * o = { iP, t0Sec, fps, k(축소px → 시퀀스px 배율), base:[px,py](대상의 현재 Position), trackP:[px,py](플레이헤드의 추적점, 시퀀스 px), scale?:[], rot?:[](도) } */
  function toKeys(res, o) {
    const c0 = res[o.iP], off = [o.base[0] - o.trackP[0], o.base[1] - o.trackP[1]];
    return res.map((r, i) => {
      if (r.src === 'lost') return null;
      const s = o.scale ? o.scale[i] : 1, th = o.rot ? o.rot[i] * Math.PI / 180 : 0;
      const ox = off[0] * s, oy = off[1] * s, cs = Math.cos(th), sn = Math.sin(th);
      return [o.t0Sec + i / o.fps, o.trackP[0] + (r.cx - c0.cx) * o.k + ox * cs - oy * sn, o.trackP[1] + (r.cy - c0.cy) * o.k + ox * sn + oy * cs];
    });
  }
  // 값 시계열(배율%·회전° 등, 이미 대상 기준으로 환산된 값) → [[초, 값] | null(놓침), …]
  function toValueKeys(res, vals, o) {
    return res.map((r, i) => r.src === 'lost' ? null : [o.t0Sec + i / o.fps, vals[i]]);
  }

  /* 필요한 키만 남기기 (Douglas–Peucker): 앞뒤 키를 직선으로 이었을 때 오차가 tol 안이면 사이 키는 뺀다.
   * 프리미어가 키 사이를 직선 보간하므로 뺀 프레임의 값은 그대로다. 키 하나 쓰는 데 20~30ms(실기: 652키 20초)라 이게 기록 시간의 전부다.
   * keys = [[초, v1, v2?] | null, …]. null(놓침)은 구간을 끊고, 구간 양 끝은 항상 남긴다. 반환 = 남긴 키 배열(null 제거). */
  function simplifyKeys(keys, tol) {
    const dist = (p, a, b) => {   // p를 a-b 직선 보간값과 비교 (값 차원 1~2)
      const u = b[0] === a[0] ? 0 : (p[0] - a[0]) / (b[0] - a[0]);
      let d = 0; for (let k = 1; k < p.length; k++) { const e = p[k] - (a[k] + (b[k] - a[k]) * u); d += e * e; }
      return Math.sqrt(d);
    };
    const out = [];
    let i = 0;
    while (i < keys.length) {
      if (keys[i] === null) { i++; continue; }
      let j = i; while (j + 1 < keys.length && keys[j + 1] !== null) j++;   // [i, j] = 연속 구간
      const keep = new Set([i, j]), stack = [[i, j]];
      while (stack.length) {
        const [a, b] = stack.pop();
        let best = -1, bd = tol;
        for (let m = a + 1; m < b; m++) { const d = dist(keys[m], keys[a], keys[b]); if (d > bd) { bd = d; best = m; } }
        if (best >= 0) { keep.add(best); stack.push([a, best], [best, b]); }
      }
      for (let m = i; m <= j; m++) if (keep.has(m)) out.push(keys[m]);
      i = j + 1;
    }
    return out;
  }

  /* 고정(피사체를 한 자리에 못 박기, 9/24): 소스 클립 자체의 Position 키. 재생 헤드 프레임에서 피사체가 있던 화면 위치 C에 계속 머물도록 클립을 반대로 옮긴다.
   *   pos_i = C − R(−θ_i)·(T_i − 프레임 중심)·k·z/s_i     (s·θ = twoPoint 배율·회전 → 역으로 적용해 크기·기울기도 고정, z = 가장자리 채움 확대)
   * 앵커 포인트 키 없이 Position·Scale·Rotation만으로 된다: 클립을 중심 기준으로 −θ 돌리고 z/s 배 키운 뒤, 그 상태에서 추적점이 C에 오도록 위치를 잡는 것.
   * o = { t0Sec, fps, k, C:[px,py], W, H(추적 해상도), zoom, scale?:[], rot?:[](도) } */
  function lockKeys(res, o) {
    return res.map((r, i) => {
      if (r.src === 'lost') return null;
      const z = o.zoom / (o.scale ? o.scale[i] : 1), th = o.rot ? -o.rot[i] * Math.PI / 180 : 0, cs = Math.cos(th), sn = Math.sin(th);
      const dx = (r.cx - o.W / 2) * o.k * z, dy = (r.cy - o.H / 2) * o.k * z;
      return [o.t0Sec + i / o.fps, o.C[0] - (dx * cs - dy * sn), o.C[1] - (dx * sn + dy * cs)];
    });
  }
  /* 고정했을 때 화면 가장자리가 비지 않는 최소 확대(≥1). 시퀀스 네 모서리 q를 미디어 좌표로 되돌리면 T_i + R(θ_i)(q − C)·s_i/(k·z) — 이게 프레임 안이어야 한다.
   * 즉 z ≥ |u| / (추적점에서 그 방향 프레임 끝까지의 여유), u = R(θ)(q − C)·s/k. 여유가 1px도 없으면(피사체가 가장자리) 그 항은 못 채우므로 건너뛴다.
   * o = { k, C, W, H, fw, fh, scale?, rot? } */
  function lockZoom(res, o) {
    let z = 1;
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r.src === 'lost') continue;
      const f = (o.scale ? o.scale[i] : 1) / o.k, th = o.rot ? o.rot[i] * Math.PI / 180 : 0, cs = Math.cos(th), sn = Math.sin(th);
      for (const c of [[0, 0], [o.fw, 0], [0, o.fh], [o.fw, o.fh]]) {
        const qx = (c[0] - o.C[0]) * f, qy = (c[1] - o.C[1]) * f, ux = qx * cs - qy * sn, uy = qx * sn + qy * cs;
        const rx = ux > 0 ? o.W - r.cx : r.cx, ry = uy > 0 ? o.H - r.cy : r.cy;
        if (rx > 1) z = Math.max(z, Math.abs(ux) / rx);
        if (ry > 1) z = Math.max(z, Math.abs(uy) / ry);
      }
    }
    return z;
  }

  /* 시퀀스에 보이는 원본 영역(미디어 px). 9/24 실기: 클립을 키워 일부만 보이는데 원본 전체를 640px로 줄여 보여 주고 추적했다
   * (232% 클립: 보이는 넓이 15%, 핀이 작아 225% 확대가 필요했고 추적 1px = 시퀀스 7.4px). 시퀀스 사각형을 소스 변환의 역으로 되돌린 게 vis,
   * 거기에 여유(margin = 한 변의 비율)를 붙여 미디어 안으로 자른 게 crop. 앵커 = 미디어 중심 가정(소스 회전·앵커 이동 미지원과 같은 전제).
   * crop은 짝수 좌표·크기(ffmpeg crop이 색 부표본 때문에 홀수를 내린다). 얻는 게 적으면(넓이 80% 이상) 또는 거의 화면 밖이면 원본 전체.
   * o = { w, h(미디어), fw, fh(시퀀스), pos:[x,y](소스 Position, 시퀀스 px), scale(1 = 100%), margin } → { vis, crop } (각 {x,y,w,h}) */
  function viewRegion(o) {
    const vis = { x: o.w / 2 - o.pos[0] / o.scale, y: o.h / 2 - o.pos[1] / o.scale, w: o.fw / o.scale, h: o.fh / o.scale };
    const mx = vis.w * o.margin, my = vis.h * o.margin, full = { x: 0, y: 0, w: o.w, h: o.h };
    const x0 = Math.max(0, 2 * Math.floor((vis.x - mx) / 2)), y0 = Math.max(0, 2 * Math.floor((vis.y - my) / 2));
    const x1 = Math.min(o.w, 2 * Math.ceil((vis.x + vis.w + mx) / 2)), y1 = Math.min(o.h, 2 * Math.ceil((vis.y + vis.h + my) / 2));
    const crop = { x: x0, y: y0, w: (x1 - x0) & ~1, h: (y1 - y0) & ~1 };
    if (crop.w < 32 || crop.h < 32 || crop.w * crop.h >= 0.8 * o.w * o.h) return { vis, crop: full };
    return { vis, crop };
  }

  const api = { makeTemplate, match, track, trackAround, trackPair, trackPairAround, twoPoint, quality, toKeys, toValueKeys, simplifyKeys, lockKeys, lockZoom, viewRegion };
  root.TrackCore = api;                                                     // 패널 전역 (CEP엔 module이 있어 UMD 분기는 쓰지 않는다)
  if (typeof module === 'object' && module.exports) module.exports = api;  // Node 테스트
})(typeof window !== 'undefined' ? window : globalThis);
