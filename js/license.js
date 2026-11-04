/* Bobos — 라이선스 (지인 배포용 · 오프라인)
 *
 * 키 = "BOBOS-" + base64url(JSON 페이로드) + "." + base64url(Ed25519 서명)
 *   페이로드: { p:"bobos", v:1, n:이름, d:기기코드, i:발급일, k:키ID }
 *   서명 대상 = 페이로드 base64url 문자열(ASCII) 그대로 — JSON 정렬 차이와 무관
 * 패널에는 공개키만 들어 있다. 개인키는 키 발급 도구(Bobos-키발급도구/private-key.pem)에만 있다.
 *
 * 기기 코드 = sha256("bobos-device-v1|" + 기기 고유값) 앞 10바이트 → Crockford base32 16자 (XXXX-XXXX-XXXX-XXXX)
 *   윈도우: 레지스트리 MachineGuid · 맥: IOPlatformUUID · 둘 다 못 읽으면 컴퓨터 이름+사용자+CPU
 * 키 저장: 윈도우 %APPDATA%\Bobos\license.key · 맥 ~/Library/Application Support/Bobos/license.key (+ localStorage 백업)
 *   → 플러그인을 지웠다 다시 깔아도 키를 다시 넣을 필요 없음
 *
 * 차단: 키가 새면 REVOKED에 그 키의 키ID(k)를 넣고 업데이트를 배포한다 (발급기록.csv의 '키ID' 열). */
(function (root) {
  'use strict';

  var PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEA7Zp720tXOeF+0IQYzNaTosli++nwB5Q/TFNw2cnFLys=\n' +
    '-----END PUBLIC KEY-----\n';
  var REVOKED = [];   // 예: ['a1b2c3d4']
  var LS_KEY = 'bobos_license';

  var nodeRequire = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : (typeof require !== 'undefined' ? require : null);
  var crypto = null, cp = null, fs = null, os = null, path = null;
  if (nodeRequire) {
    try { crypto = nodeRequire('crypto'); cp = nodeRequire('child_process'); fs = nodeRequire('fs'); os = nodeRequire('os'); path = nodeRequire('path'); } catch (e) { crypto = null; }
  }
  var IS_WIN = typeof process !== 'undefined' && process.platform === 'win32';

  var MESSAGES = {
    node: 'Node를 쓸 수 없는 환경이에요. Premiere Pro 2022 이상에서 실행해 주세요.',
    format: '키 형식이 올바르지 않아요. 받은 키 전체(BOBOS-로 시작)를 빠짐없이 붙여 넣었는지 확인해 주세요.',
    sig: '올바른 Bobos 키가 아니에요. 받은 키를 그대로 다시 붙여 넣어 주세요.',
    device: '이 키는 다른 컴퓨터용이에요. 이 컴퓨터의 기기 코드를 보내고 새 키를 받아 주세요.',
    revoked: '사용이 중지된 키예요. Bobos를 준 사람에게 문의해 주세요.',
    none: ''
  };

  // ---- 인코딩
  function b64uDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) { s += '='; }
    return Buffer.from(s, 'base64');
  }
  var ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford — I·L·O·U 없음 (헷갈리는 글자 제외)
  function base32(buf) {
    var out = '', bits = 0, val = 0;
    for (var i = 0; i < buf.length; i++) {
      val = (val << 8) | buf[i]; bits += 8;
      while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) { out += ALPH[(val << (5 - bits)) & 31]; }
    return out;
  }

  // ---- 윈도우 환경변수: CEP Node의 process.env는 한글 사용자 폴더가 깨질 수 있어 cmd로 UTF-16 재조회 (Pin과 같은 방법)
  function winEnv(name) {
    try {
      var out = cp.execSync('cmd /d /u /c echo %' + name + '%', { encoding: 'utf16le', windowsHide: true, timeout: 5000 }).trim();
      if (out && out !== '%' + name + '%') { return out; }
    } catch (e) {}
    return process.env[name] || '';
  }

  // ---- 기기 코드
  var deviceCache = null;
  function rawMachineId() {
    try {
      if (IS_WIN) {
        var reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
        var out = cp.execFileSync(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        var m = out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Za-z-]+)/);
        if (m) { return 'win|' + m[1].toLowerCase(); }
      } else if (process.platform === 'darwin') {
        var out2 = cp.execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
        var m2 = out2.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        if (m2) { return 'mac|' + m2[1].toLowerCase(); }
      }
    } catch (e) {}
    var user = '';
    try { user = os.userInfo().username; } catch (e2) {}
    var cpu = '';
    try { cpu = (os.cpus()[0] || {}).model || ''; } catch (e3) {}
    return 'fb|' + os.hostname() + '|' + user + '|' + cpu;
  }
  function deviceCode() {
    if (deviceCache) { return deviceCache; }
    if (!crypto) { return ''; }
    var h = crypto.createHash('sha256').update('bobos-device-v1|' + rawMachineId(), 'utf8').digest();
    var s = base32(h.slice(0, 10));   // 80비트 = 16자
    deviceCache = s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
    return deviceCache;
  }

  // ---- 키 검증
  function parse(key) {
    var s = String(key || '').replace(/\s+/g, '');
    if (s.indexOf('BOBOS-') !== 0) { return null; }
    var parts = s.slice(6).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) { return null; }
    var lic = null;
    try { lic = JSON.parse(b64uDecode(parts[0]).toString('utf8')); } catch (e) { return null; }
    if (!lic || typeof lic !== 'object') { return null; }
    return { clean: s, payloadB64: parts[0], sig: b64uDecode(parts[1]), lic: lic };
  }
  function verify(key) {
    if (!crypto || typeof crypto.verify !== 'function') { return { ok: false, reason: 'node' }; }
    var p = parse(key);
    if (!p) { return { ok: false, reason: 'format' }; }
    var good = false;
    try { good = crypto.verify(null, Buffer.from(p.payloadB64, 'ascii'), crypto.createPublicKey(PUBLIC_KEY), p.sig); } catch (e) { good = false; }
    if (!good || p.lic.p !== 'bobos' || p.lic.v !== 1) { return { ok: false, reason: 'sig' }; }
    if (REVOKED.indexOf(p.lic.k) >= 0) { return { ok: false, reason: 'revoked', lic: p.lic }; }
    if (p.lic.d !== deviceCode()) { return { ok: false, reason: 'device', lic: p.lic }; }
    return { ok: true, lic: p.lic, clean: p.clean };
  }

  // ---- 저장
  function licFile() {
    try {
      var base = IS_WIN ? winEnv('APPDATA') : path.join(os.homedir(), 'Library', 'Application Support');
      return base ? path.join(base, 'Bobos', 'license.key') : null;
    } catch (e) { return null; }
  }
  function load() {
    var f = licFile();
    if (f) { try { var t = fs.readFileSync(f, 'utf8').trim(); if (t) { return t; } } catch (e) {} }
    try { return localStorage.getItem(LS_KEY) || ''; } catch (e2) { return ''; }
  }
  function save(key) {
    var f = licFile();
    if (f) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, key, 'utf8'); } catch (e) {} }
    try { localStorage.setItem(LS_KEY, key); } catch (e2) {}
  }
  function clear() {
    var f = licFile();
    if (f) { try { fs.unlinkSync(f); } catch (e) {} }
    try { localStorage.removeItem(LS_KEY); } catch (e2) {}
  }

  // 시작할 때: 저장된 키 확인
  function check() {
    if (!crypto) { return { ok: false, reason: 'node' }; }
    var k = load();
    if (!k) { return { ok: false, reason: 'none' }; }
    return verify(k);
  }
  // 등록 버튼: 검증에 통과한 키만 저장
  function activate(key) {
    var r = verify(key);
    if (r.ok) { save(r.clean); }
    return r;
  }

  root.BobosLicense = {
    deviceCode: deviceCode, check: check, activate: activate, verify: verify, clear: clear,
    message: function (reason) { return MESSAGES[reason] || ''; }
  };
}(typeof window !== 'undefined' ? window : this));
