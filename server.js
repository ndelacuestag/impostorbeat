const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ hostName, totalPlayers }) => {
    const code = genCode();
    rooms[code] = {
      code, totalPlayers, created: Date.now(),
      players: [{ name: hostName, isHost: true }],
      scores: { [hostName]: 0 },
      phase: 'lobby', rounds: [], currentRound: 0,
      stopVotes: [], votes: {}
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = hostName;
    socket.emit('room_created', { code });
    io.to(code).emit('lobby_update', rooms[code]);
  });

  socket.on('join_room', ({ name, code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('join_error', 'Sala no encontrada');
    if (room.phase !== 'lobby') return socket.emit('join_error', 'La partida ya comenzó');
    if (room.players.some(p => p.name === name)) return socket.emit('join_error', 'Nombre ya en uso');
    room.players.push({ name, isHost: false });
    room.scores[name] = 0;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;
    socket.emit('joined', { code });
    io.to(code).emit('lobby_update', room);
  });

  socket.on('start_game', ({ code, roundsConfig }) => {
    const room = rooms[code];
    if (!room) return;
    const players = room.players.map(p => p.name);
    room.rounds = roundsConfig.map(cfg => {
      const n = Math.min(cfg.impostors, players.length - 2);
      const shuffled = [...players].sort(() => Math.random() - 0.5);
      const impostors = shuffled.slice(0, n);
      const assignments = {};
      players.forEach(p => {
        assignments[p] = impostors.includes(p)
          ? { role: 'impostor', genre: cfg.impostorGenre }
          : { role: 'titular', genre: cfg.titularGenre };
      });
      return { numImpostors: n, titularGenre: cfg.titularGenre, impostorGenre: cfg.impostorGenre, impostors, assignments };
    });
    room.phase = 'playing';
    room.currentRound = 0;
    room.stopVotes = [];
    room.votes = {};
    io.to(code).emit('game_started', room);
  });

  socket.on('vote_stop', ({ code, name }) => {
    const room = rooms[code];
    if (!room || room.stopVotes.includes(name)) return;
    room.stopVotes.push(name);
    const needed = Math.max(1, room.players.length - 2);
    io.to(code).emit('stop_update', { votes: room.stopVotes.length, needed });
    if (room.stopVotes.length >= needed) {
      room.phase = 'voting';
      io.to(code).emit('round_stopped');
    }
  });

  socket.on('submit_vote', ({ code, name, votes }) => {
    const room = rooms[code];
    if (!room) return;
    room.votes[name] = votes;
    if (Object.keys(room.votes).length >= room.players.length) {
      computeResults(room);
      const rnd = room.rounds[room.currentRound];
      io.to(code).emit('results_ready', {
        roundScores: room.roundScores,
        totalScores: room.scores,
        impostors: rnd.impostors,
        roundNum: room.currentRound + 1,
        isLast: room.currentRound >= room.rounds.length - 1
      });
    }
  });

  socket.on('next_round', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.currentRound++;
    room.stopVotes = [];
    room.votes = {};
    room.roundScores = {};
    room.phase = 'playing';
    io.to(code).emit('game_started', room);
  });

  socket.on('end_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.phase = 'gameover';
    io.to(code).emit('game_over', { scores: room.scores, players: room.players });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const name = socket.data.name;
    if (code && rooms[code]) {
      rooms[code].players = rooms[code].players.filter(p => p.name !== name);
      io.to(code).emit('lobby_update', rooms[code]);
    }
  });
});

function computeResults(room) {
  const rnd = room.rounds[room.currentRound];
  const impostors = rnd.impostors;
  const players = room.players.map(p => p.name);
  const roundScores = {};
  players.forEach(p => roundScores[p] = 0);
  players.forEach(voter => {
    if (!room.votes[voter] || impostors.includes(voter)) return;
    room.votes[voter].forEach(guessed => {
      if (impostors.includes(guessed)) {
        roundScores[voter] += 2;
        roundScores[guessed] -= 2;
      }
    });
  });
  impostors.forEach(imp => {
    const notCaught = players.filter(p =>
      !impostors.includes(p) && room.votes[p] && !room.votes[p].includes(imp)
    ).length;
    roundScores[imp] += notCaught;
  });
  room.roundScores = roundScores;
  players.forEach(p => { room.scores[p] = (room.scores[p] || 0) + roundScores[p]; });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ImpostorBeat en puerto ${PORT}`));
