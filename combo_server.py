import socket
import json
import struct
import threading

# ==================== CONFIGURATION ====================
PUBLIC_PORT = 25516   # <-- Put your main Pterodactyl allocated port here
WEBSITE_PORT = 9999   # <-- Put the secret internal port you moved your site to
HOST = '0.0.0.0'
# =======================================================

def write_varint(val):
    total = b""
    while True:
        byte = val & 0x7F
        val >>= 7
        if val: byte |= 0x80
        total += struct.pack('B', byte)
        if not val: break
    return total

def create_packet(packet_id, data):
    packet_id_bytes = write_varint(packet_id)
    return write_varint(len(packet_id_bytes) + len(data)) + packet_id_bytes + data

def forward_traffic(source_sock, destination_port):
    """ Forwards web browser traffic directly to your actual website """
    try:
        dest_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        dest_sock.connect(('127.0.0.1', destination_port))
        
        # Bi-directional data piping
        def pipe(src, dst):
            try:
                while True:
                    data = src.recv(4096)
                    if not data: break
                    dst.sendall(data)
            except: pass
            finally:
                src.close()
                dst.close()

        threading.Thread(target=pipe, args=(source_sock, dest_sock), daemon=True).start()
        threading.Thread(target=pipe, args=(dest_sock, source_sock), daemon=True).start()
    except Exception as e:
        print(f"Error proxying to website: {e}")
        source_sock.close()

def handle_client(conn, addr):
    try:
        # Peek at the first few bytes to see what kind of connection this is
        first_bytes = conn.recv(5, socket.MSG_PEEK)
        if not first_bytes:
            conn.close()
            return

        # Web browsers send clear HTTP text like 'GET /', 'POST', etc.
        if first_bytes.startswith(b'GET ') or first_bytes.startswith(b'POST') or first_bytes.startswith(b'HEAD'):
            # This is a browser trying to see your website! Forward it.
            forward_traffic(conn, WEBSITE_PORT)
            return

        # Otherwise, assume it's Pterodactyl/Minecraft pinging the server
        # --- Packet 1: Handshake ---
        # Clear out the peeked bytes from buffer natively by reading them
        conn.recv(1) # Clear initial size byte
        
        # Send fake Minecraft payload response to fool Pterodactyl
        motd_payload = {
            "version": {"name": "Paper 1.20.4", "protocol": 765},
            "players": {"max": 20, "online": 1, "sample": []},
            "description": {"text": "§a✔ System Online"}
        }
        json_bytes = json.dumps(motd_payload).encode('utf-8')
        response_data = write_varint(len(json_bytes)) + json_bytes
        
        conn.sendall(create_packet(0x00, response_data))
        conn.close()
    except:
        try: conn.close()
        except: pass

def start_proxy():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((HOST, PUBLIC_PORT))
    server.listen(100)
    print(f"🚀 Smart Router active on port {PUBLIC_PORT}")
    print(f"🔗 Forwarding web traffic internally to port {WEBSITE_PORT}...")

    while True:
        conn, addr = server.accept()
        threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()

if __name__ == '__main__':
    start_proxy()
