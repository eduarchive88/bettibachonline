const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ── 상수 ──────────────────────────────────────────────
const CONSONANTS = ['ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const CATEGORIES = [
  { id: 'name',   label: '유명인/역사적 인물' },
  { id: 'animal', label: '동물' },
  { id: 'city',   label: '도시/나라' },
  { id: 'food',   label: '음식/요리' },
  { id: 'thing',  label: '물건/도구' },
  { id: 'sport',  label: '스포츠' },
];

const rooms = {};

function seedLetter(roomId, round) {
  let hash = 0;
  const str = roomId + round;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return CONSONANTS[Math.abs(hash) % CONSONANTS.length];
}

function getRoom(roomId) { return rooms[roomId]; }

// 플레이어 요약 (모둠명 포함)
function roomSummary(room) {
  // 개인전
  if (room.mode === 'individual') {
    return room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      score: room.scores[p.nickname] ?? 0,
      isHost: p.id === room.hostId,
      isSpectator: p.spectator ?? false,
    }));
  }
  // 모둠전: 모둠(닉네임)별로 묶어서 반환
  const teams = {};
  room.players.forEach(p => {
    if (!teams[p.nickname]) {
      teams[p.nickname] = { nickname: p.nickname, members: [], score: room.scores[p.nickname] ?? 0 };
    }
    teams[p.nickname].members.push(p.id);
    if (p.id === room.hostId) teams[p.nickname].isHost = true;
  });
  return Object.values(teams).map(t => ({
    id: t.nickname,           // 모둠전에서는 닉네임이 고유 ID
    nickname: t.nickname,
    score: t.score,
    isHost: t.isHost ?? false,
    members: t.members,
  }));
}

io.on('connection', (socket) => {

  // ── 방 입장 ──────────────────────────────────────────
  socket.on('join_room', ({ roomId, nickname, mode, totalRounds, spectator, hostSpectator }) => {
    if (!roomId || !nickname) return;

    const isNewRoom = !rooms[roomId];
    if (isNewRoom) {
      rooms[roomId] = {
        players: [],
        hostId: socket.id,
        hostSpectator: hostSpectator ?? false,
        round: 0,
        letter: null,
        phase: 'lobby',
        answers: {},
        scores: {},
        stopper: null,
        stopperSocketId: null,
        mode: mode || 'individual',
        totalRounds: totalRounds || 7,
        roundHistory: [],
        submittedTeams: new Set(),
      };
    }

    const room = rooms[roomId];

    // 재접속: 같은 소켓ID 또는 같은 닉네임(개인전) 처리
    const existing = room.players.find(p =>
      room.mode === 'individual' ? p.nickname === nickname && !p.spectator : p.id === socket.id
    );
    if (existing) {
      existing.id = socket.id;
    } else {
      room.players.push({ id: socket.id, nickname, spectator: spectator ?? false });
      if (!room.scores[nickname]) room.scores[nickname] = 0;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;
    socket.data.spectator = spectator ?? false;

    socket.emit('room_state', {
      roomId,
      isHost: socket.id === room.hostId,
      phase: room.phase,
      round: room.round,
      letter: room.letter,
      categories: CATEGORIES,
      totalRounds: room.totalRounds,
      mode: room.mode,
      players: roomSummary(room),
      roundHistory: room.roundHistory,
      spectator: spectator ?? false,
    });

    socket.to(roomId).emit('player_joined', { players: roomSummary(room) });
  });

  // ── 방장: 설정 업데이트 (라운드 수, 모드) ────────────
  socket.on('update_settings', ({ totalRounds, mode, hostSpectator }) => {
    const room = getRoom(socket.data.roomId);
    if (!room || socket.id !== room.hostId) return;
    if (totalRounds !== undefined) room.totalRounds = totalRounds;
    if (mode !== undefined) room.mode = mode;
    if (hostSpectator !== undefined) room.hostSpectator = hostSpectator;
    io.to(socket.data.roomId).emit('settings_updated', { totalRounds: room.totalRounds, mode: room.mode, hostSpectator: room.hostSpectator });
  });

  // ── 방장: 라운드 시작 ────────────────────────────────
  socket.on('start_round', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase === 'playing') return;

    room.round += 1;
    room.letter = seedLetter(roomId, room.round);
    room.phase = 'playing';
    room.answers = {};
    room.stopper = null;
    room.stopperSocketId = null;
    room.submittedTeams = new Set();

    io.to(roomId).emit('round_started', {
      round: room.round,
      letter: room.letter,
      totalRounds: room.totalRounds,
    });
  });

  // ── STOP! ────────────────────────────────────────────
  socket.on('stop', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'playing') return;
    if (socket.data.spectator) return;

    room.phase = 'collecting';
    room.stopperSocketId = socket.id;
    // 모둠전이면 팀명, 개인전이면 소켓ID
    room.stopper = room.mode === 'team' ? socket.data.nickname : socket.id;

    io.to(roomId).emit('collect_answers', {
      stopperId: room.stopper,
      stopperNickname: socket.data.nickname,
    });
  });

  // ── 모둠전: 실시간 입력 동기화 ───────────────────────
  socket.on('team_input', ({ catId, value }) => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'playing') return;
    // 같은 팀(닉네임)에게만 브로드캐스트
    socket.to(roomId).emit('team_input_update', {
      team: socket.data.nickname,
      catId,
      value,
    });
  });

  // ── 답변 제출 ────────────────────────────────────────
  socket.on('submit_answers', (answers) => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'collecting') return;
    if (socket.data.spectator) return;

    if (room.mode === 'team') {
      const team = socket.data.nickname;
      if (room.submittedTeams.has(team)) return; // 팀에서 이미 제출
      room.submittedTeams.add(team);
      room.answers[team] = answers;

      // 모든 팀이 제출했는지 확인 (방장 관전 시 방장 팀 제외)
      const allTeams = [...new Set(room.players
        .filter(p => !(p.id === room.hostId && room.hostSpectator))
        .map(p => p.nickname))];
      if (room.submittedTeams.size >= allTeams.length) broadcastReview(roomId);
    } else {
      room.answers[socket.id] = answers;
      // 방장 관전 시 방장 제외
      const activePlayers = room.players.filter(p => !(p.id === room.hostId && room.hostSpectator));
      if (Object.keys(room.answers).length >= activePlayers.length) broadcastReview(roomId);
    }
  });

  // ── STOP 취소: 입력값 복원 후 다시 playing ────────────
  socket.on('cancel_stop', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase !== 'review') return;

    room.phase = 'playing';
    room.stopper = null;
    room.stopperSocketId = null;
    room.submittedTeams = new Set();

    // 기존 입력값을 클라이언트에 복원해서 다시 playing 상태로
    io.to(roomId).emit('stop_cancelled', {
      answers: room.answers,   // { socketId or teamName: { catId: value } }
      letter: room.letter,
      round: room.round,
      totalRounds: room.totalRounds,
    });
  });

  // ── 유효/무효 변경 브로드캐스트 (방장 → 전체) ──────
  socket.on('validity_update', ({ catId, playerId, valid }) => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || socket.id !== room.hostId) return;
    socket.to(roomId).emit('validity_update', { catId, playerId, valid });
  });

  // ── 점수 확정 ────────────────────────────────────────
  socket.on('confirm_scores', (roundScores) => {
    // roundScores: { socketId(개인전) or teamName(모둠전): points }
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || socket.id !== room.hostId) return;

    const roundPts = {};
    Object.entries(roundScores).forEach(([key, pts]) => {
      // 개인전: key가 socketId → nickname으로 변환해서 저장
      let nameKey = key;
      if (room.mode === 'individual') {
        const player = room.players.find(p => p.id === key);
        if (player) nameKey = player.nickname;
      }
      room.scores[nameKey] = (room.scores[nameKey] ?? 0) + pts;
      roundPts[nameKey] = pts;
    });

    room.roundHistory.push({ round: room.round, letter: room.letter, scores: roundPts });

    const isLastRound = room.round >= room.totalRounds;
    room.phase = isLastRound ? 'finished' : 'lobby';

    io.to(roomId).emit('scores_updated', {
      players: roomSummary(room),
      isLastRound,
      round: room.round,
      roundHistory: room.roundHistory,
    });
  });

  // ── 연결 해제 ────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[roomId]; return; }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      io.to(room.hostId).emit('host_transferred');
    }
    io.to(roomId).emit('player_left', { players: roomSummary(room) });
  });
});

// ── 리뷰 브로드캐스트 ────────────────────────────────
function broadcastReview(roomId) {
  const room = rooms[roomId];
  room.phase = 'review';

  const compiled = {};
  CATEGORIES.forEach(cat => { compiled[cat.id] = []; });

  if (room.mode === 'team') {
    const teams = [...new Set(room.players
      .filter(p => !(p.id === room.hostId && room.hostSpectator))
      .map(p => p.nickname))];
    teams.forEach(team => {
      const ans = room.answers[team] ?? {};
      CATEGORIES.forEach(cat => {
        compiled[cat.id].push({ id: team, nickname: team, answer: (ans[cat.id] ?? '').trim() });
      });
    });
  } else {
    room.players
      .filter(p => !(p.id === room.hostId && room.hostSpectator))
      .forEach(p => {
        const ans = room.answers[p.id] ?? {};
        CATEGORIES.forEach(cat => {
          compiled[cat.id].push({ id: p.id, nickname: p.nickname, answer: (ans[cat.id] ?? '').trim() });
        });
      });
  }

  io.to(roomId).emit('review_started', {
    letter: room.letter,
    compiled,
    categories: CATEGORIES,
    stopperId: room.stopper,
    stopperNickname: room.players.find(p => p.id === room.stopperSocketId)?.nickname ?? '',
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
