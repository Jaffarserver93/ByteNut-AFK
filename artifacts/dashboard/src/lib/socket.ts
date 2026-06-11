type EventMap = {
  connect: [];
  disconnect: [];
  screenshot: [{ data: string; capturedAt: string }];
  status: [object];
  log: [object];
};

type Listener<T extends unknown[]> = (...args: T) => void;

class NativeSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener<any>>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  connected = false;

  constructor() {
    this.connect();
  }

  private getWsUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.getWsUrl());

      this.ws.onopen = () => {
        this.connected = true;
        this.emit("connect");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit("disconnect");
        this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          const { type, ...payload } = msg;
          if (type) this.emit(type, payload);
        } catch {}
      };
    } catch {
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    }
  }

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener<any>);
  }

  off<K extends keyof EventMap>(event: K, listener?: Listener<EventMap[K]>): void {
    if (!listener) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.get(event)?.delete(listener as Listener<any>);
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
}

const socket = new NativeSocket();
export default socket;
