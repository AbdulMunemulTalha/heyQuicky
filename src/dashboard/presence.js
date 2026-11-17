// Collision detection (INB-10): each dashboard tells the server which chat it has open and whether
// the person is typing; everyone else in the shop sees "Rafi is typing a reply…" in that chat.
export function attachPresence(io) {
  io.on('connection', (socket) => {
    const user = socket.data.user;
    if (!user) return;
    const room = `workspace:${user.workspace_id}`;
    let current = null;
    const send = (conversationId, state) => socket.to(room).emit('presence', { conversationId, userId: user.id, name: user.name, state, at: Date.now() });

    socket.on('presence', (msg) => {
      const conversationId = Number(msg?.conversationId);
      const state = ['viewing', 'typing', 'left'].includes(msg?.state) ? msg.state : 'viewing';
      if (current && current !== conversationId) send(current, 'left');
      if (!Number.isSafeInteger(conversationId)) { current = null; return; }
      current = state === 'left' ? null : conversationId;
      send(conversationId, state);
    });
    socket.on('disconnect', () => { if (current) send(current, 'left'); });
  });
}
