const rooms = new Map<string, Set<WebSocket>>();

Deno.serve((req) => {
    const url = new URL(req.url);
    const roomId = url.searchParams.get('room');
    if (!roomId) return new Response('missing room', { status: 400 });

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onopen = () => {
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        rooms.get(roomId)!.add(socket);
        console.log(`[+] 玩家加入房间: ${roomId}, 当前人数: ${rooms.get(roomId)!.size}`);
    };

    socket.onmessage = (e) => {
        const peers = rooms.get(roomId);
        if (!peers) return;
        for (const peer of peers) {
            if (peer !== socket && peer.readyState === WebSocket.OPEN) {
                peer.send(e.data);
            }
        }
    };

    socket.onclose = () => {
        const peers = rooms.get(roomId);
        if (peers) {
            peers.delete(socket);
            console.log(`[-] 玩家离开房间: ${roomId}, 当前人数: ${peers.size}`);
            if (peers.size === 0) rooms.delete(roomId);
        }
    };

    return response;
});
