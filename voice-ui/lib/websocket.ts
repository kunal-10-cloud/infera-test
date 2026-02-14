
export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export interface TranscriptMessage {
    role: "user" | "assistant";
    text: string;
    isInterim?: boolean;
}

export interface WebSocketMessage {
    type: "state" | "transcript_user" | "transcript_assistant" | "barge_in" | "session_started" | "tts_audio_full" | "tts_complete" | "metrics" | "interview_end";
    value?: AgentState;
    text?: string;
    sessionId?: string;
    payload?: any;
    requestId?: number;
    isInterim?: boolean;
    turnId?: number;
    data?: {
        sttLatencyMs: number;
        llmTtftMs: number;
        llmTotalMs: number;
        ttsLatencyMs: number;
        e2eLatencyMs: number;
        bargeIn: boolean;
    };
}

export class VoiceWebSocket {
    private ws: WebSocket | null = null;
    private url: string;
    private onMessage: (msg: WebSocketMessage) => void;

    constructor(url: string, onMessage: (msg: WebSocketMessage) => void) {
        this.url = url;
        this.onMessage = onMessage;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                console.log("[WS] Connected to voice server");
                resolve();
            };

            this.ws.onmessage = (event) => {
                try {
                    if (typeof event.data !== 'string') return;
                    const msg: WebSocketMessage = JSON.parse(event.data);
                    this.onMessage(msg);
                } catch (err) {
                    console.error("[WS] Failed to parse message:", err);
                }
            };

            this.ws.onclose = () => {
                console.log("[WS] Disconnected.");
            };

            this.ws.onerror = (err) => {
                console.error("[WS] Error:", err);
                reject(err);
            };
        });
    }

    sendRaw(data: ArrayBuffer) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        }
    }

    send(data: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}
