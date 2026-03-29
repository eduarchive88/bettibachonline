// ── 초성 추출 ──────────────────────────────────────────
const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
function getChosung(word) {
  if (!word) return null;
  const code = word.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return null;
  return CHOSUNG[Math.floor((code - 0xAC00) / 588)];
}

// ── 상태 ───────────────────────────────────────────────
let myId = null;
let isHost = false;
let categories = [];
let currentLetter = '';
let currentRound = 0;
let totalRounds = 7;
// reviewData: { letter, compiled, categories, stopperId }
let reviewData = null;
// validityMap: { categoryId: { playerId: bool } }
let validityMap = {};

const socket = io();

// ── 화면 전환 ──────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── 로비 ───────────────────────────────────────────────
const inputNickname = document.getElementById('input-nickname');
const inputRoomId   = document.getElementById('input-roomid');
const btnJoin       = document.getElementById('btn-join');

function validateLobby() {
  btnJoin.disabled = !(inputNickname.value.trim() && inputRoomId.value.trim());
}
inputNickname.addEventListener('input', validateLobby);
inputRoomId.addEventListener('input', () => {
  inputRoomId.value = inputRoomId.value.toUpperCase();
  validateLobby();
});

btnJoin.addEventListener('click', () => {
  const nickname = inputNickname.value.trim();
  const roomId   = inputRoomId.value.trim().toUpperCase();
  if (!nickname || !roomId) return;
  socket.emit('join_room', { roomId, nickname });
});

// ── 대기실 렌더 ────────────────────────────────────────
function renderWaiting(players, roomId, showScores) {
  document.getElementById('waiting-roomid').textContent = roomId || inputRoomId.value.trim().toUpperCase();
  document.getElementById('waiting-count').textContent = `${players.length}명 참가 중`;

  const wrap = document.getElementById('waiting-players');
  wrap.innerHTML = players.map(p => `
    <span class="player-chip ${p.isHost ? 'host' : ''}">
      ${p.isHost ? '👑 ' : ''}${p.nickname}
    </span>
  `).join('');

  document.getElementById('host-controls').classList.toggle('hidden', !isHost);
  document.getElementById('guest-waiting').classList.toggle('hidden', isHost);

  const scoreBoard = document.getElementById('waiting-scoreboard');
  if (showScores) {
    scoreBoard.classList.remove('hidden');
    renderScoreList(players, 'waiting-scores');
  } else {
    scoreBoard.classList.add('hidden');
  }
}

function renderScoreList(players, containerId) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  document.getElementById(containerId).innerHTML = sorted.map((p, i) => `
    <div class="flex justify-between items-center text-sm">
      <span class="text-slate-300">${i + 1}. ${p.nickname}${p.isHost ? ' 👑' : ''}</span>
      <span class="font-bold text-violet-300">${p.score}점</span>
    </div>
  `).join('');
}

// ── 게임 화면 렌더 ─────────────────────────────────────
function renderGameInputs() {
  const wrap = document.getElementById('game-inputs');
  wrap.innerHTML = categories.map(cat => `
    <div class="glass rounded-xl px-4 py-3 flex items-center gap-3">
      <label class="text-sm font-semibold text-slate-300 w-32 shrink-0">${cat.label}</label>
      <input
        id="ans-${cat.id}"
        class="input-field flex-1"
        type="text"
        placeholder="${currentLetter}(으)로 시작하는 ${cat.label}"
        maxlength="20"
        autocomplete="off"
      />
    </div>
  `).join('');
}

function lockGameInputs() {
  document.querySelectorAll('#game-inputs input').forEach(i => i.disabled = true);
  document.getElementById('btn-stop').disabled = true;
}

function collectMyAnswers() {
  const answers = {};
  categories.forEach(cat => {
    const el = document.getElementById(`ans-${cat.id}`);
    answers[cat.id] = el ? el.value.trim() : '';
  });
  return answers;
}

// ── 리뷰 화면 렌더 ─────────────────────────────────────
function renderReview(data) {
  reviewData = data;
  validityMap = {};

  const { letter, compiled, categories: cats, stopperId } = data;

  document.getElementById('review-letter-badge').textContent = `시작 글자: ${letter}`;
  document.getElementById('review-host-note').textContent = isHost
    ? '방장으로서 유효/무효를 결정하고 점수를 확정하세요.'
    : '';

  const table = document.getElementById('review-table');
  table.innerHTML = '';

  cats.forEach(cat => {
    const entries = compiled[cat.id] ?? [];

    // 중복 감지: 초성 일치하는 답변 중 같은 값이 2개 이상이면 중복
    const validAnswers = entries.map(e => e.answer.toLowerCase()).filter((a, _, arr) => {
      return a && getChosung(a) === letter;
    });
    const dupSet = new Set(
      validAnswers.filter((a, _, arr) => arr.filter(x => x === a).length > 1)
    );

    validityMap[cat.id] = {};

    const rows = entries.map(entry => {
      const hasAnswer = !!entry.answer;
      const chosungMatch = hasAnswer && getChosung(entry.answer) === letter;
      const isDup = chosungMatch && dupSet.has(entry.answer.toLowerCase());
      const isStop = entry.playerId === stopperId;

      // 기본 유효 판정: 초성 일치 + 중복 아님
      const defaultValid = chosungMatch && !isDup;
      validityMap[cat.id][entry.playerId] = defaultValid;

      const statusBadge = !hasAnswer
        ? `<span class="score-badge badge-invalid">미입력</span>`
        : !chosungMatch
          ? `<span class="score-badge badge-invalid">초성 불일치</span>`
          : isDup
            ? `<span class="score-badge badge-dup">중복</span>`
            : `<span class="score-badge badge-valid">유효</span>`;

      return `
        <div class="answer-row ${isDup ? 'duplicate' : defaultValid ? 'unique' : ''} rounded-lg px-3 py-2 flex items-center justify-between gap-2"
             data-cat="${cat.id}" data-player="${entry.playerId}">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-xs text-slate-400 shrink-0">${entry.nickname}${isStop ? ' 🛑' : ''}</span>
            <span class="font-bold text-white truncate">${entry.answer || '—'}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${statusBadge}
            ${isHost && hasAnswer ? `
              <button class="toggle-validity text-xs px-2 py-1 rounded-lg font-bold transition
                ${defaultValid ? 'bg-green-700 hover:bg-red-700' : 'bg-red-700 hover:bg-green-700'}"
                data-valid="${defaultValid}">
                ${defaultValid ? '✔ 유효' : '✘ 무효'}
              </button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    table.innerHTML += `
      <div class="glass rounded-2xl p-4 space-y-2">
        <p class="font-bold text-slate-200 text-sm">${cat.label}</p>
        ${rows}
      </div>
    `;
  });

  // 유효/무효 토글 이벤트 (방장만)
  if (isHost) {
    table.querySelectorAll('.toggle-validity').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('[data-cat]');
        const catId = row.dataset.cat;
        const playerId = row.dataset.player;
        const nowValid = btn.dataset.valid === 'true';
        const newValid = !nowValid;

        validityMap[catId][playerId] = newValid;
        btn.dataset.valid = newValid;
        btn.textContent = newValid ? '✔ 유효' : '✘ 무효';
        btn.className = `toggle-validity text-xs px-2 py-1 rounded-lg font-bold transition
          ${newValid ? 'bg-green-700 hover:bg-red-700' : 'bg-red-700 hover:bg-green-700'}`;

        // 배지 업데이트
        const badge = row.querySelector('.score-badge');
        if (badge) {
          badge.className = `score-badge ${newValid ? 'badge-valid' : 'badge-invalid'}`;
          badge.textContent = newValid ? '유효' : '무효';
        }
        row.className = `answer-row ${newValid ? 'unique' : ''} rounded-lg px-3 py-2 flex items-center justify-between gap-2`;
      });
    });
  }

  document.getElementById('review-host-actions').classList.toggle('hidden', !isHost);
  document.getElementById('review-guest-wait').classList.toggle('hidden', isHost);
  showScreen('screen-review');
}

// ── 점수 확정 ──────────────────────────────────────────
document.getElementById('btn-confirm-scores').addEventListener('click', () => {
  if (!reviewData) return;

  // validityMap → { playerId: totalPoints }
  const roundScores = {};
  reviewData.categories.forEach(cat => {
    const catValidity = validityMap[cat.id] ?? {};
    Object.entries(catValidity).forEach(([pid, valid]) => {
      if (!roundScores[pid]) roundScores[pid] = 0;
      if (valid) roundScores[pid] += 10;
    });
  });

  socket.emit('confirm_scores', roundScores);
});

// ── 최종 결과 ──────────────────────────────────────────
function renderFinal(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const medals = ['🥇','🥈','🥉'];
  document.getElementById('final-scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="flex justify-between items-center py-2 border-b border-white/10 last:border-0">
      <span class="text-lg font-bold">${medals[i] ?? `${i+1}.`} ${p.nickname}</span>
      <span class="text-2xl font-black text-violet-300">${p.score}점</span>
    </div>
  `).join('');
  showScreen('screen-final');
}

document.getElementById('btn-restart').addEventListener('click', () => {
  showScreen('screen-lobby');
});

// ── STOP 버튼 ──────────────────────────────────────────
document.getElementById('btn-stop').addEventListener('click', () => {
  socket.emit('stop');
});

// ── 라운드 시작 버튼 ───────────────────────────────────
document.getElementById('btn-start-round').addEventListener('click', () => {
  socket.emit('start_round');
});

// ══════════════════════════════════════════════════════
// Socket 이벤트
// ══════════════════════════════════════════════════════

socket.on('connect', () => { myId = socket.id; });

socket.on('room_state', (state) => {
  isHost = state.isHost;
  categories = state.categories;
  totalRounds = state.totalRounds;
  currentRound = state.round;

  renderWaiting(state.players, state.roomId, state.round > 0);

  if (state.phase === 'playing') {
    // 재접속 시 게임 중이면 게임 화면으로
    currentLetter = state.letter;
    document.getElementById('game-letter').textContent = currentLetter;
    document.getElementById('game-round-badge').textContent = `${state.round} / ${state.totalRounds} 라운드`;
    renderGameInputs();
    showScreen('screen-game');
  } else {
    showScreen('screen-waiting');
  }
});

socket.on('player_joined', ({ players }) => {
  renderWaiting(players, null, currentRound > 0);
});

socket.on('player_left', ({ players }) => {
  renderWaiting(players, null, currentRound > 0);
});

socket.on('host_transferred', () => {
  isHost = true;
  document.getElementById('host-controls').classList.remove('hidden');
  document.getElementById('guest-waiting').classList.add('hidden');
  // 리뷰 화면에 있다면 방장 UI 갱신
  if (reviewData) renderReview(reviewData);
});

socket.on('round_started', ({ round, letter, totalRounds: tr }) => {
  currentLetter = letter;
  currentRound = round;
  totalRounds = tr;

  document.getElementById('game-letter').textContent = letter;
  document.getElementById('game-round-badge').textContent = `${round} / ${tr} 라운드`;
  document.getElementById('btn-stop').disabled = false;
  document.getElementById('stop-notice').classList.add('hidden');
  renderGameInputs();
  showScreen('screen-game');
});

socket.on('collect_answers', ({ stopperNickname }) => {
  lockGameInputs();
  document.getElementById('stop-notice').classList.remove('hidden');
  document.getElementById('stop-notice').textContent =
    `${stopperNickname} 님이 STOP을 눌렀습니다! 답변 제출 중…`;
  socket.emit('submit_answers', collectMyAnswers());
});

socket.on('review_started', (data) => {
  renderReview(data);
});

socket.on('scores_updated', ({ players, isLastRound }) => {
  if (isLastRound) {
    renderFinal(players);
  } else {
    renderWaiting(players, null, true);
    showScreen('screen-waiting');
  }
});
