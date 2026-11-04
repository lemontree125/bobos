/* Bobos · 효과음 탭 — 의성어·분위기 사전 + 검색 엔진
 *
 * 효과음 팩은 대부분 영어 파일명(Cartoon_Boing_03.wav)이라 "띠용"으로는 그냥 안 걸린다.
 * 그래서 한글 의성어/분위기 → 영어 키워드 묶음을 두고, 검색어를 펼쳐서 파일명·폴더명·태그에서 찾는다.
 *
 * 묶음 = [한글 키들, 영어 키워드들, (1 = 분위기·용도 묶음)]. 분위기 묶음은 한글로 찾을 때만 펼친다
 *   (영어 'whoosh'를 쳤는데 '전환' 묶음이 펼쳐져 impact·riser까지 나오지 않게).
 *   검색어가 묶음의 한글 키와 겹치거나(포함 관계) 영어 키워드와 같으면
 * 그 묶음의 모든 단어로 찾는다. 사전에 단어를 더 넣고 싶으면 여기 줄만 추가하면 된다.
 * CHIPS = 검색창 아래 빠른 검색 버튼.
 *
 * window.SfxSearch = { expand(term), search(files, query, tagsOf), haystack(relPath), CHIPS } */
(function (root) {
  'use strict';

  var GROUPS = [
    // ── 만화·예능 리액션
    [['띠용', '띠요옹', '뾰잉', '뾰옹', '띠오옹', '스프링', '튕김'], ['boing', 'sproing', 'spring', 'bounce', 'bouncy', 'doink', 'jaw harp', 'jew harp', 'twang']],
    [['슉', '슝', '쉭', '휙', '휘익', '쉬익', '슈욱', '쓩', '휭', '스윽'], ['whoosh', 'woosh', 'swoosh', 'swish', 'swipe', 'swing', 'pass by', 'passby', 'fly by', 'flyby', 'zip', 'whip']],
    [['뿅', '뽁', '뽀잉', '뽕', '퐁', '뾱', '팝'], ['pop', 'bloop', 'blip', 'plop', 'bubble', 'boop', 'pluck', 'cork']],
    [['뾰로롱', '반짝', '반짝반짝', '샤랄라', '띠링', '마법', '요정'], ['sparkle', 'twinkle', 'shine', 'glitter', 'magic', 'fairy', 'chime', 'shimmer', 'wand', 'glint']],
    [['짠', '짜잔', '빠밤', '빰', '팡파레', '등장'], ['tada', 'ta-da', 'ta da', 'fanfare', 'reveal', 'sting', 'stinger', 'announce', 'trumpet']],
    [['두둥', '둥', '두두둥', '긴박', '충격'], ['dun dun', 'dramatic', 'sting', 'stinger', 'impact', 'boom', 'bass drop', 'braam', 'hit', 'suspense']],
    [['딩동', '띵동', '띵', '딩', '정답', '맞음', '성공'], ['ding', 'ding dong', 'correct', 'right', 'success', 'win', 'bell', 'chime', 'achievement', 'positive']],
    [['땡', '삐빅', '오답', '틀림', '실패', '에러'], ['wrong', 'buzzer', 'error', 'fail', 'incorrect', 'lose', 'negative', 'denied', 'bonk']],
    [['삐', '삑', '삐처리', '비프'], ['beep', 'bleep', 'censor', 'blip']],
    [['헉', '어머', '오오', '놀람', '깜짝'], ['gasp', 'surprise', 'surprised', 'wow', 'ooh', 'shock', 'shocked', 'whoa']],
    [['웃음', '하하', '깔깔', '킥킥', '웃긴', '시트콤'], ['laugh', 'laughter', 'laughing', 'giggle', 'chuckle', 'sitcom', 'haha']],
    [['박수', '짝짝', '박수갈채'], ['applause', 'clap', 'clapping', 'claps']],
    [['환호', '와아', '함성', '응원'], ['cheer', 'cheering', 'crowd', 'yay', 'hooray', 'applause']],
    [['야유', '우우', '부우'], ['boo', 'booing', 'jeer']],
    [['아쉬움', '에이', '아이고'], ['aww', 'awww', 'disappoint', 'disappointed', 'sad trombone', 'womp']],
    [['코믹', '웃긴소리', '우스꽝', '개그', '예능'], ['funny', 'comic', 'comedy', 'cartoon', 'silly', 'goofy', 'toon', 'wacky'], 1],
    [['귀여운', '귀염', '큐트', '깜찍'], ['cute', 'kawaii', 'cartoon', 'bubbly', 'squeak', 'toy'], 1],
    [['뿌뿌', '삑삑이', '장난감'], ['squeak', 'squeaky', 'toy', 'rubber duck', 'honk']],
    [['미끄러짐', '주르륵', '미끄덩'], ['slide', 'slip', 'slide whistle', 'whistle down', 'whistle up']],
    [['떨어짐', '추락', '휘이잉', '낙하'], ['fall', 'falling', 'drop', 'whistle', 'descend', 'plummet']],
    [['끽', '끼익', '스크래치', '레코드'], ['record scratch', 'scratch', 'screech', 'vinyl stop', 'rewind']],
    [['되감기', '테이프', '뒤로감기'], ['rewind', 'tape', 'vhs', 'reverse', 'tape stop']],

    // ── 타격·액션
    [['쾅', '꽝', '콰광', '폭발', '펑'], ['boom', 'explosion', 'explode', 'blast', 'bang', 'kaboom', 'detonation']],
    [['쿵', '쿠웅', '털썩', '둔탁'], ['thud', 'thump', 'impact', 'slam', 'heavy', 'drop', 'body fall']],
    [['퍽', '퍼억', '빡', '타격', '때림', '펀치'], ['punch', 'hit', 'smack', 'whack', 'impact', 'kick', 'strike', 'bonk']],
    [['찰싹', '짝', '따귀'], ['slap', 'smack', 'face slap']],
    [['챙', '칼', '검', '쉭칼'], ['sword', 'blade', 'slash', 'sheath', 'unsheath', 'metal', 'katana', 'knife']],
    [['탕', '빵', '총', '총소리'], ['gun', 'gunshot', 'shot', 'pistol', 'rifle', 'shotgun', 'firearm']],
    [['피융', '레이저', '광선'], ['laser', 'zap', 'blaster', 'pew', 'phaser', 'sci-fi', 'scifi']],
    [['지직', '지지직', '전기', '스파크'], ['electric', 'electricity', 'zap', 'spark', 'static', 'shock', 'buzz']],
    [['글리치', '치직', '노이즈', '깨짐'], ['glitch', 'static', 'noise', 'distortion', 'digital', 'interference', 'bitcrush']],
    [['쨍그랑', '유리', '깨지는'], ['glass', 'shatter', 'break', 'smash', 'crash']],
    [['와장창', '와르르', '무너짐'], ['crash', 'collapse', 'debris', 'rubble', 'smash', 'destruction']],

    // ── 전환·연출
    [['전환', '트랜지션', '장면전환'], ['transition', 'whoosh', 'swoosh', 'swish', 'sweep', 'riser', 'impact'], 1],
    [['상승', '라이저', '고조', '빌드업'], ['riser', 'rise', 'rising', 'build up', 'buildup', 'uplifter', 'tension', 'swell'], 1],
    [['하강', '다운'], ['downer', 'down', 'falling', 'drop', 'downlifter', 'fall'], 1],
    [['리버스', '역재생', '빨려들'], ['reverse', 'reversed', 'suck', 'reverse cymbal']],
    [['슬로우', '느려짐'], ['slow motion', 'slowmo', 'slow down', 'slowdown']],
    [['텍스트', '자막', '타이틀'], ['text', 'title', 'typewriter', 'pop', 'ui', 'whoosh'], 1],
    [['ui', '버튼', '메뉴', '인터페이스'], ['ui', 'button', 'interface', 'menu', 'click', 'tap', 'hover', 'select'], 1],

    // ── 생활
    [['딸깍', '클릭', '탁', '톡'], ['click', 'tap', 'button', 'mouse', 'switch', 'tick']],
    [['타자', '타닥', '타닥타닥', '키보드', '타이핑'], ['typing', 'keyboard', 'type', 'keys', 'typewriter', 'keystroke']],
    [['찰칵', '카메라', '셔터', '사진'], ['camera', 'shutter', 'snapshot', 'photo', 'polaroid']],
    [['알림', '띠링띠링', '메시지', '문자', '카톡'], ['notification', 'notify', 'alert', 'message', 'text', 'sms', 'ping', 'ding']],
    [['따르릉', '전화', '벨소리'], ['phone', 'ring', 'ringtone', 'ringing', 'telephone', 'call', 'vibrate']],
    [['알람', '자명종'], ['alarm', 'alarm clock', 'beep', 'wake']],
    [['똑딱', '시계', '째깍'], ['clock', 'tick', 'tock', 'ticking', 'timer', 'countdown']],
    [['똑똑', '노크'], ['knock', 'knocking', 'door knock']],
    [['문', '끼익문', '문닫는', '문여는'], ['door', 'open', 'close', 'creak', 'slam', 'squeak']],
    [['저벅', '발소리', '걷는', '뛰는'], ['footstep', 'footsteps', 'step', 'steps', 'walk', 'walking', 'run', 'running']],
    [['바스락', '종이', '책장'], ['paper', 'rustle', 'crumple', 'page', 'flip', 'book']],
    [['지퍼', '지익'], ['zipper', 'zip']],
    [['짤랑', '동전', '돈', '코인', '찰캉'], ['coin', 'coins', 'money', 'cash', 'cha-ching', 'register', 'jingle']],
    [['쪽', '뽀뽀'], ['kiss', 'smooch', 'mwah']],
    [['꿀꺽', '마시는', '벌컥'], ['gulp', 'swallow', 'drink', 'drinking', 'sip', 'slurp']],
    [['냠냠', '먹는', '쩝쩝', '우걱'], ['eat', 'eating', 'chew', 'chewing', 'munch', 'bite', 'nom']],
    [['아삭', '바삭', '와삭'], ['crunch', 'crunchy', 'crisp', 'bite', 'chips']],
    [['뿡', '방귀'], ['fart', 'toot']],
    [['꺼억', '트림'], ['burp', 'belch']],
    [['드르렁', '코골이'], ['snore', 'snoring']],
    [['에취', '재채기'], ['sneeze', 'achoo']],
    [['하품'], ['yawn']],
    [['두근', '심장', '두근두근'], ['heartbeat', 'heart', 'pulse', 'heart beat']],
    [['부릉', '자동차', '엔진'], ['car', 'engine', 'vroom', 'motor', 'rev', 'drive by']],
    [['빵빵', '경적', '클락션'], ['horn', 'honk', 'car horn']],
    [['끼이익', '브레이크', '타이어'], ['brake', 'skid', 'tire', 'tyre', 'screech']],
    [['사이렌', '앵앵', '경찰', '구급차'], ['siren', 'police', 'ambulance', 'emergency', 'alarm']],
    [['엘리베이터', '띵엘베'], ['elevator', 'lift', 'elevator ding']],

    // ── 자연·물
    [['첨벙', '풍덩', '퐁당', '물'], ['water', 'splash', 'plop', 'dive', 'drop', 'liquid']],
    [['똑똑물', '뚝', '물방울'], ['drip', 'drop', 'droplet', 'water drop']],
    [['바람', '쌩', '휘잉'], ['wind', 'breeze', 'gust', 'air', 'howl']],
    [['비', '빗소리', '주룩'], ['rain', 'rainfall', 'drizzle', 'storm']],
    [['천둥', '우르릉', '번개'], ['thunder', 'lightning', 'storm', 'rumble']],
    [['화르르', '불', '타닥불'], ['fire', 'flame', 'burn', 'burning', 'crackle', 'fireplace']],
    [['폭죽', '불꽃놀이', '축하', '파티'], ['firework', 'fireworks', 'celebration', 'party', 'confetti', 'popper', 'party horn']],
    [['풍선'], ['balloon', 'pop', 'inflate', 'deflate']],

    // ── 동물
    [['멍멍', '왈왈', '강아지', '개'], ['dog', 'bark', 'barking', 'woof', 'puppy']],
    [['야옹', '냐옹', '고양이'], ['cat', 'meow', 'kitten', 'purr']],
    [['짹짹', '새', '지저귀'], ['bird', 'birds', 'chirp', 'tweet', 'birdsong']],
    [['꼬끼오', '닭'], ['rooster', 'chicken', 'cluck']],
    [['음메', '소'], ['cow', 'moo']],
    [['꿀꿀', '돼지'], ['pig', 'oink']],
    [['개굴', '개구리'], ['frog', 'croak', 'ribbit']],
    [['까악', '까마귀'], ['crow', 'raven', 'caw']],
    [['매미'], ['cicada']],
    [['귀뚤', '귀뚜라미', '적막'], ['cricket', 'crickets', 'silence', 'awkward']],

    // ── 분위기
    [['공포', '무서운', '소름', '호러'], ['horror', 'scary', 'creepy', 'spooky', 'eerie', 'ghost', 'haunted', 'jumpscare', 'jump scare'], 1],
    [['긴장', '서스펜스', '스릴'], ['tension', 'suspense', 'thriller', 'drone', 'dark', 'ominous'], 1],
    [['슬픈', '감성', '눈물'], ['sad', 'sorrow', 'emotional', 'melancholy', 'tear'], 1],
    [['신나는', '경쾌', '밝은'], ['happy', 'upbeat', 'cheerful', 'fun', 'bright', 'positive'], 1],
    [['몽환', '꿈', '신비'], ['dream', 'dreamy', 'ethereal', 'ambient', 'mystic', 'mysterious', 'magic'], 1],
    [['어색', '정적', '썰렁'], ['awkward', 'silence', 'crickets', 'tumbleweed'], 1],
    [['게임', '8비트', '레트로', '오락실'], ['game', '8bit', '8-bit', 'chiptune', 'arcade', 'retro', 'pixel', 'nes'], 1],
    [['레벨업', '파워업', '아이템'], ['level up', 'levelup', 'power up', 'powerup', 'pickup', 'collect', 'item', 'bonus']],
    [['게임오버'], ['game over', 'gameover', 'lose', 'death']],
    [['우주', 'sf', '미래'], ['space', 'sci-fi', 'scifi', 'futuristic', 'alien', 'spaceship'], 1],
    [['로봇', '기계'], ['robot', 'robotic', 'mechanical', 'machine', 'servo', 'mech']],
    [['순간이동', '텔레포트', '워프'], ['teleport', 'warp', 'portal', 'beam']],
    [['변신'], ['transform', 'transformation', 'morph']],
    [['드럼', '북', '드럼롤'], ['drum', 'drums', 'snare', 'kick', 'drum roll', 'drumroll', 'rimshot', 'ba dum tss']]
  ];

  var CHIPS = ['띠용', '슉', '뿅', '반짝', '짠', '두둥', '딩동', '땡', '쾅', '퍽', '웃음', '박수', '딸깍', '타자', '알림', '글리치', '전환', '공포'];

  function lc(s) { return String(s || '').toLowerCase(); }
  var HANGUL = /[가-힣]/;

  // 검색어 하나 → 같이 찾을 단어들 (원래 단어 포함)
  var expandCache = {};
  function expand(term) {
    term = lc(term).trim();
    if (!term) { return []; }
    if (expandCache[term]) { return expandCache[term]; }
    var out = [term], seen = {}; seen[term] = 1;
    var isKo = HANGUL.test(term);
    for (var g = 0; g < GROUPS.length; g++) {
      var ko = GROUPS[g][0], en = GROUPS[g][1], hit = false, i;
      if (isKo) {
        for (i = 0; i < ko.length && !hit; i++) {
          // "슉" ↔ "슉", "띠요" → "띠용"(앞부분), "띠요오옹" ⊃ "띠용"은 아님 → 한 글자만 같아도 걸리면 너무 넓어서 2글자 이상은 포함 관계만
          if (ko[i] === term || (term.length >= 2 && ko[i].indexOf(term) === 0) || (ko[i].length >= 2 && term.indexOf(ko[i]) >= 0)) { hit = true; }
        }
      } else if (!GROUPS[g][2]) {
        for (i = 0; i < en.length && !hit; i++) { if (en[i] === term) { hit = true; } }
      }
      if (!hit) { continue; }
      ko.concat(en).forEach(function (w) { w = lc(w); if (!seen[w]) { seen[w] = 1; out.push(w); } });
    }
    expandCache[term] = out;
    return out;
  }

  // 파일 경로 → 검색용 문자열: 폴더명 + 파일명, 구분자·camelCase·숫자 경계를 공백으로
  function haystack(relPath) {
    var s = String(relPath).replace(/\.[^.\\\/]+$/, '');
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2');
    s = s.replace(/[\\\/_\-.+()[\]{},&]+/g, ' ');
    return ' ' + lc(s).replace(/\s+/g, ' ').trim() + ' ';
  }


  /* ---- 한/영 자판 실수 바로잡기 (1.1.1)
   * 한글 자판인데 영어 모드로 친 것 "Eldyd" → "띠용", 반대로 영어를 한글 모드로 친 것 "ㅠㅐㅑㅜㅎ" → "boing".
   * 두벌식 자판 위치 그대로 바꾼다. 영어→한글은 글자가 전부 온전한 한글 음절로 조립될 때만 쓴다
   * ("whoosh"→"조ㅐㅐ노"처럼 안 맞으면 버림 — 진짜 영어 검색어에 엉뚱한 한글이 섞이지 않게). */
  var KEY2JAMO = { q: 'ㅂ', w: 'ㅈ', e: 'ㄷ', r: 'ㄱ', t: 'ㅅ', y: 'ㅛ', u: 'ㅕ', i: 'ㅑ', o: 'ㅐ', p: 'ㅔ', a: 'ㅁ', s: 'ㄴ', d: 'ㅇ', f: 'ㄹ', g: 'ㅎ', h: 'ㅗ', j: 'ㅓ', k: 'ㅏ', l: 'ㅣ',
    z: 'ㅋ', x: 'ㅌ', c: 'ㅊ', v: 'ㅍ', b: 'ㅠ', n: 'ㅜ', m: 'ㅡ', Q: 'ㅃ', W: 'ㅉ', E: 'ㄸ', R: 'ㄲ', T: 'ㅆ', O: 'ㅒ', P: 'ㅖ' };
  var JAMO2KEY = {}; Object.keys(KEY2JAMO).forEach(function (k) { JAMO2KEY[KEY2JAMO[k]] = k.toLowerCase(); });
  var CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ', JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  var JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  var VCOMB = { 'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ' };
  var FCOMB = { 'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ', 'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ' };
  var FSPLIT = {}; Object.keys(FCOMB).forEach(function (k) { FSPLIT[FCOMB[k]] = [k.charAt(0), k.charAt(1)]; });
  var VSPLIT = {}; Object.keys(VCOMB).forEach(function (k) { VSPLIT[VCOMB[k]] = k; });
  function isVowel(j) { return JUNG.indexOf(j) >= 0; }

  // "Eldyd" → { text: "띠용", ok: true }  (ok = 남는 낱자 없이 전부 음절로 조립됨)
  function toHangul(str) {
    var out = '', ok = true, cho = '', jung = '', jong = '';
    function flush() {
      if (cho && jung) { out += String.fromCharCode(0xAC00 + (CHO.indexOf(cho) * 21 + JUNG.indexOf(jung)) * 28 + JONG.indexOf(jong)); }
      else if (cho || jung) { out += cho + jung; ok = false; }
      cho = ''; jung = ''; jong = '';
    }
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i), j = KEY2JAMO[ch] || KEY2JAMO[ch.toLowerCase()];
      if (!j) { flush(); out += ch; if (/[a-z]/i.test(ch)) { ok = false; } continue; }
      if (!isVowel(j)) {
        if (cho && jung) {
          if (!jong && JONG.indexOf(j) > 0) { jong = j; }
          else if (jong && FCOMB[jong + j]) { jong = FCOMB[jong + j]; }
          else { flush(); cho = j; }
        } else { flush(); cho = j; }
      } else {
        if (cho && !jung) { jung = j; }
        else if (cho && jung && !jong && VCOMB[jung + j]) { jung = VCOMB[jung + j]; }
        else if (cho && jung && jong) {          // 받침이 다음 글자 첫소리로 넘어감 (띵+ㅛ → 띠요)
          var move;
          if (FSPLIT[jong]) { move = FSPLIT[jong][1]; jong = FSPLIT[jong][0]; } else { move = jong; jong = ''; }
          flush(); cho = move; jung = j;
        } else { flush(); jung = j; }
      }
    }
    flush();
    return { text: out, ok: ok };
  }
  // "ㅠㅐㅑㅜㅎ"·"보잉" 같은 한글 → 그 자판 위치의 영어 글자 ("boing", "qhdld")
  function toKeys(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i), ch = str.charAt(i);
      if (c >= 0xAC00 && c <= 0xD7A3) {
        var n = c - 0xAC00, jo = JONG[n % 28], ju = JUNG.charAt(Math.floor(n / 28) % 21), co = CHO.charAt(Math.floor(n / 588));
        out += toKeys(co + (VSPLIT[ju] || ju) + (FSPLIT[jo] ? FSPLIT[jo].join('') : jo));
      } else if (JAMO2KEY[ch]) { out += JAMO2KEY[ch]; }
      else if (VSPLIT[ch]) { out += toKeys(VSPLIT[ch]); }
      else if (FSPLIT[ch]) { out += toKeys(FSPLIT[ch].join('')); }
      else { out += ch; }
    }
    return out;
  }
  // 검색어 하나 → 자판을 잘못 놓고 친 경우의 다른 뜻 (없으면 null)
  function altTerm(term) {
    if (/^[a-z]+$/i.test(term)) { var h = toHangul(term); return h.ok ? h.text : null; }
    if (HANGUL.test(term) || /[ㄱ-ㆎ]/.test(term)) { var k = toKeys(term); return /^[a-z]+$/.test(k) && k.length >= 3 ? k : null; }
    return null;
  }

  /* files: [{ rel, name, hay }]  (hay = haystack(rel) 미리 계산)
   * tagsOf(file) → '띠용 귀여운' 같은 소문자 문자열 (없으면 '')
   * 검색어를 공백으로 나눠 모든 단어가 (펼친 단어 중 하나라도) 맞아야 결과. 점수: 태그 > 파일명 단어 > 파일명 일부 > 폴더 */
  function search(files, query, tagsOf) {
    var raw = String(query || '').split(/\s+/).filter(Boolean);    // 대소문자 그대로 (Shift = 쌍자음: E → ㄸ)
    if (!raw.length) { return files.map(function (f) { return { f: f, score: 0, words: [] }; }); }
    // 단어마다 [찾을 단어, 가중치] 목록: 친 그대로 1.5 · 펼친 말 1 · 자판 바꾼 말 1.4 · 그걸 펼친 말 0.95
    var sets = raw.map(function (t) {
      var list = [], seen = {};
      function add(words, first, rest) { words.forEach(function (w, k) { if (!seen[w]) { seen[w] = 1; list.push([w, k === 0 ? first : rest]); } }); }
      add(expand(t), 1.5, 1);
      var alt = altTerm(t);
      if (alt) { add(expand(alt), 1.4, 0.95); }
      return list;
    });
    var res = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i], tags = tagsOf ? (' ' + tagsOf(f) + ' ') : '', nameHay = f.nameHay, total = 0, words = [], ok = true;
      for (var t = 0; t < sets.length && ok; t++) {
        var best = 0, bestWord = null, set = sets[t];
        for (var k = 0; k < set.length; k++) {
          var w = set[k][0], sc = 0, orig = set[k][1];
          if (tags.indexOf(' ' + w + ' ') >= 0) { sc = 100; }
          else if (tags.indexOf(w) >= 0) { sc = 80; }
          else if (nameHay.indexOf(' ' + w + ' ') >= 0) { sc = 40; }
          else if (nameHay.indexOf(' ' + w) >= 0) { sc = 30; }
          else if ((w.length >= 4 || HANGUL.test(w)) && nameHay.indexOf(w) >= 0) { sc = 20; }   // 짧은 영어 단어(hit 등)는 중간 일치 안 함 — "white"에 걸리지 않게
          else if (f.hay.indexOf(' ' + w) >= 0) { sc = 12; }
          else if ((w.length >= 4 || HANGUL.test(w)) && f.hay.indexOf(w) >= 0) { sc = 8; }
          sc *= orig;
          if (sc > best) { best = sc; bestWord = w; }
        }
        if (!best) { ok = false; } else { total += best; words.push(bestWord); }
      }
      if (ok) { res.push({ f: f, score: total, words: words }); }
    }
    res.sort(function (a, b) { return b.score - a.score || (a.f.name < b.f.name ? -1 : a.f.name > b.f.name ? 1 : 0); });
    return res;
  }

  root.SfxSearch = { expand: expand, search: search, haystack: haystack, altTerm: altTerm, toHangul: toHangul, toKeys: toKeys, CHIPS: CHIPS, GROUPS: GROUPS };
}(typeof window !== 'undefined' ? window : this));
