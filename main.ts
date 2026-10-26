// main.ts
const rooms = new Map<string, Set<WebSocket>>();

Deno.serve((req) => {
    const url = new URL(req.url);
    const roomId = url.searchParams.get('room');
    if (!roomId) return new Response('missing room', { status: 400 });

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onopen = () => {
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        const room = rooms.get(roomId)!;
        
        // 1v1 限制：如果房间已经有 2 个人，拒绝加入
        if (room.size >= 2) {
            socket.send(JSON.stringify({ type: 'error', msg: '房间已满' }));
            socket.close();
            return;
        }

        room.add(socket);
        console.log(`[+] 玩家加入房间: ${roomId}, 当前人数: ${room.size}`);

        // 如果房间凑齐了 2 个人，通知双方准备建立 WebRTC 连接
        if (room.size === 2) {
            for (const peer of room) {
                peer.send(JSON.stringify({ type: 'ready' }));
            }
        }
    };

    socket.onmessage = (e) => {
        // 拦截心跳包
        if (e.data === 'ping') {
            socket.send('pong');
            return;
        }

        const peers = rooms.get(roomId);
        if (!peers) return;
        for (const peer of peers) {
            if (peer !== socket && peer.readyState === WebSocket.OPEN) {
                peer.send(e.data); // 原样转发 WebRTC 信令 (offer/answer/candidate)
            }
        }
    };

    socket.onclose = () => {
        const peers = rooms.get(roomId);
        if (peers) {
            peers.delete(socket);
            console.log(`[-] 玩家离开房间: ${roomId}, 当前人数: ${peers.size}`);
            // 通知房间里剩下的人，对方掉线了
            for (const peer of peers) {
                peer.send(JSON.stringify({ type: 'peer-disconnected' }));
            }
            if (peers.size === 0) rooms.delete(roomId);
        }
    };

    return response;
});
