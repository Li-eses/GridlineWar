# Gridline War

# Want to test your mathematical intuition and strategic thinking against your friends?  Welcome to **Gridline War** (格线战争). 

Originating from a simple pen-and-paper concept, this game has been transformed into a highly competitive digital battlefield. From elementary school students to top chess players, this game offers a rewarding challenge for all skill levels.

## Play Now

Experience the game directly in your browser. No downloads or installations required:
**[Click here to play Gridline War](http://lisiqi.qd.je/)** *(Note: Replace with your actual GitHub Pages link if different)*

## Core Features

*   **Instant P2P Multiplayer**: We abandoned heavy third-party networking libraries and built our networking layer from scratch using native WebRTC. Combined with a custom Deno edge signaling server, it establishes a peer-to-peer connection in milliseconds.
*   **Strict Network Penetration**: Designed to survive highly restrictive networks (like school firewalls). By utilizing WebRTC with fallback TURN servers over TCP port 443, players can connect seamlessly even in complex NAT environments.
*   **Advanced AI Engine**: Play against three levels of AI. The "Master" AI utilizes a deep state-evaluation algorithm and heuristic search to calculate the optimal counter-moves and strategically trap your base.
*   **Deep Mathematical Gameplay**: The mechanics are built on graph theory and topology. Players must calculate multi-step paths, predict spatial containment (the "squeeze" mechanics), and manage limited variant deployments simultaneously.

## About the Developers

This project was entirely developed by two 8th-grade students (Class 9) from China. 
*   **Jason Lee**: Game Design, Rule Architect, and Quality Assurance.
*   **Jimmy Lee**: Code Implementation, Frontend Rendering, and Backend Architecture.
*   **Special Thanks**: DeepSeek AI, for providing invaluable technical assistance, debugging support, and acting as our virtual pair programmer during the development process.

## Technology Stack

*   **Frontend**: Vanilla JavaScript, HTML5 Canvas (for all geometric rendering and animations).
*   **Networking**: Native WebRTC (`RTCPeerConnection` and `RTCDataChannel`).
*   **Backend (Signaling)**: Deno (TypeScript), deployed on Deno Deploy.
*   **Hosting**: GitHub Pages.

## Local Development

If you want to explore or modify the code locally, follow these steps:

1. Clone the repository.
2. Navigate to the `net` directory.
3. Ensure you have [Deno](https://deno.com/) installed.
4. Start the signaling server:
   ```bash
   deno run --allow-net main.ts
