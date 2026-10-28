const rooms = new Map<string, Set<WebSocket>>();

const port = Number(Deno.env.get("PORT")) || 8000;

Deno.serve({ port: port }, (req) => {
    const url = new URL(req.url);
    const roomId = url.searchParams.get('room');

    // 1. 如果没有 room 参数，直接拒绝
    if (!roomId) return new Response('missing room', { status: 400 });

    // ★ 核心修复：检查请求头，确保真的是 WebSocket 请求，否则返回普通提示，防止后端崩溃
    const upgradeHeader = req.headers.get("upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("信令服务器运行正常！(这是一个 WebSocket 接口，请通过游戏客户端连接)", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" }
        });
    }

    // 2. 安检通过，升级为 WebSocket
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