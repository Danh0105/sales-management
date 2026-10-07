// Preload cho acceptance: ghi MỌI lần mở kết nối TCP đi ra của process app
// (pg, fetch/undici, http/https, tls đều đi qua net.Socket#connect) vào file JSONL
// — để đếm được thật số lời gọi tới OpenClaw / API Zalo, kể cả lần bị mạng chặn.
//
//   NODE_OPTIONS=--require=/run/kido/net-tap.js  (NET_TAP_FILE mặc định /tmp/net-tap.jsonl)
//
// Chỉ ghi cho process chính `dist/main.js`; tiến trình phụ (docker exec node ...) bỏ qua.
const net = require('net');
const fs = require('fs');

const FILE = process.env.NET_TAP_FILE || '/tmp/net-tap.jsonl';

if (/dist\/main(\.js)?$/.test(process.argv[1] || '')) {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function tappedConnect(...args) {
    try {
      // net.connect() gọi socket.connect([options, cb]) đã chuẩn hoá; pg gọi connect(port, host).
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      let host;
      let port;
      if (first && typeof first === 'object') {
        if (!first.path) {
          host = first.host || 'localhost';
          port = Number(first.port);
        }
      } else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
        port = Number(first);
        host = typeof args[1] === 'string' ? args[1] : 'localhost';
      }
      if (port) {
        fs.appendFileSync(
          FILE,
          JSON.stringify({ t: new Date().toISOString(), host, port }) + '\n',
        );
      }
    } catch {
      // Đo đạc không bao giờ được làm hỏng kết nối thật.
    }
    return original.apply(this, args);
  };
}
