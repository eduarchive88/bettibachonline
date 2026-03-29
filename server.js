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
  { id: 'name',   label: '유명인 / 역사적 인물' },
  { id: 'animal', label: '동물' },
  { id: 'city',   label: '도시 / 나라' },
  { id: 'food',   label: '음식 / 요리' },
  { id: 'thing',  label: '물건 / 도구' },
  { id: 'sport',  label: '스포츠' },
];
const TOTAL_ROUNDS = 7;

// ── 인메모리 방 저장소 ────────────────────────────────
// rooms[roomId] = { players, hostId, round, letter, phase, answers, scores }
const rooms = {};

// ── 유틸 ──────────────────────────────────────────────
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

function roomSummary(room) {
  return room.players.map(p => ({
    id: p.id,
    nickname: p.nickname,
    score: room.scores[p.id] ?? 0,
    isHost: p.id === room.hostId,
  }));
}

// ── Socket.io ─────────────────────────────────────────
io.on('connection', (socket) => {

  // 방 입장
  socket.on('join_room', ({ roomId, nickname }) => {
    if (!roomId || !nickname) return;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        hostId: socket.id,
        round: 0,
        letter: null,
        phase: 'lobby',   // lobby | playing | review
        answers: {},      // { socketId: { categoryId: answer } }
        scores: {},       // { socketId: totalScore }
        stopper: null,    // 이번 라운드 STOP 누른 사람
      };
    }

    const room = rooms[roomId];

    // 재접속 처리: 같은 닉네임이 이미 있으면 id 교체
    const existing = room.players.find(p => p.nickname === nickname);
    if (existing) {
      existing.id = socket.id;
      room.scores[socket.id] = room.scores[existing.id] ?? 0;
    } else {
      room.players.push({ id: socket.id, nickname });
      room.scores[socket.id] = 0;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    // 입장한 본인에게 현재 방 상태 전송
    socket.emit('room_state', {
      roomId,
      isHost: socket.id === room.hostId,
      phase: room.phase,
      round: room.round,
      letter: room.letter,
      categories: CATEGORIES,
      totalRounds: TOTAL_ROUNDS,
      players: roomSummary(room),
    });

    // 나머지 플레이어에게 입장 알림
    socket.to(roomId).emit('player_joined', { players: roomSummary(room) });
  });

  // 방장이 라운드 시작
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

    io.to(roomId).emit('round_started', {
      round: room.round,
      letter: room.letter,
      totalRounds: TOTAL_ROUNDS,
    });
  });

  // 누군가 STOP! 을 누름
  socket.on('stop', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'playing') return;

    room.phase = 'collecting';
    room.stopper = socket.id;

    // 모든 클라이언트에게 입력 잠금 + 답변 제출 요청
    io.to(roomId).emit('collect_answers', {
      stopperId: socket.id,
      stopperNickname: socket.data.nickname,
    });
  });

  // 각 클라이언트가 답변 제출
  socket.on('submit_answers', (answers) => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'collecting') return;

    room.answers[socket.id] = answers; // { categoryId: string }

    // 모든 플레이어가 제출했으면 결과 브로드캐스트
    if (Object.keys(room.answers).length >= room.players.length) {
      room.phase = 'review';

      // 답변 목록 구성: { categoryId: [ { nickname, answer } ] }
      const compiled = {};
      CATEGORIES.forEach(cat => { compiled[cat.id] = []; });

      room.players.forEach(p => {
        const playerAnswers = room.answers[p.id] ?? {};
        CATEGORIES.forEach(cat => {
          compiled[cat.id].push({
            playerId: p.id,
            nickname: p.nickname,
            answer: (playerAnswers[cat.id] ?? '').trim(),
          });
        });
      });

      io.to(roomId).emit('review_started', {
        letter: room.letter,
        compiled,
        categories: CATEGORIES,
        stopperId: room.stopper,
      });
    }
  });

  // 방장이 점수 확정 후 다음 라운드 or 게임 종료
  socket.on('confirm_scores', (roundScores) => {
    // roundScores: { socketId: points }
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || socket.id !== room.hostId) return;

    Object.entries(roundScores).forEach(([pid, pts]) => {
      room.scores[pid] = (room.scores[pid] ?? 0) + pts;
    });

    const isLastRound = room.round >= TOTAL_ROUNDS;
    room.phase = isLastRound ? 'finished' : 'lobby';

    io.to(roomId).emit('scores_updated', {
      scores: room.scores,
      players: roomSummary(room),
      isLastRound,
      round: room.round,
    });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    // 방장이 나갔으면 다음 사람에게 위임
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      io.to(room.hostId).emit('host_transferred');
    }

    io.to(roomId).emit('player_left', { players: roomSummary(room) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
