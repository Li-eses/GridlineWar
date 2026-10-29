# Gridline War

# Want to test your mathematical intuition and strategic thinking against your friends?  
# Welcome to **Gridline War** (格线战争). 

Originating from a simple pen-and-paper concept, this game has been transformed into a highly competitive digital battlefield. From elementary school students to top chess players, this game offers a rewarding challenge for all skill levels.

## Play Now

Experience the game directly in your browser. No downloads or installations required:
**[Click here to play Gridline War](http://lisiqi.qd.je/)** 
## Core Features

*   **Instant P2P Multiplayer**: We abandoned heavy third-party networking libraries and built our networking layer from scratch using native WebRTC. It features instruction-level state synchronization with cryptographic hash verification, ensuring seamless peer-to-peer connection and anti-desync protection.
*   **Strict Network Penetration**: Designed to survive highly restrictive networks (like school firewalls). By utilizing WebRTC with fallback TURN servers over TCP port 443, players can connect seamlessly even in complex NAT environments.
*   **Advanced AI Engine**: Play against three levels of AI. The "Master" AI utilizes **Monte Carlo Tree Search (MCTS)** combined with a deterministic heuristic evaluator and a precise kill-finder algorithm. It deeply simulates your moves and strategically traps your base within a single turn.
*   **Deep Mathematical Gameplay & Visuals**: The mechanics are built on graph theory and topology. Players must calculate multi-step paths, predict spatial containment (the "squeeze" mechanics), and manage limited variant deployments simultaneously. The game also features a new event-driven rendering engine with dynamic Canvas animations for bomb blasts and chain deaths.

## About the Developers

This project was entirely developed by a team of three 8th-grade students (Class 9) from China. 

*   **Jason Lee**: Game Design, Rule Architect, and Quality Assurance.
*   **Jimmy Lee**: Frontend Rendering, Native WebRTC Networking, and Cloud Deployment.
*   **Liu Ziyu**: Core Engine Architecture, Advanced AI Algorithms (MCTS), and State Synchronization.
*   **Special Thanks**: DeepSeek AI and Claude AI, for providing invaluable technical assistance, debugging support, and acting as our virtual pair programmer during the development process.
## Technology Stack

*   **Frontend**: Vanilla JavaScript, HTML5 Canvas (for all geometric rendering, particle effects, and animations).
*   **Core Engine**: A pure-function, immutable-state rules engine shared across the UI, AI, and network layers.
*   **Networking**: Native WebRTC (`RTCPeerConnection` and `RTCDataChannel`) with sequence synchronization.
*   **Backend (Signaling)**: Deno (TypeScript) deployed on Deno Deploy (Edge Computing).
*   **Hosting**: Cloudflare Pages (Global CDN distribution).

## Local Development

If you want to explore or modify the code locally, follow these steps:

1. Clone the repository.
2. Navigate to the `net` directory.
3. Ensure you have [Deno](https://deno.com/) installed.
4. Start the signaling server:
   ```bash
   deno run --allow-net main.ts
