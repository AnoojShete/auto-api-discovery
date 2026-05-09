const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'welcome', ts: Date.now() }));

  socket.on('message', (message) => {
    socket.send(JSON.stringify({ type: 'echo', message: message.toString() }));
  });
});

const port = Number(process.env.PORT || 4002);
server.listen(port, () => {
  console.log(`[websocket] listening on ws://localhost:${port}`);
});
