// ── 초성 추출 ──────────────────────────────────────────
const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
function getChosung(word) {
  if (!word) return null;
  const code = word.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return null;
  return CHOSUNG[Math.floor((code - 0xAC00) / 588)];
}
function normalize(s) { return (s || '').trim().replace(/\s+/g, ''); }

// ── 상태 ───────────────────────────────────────────────
let myId        = null;
let isHost      = false;
let isSpectator = false;
let hostRole    = 'play';      // 'play' | 'spectate'
let gameMode    = 'individual';
let categories  = [];
let currentLetter = '';
let currentRound  = 0;
let totalRounds   = 7;
let myNickname    = '';
let myTeam        = '';
let reviewData    = null;
let validityMap   = {};        // { catId: { id: bool } }
let roundHistory  = [];
let allPlayers    = [];

const socket = io();

// ── 화면 전환 ──────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ── 방장 설정 UI ───────────────────────────────────────
let selectedMode  = 'individual';
let selectedRounds = 7;

function setMode(mode) {
  selectedMode = mode;
  document.getElementById('mode-individual').classList.toggle('active', mode === 'individual');
  document.getElementById('mode-team').classList.toggle('active', mode === 'team');
  socket.emit('update_settings', { mode });
}

function setHostRole(role) {
  hostRole = role;
  document.getElementById('host-play').classList.toggle('active', role === 'play');
  document.getElementById('host-spectate').classList.toggle('active', role === 'spectate');
  socket.emit('update_settings', { hostSpectator: role === 'spectate' });
}

document.getElementById('select-rounds')?.addEventListener('change', (e) => {
  selectedRounds = parseInt(e.target.value);
  socket.emit('update_settings', { totalRounds: selectedRounds });
});

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
  myNickname = inputNickname.value.trim();
  myTeam     = myNickname;
  const roomId = inputRoomId.value.trim().toUpperCase();
  if (!myNickname || !roomId) return;
  socket.emit('join_room', { roomId, nickname: myNickname, mode: selectedMode, totalRounds: selectedRounds, spectator: false });
});

// ── 대기실 렌더 ────────────────────────────────────────
function renderWaiting(players, roomId) {
  allPlayers = players;
  if (roomId) document.getElementById('waiting-roomid').textContent = roomId;
  document.getElementById('waiting-count').textContent = `${players.length}명`;
  document.getElementById('waiting-mode-label').textContent = gameMode === 'team' ? '👥 모둠전' : '👤 개인전';
  document.getElementById('waiting-round-label').textContent = `총 ${totalRounds}라운드`;

  const wrap = document.getElementById('waiting-players');
  wrap.innerHTML = players.map(p => `
    <span class="player-chip ${p.isHost ? 'host' : gameMode === 'team' ? 'team' : ''}">
      ${p.isHost ? '👑 ' : ''}${p.nickname}${p.members ? ` (${p.members.length}명)` : ''}
    </span>
  `).join('');

  document.getElementById('host-settings').classList.toggle('hidden', !isHost);
  document.getElementById('guest-waiting').classList.toggle('hidden', isHost);

  if (roundHistory.length > 0) {
    document.getElementById('waiting-scoreboard').classList.remove('hidden');
    renderScoreTable('score-table-wrap', players, roundHistory);
  }
}

// ── 누적 점수표 렌더 ───────────────────────────────────
function renderScoreTable(containerId, players, history) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const catLabels = ['유명인', '동물', '도시/나라', '음식', '물건', '스포츠'];
  const catIds    = ['name','animal','city','food','thing','sport'];

  // 플레이어/팀 목록
  const ids = players.map(p => p.id ?? p.nickname);
  const names = players.map(p => p.nickname);

  // 헤더
  let html = `<table class="score-table"><thead><tr>
    <th>라운드</th><th>자음</th>`;
  names.forEach(n => { html += `<th>${n}</th>`; });
  html += `</tr></thead><tbody>`;

  // 라운드별 행
  const totals = {};
  ids.forEach(id => { totals[id] = 0; });

  for (let r = 1; r <= totalRounds; r++) {
    const h = history.find(x => x.round === r);
    const isActive = r === currentRound;
    html += `<tr>`;
    html += `<td class="${isActive ? 'active-round' : ''}">${r}</td>`;
    html += `<td class="${isActive ? 'active-round' : ''}">${h ? h.letter : ''}</td>`;
    ids.forEach((id, i) => {
      const pts = h ? (h.scores[id] ?? h.scores[names[i]] ?? 0) : '';
      if (pts !== '') totals[id] = (totals[id] || 0) + pts;
      html += `<td class="${isActive ? 'active-round' : ''} ${pts !== '' ? 'score-cell' : ''}">${pts !== '' ? pts + '점' : ''}</td>`;
    });
    html += `</tr>`;
  }

  // 합계 행
  html += `<tr class="total-row"><td colspan="2">합계</td>`;
  ids.forEach((id, i) => {
    html += `<td>${totals[id] || 0}점</td>`;
  });
  html += `</tr></tbody></table>`;
  container.innerHTML = html;
}

// ── 게임 입력 렌더 ─────────────────────────────────────
function renderGameInputs() {
  const wrap = document.getElementById('game-inputs');
  wrap.innerHTML = categories.map(cat => `
    <div class="card px-4 py-3 flex items-center gap-3">
      <label class="text-sm font-bold text-slate-600 w-28 shrink-0">${cat.label}</label>
      <input id="ans-${cat.id}" class="input-field flex-1" type="text"
        placeholder="${currentLetter}(으)로 시작하는 단어" maxlength="20" autocomplete="off"/>
    </div>
  `).join('');

  // 모둠전: 입력 시 팀원에게 실시간 동기화
  if (gameMode === 'team') {
    categories.forEach(cat => {
      document.getElementById(`ans-${cat.id}`)?.addEventListener('input', (e) => {
        socket.emit('team_input', { catId: cat.id, value: e.target.value });
      });
    });
  }
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

  const { letter, compiled, categories: cats, stopperId, stopperNickname } = data;

  document.getElementById('review-letter-badge').textContent = `시작 글자: ${letter}`;
  document.getElementById('review-host-note').textContent = isHost
    ? '✏️ 방장으로서 유효/무효를 조정하고 점수를 확정하세요.'
    : '';

  const table = document.getElementById('review-table');
  table.innerHTML = '';

  cats.forEach(cat => {
    const entries = compiled[cat.id] ?? [];
    validityMap[cat.id] = {};

    // STOP 외친 사람의 답
    const stopperEntry = entries.find(e => e.id === stopperId);
    const stopperAns   = normalize(stopperEntry?.answer ?? '');
    const stopperChosungOk = stopperAns && getChosung(stopperAns) === letter;

    const rows = entries.map(entry => {
      const ans         = normalize(entry.answer);
      const hasAnswer   = !!ans;
      const chosungOk   = hasAnswer && getChosung(ans) === letter;
      const isStopperEntry = entry.id === stopperId;

      // 자동 채점 로직
      let valid = false;
      let statusKey = 'invalid';

      if (!hasAnswer) {
        statusKey = 'empty';
      } else if (!chosungOk) {
        statusKey = 'invalid';
      } else if (isStopperEntry) {
        // STOP 외친 사람: 다른 사람 중 같은 답이 있으면 0점
        const hasDup = entries.some(e => e.id !== stopperId && normalize(e.answer) === ans && getChosung(normalize(e.answer)) === letter);
        if (hasDup) { statusKey = 'stopper-dup'; valid = false; }
        else         { statusKey = 'valid';       valid = true;  }
      } else {
        // 일반 플레이어: 초성 일치면 유효 (STOP 외친 사람과 같은 답이어도 본인은 유효)
        valid = true;
        statusKey = 'valid';
      }

      validityMap[cat.id][entry.id] = valid;

      const badgeMap = {
        'valid':       `<span class="badge badge-valid">✔ 유효</span>`,
        'invalid':     `<span class="badge badge-invalid">✘ 초성 불일치</span>`,
        'stopper-dup': `<span class="badge badge-stop">🛑 중복(0점)</span>`,
        'empty':       `<span class="badge badge-empty">미입력</span>`,
      };

      const toggleClass = valid ? 'valid' : 'invalid';
      const rowClass    = statusKey === 'stopper-dup' ? 'stopper-dup' : (valid ? 'valid' : 'invalid');

      return `
        <div class="review-row ${rowClass}" data-cat="${cat.id}" data-player="${entry.id}">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-xs text-slate-400 shrink-0 font-semibold">${entry.nickname}${isStopperEntry ? ' 🛑' : ''}</span>
            <span class="font-bold text-slate-800 truncate">${entry.answer || '—'}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${badgeMap[statusKey]}
      ${hasAnswer && isHost ? `<button class="toggle-btn ${toggleClass}" data-valid="${valid}" data-cat="${cat.id}" data-player="${entry.id}">
              ${valid ? '✔ 유효' : '✘ 무효'}
            </button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    table.innerHTML += `
      <div class="card p-4 space-y-2">
        <p class="font-bold text-slate-700 text-sm">${cat.label}</p>
        ${rows}
      </div>
    `;
  });

  // 토글 이벤트 (모든 플레이어 가능)
  table.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const catId    = btn.dataset.cat;
      const playerId = btn.dataset.player;
      const nowValid = btn.dataset.valid === 'true';
      const newValid = !nowValid;

      validityMap[catId][playerId] = newValid;
      btn.dataset.valid = newValid;
      btn.textContent   = newValid ? '✔ 유효' : '✘ 무효';
      btn.className     = `toggle-btn ${newValid ? 'valid' : 'invalid'}`;

      const row = btn.closest('.review-row');
      row.className = `review-row ${newValid ? 'valid' : 'invalid'}`;

      const badge = row.querySelector('.badge');
      if (badge) {
        badge.className = `badge ${newValid ? 'badge-valid' : 'badge-invalid'}`;
        badge.textContent = newValid ? '✔ 유효' : '✘ 무효';
      }

      updateScorePreview();
      // 방장이 변경한 유효/무효를 모든 클라이언트에 브로드캐스트
      socket.emit('validity_update', { catId, playerId, valid: newValid });
    });
  });

  updateScorePreview();

  document.getElementById('review-host-actions').classList.toggle('hidden', !isHost);
  document.getElementById('review-guest-wait').classList.toggle('hidden', isHost);
  showScreen('screen-review');
}

function updateScorePreview() {
  if (!reviewData) return;
  const preview = {};
  reviewData.categories.forEach(cat => {
    Object.entries(validityMap[cat.id] ?? {}).forEach(([id, valid]) => {
      if (!preview[id]) preview[id] = 0;
      if (valid) preview[id] += 10;
    });
  });

  const container = document.getElementById('review-score-preview');
  container.innerHTML = allPlayers.map(p => {
    const id  = p.id ?? p.nickname;
    const pts = preview[id] ?? 0;
    return `
      <div class="flex justify-between items-center text-sm py-1 border-b border-slate-100 last:border-0">
        <span class="text-slate-600 font-semibold">${p.nickname}</span>
        <span class="font-black text-purple-600">${pts}점</span>
      </div>
    `;
  }).join('');
}

// ── 점수 확정 ──────────────────────────────────────────
document.getElementById('btn-confirm-scores').addEventListener('click', () => {
  if (!reviewData || !isHost) return;
  const roundScores = {};
  reviewData.categories.forEach(cat => {
    Object.entries(validityMap[cat.id] ?? {}).forEach(([id, valid]) => {
      if (!roundScores[id]) roundScores[id] = 0;
      if (valid) roundScores[id] += 10;
    });
  });
  socket.emit('confirm_scores', roundScores);
});

// ── 최종 결과 ──────────────────────────────────────────
function renderFinal(players, history) {
  renderScoreTable('final-score-table-wrap', players, history);

  const sorted  = [...players].sort((a, b) => b.score - a.score);
  const medals  = ['🥇','🥈','🥉'];
  document.getElementById('final-podium').innerHTML = `
    <p class="font-bold text-slate-700 text-sm mb-2">🏅 최종 순위</p>
    ${sorted.map((p, i) => `
      <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
        <span class="text-base font-bold text-slate-700">${medals[i] ?? `${i+1}.`} ${p.nickname}</span>
        <span class="text-xl font-black text-purple-600">${p.score}점</span>
      </div>
    `).join('')}
  `;
  showScreen('screen-final');
}

document.getElementById('btn-restart').addEventListener('click', () => showScreen('screen-lobby'));
document.getElementById('btn-stop').addEventListener('click', () => socket.emit('stop'));
document.getElementById('btn-start-round').addEventListener('click', () => socket.emit('start_round'));

// ══════════════════════════════════════════════════════
// Socket 이벤트
// ══════════════════════════════════════════════════════

socket.on('connect', () => { myId = socket.id; });

socket.on('room_state', (state) => {
  isHost      = state.isHost;
  isSpectator = state.spectator;
  categories  = state.categories;
  totalRounds = state.totalRounds;
  currentRound = state.round;
  gameMode    = state.mode;
  roundHistory = state.roundHistory ?? [];
  allPlayers  = state.players;

  renderWaiting(state.players, state.roomId);

  if (state.phase === 'playing' && !isSpectator) {
    currentLetter = state.letter;
    document.getElementById('game-letter').textContent = currentLetter;
    document.getElementById('game-round-badge').textContent = `${state.round} / ${state.totalRounds} 라운드`;
    renderGameInputs();
    showScreen('screen-game');
  } else if (isSpectator || hostRole === 'spectate') {
    showScreen('screen-spectate');
  } else {
    showScreen('screen-waiting');
  }
});

socket.on('settings_updated', ({ totalRounds: tr, mode }) => {
  totalRounds = tr;
  gameMode    = mode;
  document.getElementById('waiting-mode-label').textContent = mode === 'team' ? '👥 모둠전' : '👤 개인전';
  document.getElementById('waiting-round-label').textContent = `총 ${tr}라운드`;
});

socket.on('player_joined', ({ players }) => {
  allPlayers = players;
  renderWaiting(players, null);
});

socket.on('player_left', ({ players }) => {
  allPlayers = players;
  renderWaiting(players, null);
});

socket.on('host_transferred', () => {
  isHost = true;
  document.getElementById('host-settings').classList.remove('hidden');
  document.getElementById('guest-waiting').classList.add('hidden');
  if (reviewData) renderReview(reviewData);
});

socket.on('round_started', ({ round, letter, totalRounds: tr }) => {
  currentLetter = letter;
  currentRound  = round;
  totalRounds   = tr;

  if (isSpectator || hostRole === 'spectate') {
    document.getElementById('spec-round').textContent  = `${round} / ${tr} 라운드`;
    document.getElementById('spec-letter').textContent = letter;
    document.getElementById('spec-stop-notice').classList.add('hidden');
    showScreen('screen-spectate');
    return;
  }

  document.getElementById('game-letter').textContent = letter;
  document.getElementById('game-round-badge').textContent = `${round} / ${tr} 라운드`;
  document.getElementById('btn-stop').disabled = false;
  document.getElementById('stop-notice').classList.add('hidden');
  renderGameInputs();
  showScreen('screen-game');
});

// 모둠전 실시간 입력 동기화
socket.on('team_input_update', ({ team, catId, value }) => {
  if (gameMode !== 'team') return;
  if (team !== myTeam) return; // 내 팀 것만 반영
  const el = document.getElementById(`ans-${catId}`);
  if (el && document.activeElement !== el) el.value = value;
});

socket.on('collect_answers', ({ stopperNickname }) => {
  const msg = `${stopperNickname} 님이 STOP을 눌렀습니다! 답변 제출 중…`;

  if (hostRole === 'spectate') {
    // 관전 방장: 알림만 표시, 제출 없음 (서버도 카운트 안 함)
    const n = document.getElementById('spec-stop-notice');
    n.textContent = msg; n.classList.remove('hidden');
    return;
  }

  lockGameInputs();
  const n = document.getElementById('stop-notice');
  n.textContent = msg; n.classList.remove('hidden');
  socket.emit('submit_answers', collectMyAnswers());
});

socket.on('review_started', (data) => {
  if (isSpectator || hostRole === 'spectate') {
    // 운영자는 리뷰 화면도 볼 수 있음
    renderReview(data);
    return;
  }
  renderReview(data);
});

// 방장이 토글한 유효/무효 수신 (게스트)
socket.on('validity_update', ({ catId, playerId, valid }) => {
  if (isHost) return; // 방장은 본인이 이미 반영함
  if (!validityMap[catId]) return;
  validityMap[catId][playerId] = valid;

  // UI 업데이트
  const row = document.querySelector(`.review-row[data-cat="${catId}"][data-player="${playerId}"]`);
  if (row) {
    row.className = `review-row ${valid ? 'valid' : 'invalid'}`;
    const badge = row.querySelector('.badge');
    if (badge) {
      badge.className = `badge ${valid ? 'badge-valid' : 'badge-invalid'}`;
      badge.textContent = valid ? '✔ 유효' : '✘ 무효';
    }
  }
  updateScorePreview();
});

socket.on('scores_updated', ({ players, isLastRound, roundHistory: rh }) => {
  allPlayers   = players;
  roundHistory = rh ?? roundHistory;

  if (isLastRound) {
    renderFinal(players, roundHistory);
  } else {
    renderWaiting(players, null);
    if (isSpectator || hostRole === 'spectate') {
      renderScoreTable('spec-score-table-wrap', players, roundHistory);
      showScreen('screen-spectate');
    } else {
      showScreen('screen-waiting');
    }
  }
});
